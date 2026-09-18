import {
  ESTADO_A_DELIVERY_STATUS,
  type DashboardFilters,
  type DashboardPayload,
  type Delivery,
  type DeliveryAttempt,
  type DeliveryKpis,
  type KpiTrendPoint,
} from "@startup-logistica/shared";
import { getOpsMetrics } from "@startup-logistica/shared/ops";
import { pool } from "../db.js";

function round(n: number, digits = 2): number {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function previousRange(from: string, to: string): { from: string; to: string } {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
  const prevEnd = new Date(start);
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - (days - 1));
  return {
    from: prevStart.toISOString().slice(0, 10),
    to: prevEnd.toISOString().slice(0, 10),
  };
}

async function kpisFor(
  agenciaId: string,
  from: string,
  to: string,
  courierId?: string,
): Promise<DeliveryKpis> {
  const { rows } = await pool.query(
    `WITH base AS (
       SELECT p.*, r.repartidor_id, r.fecha AS scheduled_date
       FROM paradas p
       JOIN rutas r ON r.id = p.ruta_id
       WHERE r.agencia_id = $1
         AND r.fecha BETWEEN $2::date AND $3::date
         AND ($4::text IS NULL OR r.repartidor_id::text = $4 OR EXISTS (
           SELECT 1 FROM repartidores rp
           WHERE rp.id = r.repartidor_id AND rp.codigo = $4
         ))
     )
     SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE estado = 'entregado')::int AS delivered,
       count(*) FILTER (WHERE estado = 'ausente')::int AS failed,
       count(*) FILTER (WHERE first_attempt_success)::int AS first_ok,
       count(*) FILTER (WHERE estado IN ('entregado', 'ausente', 'reprogramado', 'reasignado'))::int AS first_total,
       count(*) FILTER (WHERE on_time)::int AS on_time,
       count(*) FILTER (WHERE estado = 'entregado')::int AS delivered_for_ontime
     FROM base`,
    [agenciaId, from, to, courierId ?? null],
  );

  const { rows: dwellRows } = await pool.query(
    `SELECT avg(dwell_seconds) AS avg_dwell
     FROM geofence_events g
     JOIN paradas p ON p.id = g.parada_id
     JOIN rutas r ON r.id = p.ruta_id
     WHERE r.agencia_id = $1
       AND r.fecha BETWEEN $2::date AND $3::date
       AND g.dwell_seconds IS NOT NULL`,
    [agenciaId, from, to],
  );

  const { rows: attemptsRows } = await pool.query(
    `SELECT avg(n)::float AS avg_attempts
     FROM (
       SELECT p.id, count(da.id)::float AS n
       FROM paradas p
       JOIN rutas r ON r.id = p.ruta_id
       LEFT JOIN delivery_attempts da ON da.parada_id = p.id
       WHERE r.agencia_id = $1
         AND r.fecha BETWEEN $2::date AND $3::date
         AND p.estado = 'entregado'
       GROUP BY p.id
     ) t`,
    [agenciaId, from, to],
  );

  const { rows: liveRows } = await pool.query(
    `SELECT count(DISTINCT g.parada_id)::int AS live,
            count(DISTINCT r.repartidor_id)::int AS couriers
     FROM geofence_events g
     JOIN paradas p ON p.id = g.parada_id
     JOIN rutas r ON r.id = p.ruta_id
     WHERE r.agencia_id = $1
       AND g.type = 'entered'
       AND g.dwell_ended_at IS NULL`,
    [agenciaId],
  );

  const total = rows[0]?.total ?? 0;
  const delivered = rows[0]?.delivered ?? 0;
  const failed = rows[0]?.failed ?? 0;
  const firstOk = rows[0]?.first_ok ?? 0;
  const firstTotal = rows[0]?.first_total ?? 0;
  const onTime = rows[0]?.on_time ?? 0;
  const dwell = Number(dwellRows[0]?.avg_dwell ?? 0);

  const ops = await getOpsMetrics(pool, {
    from: `${from}T00:00:00.000Z`,
    to: `${to}T23:59:59.999Z`,
    agenciaId,
  });

  return {
    period: { from, to },
    totalDeliveries: total,
    deliveredCount: delivered,
    failedCount: failed,
    failedDeliveriesAvoided: ops.failureAvoided.count,
    failedDeliveriesAvoidedRate: ops.failureAvoided.rate,
    avgGeofenceDwellSeconds: ops.dwell.avgSeconds ?? round(dwell, 1),
    avgGeofenceDwellMinutes: ops.dwell.avgMinutes ?? round(dwell / 60, 2),
    firstAttemptSuccessRate: firstTotal ? round(firstOk / firstTotal) : 0,
    firstAttemptSuccessCount: firstOk,
    firstAttemptTotal: firstTotal,
    onTimeRate: delivered ? round(onTime / delivered) : 0,
    avgAttemptsToDeliver: round(Number(attemptsRows[0]?.avg_attempts ?? 0), 2),
    activeCouriers: liveRows[0]?.couriers ?? 0,
    inGeofenceNow: ops.system.inGeofenceNow,
  };
}

