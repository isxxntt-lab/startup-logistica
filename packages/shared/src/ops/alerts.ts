import {
  OPS_CLIENT_RESPONSE_DELAY_MINUTES_DEFAULT,
  OPS_DWELL_ANOMALY_MINUTES,
  OPS_FAIL_RATE_MIN_JOBS,
  OPS_FAIL_RATE_THRESHOLD,
  OPS_FAIL_RATE_WINDOW_MINUTES,
  OPS_STUCK_JOB_MINUTES,
  OPS_WEBHOOK_SPIKE_THRESHOLD,
  OPS_WEBHOOK_SPIKE_WINDOW_MINUTES,
  type OpsAlertCandidate,
  type SqlClient,
} from "./types.js";

export interface EvaluateOpsAlertsOptions {
  now?: Date;
  clientResponseDelayMinutes?: number;
}

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function windowBucket(now: Date, windowMinutes: number): string {
  const ms = windowMinutes * 60_000;
  return String(Math.floor(now.getTime() / ms) * ms);
}

export async function evaluateOpsAlerts(
  db: SqlClient,
  opts: EvaluateOpsAlertsOptions = {},
): Promise<OpsAlertCandidate[]> {
  const now = opts.now ?? new Date();
  const delayMin =
    opts.clientResponseDelayMinutes ??
    Number(process.env.OPS_CLIENT_RESPONSE_DELAY_MINUTES ?? OPS_CLIENT_RESPONSE_DELAY_MINUTES_DEFAULT);
  const alerts: OpsAlertCandidate[] = [];

  const stuck = await db.query<{
    id: string;
    order_id: string | null;
    parada_id: string | null;
    created_at: string;
    next_retry_at: string | null;
    channel: string;
    status: string;
  }>(
    `SELECT id::text, order_id, parada_id::text, created_at::text, next_retry_at::text,
            channel, status
     FROM notification_jobs
     WHERE status IN ('pending', 'retry')
       AND coalesce(next_retry_at, created_at) < $1::timestamptz - ($2 || ' minutes')::interval`,
    [now.toISOString(), String(OPS_STUCK_JOB_MINUTES)],
  );

  for (const job of stuck.rows) {
    const orderId = job.order_id ?? job.parada_id;
    alerts.push({
      severity: "warning",
      code: "BG_JOB_STUCK",
      title: "Job de notificación atascado",
      message: `El job ${job.id} lleva más de ${OPS_STUCK_JOB_MINUTES} min en ${job.status} (${job.channel}).`,
      orderId,
      payload: {
        jobId: job.id,
        channel: job.channel,
        createdAt: job.created_at,
        nextRetryAt: job.next_retry_at,
      },
      dedupeKey: orderId ?? job.id,
    });
  }

  const failRate = await db.query<{ total: number; failed: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'failed')::int AS failed
     FROM notification_jobs
     WHERE coalesce(updated_at, created_at) >= $1::timestamptz - ($2 || ' minutes')::interval`,
    [now.toISOString(), String(OPS_FAIL_RATE_WINDOW_MINUTES)],
  );
  const total = num(failRate.rows[0]?.total);
  const failed = num(failRate.rows[0]?.failed);
  const rate = total > 0 ? failed / total : 0;
  if (total >= OPS_FAIL_RATE_MIN_JOBS && rate > OPS_FAIL_RATE_THRESHOLD) {
    const bucket = windowBucket(now, OPS_FAIL_RATE_WINDOW_MINUTES);
    alerts.push({
      severity: "critical",
      code: "BG_JOB_FAIL_RATE",
      title: "Tasa de fallo de notificaciones alta",
      message: `${Math.round(rate * 100)}% de jobs fallidos (${failed}/${total}) en ${OPS_FAIL_RATE_WINDOW_MINUTES} min.`,
      payload: { total, failed, rate, windowMinutes: OPS_FAIL_RATE_WINDOW_MINUTES },
      dedupeKey: `window:${bucket}`,
    });
  }

  const exhausted = await db.query<{
    id: string;
    order_id: string | null;
    parada_id: string | null;
    channel: string;
    error_code: string | null;
  }>(
    `SELECT id::text, order_id, parada_id::text, channel, error_code
     FROM notification_jobs
     WHERE status = 'failed'
       AND next_channel IS NULL
       AND coalesce(updated_at, created_at) >= $1::timestamptz - interval '24 hours'`,
    [now.toISOString()],
  );
  for (const job of exhausted.rows) {
    const orderId = job.order_id ?? job.parada_id;
    alerts.push({
      severity: "critical",
      code: "FALLBACK_CHAIN_EXHAUSTED",
      title: "Cadena de fallback agotada",
      message: `El job ${job.id} falló en ${job.channel} sin canal siguiente.`,
      orderId,
      payload: { jobId: job.id, channel: job.channel, errorCode: job.error_code },
      dedupeKey: orderId ?? job.id,
    });
  }

  const delays = await db.query<{
    id: string;
    order_id: string | null;
    parada_id: string;
    approach_notified_at: string;
    wait_minutes: number;
  }>(
    `SELECT da.id::text,
            coalesce(p.referencia_pedido, p.id::text) AS order_id,
            p.id::text AS parada_id,
            da.approach_notified_at::text,
            (extract(epoch FROM ($1::timestamptz - da.approach_notified_at)) / 60)::int AS wait_minutes
     FROM delivery_attempts da
     JOIN paradas p ON p.id = da.parada_id
     WHERE da.status = 'open'
       AND da.recipient_status = 'pending'
       AND da.approach_notified_at IS NOT NULL
       AND da.approach_notified_at < $1::timestamptz - ($2 || ' minutes')::interval
       AND p.estado NOT IN ('confirmado', 'reprogramado', 'reasignado', 'entregado', 'ausente')`,
    [now.toISOString(), String(delayMin)],
  );
  for (const row of delays.rows) {
    alerts.push({
      severity: "warning",
      code: "CLIENT_RESPONSE_DELAY",
      title: "Cliente sin respuesta tras aviso de proximidad",
      message: `Pedido ${row.order_id} lleva ${row.wait_minutes} min sin confirmar ni reprogramar.`,
      orderId: row.order_id,
      payload: {
        attemptId: row.id,
        paradaId: row.parada_id,
        approachNotifiedAt: row.approach_notified_at,
        waitMinutes: row.wait_minutes,
        thresholdMinutes: delayMin,
      },
      dedupeKey: row.order_id ?? row.parada_id,
    });
  }

  const spike = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM ops_logs
     WHERE category = 'webhook'
       AND level = 'error'
       AND created_at >= $1::timestamptz - ($2 || ' minutes')::interval`,
    [now.toISOString(), String(OPS_WEBHOOK_SPIKE_WINDOW_MINUTES)],
  );
  const webhookErrors = num(spike.rows[0]?.n);
  if (webhookErrors > OPS_WEBHOOK_SPIKE_THRESHOLD) {
    const bucket = windowBucket(now, OPS_WEBHOOK_SPIKE_WINDOW_MINUTES);
    alerts.push({
      severity: "critical",
      code: "WEBHOOK_ERROR_SPIKE",
      title: "Pico de errores de webhook",
      message: `${webhookErrors} webhooks en error en ${OPS_WEBHOOK_SPIKE_WINDOW_MINUTES} min.`,
      payload: { errors: webhookErrors, windowMinutes: OPS_WEBHOOK_SPIKE_WINDOW_MINUTES },
      dedupeKey: `window:${bucket}`,
    });
  }

  const dwell = await db.query<{
    id: string;
    order_id: string | null;
    parada_id: string;
    open_seconds: number;
  }>(
    `SELECT da.id::text,
            coalesce(p.referencia_pedido, p.id::text) AS order_id,
            p.id::text AS parada_id,
            extract(epoch FROM ($1::timestamptz - da.geofence_entered_at))::int AS open_seconds
     FROM delivery_attempts da
     JOIN paradas p ON p.id = da.parada_id
     WHERE da.geofence_entered_at IS NOT NULL
       AND da.dwell_closed_by IS NULL
       AND da.geofence_entered_at < $1::timestamptz - ($2 || ' minutes')::interval`,
    [now.toISOString(), String(OPS_DWELL_ANOMALY_MINUTES)],
  );
  for (const row of dwell.rows) {
    alerts.push({
      severity: "warning",
      code: "DWELL_ANOMALY",
      title: "Permanencia en geocerca anómala",
      message: `Pedido ${row.order_id} lleva ${Math.round(row.open_seconds / 60)} min en geocerca sin cierre.`,
      orderId: row.order_id,
      payload: {
        attemptId: row.id,
        paradaId: row.parada_id,
        openSeconds: row.open_seconds,
        thresholdMinutes: OPS_DWELL_ANOMALY_MINUTES,
      },
      dedupeKey: row.order_id ?? row.parada_id,
    });
  }

  return alerts;
}

