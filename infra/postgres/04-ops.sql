-- Optimización y monitoreo: logs, alertas, jobs de notificación y dwell/failure avoided.
-- Idempotente: se puede reaplicar en arranque de API/workers y en volúmenes ya inicializados.

ALTER TABLE delivery_attempts
  ADD COLUMN IF NOT EXISTS dwell_seconds INT,
  ADD COLUMN IF NOT EXISTS dwell_closed_by TEXT,
  ADD COLUMN IF NOT EXISTS geofence_entered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failure_avoided_candidate BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approach_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recipient_status TEXT NOT NULL DEFAULT 'pending';

DO $$
BEGIN
  ALTER TABLE delivery_attempts DROP CONSTRAINT IF EXISTS delivery_attempts_status_check;
  ALTER TABLE delivery_attempts
    ADD CONSTRAINT delivery_attempts_status_check
    CHECK (status IN ('open', 'delivered', 'failed', 'rescheduled'));

  ALTER TABLE delivery_attempts DROP CONSTRAINT IF EXISTS delivery_attempts_dwell_closed_by_check;
  ALTER TABLE delivery_attempts
    ADD CONSTRAINT delivery_attempts_dwell_closed_by_check
    CHECK (dwell_closed_by IS NULL OR dwell_closed_by IN ('delivered', 'exited'));

  ALTER TABLE delivery_attempts DROP CONSTRAINT IF EXISTS delivery_attempts_recipient_status_check;
  ALTER TABLE delivery_attempts
    ADD CONSTRAINT delivery_attempts_recipient_status_check
    CHECK (recipient_status IN ('pending', 'confirmed', 'rescheduled', 'absent'));
END $$;

UPDATE delivery_attempts
SET dwell_seconds = geofence_dwell_seconds
WHERE dwell_seconds IS NULL AND geofence_dwell_seconds IS NOT NULL;

UPDATE delivery_attempts
SET dwell_closed_by = 'delivered'
WHERE status = 'delivered'
  AND coalesce(dwell_seconds, geofence_dwell_seconds) IS NOT NULL
  AND dwell_closed_by IS NULL;

UPDATE delivery_attempts
SET failure_avoided_candidate = true
WHERE failure_avoided = true AND failure_avoided_candidate = false;

UPDATE delivery_attempts
SET geofence_entered_at = coalesce(geofence_entered_at, started_at)
WHERE status IN ('delivered', 'failed', 'rescheduled')
  AND coalesce(dwell_seconds, geofence_dwell_seconds) IS NOT NULL
  AND geofence_entered_at IS NULL;

-- Demo: permanencia cerrada en la entrega seed (fallo evitado).
UPDATE delivery_attempts
SET dwell_seconds = coalesce(dwell_seconds, 900),
    geofence_dwell_seconds = coalesce(geofence_dwell_seconds, 900),
    dwell_closed_by = coalesce(dwell_closed_by, 'delivered'),
    geofence_entered_at = coalesce(geofence_entered_at, started_at),
    failure_avoided_candidate = true
WHERE parada_id = '55555555-5555-5555-5555-555555555551';

CREATE TABLE IF NOT EXISTS notification_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  parada_id UUID REFERENCES paradas(id) ON DELETE CASCADE,
  order_id TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'call', 'app')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'skipped', 'retry')),
  next_retry_at TIMESTAMPTZ,
  error_code TEXT,
  fallback_of_job_id UUID REFERENCES notification_jobs(id) ON DELETE SET NULL,
  next_channel TEXT CHECK (
    next_channel IS NULL OR next_channel IN ('whatsapp', 'sms', 'call', 'app')
  ),
  dedupe_key TEXT,
  attempt_number INT,
  correlation_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_notification_jobs_status_retry
  ON notification_jobs (status, (coalesce(next_retry_at, created_at)));
CREATE INDEX IF NOT EXISTS idx_notification_jobs_parada
  ON notification_jobs (parada_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_jobs_created
  ON notification_jobs (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_notification_jobs_active_dedupe
  ON notification_jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'sent', 'retry');

CREATE TABLE IF NOT EXISTS ops_logs (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  category TEXT NOT NULL CHECK (
    category IN (
      'webhook',
      'delivery_status',
      'notification_fallback',
      'geofence',
      'tracking_token',
      'system'
    )
  ),
  event TEXT NOT NULL,
  order_id TEXT,
  attempt_number INT,
  correlation_id TEXT NOT NULL,
  actor TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  duration_ms INT
);

CREATE INDEX IF NOT EXISTS idx_ops_logs_created ON ops_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_logs_category_created ON ops_logs (category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_logs_order_created ON ops_logs (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_logs_correlation ON ops_logs (correlation_id);

CREATE TABLE IF NOT EXISTS ops_alerts (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  order_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ack', 'resolved')),
  resolved_at TIMESTAMPTZ,
  dedupe_key TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ops_alerts_status_created ON ops_alerts (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_alerts_code ON ops_alerts (code, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ops_alerts_open_dedupe
  ON ops_alerts (code, dedupe_key)
  WHERE status = 'open';

-- Consentimiento por parada (NULL = no consta → el worker no envía ese canal).
ALTER TABLE paradas
  ADD COLUMN IF NOT EXISTS consent_whatsapp BOOLEAN,
  ADD COLUMN IF NOT EXISTS consent_sms BOOLEAN,
  ADD COLUMN IF NOT EXISTS consent_push BOOLEAN;

-- Demo seed: el destinatario de las paradas de Madrid acepta WA + SMS + push.
UPDATE paradas
SET consent_whatsapp = COALESCE(consent_whatsapp, true),
    consent_sms = COALESCE(consent_sms, true),
    consent_push = COALESCE(consent_push, true)
WHERE id IN (
  '55555555-5555-5555-5555-555555555551',
  '55555555-5555-5555-5555-555555555552',
  '55555555-5555-5555-5555-555555555553',
  '55555555-5555-5555-5555-555555555554'
);
