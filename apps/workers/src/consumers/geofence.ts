import {
  STREAMS,
  type LocationUpdated,
  type NotificationRequested,
  serializeEvent,
} from "@startup-logistica/shared";
import { pool } from "../db.js";
import { redis } from "../redis.js";

export async function handleGeofence(event: LocationUpdated) {
  const params = [
    event.repartidorId,
    event.lon,
    event.lat,
    event.orderId ?? null,
  ];
  const { rows } = await pool.query<{
    id: string;
    estado: string;
    geocerca_radio_m: number;
    referencia_pedido: string | null;
    distance_m: number;
    dentro: boolean;
  }>(
    `SELECT p.id, p.estado, p.geocerca_radio_m, p.referencia_pedido,
            ST_Distance(
              p.ubicacion,
              ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography
            ) AS distance_m,
            ST_DWithin(
              p.ubicacion,
              ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
              p.geocerca_radio_m
            ) AS dentro
     FROM paradas p
     JOIN rutas r ON r.id = p.ruta_id
     WHERE r.repartidor_id = $1
       AND r.fecha = (now() AT TIME ZONE 'Europe/Madrid')::date
       AND r.estado = 'en_curso'
       AND p.estado IN ('pendiente', 'notificado', 'confirmado')
       AND ($4::text IS NULL OR p.referencia_pedido = $4)
     ORDER BY p.orden
     LIMIT 1`,
    params,
  );

  const siguiente = rows[0];
  if (!siguiente) {
    console.log(
      `[geofence] sin parada para ${event.repartidorId} @ ${event.lat},${event.lon}`,
    );
    return;
  }

  const distanceM = Number(siguiente.distance_m);
  const orderId = siguiente.referencia_pedido ?? siguiente.id;
  const at = event.timestamp ?? event.at;
  const speed = event.location?.speedMps ?? 0;

  const { rows: openRows } = await pool.query<{
    id: string;
    dwell_started_at: string;
  }>(
    `SELECT id, dwell_started_at FROM geofence_events
     WHERE parada_id = $1 AND type = 'entered' AND dwell_ended_at IS NULL
     ORDER BY timestamp DESC LIMIT 1`,
    [siguiente.id],
  );
  const abierto = openRows[0];

  if (!siguiente.dentro) {
    if (abierto) {
        const started = new Date(abierto.dwell_started_at).getTime();
        const nowTs = new Date(at).getTime();
        const dwellSeconds = Math.max(0, Math.round((nowTs - started) / 1000));
      await pool.query(
        `UPDATE geofence_events
         SET dwell_ended_at = $2, dwell_seconds = $3
         WHERE id = $1`,
        [abierto.id, at, dwellSeconds],
      );
      await pool.query(
        `INSERT INTO geofence_events (
           parada_id, repartidor_id, order_id, type, radius_m, distance_m, timestamp, dwell_seconds
         ) VALUES ($1,$2,$3,'exited',$4,$5,$6,$7)`,
        [
          siguiente.id,
          event.repartidorId,
          orderId,
          siguiente.geocerca_radio_m,
          distanceM,
          at,
          dwellSeconds,
        ],
      );
      console.log(`[geofence] exited parada=${siguiente.id} dwell=${dwellSeconds}s`);
    } else {
      console.log(
        `[geofence] fuera parada=${siguiente.id} dist=${Math.round(distanceM)}m gps=${event.lat},${event.lon}`,
      );
    }
    return;
  }

  if (!abierto) {
    await pool.query(
      `INSERT INTO geofence_events (
         parada_id, repartidor_id, order_id, type, radius_m, distance_m,
         timestamp, dwell_started_at
       ) VALUES ($1,$2,$3,'entered',$4,$5,$6,$6)`,
      [
        siguiente.id,
        event.repartidorId,
        orderId,
        siguiente.geocerca_radio_m,
        distanceM,
        at,
      ],
    );

    if (siguiente.estado === "pendiente") {
      const notif: NotificationRequested = {
        type: "NOTIFICATION_REQUESTED",
        paradaId: siguiente.id,
        motivo: "proximidad_geocerca",
        minutosRestantes: 10,
      };
      await redis.xadd(
        STREAMS.notifications,
        "*",
        ...Object.entries(serializeEvent(notif)).flat(),
      );
      console.log(`[geofence] entered → aviso_cercania parada=${siguiente.id}`);
    }
  }

  if (speed <= 0.5) {
    const dwellStarted = abierto?.dwell_started_at ?? at;
    const dwellSeconds = Math.max(
      0,
      Math.round((new Date(at).getTime() - new Date(dwellStarted).getTime()) / 1000),
    );
    await pool.query(
      `INSERT INTO geofence_events (
         parada_id, repartidor_id, order_id, type, radius_m, distance_m,
         timestamp, dwell_started_at, dwell_seconds
       ) VALUES ($1,$2,$3,'at_delivery',$4,$5,$6,$7,$8)`,
      [
        siguiente.id,
        event.repartidorId,
        orderId,
        siguiente.geocerca_radio_m,
        distanceM,
        at,
        dwellStarted,
        dwellSeconds,
      ],
    );
    console.log(`[geofence] at_delivery parada=${siguiente.id} dwell=${dwellSeconds}s`);
  }
}
