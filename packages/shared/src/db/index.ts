import type { SqlClient } from "../ops/types.js";

/**
 * URL de Postgres por defecto para desarrollo local (docker compose).
 * En producción `DATABASE_URL` es obligatorio.
 */
export const DEFAULT_DATABASE_URL =
  "postgres://logistica:logistica@localhost:5432/startup_logistica";

type Env = Record<string, string | undefined>;

function isProd(env: Env): boolean {
  return (env.NODE_ENV ?? "development") === "production";
}

/**
 * Resuelve `DATABASE_URL` con la misma semántica que `apps/api/src/config.ts`:
 * en desarrollo cae al valor local; en producción exige la variable.
 */
export function resolveDatabaseUrl(env: Env = process.env): string {
  const url = env.DATABASE_URL ?? (isProd(env) ? undefined : DEFAULT_DATABASE_URL);
  if (!url) {
    throw new Error("Falta la variable de entorno DATABASE_URL");
  }
  return url;
}

export interface PgPoolConfig {
  connectionString: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  ssl?: { rejectUnauthorized: boolean };
}

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Decide si activar TLS. Útil para Postgres gestionado (RDS, Supabase, Neon…),
 * donde `sslmode=require` o `DATABASE_SSL=true` es habitual.
 */
function wantsSsl(connectionString: string, env: Env): boolean {
  const flag = (env.DATABASE_SSL ?? "").trim().toLowerCase();
  if (["1", "true", "require", "required", "on"].includes(flag)) return true;
  if (["0", "false", "disable", "disabled", "off"].includes(flag)) return false;
  return /[?&]sslmode=(require|verify-ca|verify-full)/i.test(connectionString);
}

/**
 * Construye la configuración del `pg.Pool` de forma centralizada para que API y
 * workers compartan tuning, TLS y URL. No importa `pg` para no acoplar el paquete
 * compartido al driver.
 */
export function buildPoolConfig(env: Env = process.env): PgPoolConfig {
  const connectionString = resolveDatabaseUrl(env);
  const config: PgPoolConfig = {
    connectionString,
    max: toInt(env.PGPOOL_MAX, 10),
    idleTimeoutMillis: toInt(env.PGPOOL_IDLE_TIMEOUT_MS, 30_000),
    connectionTimeoutMillis: toInt(env.PGPOOL_CONNECTION_TIMEOUT_MS, 10_000),
  };
  if (wantsSsl(connectionString, env)) {
    const rejectUnauthorized =
      (env.DATABASE_SSL_REJECT_UNAUTHORIZED ?? "false").trim().toLowerCase() ===
      "true";
    config.ssl = { rejectUnauthorized };
  }
  return config;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface WaitForPostgresOptions {
  retries?: number;
  delayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, error: unknown) => void;
}

/**
 * Espera a que Postgres acepte conexiones con backoff exponencial. Evita que la
 * API o los workers crasheen si la base aún está arrancando (típico al levantar
 * docker compose o tras un reinicio).
 */
export async function waitForPostgres(
  client: SqlClient,
  options: WaitForPostgresOptions = {},
): Promise<void> {
  const retries = options.retries ?? 15;
  const maxDelay = options.maxDelayMs ?? 5_000;
  let delay = options.delayMs ?? 500;
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await client.query("SELECT 1");
      return;
    } catch (error) {
      lastError = error;
      options.onRetry?.(attempt, error);
      if (attempt < retries) {
        await sleep(delay);
        delay = Math.min(maxDelay, delay * 2);
      }
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Postgres no respondió tras ${retries} intentos: ${detail}`);
}

export interface PostgisStatus {
  version: string | null;
}

/**
 * Garantiza de forma idempotente que las extensiones que necesita el dominio
 * (`postgis` para geocercas y `pgcrypto` para `gen_random_uuid`) existan. El
 * schema base solo se aplica en la primera inicialización del volumen de Docker,
 * así que esto cubre bases gestionadas o volúmenes preexistentes.
 */
export async function ensurePostgis(client: SqlClient): Promise<PostgisStatus> {
  await ensureExtension(client, "postgis");
  await ensureExtension(client, "pgcrypto");
  const result = await client.query<{ version: string }>(
    "SELECT postgis_version() AS version",
  );
  return { version: result.rows[0]?.version ?? null };
}

async function ensureExtension(client: SqlClient, name: string): Promise<void> {
  const existing = await client.query<{ extversion: string }>(
    "SELECT extversion FROM pg_extension WHERE extname = $1",
    [name],
  );
  const count = existing.rowCount ?? existing.rows.length;
  if (count > 0) return;

  try {
    await client.query(`CREATE EXTENSION IF NOT EXISTS ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `No se pudo crear la extensión "${name}". Verifica que el rol tenga permisos ` +
        `(superusuario) o que la extensión venga preinstalada en el Postgres gestionado. ` +
        `Detalle: ${detail}`,
    );
  }
}

export interface DbReadiness {
  ok: boolean;
  postgis: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * Readiness real de la base: comprueba conectividad y que PostGIS esté instalado.
 */
export async function checkDbReadiness(client: SqlClient): Promise<DbReadiness> {
  const start = Date.now();
  try {
    const result = await client.query<{ postgis: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS postgis",
    );
    return {
      ok: true,
      postgis: result.rows[0]?.postgis === true,
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      ok: false,
      postgis: false,
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface BootstrapDatabaseOptions {
  wait?: WaitForPostgresOptions;
  logger?: (message: string) => void;
}

/**
 * Secuencia de arranque para API y workers: espera a Postgres y garantiza las
 * extensiones antes de aplicar migraciones idempotentes.
 */
export async function bootstrapDatabase(
  client: SqlClient,
  options: BootstrapDatabaseOptions = {},
): Promise<PostgisStatus> {
  const log = options.logger ?? (() => {});
  await waitForPostgres(client, {
    ...options.wait,
    onRetry: (attempt, error) => {
      const detail = error instanceof Error ? error.message : String(error);
      log(`Esperando a Postgres (intento ${attempt}): ${detail}`);
      options.wait?.onRetry?.(attempt, error);
    },
  });
  const status = await ensurePostgis(client);
  log(`PostGIS disponible: ${status.version ?? "desconocido"}`);
  return status;
}
