import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import {
  applyOpsSchema,
  evaluateOpsAlerts,
  getOpsMetrics,
  initOps,
  logOps,
  persistOpsAlerts,
  runOpsChecks,
  sanitizeOpsPayload,
  withCorrelation,
} from "@startup-logistica/shared";

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://logistica:logistica@localhost:5432/startup_logistica",
});

const RUTA = "44444444-4444-4444-4444-444444444444";
const PARADA_STUCK = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1";
const PARADA_DELAY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2";
const PARADA_METRICS = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3";

before(async () => {
  initOps(pool);
  await applyOpsSchema(pool);
  await pool.query(
    `INSERT INTO paradas (
       id, ruta_id, orden, referencia_pedido, cliente_nombre, cliente_telefono,
       direccion_texto, ubicacion, estado
     ) VALUES
       ($1, $4, 90, 'ORD-OPS-STUCK', 'Ops Stuck', '+34600000901',
        'Test stuck', ST_SetSRID(ST_MakePoint(-3.7, 40.4), 4326)::geography, 'notificado'),
       ($2, $4, 91, 'ORD-OPS-DELAY', 'Ops Delay', '+34600000902',
        'Test delay', ST_SetSRID(ST_MakePoint(-3.7, 40.4), 4326)::geography, 'notificado'),
       ($3, $4, 92, 'ORD-OPS-METRICS', 'Ops Metrics', '+34600000903',
        'Test metrics', ST_SetSRID(ST_MakePoint(-3.7, 40.4), 4326)::geography, 'entregado')
     ON CONFLICT (ruta_id, orden) DO UPDATE SET referencia_pedido = EXCLUDED.referencia_pedido`,
    [PARADA_STUCK, PARADA_DELAY, PARADA_METRICS, RUTA],
  );
});

after(async () => {
  await pool.query(
    `DELETE FROM ops_alerts WHERE order_id IN ('ORD-OPS-STUCK', 'ORD-OPS-DELAY', 'ORD-OPS-METRICS', $1, $2, $3)`,
    [PARADA_STUCK, PARADA_DELAY, PARADA_METRICS],
  );
  await pool.query(
    `DELETE FROM ops_logs WHERE order_id IN ('ORD-OPS-FALLBACK', 'ORD-OPS-STUCK', 'ORD-OPS-DELAY', 'ORD-OPS-METRICS')`,
  );
  await pool.query(
    `DELETE FROM notification_jobs WHERE parada_id IN ($1, $2, $3)`,
    [PARADA_STUCK, PARADA_DELAY, PARADA_METRICS],
  );
  await pool.query(
    `DELETE FROM delivery_attempts WHERE parada_id IN ($1, $2, $3)`,
    [PARADA_STUCK, PARADA_DELAY, PARADA_METRICS],
  );
  await pool.query(`DELETE FROM paradas WHERE id IN ($1, $2, $3)`, [
    PARADA_STUCK,
    PARADA_DELAY,
    PARADA_METRICS,
  ]);
  await pool.end();
});

test("log de fallback persiste channel, error_code, next_channel y correlation_id", async () => {
  const correlationId = await withCorrelation(async (id) => {
    await logOps({
      level: "warn",
      category: "notification_fallback",
      event: "notification.fallback",
      orderId: "ORD-OPS-FALLBACK",
      actor: "worker",
      payload: {
        channel: "whatsapp",
        error_code: "TWILIO_30006",
        next_channel: "sms",
        dedupe_key: "ops-fallback-test",
        status: "failed",
        token: "super-secret-token-value",
      },
    });
    return id;
  }, "corr-fallback-test");

  const { rows } = await pool.query<{
    correlation_id: string;
    payload: Record<string, unknown>;
    event: string;
  }>(
    `SELECT correlation_id, payload, event
     FROM ops_logs
     WHERE order_id = 'ORD-OPS-FALLBACK' AND event = 'notification.fallback'
     ORDER BY created_at DESC LIMIT 1`,
  );
  assert.equal(rows[0]?.correlation_id, correlationId);
  assert.equal(rows[0]?.payload.channel, "whatsapp");
  assert.equal(rows[0]?.payload.error_code, "TWILIO_30006");
  assert.equal(rows[0]?.payload.next_channel, "sms");
  assert.equal(rows[0]?.payload.status, "failed");
  assert.notEqual(rows[0]?.payload.token, "super-secret-token-value");
  const sanitized = sanitizeOpsPayload({ token: "abc123secret" });
  assert.equal((sanitized.token as { tokenHash: string }).tokenHash.length, 16);
});

