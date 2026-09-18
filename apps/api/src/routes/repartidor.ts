import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";
import { enqueueGeofence, enqueueRouteProgress, enqueueNotification } from "../queue.js";
import {
  assertTransicion,
  type EstadoParada,
} from "@startup-logistica/shared";
import { toLocationUpdated } from "../location.js";
import {
  completeOpenAttempt,
  logOps,
} from "@startup-logistica/shared";

const ubicacionSchema = z.object({
  event: z.literal("location_update").optional(),
  courier_id: z.string().optional(),
  courierId: z.string().optional(),
  order_id: z.string().optional(),
  orderId: z.string().optional(),
  timestamp: z.string().optional(),
  lat: z.number().gte(-90).lte(90).optional(),
  lon: z.number().gte(-180).lte(180).optional(),
  lng: z.number().gte(-180).lte(180).optional(),
  rutaId: z.string().uuid().optional(),
  location: z
    .object({
      lat: z.number(),
      lng: z.number().optional(),
      lon: z.number().optional(),
      accuracy_m: z.number().optional(),
      accuracyM: z.number().optional(),
      altitude_m: z.number().optional(),
      altitudeM: z.number().optional(),
      heading_deg: z.number().optional(),
      headingDeg: z.number().optional(),
      speed_mps: z.number().optional(),
      speedMps: z.number().optional(),
    })
    .optional(),
});

const estadoSchema = z.object({
  estado: z.enum(["entregado", "ausente"]),
  fotoUrl: z.string().url().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  failureReason: z
    .enum(["recipient_absent", "wrong_address", "refused", "access_issue", "other"])
    .optional(),
  receptorNombre: z.string().optional(),
});

async function persistAndEnqueue(repartidorId: string, raw: unknown) {
  const event = toLocationUpdated(raw as never, repartidorId);
  let paradaId: string | null = null;
  if (event.orderId) {
    const found = await pool.query(
      `SELECT p.id FROM paradas p
       JOIN rutas r ON r.id = p.ruta_id
       WHERE r.repartidor_id = $1 AND p.referencia_pedido = $2
       ORDER BY p.orden LIMIT 1`,
      [repartidorId, event.orderId],
    );
    paradaId = found.rows[0]?.id ?? null;
  }

  await pool.query(
    `UPDATE repartidores
     SET ubicacion_actual = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
         ultima_actualizacion = $4::timestamptz
     WHERE id = $1`,
    [repartidorId, event.lon, event.lat, event.timestamp],
  );

  await pool.query(
    `INSERT INTO location_pings (
       repartidor_id, parada_id, order_id, captured_at, lat, lng,
       accuracy_m, altitude_m, heading_deg, speed_mps, raw
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [
      repartidorId,
      paradaId,
      event.orderId ?? null,
      event.timestamp,
      event.lat,
      event.lon,
      event.location.accuracyM,
      event.location.altitudeM ?? null,
      event.location.headingDeg ?? null,
      event.location.speedMps ?? null,
      JSON.stringify(raw),
    ],
  );

  await enqueueGeofence(event);
  return event;
}

async function resolveRepartidor(idOrCodigo: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT id FROM repartidores WHERE id::text = $1 OR codigo = $1`,
    [idOrCodigo],
  );
  return rows[0]?.id ?? null;
}

