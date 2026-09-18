import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  assertTransicion,
  type EstadoParada,
  repartidorChannel,
} from "@startup-logistica/shared";
import {
  logOps,
  markRecipientResponse,
  tokenFingerprint,
} from "@startup-logistica/shared/ops";
import { pool } from "../db.js";
import { peekAgenciaId, verificarTokenCliente } from "../jwt.js";
import { redisPub } from "../redis.js";

const respuestaSchema = z.object({
  accion: z.enum(["confirmado", "ausente", "reprogramado", "reasignado"]),
  notas: z.string().max(500).optional(),
  punto_recogida_id: z.string().uuid().optional(),
  ventana_alternativa: z.string().optional(),
});

class ClienteAuthError extends Error {
  statusCode: number;
  reason: "missing" | "invalid" | "revoked" | "expired";
  fingerprint?: { tokenPrefix: string; tokenHash: string };
  constructor(
    message: string,
    statusCode: number,
    reason: ClienteAuthError["reason"],
    fingerprint?: { tokenPrefix: string; tokenHash: string },
  ) {
    super(message);
    this.statusCode = statusCode;
    this.reason = reason;
    this.fingerprint = fingerprint;
  }
}

async function autenticarCliente(token: string | undefined) {
  if (!token) {
    throw new ClienteAuthError("token requerido", 401, "missing");
  }
  const fingerprint = tokenFingerprint(token);
  const agenciaId = peekAgenciaId(token);
  if (!agenciaId) {
    throw new ClienteAuthError("token inválido", 401, "invalid", fingerprint);
  }
  try {
    verificarTokenCliente(token, agenciaId);
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "TokenExpiredError") {
      throw new ClienteAuthError("token caducado", 410, "expired", fingerprint);
    }
    throw new ClienteAuthError("token inválido", 401, "invalid", fingerprint);
  }

  const { rows } = await pool.query(
    `SELECT p.*, r.repartidor_id, r.agencia_id,
            ST_Y(p.ubicacion::geometry) AS lat,
            ST_X(p.ubicacion::geometry) AS lon
     FROM paradas p
     JOIN rutas r ON r.id = p.ruta_id
     WHERE p.token_acceso = $1`,
    [token],
  );
  const parada = rows[0];
  if (!parada) {
    throw new ClienteAuthError("token revocado", 410, "revoked", fingerprint);
  }
  if (parada.token_expira_at && new Date(parada.token_expira_at) < new Date()) {
    throw new ClienteAuthError("token caducado", 410, "expired", fingerprint);
  }
  return parada;
}

async function logTrackingAuthError(err: unknown) {
  if (!(err instanceof ClienteAuthError)) return;
  if (err.reason === "missing") return;
  await logOps({
    level: err.statusCode === 410 ? "info" : "warn",
    category: "tracking_token",
    event: "tracking.token_rejected",
    actor: "api",
    payload: {
      reason: err.reason,
      statusCode: err.statusCode,
      tokenPrefix: err.fingerprint?.tokenPrefix,
      tokenHash: err.fingerprint?.tokenHash,
    },
  });
}

function clienteErrorStatus(err: unknown): number {
  if (err instanceof ClienteAuthError) return err.statusCode;
  if ((err as { name?: string }).name === "TransicionParadaInvalida") return 409;
  return (err as { statusCode?: number }).statusCode ?? 400;
}

async function aplicarRespuestaCliente(
  parada: Record<string, unknown>,
  data: z.infer<typeof respuestaSchema>,
) {
  const hacia = data.accion as EstadoParada;
  assertTransicion(parada.estado as EstadoParada, hacia);
  const from = String(parada.estado);
  const orderId = String(parada.referencia_pedido ?? parada.id);

  await pool.query(
    `UPDATE paradas
     SET estado = $2,
         notas_cliente = COALESCE($3, notas_cliente),
         punto_recogida_id = COALESCE($4, punto_recogida_id)
     WHERE id = $1`,
    [
      parada.id,
      hacia,
      data.notas ?? null,
      data.punto_recogida_id ?? null,
    ],
  );

  const recipientStatus =
    hacia === "confirmado"
      ? "confirmed"
      : hacia === "reprogramado" || hacia === "reasignado"
        ? "rescheduled"
        : hacia === "ausente"
          ? "absent"
          : null;
  if (recipientStatus) {
    await markRecipientResponse(pool, {
      paradaId: String(parada.id),
      recipientStatus,
      closeAttempt: recipientStatus === "rescheduled",
    });
  }

  await logOps({
    level: "info",
    category: "delivery_status",
    event: "delivery_status.changed",
    orderId,
    actor: "cliente",
    payload: { from, to: hacia },
  });

  if (hacia === "confirmado") {
    await logOps({
      level: "info",
      category: "tracking_token",
      event: "tracking.confirm_presence",
      orderId,
      actor: "cliente",
      payload: { from, to: hacia },
    });
  }
  if (hacia === "reprogramado" || hacia === "reasignado") {
    await logOps({
      level: "info",
      category: "tracking_token",
      event: "tracking.reschedule",
      orderId,
      actor: "cliente",
      payload: {
        from,
        to: hacia,
        ventana_alternativa: data.ventana_alternativa ?? null,
      },
    });
  }

  const payload = JSON.stringify({
    tipo: "cliente_respuesta",
    paradaId: parada.id,
    accion: hacia,
    ventana_alternativa: data.ventana_alternativa ?? null,
  });
  await redisPub.publish(
    repartidorChannel(String(parada.repartidor_id)),
    payload,
  );

  return { ok: true, estado: hacia };
}

