import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  canConfirmPresence,
  canReschedule,
  logOps,
  markRecipientResponse,
  tokenFingerprint,
  type EstadoParada,
  repartidorChannel,
} from "@startup-logistica/shared";
import { pool } from "../db.js";
import { peekAgenciaId, verificarTokenCliente } from "../jwt.js";
import { redisPub } from "../redis.js";
import { gateFromJwtError, gateFromParada } from "../tracking-gate.js";

const tokenBodySchema = z.object({
  token: z.string().min(1),
  preferred_window: z.string().max(200).optional(),
});

type ParadaTracking = {
  id: string;
  cliente_nombre: string;
  direccion_texto: string;
  referencia_pedido: string | null;
  estado: EstadoParada;
  lat: number;
  lng: number;
  token_expira_at: Date | null;
  repartidor_id: string;
  courier_lat: number | null;
  courier_lng: number | null;
  courier_updated_at: Date | null;
};

type TrackingAuthFailure =
  | { kind: "invalid"; status: 401 | 404 }
  | { kind: "gone"; reason: "expired" | "used" };

function tokenDesdeRequest(request: {
  headers: { authorization?: string };
  query: unknown;
  body?: unknown;
}): string | undefined {
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  const q = request.query as { token?: string };
  const bodyToken =
    request.body && typeof request.body === "object"
      ? (request.body as { token?: string }).token
      : undefined;
  return bearer || q.token || bodyToken;
}

function sendGone(
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  reason: "expired" | "used",
) {
  return reply.code(410).send({ error: "gone", reason });
}

async function logTrackingAuthFailure(
  token: string | undefined,
  failure: TrackingAuthFailure,
) {
  if (!token) return;
  const { tokenPrefix, tokenHash } = tokenFingerprint(token);
  await logOps({
    level: failure.kind === "gone" ? "info" : "warn",
    category: "tracking_token",
    event: "tracking.token_rejected",
    actor: "api",
    payload: {
      reason: failure.kind === "gone" ? failure.reason : "invalid",
      statusCode: failure.kind === "gone" ? 410 : failure.status,
      tokenPrefix,
      tokenHash,
    },
  });
}

async function replyTrackingAuth(
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  token: string | undefined,
  failure: TrackingAuthFailure,
) {
  await logTrackingAuthFailure(token, failure);
  if (failure.kind === "gone") return sendGone(reply, failure.reason);
  return reply.code(failure.status).send({ error: "invalid" });
}

async function cargarParada(token: string): Promise<ParadaTracking | null> {
  const { rows } = await pool.query(
    `SELECT p.id, p.cliente_nombre, p.direccion_texto, p.referencia_pedido,
            p.estado, p.token_expira_at, r.repartidor_id,
            ST_Y(p.ubicacion::geometry) AS lat,
            ST_X(p.ubicacion::geometry) AS lng,
            ST_Y(rep.ubicacion_actual::geometry) AS courier_lat,
            ST_X(rep.ubicacion_actual::geometry) AS courier_lng,
            rep.ultima_actualizacion AS courier_updated_at
     FROM paradas p
     JOIN rutas r ON r.id = p.ruta_id
     JOIN repartidores rep ON rep.id = r.repartidor_id
     WHERE p.token_acceso = $1`,
    [token],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    cliente_nombre: row.cliente_nombre,
    direccion_texto: row.direccion_texto,
    referencia_pedido: row.referencia_pedido,
    estado: row.estado as EstadoParada,
    lat: Number(row.lat),
    lng: Number(row.lng),
    token_expira_at: row.token_expira_at,
    repartidor_id: row.repartidor_id,
    courier_lat: row.courier_lat == null ? null : Number(row.courier_lat),
    courier_lng: row.courier_lng == null ? null : Number(row.courier_lng),
    courier_updated_at: row.courier_updated_at,
  };
}

async function autenticarTracking(token: string | undefined) {
  if (!token) {
    return { ok: false as const, failure: { kind: "invalid" as const, status: 401 as const } };
  }
  const agenciaId = peekAgenciaId(token);
  if (!agenciaId) {
    return { ok: false as const, failure: { kind: "invalid" as const, status: 401 as const } };
  }
  try {
    verificarTokenCliente(token, agenciaId);
  } catch (err) {
    return { ok: false as const, failure: gateFromJwtError(err as { name?: string }) };
  }

  const parada = await cargarParada(token);
  const gate = gateFromParada({
    found: Boolean(parada),
    tokenExpiraAt: parada?.token_expira_at ?? null,
    estado: parada?.estado,
  });
  if (gate.kind !== "ok" || !parada) {
    return {
      ok: false as const,
      failure: gate.kind === "ok" ? { kind: "invalid" as const, status: 404 as const } : gate,
    };
  }
  return { ok: true as const, parada, sessionStatus: gate.sessionStatus };
}