export async function repartidorRoutes(app: FastifyInstance) {
  app.post("/repartidor/:id/ubicacion", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = ubicacionSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    const repartidorId = await resolveRepartidor(id);
    if (!repartidorId) return reply.code(404).send({ error: "repartidor no encontrado" });
    const event = await persistAndEnqueue(repartidorId, {
      ...body.data,
      rutaId: body.data.rutaId,
    });
    return { ok: true, event };
  });

  app.post("/events/location_update", async (request, reply) => {
    const body = ubicacionSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    const codigo = body.data.courier_id ?? body.data.courierId;
    if (!codigo) return reply.code(400).send({ error: "courier_id requerido" });
    const repartidorId = await resolveRepartidor(codigo);
    if (!repartidorId) return reply.code(404).send({ error: "repartidor no encontrado" });
    const event = await persistAndEnqueue(repartidorId, body.data);
    return { ok: true, event };
  });

  app.get("/repartidor/:id/ruta-hoy", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repartidorId = await resolveRepartidor(id);
    if (!repartidorId) return reply.code(404).send({ error: "repartidor no encontrado" });
    const { rows } = await pool.query(
      `SELECT r.*,
              json_agg(
                json_build_object(
                  'id', p.id,
                  'orden', p.orden,
                  'referencia_pedido', p.referencia_pedido,
                  'cliente_nombre', p.cliente_nombre,
                  'direccion_texto', p.direccion_texto,
                  'estado', p.estado,
                  'lat', ST_Y(p.ubicacion::geometry),
                  'lon', ST_X(p.ubicacion::geometry)
                ) ORDER BY p.orden
              ) AS paradas
       FROM rutas r
       JOIN paradas p ON p.ruta_id = r.id
       WHERE r.repartidor_id = $1
         AND r.fecha = (now() AT TIME ZONE 'Europe/Madrid')::date
       GROUP BY r.id
       ORDER BY r.hora_inicio NULLS LAST
       LIMIT 1`,
      [repartidorId],
    );
    if (!rows[0]) return reply.code(404).send({ error: "sin ruta hoy" });
    return rows[0];
  });

  app.post("/repartidor/paradas/:paradaId/estado", async (request, reply) => {
    const { paradaId } = request.params as { paradaId: string };
    const body = estadoSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }

    const { rows } = await pool.query(
      `SELECT p.*, r.repartidor_id
       FROM paradas p
       JOIN rutas r ON r.id = p.ruta_id
       WHERE p.id = $1`,
      [paradaId],
    );
    const parada = rows[0];
    if (!parada) return reply.code(404).send({ error: "parada no encontrada" });

    try {
      assertTransicion(parada.estado as EstadoParada, body.data.estado);
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }

    const fromEstado = parada.estado as EstadoParada;
    const failureAvoided = body.data.estado === "entregado" &&
      ["notificado", "confirmado"].includes(parada.estado);
    const orderId = parada.referencia_pedido ?? paradaId;

    await pool.query(
      `UPDATE paradas
       SET estado = $2,
           receptor_nombre = COALESCE($6, receptor_nombre),
           delivered_at = CASE WHEN $2 = 'entregado' THEN now() ELSE delivered_at END,
           first_attempt_success = CASE
             WHEN $2 = 'entregado' AND $7 THEN true ELSE first_attempt_success END,
           on_time = CASE WHEN $2 = 'entregado' THEN true ELSE on_time END,
           failure_reason = CASE WHEN $2 = 'ausente' THEN COALESCE($8, 'recipient_absent') ELSE failure_reason END,
           prueba_ausencia_foto_url = CASE WHEN $2 = 'ausente' THEN $3 ELSE prueba_ausencia_foto_url END,
           prueba_ausencia_gps = CASE
             WHEN $2 = 'ausente' AND $4 IS NOT NULL AND $5 IS NOT NULL
             THEN ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography
             ELSE prueba_ausencia_gps
           END,
           prueba_ausencia_timestamp = CASE WHEN $2 = 'ausente' THEN now() ELSE prueba_ausencia_timestamp END
       WHERE id = $1`,
      [
        paradaId,
        body.data.estado,
        body.data.fotoUrl ?? null,
        body.data.lon ?? null,
        body.data.lat ?? null,
        body.data.receptorNombre ?? null,
        failureAvoided,
        body.data.failureReason ?? null,
      ],
    );

    const { rows: dwell } = await pool.query(
      `SELECT dwell_seconds FROM geofence_events
       WHERE parada_id = $1 AND dwell_seconds IS NOT NULL
       ORDER BY timestamp DESC LIMIT 1`,
      [paradaId],
    );

    const attemptStatus =
      body.data.estado === "entregado"
        ? "delivered"
        : body.data.estado === "ausente"
          ? "failed"
          : "rescheduled";
    const completed = await completeOpenAttempt(pool, {
      paradaId,
      status: attemptStatus,
      failureReason:
        body.data.estado === "ausente"
          ? (body.data.failureReason ?? "recipient_absent")
          : null,
      failureAvoided,
      avoidanceChannel: failureAvoided ? "whatsapp" : null,
      dwellSeconds: dwell[0]?.dwell_seconds ?? null,
    });

    await logOps({
      level: "info",
      category: "delivery_status",
      event: "delivery_status.changed",
      orderId,
      attemptNumber: completed.attemptNumber,
      actor: parada.repartidor_id,
      payload: { from: fromEstado, to: body.data.estado, attemptStatus },
    });

    if (body.data.estado === "entregado") {
      await enqueueRouteProgress({
        type: "PARADA_COMPLETED",
        rutaId: parada.ruta_id,
        paradaId,
        orden: parada.orden,
        repartidorId: parada.repartidor_id,
      });
      await enqueueNotification({
        type: "NOTIFICATION_REQUESTED",
        paradaId,
        motivo: "entrega_confirmada",
      });
    }

    return { ok: true, estado: body.data.estado };
  });
}
