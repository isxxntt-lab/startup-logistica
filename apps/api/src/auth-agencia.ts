import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { pool } from "./db.js";

export function apiKeyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export async function agenciaPorClave(key: string | undefined | null) {
  if (typeof key !== "string" || key.length === 0) return null;
  const { rows } = await pool.query(
    `SELECT * FROM agencias WHERE api_key_hash = $1`,
    [apiKeyHash(key)],
  );
  return rows[0] ?? null;
}

export async function agenciaPorApiKey(request: FastifyRequest) {
  const key = request.headers["x-api-key"];
  return agenciaPorClave(typeof key === "string" ? key : null);
}