export async function clienteRoutes(app: FastifyInstance) {
  app.get("/cliente/parada", async (request, reply) => {
    const token =
      (request.headers.authorization?.replace(/^Bearer\s+/i, "") as
        | string
        | undefined) || (request.query as { token?: string }).token;
    try {
      const parada = await autenticarCliente(token);
      return {
        id: parada.id,
        cliente_nombre: parada.cliente_nombre,
        direccion_texto: parada.direccion_texto,
        estado: parada.estado,
        lat: Number(parada.lat),
        lon: Number(parada.lon),
        notas_cliente: parada.notas_cliente,
      };
    } catch (err) {
      await logTrackingAuthError(err);
      const status = clienteErrorStatus(err);
      return reply.code(status).send({ error: (err as Error).message });
    }
  });

  app.get("/cliente/puntos-recogida", async (request, reply) => {
    const token =
      (request.headers.authorization?.replace(/^Bearer\s+/i, "") as
        | string
        | undefined) || (request.query as { token?: string }).token;
    try {
      const parada = await autenticarCliente(token);
      const { rows } = await pool.query(
        `SELECT pr.id, pr.nombre, pr.horario,
                ST_Y(pr.ubicacion::geometry) AS lat,
                ST_X(pr.ubicacion::geometry) AS lon,
                ST_Distance(pr.ubicacion, p.ubicacion) AS distancia_m
         FROM puntos_recogida pr
         JOIN paradas p ON p.id = $1
         WHERE pr.agencia_id = $2
         ORDER BY pr.ubicacion <-> p.ubicacion
         LIMIT 8`,
        [parada.id, parada.agencia_id],
      );
      return { puntos: rows };
    } catch (err) {
      await logTrackingAuthError(err);
      const status = clienteErrorStatus(err);
      return reply.code(status).send({ error: (err as Error).message });
    }
  });

  app.post("/cliente/parada/respuesta", async (request, reply) => {
    const token =
      (request.headers.authorization?.replace(/^Bearer\s+/i, "") as
        | string
        | undefined) || (request.query as { token?: string }).token;
    const parsed = respuestaSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const parada = await autenticarCliente(token);
      return await aplicarRespuestaCliente(parada, parsed.data);
    } catch (err) {
      await logTrackingAuthError(err);
      return reply.code(clienteErrorStatus(err)).send({ error: (err as Error).message });
    }
  });

  app.post("/cliente/confirm-presence", async (request, reply) => {
    const token =
      (request.headers.authorization?.replace(/^Bearer\s+/i, "") as
        | string
        | undefined) || (request.query as { token?: string }).token;
    try {
      const parada = await autenticarCliente(token);
      return await aplicarRespuestaCliente(parada, { accion: "confirmado" });
    } catch (err) {
      await logTrackingAuthError(err);
      return reply.code(clienteErrorStatus(err)).send({ error: (err as Error).message });
    }
  });

  app.post("/cliente/reschedule", async (request, reply) => {
    const token =
      (request.headers.authorization?.replace(/^Bearer\s+/i, "") as
        | string
        | undefined) || (request.query as { token?: string }).token;
    const body = (request.body ?? {}) as { ventana_alternativa?: string; notas?: string };
    try {
      const parada = await autenticarCliente(token);
      return await aplicarRespuestaCliente(parada, {
        accion: "reprogramado",
        ventana_alternativa: body.ventana_alternativa,
        notas: body.notas,
      });
    } catch (err) {
      await logTrackingAuthError(err);
      return reply.code(clienteErrorStatus(err)).send({ error: (err as Error).message });
    }
  });
}
