import type { FastifyReply, FastifyRequest } from "fastify";
import { pool } from "./db.js";
import { agenciaPorClave } from "./auth-agencia.js";

export type AuthRepartidorOk = {
  ok: true;
  agenciaId: string;
  repartidorId: string;
};

export type AuthParadaOk = {
  ok: true;
  agenciaId: string;
  parada: ParadaAutorizada;
};

export type AuthRepartidorFail = {
  ok: false;
  status: 401 | 403;
  error: string;
};

export type AuthRepartidorResult = AuthRepartidorOk | AuthRepartidorFail;
export type AuthParadaResult = AuthParadaOk | AuthRepartidorFail;

export type ParadaAutorizada = {
  id: string;
  ruta_id: string;
  orden: number;
  estado: string;
  referencia_pedido: string | null;
  repartidor_id: string;
};

const ERROR_API_KEY = "api key inválida";
const ERROR_REPARTIDOR = "repartidor no autorizado";
const ERROR_PARADA = "parada no autorizada";

export function apiKeyDesdeHeader(
  headers: FastifyRequest["headers"] | Record<string, unknown>,
): string | undefined {
  const raw = headers["x-api-key"];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (typeof key !== "string") return undefined;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Misma política que `/ws/repartidor`: API key de agencia + el
 * repartidor (uuid o código) tiene que ser de esa agencia y estar activo.
 * 401 = sin clave o clave desconocida. 403 = clave válida pero recurso ajeno.
 */
export async function autorizarRepartidor(opts: {
  apiKey?: string;
  id?: string;
}): Promise<AuthRepartidorResult> {
  const apiKey = opts.apiKey?.trim();
  if (!apiKey) {
    return { ok: false, status: 401, error: ERROR_API_KEY };
  }

  const agencia = await agenciaPorClave(apiKey);
  if (!agencia) {
    return { ok: false, status: 401, error: ERROR_API_KEY };
  }

  const id = opts.id?.trim();
  if (!id) {
    return { ok: false, status: 403, error: ERROR_REPARTIDOR };
  }

  const { rows } = await pool.query<{ id: string }>(
    `SELECT id::text AS id
     FROM repartidores
     WHERE agencia_id = $1
       AND activo = true
       AND (id::text = $2 OR codigo = $2)
     LIMIT 1`,
    [agencia.id, id],
  );
  if (!rows[0]) {
    return { ok: false, status: 403, error: ERROR_REPARTIDOR };
  }
  return {
    ok: true,
    agenciaId: agencia.id,
    repartidorId: rows[0].id,
  };
}

export async function autorizarParada(opts: {
  apiKey?: string;
  paradaId?: string;
}): Promise<AuthParadaResult> {
  const apiKey = opts.apiKey?.trim();
  if (!apiKey) {
    return { ok: false, status: 401, error: ERROR_API_KEY };
  }

  const agencia = await agenciaPorClave(apiKey);
  if (!agencia) {
    return { ok: false, status: 401, error: ERROR_API_KEY };
  }

  const paradaId = opts.paradaId?.trim();
  if (!paradaId) {
    return { ok: false, status: 403, error: ERROR_PARADA };
  }

  const { rows } = await pool.query<ParadaAutorizada>(
    `SELECT p.id::text AS id,
            p.ruta_id::text AS ruta_id,
            p.orden,
            p.estado,
            p.referencia_pedido,
            r.repartidor_id::text AS repartidor_id
     FROM paradas p
     JOIN rutas r ON r.id = p.ruta_id
     WHERE p.id = $1 AND r.agencia_id = $2
     LIMIT 1`,
    [paradaId, agencia.id],
  );
  if (!rows[0]) {
    return { ok: false, status: 403, error: ERROR_PARADA };
  }
  return { ok: true, agenciaId: agencia.id, parada: rows[0] };
}

type AutorizarRepartidorFn = typeof autorizarRepartidor;
type AutorizarParadaFn = typeof autorizarParada;

export async function protegerRepartidor(
  request: FastifyRequest,
  reply: FastifyReply,
  id: string | undefined,
  autorizar: AutorizarRepartidorFn = autorizarRepartidor,
): Promise<string | null> {
  const result = await autorizar({
    apiKey: apiKeyDesdeHeader(request.headers),
    id,
  });
  if (!result.ok) {
    reply.code(result.status).send({ error: result.error });
    return null;
  }
  return result.repartidorId;
}

export async function protegerParada(
  request: FastifyRequest,
  reply: FastifyReply,
  paradaId: string | undefined,
  autorizar: AutorizarParadaFn = autorizarParada,
): Promise<ParadaAutorizada | null> {
  const result = await autorizar({
    apiKey: apiKeyDesdeHeader(request.headers),
    paradaId,
  });
  if (!result.ok) {
    reply.code(result.status).send({ error: result.error });
    return null;
  }
  return result.parada;
}