export async function buildDashboard(
  agenciaId: string,
  filters: DashboardFilters,
): Promise<DashboardPayload> {
  const kpis = await kpisFor(agenciaId, filters.from, filters.to, filters.courierId);

  let previousKpis: DeliveryKpis | undefined;
  if (filters.comparePreviousPeriod) {
    const prev = previousRange(filters.from, filters.to);
    previousKpis = await kpisFor(agenciaId, prev.from, prev.to, filters.courierId);
  }

  const { rows: trendRows } = await pool.query(
    `SELECT r.fecha::text AS date,
            count(*) FILTER (WHERE p.estado = 'entregado')::int AS delivered,
            count(*) FILTER (WHERE p.first_attempt_success)::int AS first_ok,
            count(*) FILTER (WHERE p.estado IN ('entregado','ausente','reprogramado','reasignado'))::int AS first_total,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM delivery_attempts da
              WHERE da.parada_id = p.id AND da.failure_avoided
            ))::int AS avoided,
            coalesce(avg(g.dwell_seconds), 0)::float AS avg_dwell
     FROM paradas p
     JOIN rutas r ON r.id = p.ruta_id
     LEFT JOIN LATERAL (
       SELECT avg(ge.dwell_seconds) AS dwell_seconds
       FROM geofence_events ge
       WHERE ge.parada_id = p.id AND ge.dwell_seconds IS NOT NULL
     ) g ON true
     WHERE r.agencia_id = $1
       AND r.fecha BETWEEN $2::date AND $3::date
     GROUP BY r.fecha
     ORDER BY r.fecha`,
    [agenciaId, filters.from, filters.to],
  );

  const trend: KpiTrendPoint[] = trendRows.map((row) => ({
    date: row.date,
    failedDeliveriesAvoided: Number(row.avoided),
    avgGeofenceDwellMinutes: round(Number(row.avg_dwell ?? 0) / 60, 2),
    firstAttemptSuccessRate: row.first_total
      ? round(Number(row.first_ok) / Number(row.first_total))
      : 0,
    deliveredCount: Number(row.delivered),
  }));

  const { rows: deliveries } = await pool.query(
    `SELECT p.id, coalesce(p.referencia_pedido, p.id::text) AS reference,
            r.repartidor_id, rp.nombre AS courier_name, p.estado,
            p.direccion_texto, r.fecha::text AS scheduled_date,
            p.first_attempt_success, p.created_at, p.delivered_at
     FROM paradas p
     JOIN rutas r ON r.id = p.ruta_id
     JOIN repartidores rp ON rp.id = r.repartidor_id
     WHERE r.agencia_id = $1
       AND r.fecha BETWEEN $2::date AND $3::date
     ORDER BY p.updated_at DESC
     LIMIT 20`,
    [agenciaId, filters.from, filters.to],
  );

  const ids = deliveries.map((d) => d.id);
  const { rows: attemptRows } = ids.length
    ? await pool.query(
        `SELECT * FROM delivery_attempts WHERE parada_id = ANY($1::uuid[]) ORDER BY attempt_number`,
        [ids],
      )
    : { rows: [] };

  const recentDeliveries: Delivery[] = deliveries.map((d) => ({
    id: d.id,
    reference: d.reference,
    courierId: d.repartidor_id,
    courierName: d.courier_name,
    status: ESTADO_A_DELIVERY_STATUS[d.estado] ?? "pending",
    address: d.direccion_texto,
    scheduledDate: d.scheduled_date,
    firstAttemptSuccess: d.first_attempt_success,
    createdAt: new Date(d.created_at).toISOString(),
    deliveredAt: d.delivered_at ? new Date(d.delivered_at).toISOString() : undefined,
    attempts: attemptRows
      .filter((a) => a.parada_id === d.id)
      .map(
        (a): DeliveryAttempt => ({
          attemptNumber: a.attempt_number,
          startedAt: new Date(a.started_at).toISOString(),
          completedAt: a.completed_at
            ? new Date(a.completed_at).toISOString()
            : undefined,
          status: a.status,
          failureReason: a.failure_reason ?? undefined,
          failureAvoided: a.failure_avoided,
          avoidanceChannel: a.avoidance_channel ?? undefined,
          geofenceDwellSeconds: a.geofence_dwell_seconds ?? undefined,
        }),
      ),
  }));

  const { rows: live } = await pool.query(
    `SELECT coalesce(p.referencia_pedido, p.id::text) AS reference,
            p.id AS order_id,
            rp.nombre AS courier_name,
            g.dwell_started_at,
            extract(epoch FROM (now() - coalesce(g.dwell_started_at, g.timestamp)))::int AS dwell_seconds
     FROM geofence_events g
     JOIN paradas p ON p.id = g.parada_id
     JOIN rutas r ON r.id = p.ruta_id
     JOIN repartidores rp ON rp.id = r.repartidor_id
     WHERE r.agencia_id = $1
       AND g.type = 'entered'
       AND g.dwell_ended_at IS NULL
     ORDER BY g.timestamp DESC`,
    [agenciaId],
  );

  return {
    filters,
    kpis,
    previousKpis,
    trend,
    recentDeliveries,
    liveInGeofence: live.map((row) => ({
      orderId: row.order_id,
      reference: row.reference,
      courierName: row.courier_name,
      enteredAt: new Date(row.dwell_started_at ?? Date.now()).toISOString(),
      dwellSeconds: Number(row.dwell_seconds),
    })),
  };
}