export async function persistOpsAlerts(
  db: SqlClient,
  candidates: OpsAlertCandidate[],
): Promise<{ opened: number; skipped: number }> {
  let opened = 0;
  let skipped = 0;
  for (const alert of candidates) {
    const result = await db.query(
      `INSERT INTO ops_alerts (
         severity, code, title, message, order_id, payload, status, dedupe_key
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,'open',$7)
       ON CONFLICT (code, dedupe_key) WHERE status = 'open' DO NOTHING
       RETURNING id`,
      [
        alert.severity,
        alert.code,
        alert.title,
        alert.message,
        alert.orderId ?? null,
        JSON.stringify(alert.payload ?? {}),
        alert.dedupeKey,
      ],
    );
    if (result.rows[0]) opened += 1;
    else skipped += 1;
  }
  return { opened, skipped };
}

export async function runOpsChecks(
  db: SqlClient,
  opts: EvaluateOpsAlertsOptions = {},
): Promise<{ evaluated: number; opened: number; skipped: number; alerts: OpsAlertCandidate[] }> {
  const alerts = await evaluateOpsAlerts(db, opts);
  const persisted = await persistOpsAlerts(db, alerts);
  return {
    evaluated: alerts.length,
    opened: persisted.opened,
    skipped: persisted.skipped,
    alerts,
  };
}
