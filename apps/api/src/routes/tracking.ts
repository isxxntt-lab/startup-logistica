import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  canConfirmPresence,
  canReschedule,
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
    const auth = await autenticarTracking(tokenDesdeRequest(request));
    if (!auth.ok) {
      if (auth.failure.kind === "gone") return sendGone(reply, auth.failure.reason);
      return reply.code(auth.failure.status).send({ error: "invalid" });
    }
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
    const auth = await autenticarTracking(tokenDesdeRequest(request));
    if (!auth.ok) {
      if (auth.failure.kind === "gone") return sendGone(reply, auth.failure.reason);
      return reply.code(auth.failure.status).send({ error: "invalid" });
    }
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
    if (!auth.ok) {
      if (auth.failure.kind === "gone") return sendGone(reply, auth.failure.reason);
      return reply.code(auth.failure.status).send({ error: "invalid" });
    }
    const { parada } = auth;
    if (!canConfirmPresence(parada.estado)) {
      return reply.code(409).send({ error: "transicion_invalida" });
    }
    if (parada.estado !== "confirmado") {
      await pool.query(`UPDATE paradas SET estado = 'confirmado' WHERE id = $1`, [
        parada.id,
      ]);
      await publicarRespuestaCliente(parada.repartidor_id, parada.id, "confirmado");
    }
    return { ok: true, status: "will_be_there" as const };
  });

  app.post("/api/tracking/reschedule", async (request, reply) => {
    const parsed = tokenBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const auth = await autenticarTracking(parsed.data.token);
    if (!auth.ok) {
      if (auth.failure.kind === "gone") return sendGone(reply, auth.failure.reason);
      return reply.code(auth.failure.status).send({ error: "invalid" });
    }
    const { parada } = auth;
    if (!canReschedule(parada.estado)) {
      return reply.code(409).send({ error: "transicion_invalida" });
    }
    if (parada.estado !== "reprogramado") {
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
      await publicarRespuestaCliente(
        parada.repartidor_id,
        parada.id,
        "reprogramado",
        parsed.data.preferred_window,
      );
    }
    return { ok: true, status: "reschedule_requested" as const };
  });
}
