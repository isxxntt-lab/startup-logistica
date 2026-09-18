import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { LogOpsInput, SqlClient } from "./types.js";

const opsStorage = new AsyncLocalStorage<{ correlationId: string }>();

let defaultDb: SqlClient | null = null;

const SENSITIVE_KEY =
  /^(token|token_acceso|access_token|refresh_token|authorization|password|secret|api_key|apikey|auth|jwt)$/i;

export function initOps(db: SqlClient): void {
  defaultDb = db;
}

export function getOpsDb(): SqlClient {
  if (!defaultDb) {
    throw new Error("Ops no inicializado: llama initOps(pool) al arrancar");
  }
  return defaultDb;
}

export function currentCorrelationId(): string | undefined {
  return opsStorage.getStore()?.correlationId;
}

export function withCorrelation<T>(
  fn: (correlationId: string) => T | Promise<T>,
  correlationId?: string,
): T | Promise<T> {
  const headerOrGiven = correlationId?.trim();
  const id = headerOrGiven && headerOrGiven.length > 0 ? headerOrGiven : randomUUID();
  return opsStorage.run({ correlationId: id }, () => fn(id));
}

export function correlationFromHeader(
  header: string | string[] | undefined,
): string {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw && raw.trim()) return raw.trim();
  return randomUUID();
}

export function tokenFingerprint(token: string): {
  tokenPrefix: string;
  tokenHash: string;
} {
  return {
    tokenPrefix: token.slice(0, 6),
    tokenHash: createHash("sha256").update(token).digest("hex").slice(0, 16),
  };
}

export function sanitizeOpsPayload(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!input) return {};
  return sanitizeValue(input) as Record<string, unknown>;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) {
      if (typeof raw === "string" && raw.length > 0) {
        out[key] = tokenFingerprint(raw);
      } else {
        out[key] = "[redacted]";
      }
      continue;
    }
    out[key] = sanitizeValue(raw);
  }
  return out;
}

export async function logOps(
  entry: LogOpsInput,
  db: SqlClient = defaultDb as SqlClient,
): Promise<void> {
  if (!db) {
    console.warn("[ops] logOps sin base de datos", entry.event);
    return;
  }
  const correlationId =
    entry.correlationId?.trim() || currentCorrelationId() || randomUUID();
  try {
    await db.query(
      `INSERT INTO ops_logs (
         level, category, event, order_id, attempt_number,
         correlation_id, actor, payload, duration_ms
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
      [
        entry.level,
        entry.category,
        entry.event,
        entry.orderId ?? null,
        entry.attemptNumber ?? null,
        correlationId,
        entry.actor ?? null,
        JSON.stringify(sanitizeOpsPayload(entry.payload)),
        entry.durationMs ?? null,
      ],
    );
  } catch (err) {
    console.error("[ops] no se pudo persistir log", entry.event, err);
  }
}
