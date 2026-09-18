import type { OpsHealth, OpsMetrics, SqlClient } from "./types.js";
import { OPS_STUCK_JOB_MINUTES } from "./types.js";

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function round(n: number, digits = 2): number {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function nullableNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface OpsMetricsRange {
  from?: string;
  to?: string;
  agenciaId?: string;
}

function defaultRange(range: OpsMetricsRange = {}): { from: string; to: string } {
  const to = range.to ? new Date(range.to) : new Date();
  const from = range.from
    ? new Date(range.from)
    : new Date(to.getTime() - 24 * 60 * 60_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function agenciaClause(aliasRuta = "r"): string {
  return `($3::uuid IS NULL OR ${aliasRuta}.agencia_id = $3::uuid)`;
}

export async function getOpsMetrics(
  db: SqlClient,
  range: OpsMetricsRange = {},
): Promise<OpsMetrics> {
  const { from, to } = defaultRange(range);
  const agenciaId = range.agenciaId ?? null;
  const params = [from, to, agenciaId];

  const system = await db.query<{
    open_alerts: number;
    pending_jobs: number;
    stuck_jobs: number;
    in_geofence: number;
    open_critical: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM ops_alerts WHERE status = 'open') AS open_alerts,
       (SELECT count(*)::int FROM ops_alerts WHERE status = 'open' AND severity = 'critical') AS open_critical,
       (SELECT count(*)::int FROM notification_jobs WHERE status IN ('pending', 'retry')) AS pending_jobs,
       (SELECT count(*)::int
          FROM notification_jobs
         WHERE status IN ('pending', 'retry')
           AND coalesce(next_retry_at, created_at) < now() - ($4 || ' minutes')::interval
       ) AS stuck_jobs,
       (SELECT count(*)::int
          FROM delivery_attempts da
          JOIN paradas p ON p.id = da.parada_id
          JOIN rutas r ON r.id = p.ruta_id
         WHERE da.geofence_entered_at IS NOT NULL
           AND da.dwell_closed_by IS NULL
           AND ${agenciaClause()}
           AND $1::timestamptz IS NOT NULL
           AND $2::timestamptz IS NOT NULL
       ) AS in_geofence`,
    [from, to, agenciaId, String(OPS_STUCK_JOB_MINUTES)],
  );

  const avoided = await db.query<{
    avoided: number;
    failed: number;
    candidates: number;
    confirmed_failed: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE da.failure_avoided)::int AS avoided,
       count(*) FILTER (WHERE da.status = 'failed')::int AS failed,
       count(*) FILTER (WHERE da.failure_avoided_candidate)::int AS candidates,
       count(*) FILTER (WHERE da.failure_avoided_candidate AND da.status = 'failed')::int AS confirmed_failed
     FROM delivery_attempts da
     JOIN paradas p ON p.id = da.parada_id
     JOIN rutas r ON r.id = p.ruta_id
     WHERE coalesce(da.completed_at, da.started_at) >= $1::timestamptz
       AND coalesce(da.completed_at, da.started_at) <= $2::timestamptz
       AND ${agenciaClause()}`,
    params,
  );

  const dwell = await db.query<{
    avg_seconds: number | null;
    p50_seconds: number | null;
    p95_seconds: number | null;
    closed_delivered: number;
    closed_exited: number;
  }>(
    `SELECT
       avg(secs) AS avg_seconds,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) AS p50_seconds,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY secs) AS p95_seconds,
       count(*) FILTER (WHERE closed_by = 'delivered')::int AS closed_delivered,
       count(*) FILTER (WHERE closed_by = 'exited')::int AS closed_exited
     FROM (
       SELECT coalesce(da.dwell_seconds, da.geofence_dwell_seconds)::float AS secs,
              da.dwell_closed_by AS closed_by
       FROM delivery_attempts da
       JOIN paradas p ON p.id = da.parada_id
       JOIN rutas r ON r.id = p.ruta_id
       WHERE coalesce(da.dwell_seconds, da.geofence_dwell_seconds) IS NOT NULL
         AND coalesce(da.completed_at, da.started_at, da.geofence_entered_at) >= $1::timestamptz
         AND coalesce(da.completed_at, da.started_at, da.geofence_entered_at) <= $2::timestamptz
         AND ${agenciaClause()}
     ) t`,
    params,
  );

  const notif = await db.query<{
    sent: number;
    failed: number;
    skipped: number;
    fallbacks: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE nj.status = 'sent')::int AS sent,
       count(*) FILTER (WHERE nj.status = 'failed')::int AS failed,
       count(*) FILTER (WHERE nj.status = 'skipped')::int AS skipped,
       count(*) FILTER (WHERE nj.fallback_of_job_id IS NOT NULL AND nj.status = 'sent')::int AS fallbacks
     FROM notification_jobs nj
     LEFT JOIN paradas p ON p.id = nj.parada_id
     LEFT JOIN rutas r ON r.id = p.ruta_id
     WHERE nj.created_at >= $1::timestamptz
       AND nj.created_at <= $2::timestamptz
       AND ($3::uuid IS NULL OR r.agencia_id = $3::uuid OR nj.parada_id IS NULL)`,
    params,
  );

  const avoidedCount = num(avoided.rows[0]?.avoided);
  const failedCount = num(avoided.rows[0]?.failed);
  const denom = avoidedCount + failedCount;
  const avgSeconds = nullableNum(dwell.rows[0]?.avg_seconds);
  const openAlerts = num(system.rows[0]?.open_alerts);
  const stuckJobs = num(system.rows[0]?.stuck_jobs);
  const openCritical = num(system.rows[0]?.open_critical);

  return {
    system: {
      healthy: openCritical === 0 && stuckJobs === 0,
      openAlerts,
      pendingNotificationJobs: num(system.rows[0]?.pending_jobs),
      stuckJobs,
      inGeofenceNow: num(system.rows[0]?.in_geofence),
    },
    failureAvoided: {
      count: avoidedCount,
      rate: denom ? round(avoidedCount / denom) : 0,
      candidates: num(avoided.rows[0]?.candidates),
      confirmedButFailed: num(avoided.rows[0]?.confirmed_failed),
    },
    dwell: {
      avgSeconds: avgSeconds === null ? null : round(avgSeconds, 1),
      avgMinutes: avgSeconds === null ? null : round(avgSeconds / 60, 2),
      p50Seconds: nullableNum(dwell.rows[0]?.p50_seconds),
      p95Seconds: nullableNum(dwell.rows[0]?.p95_seconds),
      closedByDelivered: num(dwell.rows[0]?.closed_delivered),
      closedByExited: num(dwell.rows[0]?.closed_exited),
    },
    notifications: {
      sent: num(notif.rows[0]?.sent),
      failed: num(notif.rows[0]?.failed),
      skipped: num(notif.rows[0]?.skipped),
      fallbacksUsed: num(notif.rows[0]?.fallbacks),
    },
    generatedAt: new Date().toISOString(),
  };
}

export async function getOpsHealth(db: SqlClient): Promise<OpsHealth> {
  const { rows } = await db.query<{ open_critical: number; stuck_jobs: number }>(
    `SELECT
       (SELECT count(*)::int FROM ops_alerts WHERE status = 'open' AND severity = 'critical') AS open_critical,
       (SELECT count(*)::int
          FROM notification_jobs
         WHERE status IN ('pending', 'retry')
           AND coalesce(next_retry_at, created_at) < now() - ($1 || ' minutes')::interval
       ) AS stuck_jobs`,
    [String(OPS_STUCK_JOB_MINUTES)],
  );
  const openCriticalAlerts = num(rows[0]?.open_critical);
  const stuckJobs = num(rows[0]?.stuck_jobs);
  return {
    ok: openCriticalAlerts === 0 && stuckJobs === 0,
    openCriticalAlerts,
    stuckJobs,
  };
}

export async function listOpsLogs(
  db: SqlClient,
  filters: { category?: string; orderId?: string; limit?: number } = {},
): Promise<Record<string, unknown>[]> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
  const { rows } = await db.query(
    `SELECT id::text, created_at, level, category, event, order_id, attempt_number,
            correlation_id, actor, payload, duration_ms
     FROM ops_logs
     WHERE ($1::text IS NULL OR category = $1)
       AND ($2::text IS NULL OR order_id = $2)
     ORDER BY created_at DESC
     LIMIT $3`,
    [filters.category ?? null, filters.orderId ?? null, limit],
  );
  return rows;
}