test("alerta BG_JOB_STUCK y CLIENT_RESPONSE_DELAY; persistencia idempotente", async () => {
  await pool.query(
    `INSERT INTO notification_jobs (
       parada_id, order_id, channel, status, created_at, next_retry_at, dedupe_key
     ) VALUES ($1, 'ORD-OPS-STUCK', 'whatsapp', 'pending', now() - interval '20 minutes',
               now() - interval '18 minutes', 'stuck-ops-test')`,
    [PARADA_STUCK],
  );
  await pool.query(
    `INSERT INTO delivery_attempts (
       parada_id, attempt_number, started_at, status, approach_notified_at,
       geofence_entered_at, recipient_status, failure_avoided_candidate
     ) VALUES ($1, 1, now() - interval '40 minutes', 'open', now() - interval '25 minutes',
               now() - interval '30 minutes', 'pending', true)`,
    [PARADA_DELAY],
  );

  const alerts = await evaluateOpsAlerts(pool);
  const stuck = alerts.filter((a) => a.code === "BG_JOB_STUCK" && a.orderId === "ORD-OPS-STUCK");
  const delay = alerts.filter(
    (a) => a.code === "CLIENT_RESPONSE_DELAY" && a.orderId === "ORD-OPS-DELAY",
  );
  assert.equal(stuck.length, 1);
  assert.equal(delay.length, 1);

  const first = await persistOpsAlerts(pool, [...stuck, ...delay]);
  const second = await persistOpsAlerts(pool, [...stuck, ...delay]);
  assert.ok(first.opened >= 2);
  assert.equal(second.opened, 0);
  assert.equal(second.skipped, 2);

  const checks = await runOpsChecks(pool);
  assert.ok(checks.skipped >= 2);
});

test("metrics incluye failureAvoided y dwell", async () => {
  await pool.query(
    `INSERT INTO delivery_attempts (
       parada_id, attempt_number, started_at, completed_at, status,
       failure_avoided, failure_avoided_candidate, avoidance_channel,
       dwell_seconds, geofence_dwell_seconds, dwell_closed_by, geofence_entered_at
     ) VALUES (
       $1, 1, now() - interval '50 minutes', now() - interval '35 minutes', 'delivered',
       true, true, 'whatsapp', 840, 840, 'delivered', now() - interval '50 minutes'
     )`,
    [PARADA_METRICS],
  );

  const metrics = await getOpsMetrics(pool, {
    from: new Date(Date.now() - 24 * 3600_000).toISOString(),
    to: new Date().toISOString(),
  });

  assert.ok(metrics.failureAvoided.count >= 1);
  assert.ok(metrics.failureAvoided.rate >= 0);
  assert.ok(metrics.failureAvoided.candidates >= 1);
  assert.ok(metrics.dwell.avgSeconds !== null && metrics.dwell.avgSeconds > 0);
  assert.ok(metrics.dwell.avgMinutes !== null);
  assert.ok((metrics.dwell.closedByDelivered ?? 0) >= 1);
  assert.equal(typeof metrics.system.inGeofenceNow, "number");
  assert.equal(typeof metrics.system.healthy, "boolean");
  assert.ok(metrics.generatedAt);
});