async function publicarRespuestaCliente(
  repartidorId: string,
  paradaId: string,
  accion: string,
  ventanaAlternativa?: string,
) {
  await redisPub.publish(
    repartidorChannel(repartidorId),
    JSON.stringify({
      tipo: "cliente_respuesta",
      paradaId,
      accion,
      ventana_alternativa: ventanaAlternativa ?? null,
    }),
  );
}

export async function trackingRoutes(app: FastifyInstance) {
  app.get("/api/tracking/session", async (request, reply) => {
    const token = tokenDesdeRequest(request);
    const auth = await autenticarTracking(token);
    if (!auth.ok) return replyTrackingAuth(reply, token, auth.failure);
    const { parada, sessionStatus } = auth;
    return {
      status: sessionStatus,
      clienteNombre: parada.cliente_nombre,
      direccionTexto: parada.direccion_texto,
      referenciaPedido: parada.referencia_pedido ?? undefined,
      delivery: { lat: parada.lat, lng: parada.lng },
    };
  });

  app.get("/api/tracking/position", async (request, reply) => {
    const token = tokenDesdeRequest(request);
    const auth = await autenticarTracking(token);
    if (!auth.ok) return replyTrackingAuth(reply, token, auth.failure);
    const { parada } = auth;
    if (parada.courier_lat == null || parada.courier_lng == null) {
      return reply.code(404).send({ error: "no_position" });
    }
    return {
      lat: parada.courier_lat,
      lng: parada.courier_lng,
      updatedAt: (parada.courier_updated_at ?? new Date()).toISOString(),
    };
  });

  app.post("/api/tracking/confirm-presence", async (request, reply) => {
    const parsed = tokenBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const auth = await autenticarTracking(parsed.data.token);
    if (!auth.ok) return replyTrackingAuth(reply, parsed.data.token, auth.failure);
    const { parada } = auth;
    if (!canConfirmPresence(parada.estado)) {
      return reply.code(409).send({ error: "transicion_invalida" });
    }
    if (parada.estado !== "confirmado") {
      const from = parada.estado;
      const orderId = parada.referencia_pedido ?? parada.id;
      await pool.query(`UPDATE paradas SET estado = 'confirmado' WHERE id = $1`, [
        parada.id,
      ]);
      await markRecipientResponse(pool, {
        paradaId: parada.id,
        recipientStatus: "confirmed",
      });
      await publicarRespuestaCliente(parada.repartidor_id, parada.id, "confirmado");
      await logOps({
        level: "info",
        category: "delivery_status",
        event: "delivery_status.changed",
        orderId,
        actor: "cliente",
        payload: { from, to: "confirmado" },
      });
      await logOps({
        level: "info",
        category: "tracking_token",
        event: "tracking.confirm_presence",
        orderId,
        actor: "cliente",
        payload: { from, to: "confirmado" },
      });
    }
    return { ok: true, status: "will_be_there" as const };
  });

  app.post("/api/tracking/reschedule", async (request, reply) => {
    const parsed = tokenBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const auth = await autenticarTracking(parsed.data.token);
    if (!auth.ok) return replyTrackingAuth(reply, parsed.data.token, auth.failure);
    const { parada } = auth;
    if (!canReschedule(parada.estado)) {
      return reply.code(409).send({ error: "transicion_invalida" });
    }
    if (parada.estado !== "reprogramado") {
      const from = parada.estado;
      const orderId = parada.referencia_pedido ?? parada.id;
      const notas = parsed.data.preferred_window
        ? `ventana: ${parsed.data.preferred_window}`
        : null;
      await pool.query(
        `UPDATE paradas
         SET estado = 'reprogramado',
             notas_cliente = COALESCE($2, notas_cliente)
         WHERE id = $1`,
        [parada.id, notas],
      );
      await markRecipientResponse(pool, {
        paradaId: parada.id,
        recipientStatus: "rescheduled",
        closeAttempt: true,
      });
      await publicarRespuestaCliente(
        parada.repartidor_id,
        parada.id,
        "reprogramado",
        parsed.data.preferred_window,
      );
      await logOps({
        level: "info",
        category: "delivery_status",
        event: "delivery_status.changed",
        orderId,
        actor: "cliente",
        payload: { from, to: "reprogramado" },
      });
      await logOps({
        level: "info",
        category: "tracking_token",
        event: "tracking.reschedule",
        orderId,
        actor: "cliente",
        payload: {
          from,
          to: "reprogramado",
          preferred_window: parsed.data.preferred_window ?? null,
        },
      });
    }
    return { ok: true, status: "reschedule_requested" as const };
  });
}
