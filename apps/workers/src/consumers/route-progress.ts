import { enqueueNotification, type ParadaCompleted } from "@startup-logistica/shared";
import { pool } from "../db.js";
import { redis } from "../redis.js";

const UMBRAL_PARADAS = 3;

export async function handleRouteProgress(event: ParadaCompleted) {
  const { rows } = await pool.query(
    `SELECT id, orden, estado
     FROM paradas
     WHERE ruta_id = $1 AND orden > $2 AND estado = 'pendiente'
     ORDER BY orden`,
    [event.rutaId, event.orden],
  );

  for (const parada of rows) {
    const restantes = parada.orden - event.orden;
    if (restantes === UMBRAL_PARADAS) {
      await enqueueNotification(redis, {
        type: "NOTIFICATION_REQUESTED",
        paradaId: parada.id,
        motivo: "faltan_n_paradas",
        paradasRestantes: UMBRAL_PARADAS,
      });
    }
  }
}
