ALTER TABLE agencias ADD COLUMN IF NOT EXISTS nombre_saas TEXT NOT NULL DEFAULT 'RutaCerca';
ALTER TABLE agencias ADD COLUMN IF NOT EXISTS telefono_soporte TEXT NOT NULL DEFAULT '+34900000000';
ALTER TABLE agencias ADD COLUMN IF NOT EXISTS email_soporte TEXT NOT NULL DEFAULT 'soporte@rutacerca.es';

ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS codigo TEXT;
ALTER TABLE repartidores ADD COLUMN IF NOT EXISTS matricula TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_repartidores_codigo ON repartidores (codigo) WHERE codigo IS NOT NULL;

ALTER TABLE paradas ADD COLUMN IF NOT EXISTS referencia_pedido TEXT;
ALTER TABLE paradas ADD COLUMN IF NOT EXISTS receptor_nombre TEXT;
ALTER TABLE paradas ADD COLUMN IF NOT EXISTS enlace_pod TEXT;
ALTER TABLE paradas ADD COLUMN IF NOT EXISTS first_attempt_success BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE paradas ADD COLUMN IF NOT EXISTS on_time BOOLEAN;
ALTER TABLE paradas ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE paradas ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS location_pings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repartidor_id UUID NOT NULL REFERENCES repartidores(id) ON DELETE CASCADE,
  parada_id UUID REFERENCES paradas(id) ON DELETE SET NULL,
  order_id TEXT,
  captured_at TIMESTAMPTZ NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  accuracy_m DOUBLE PRECISION,
  altitude_m DOUBLE PRECISION,
  heading_deg DOUBLE PRECISION,
  speed_mps DOUBLE PRECISION,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS geofence_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parada_id UUID NOT NULL REFERENCES paradas(id) ON DELETE CASCADE,
  repartidor_id UUID NOT NULL REFERENCES repartidores(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('entered', 'exited', 'at_delivery')),
  radius_m INT NOT NULL,
  distance_m DOUBLE PRECISION NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  dwell_started_at TIMESTAMPTZ,
  dwell_ended_at TIMESTAMPTZ,
  dwell_seconds INT
);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parada_id UUID NOT NULL REFERENCES paradas(id) ON DELETE CASCADE,
  attempt_number INT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('delivered', 'failed', 'rescheduled')),
  failure_reason TEXT,
  failure_avoided BOOLEAN NOT NULL DEFAULT false,
  avoidance_channel TEXT,
  geofence_dwell_seconds INT
);

CREATE INDEX IF NOT EXISTS idx_paradas_referencia ON paradas (referencia_pedido);
CREATE INDEX IF NOT EXISTS idx_location_pings_repartidor ON location_pings (repartidor_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_geofence_events_parada ON geofence_events (parada_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_attempts_parada ON delivery_attempts (parada_id, attempt_number);

UPDATE agencias
SET nombre_saas = 'RutaCerca',
    telefono_soporte = '+34911222333',
    email_soporte = 'soporte@rutacerca.es'
WHERE id = '11111111-1111-1111-1111-111111111111';

UPDATE repartidores
SET codigo = 'repartidor_001',
    matricula = '1234-LCS'
WHERE id = '22222222-2222-2222-2222-222222222222';

UPDATE paradas SET referencia_pedido = 'ORD-ALCALA-001', receptor_nombre = 'Cliente 1'
WHERE id = '55555555-5555-5555-5555-555555555551';

UPDATE paradas
SET referencia_pedido = 'ORD-TEST-001',
    receptor_nombre = 'Cliente 2',
    cliente_nombre = 'Cliente 2',
    direccion_texto = 'Puerta del Sol, Madrid',
    ubicacion = ST_SetSRID(ST_MakePoint(-3.703790, 40.416775), 4326)::geography,
    geocerca_radio_m = 600,
    estado = 'pendiente',
    token_acceso = NULL,
    token_expira_at = NULL
WHERE id = '55555555-5555-5555-5555-555555555552';

UPDATE paradas SET referencia_pedido = 'ORD-ESPANA-003', receptor_nombre = 'Cliente 3'
WHERE id = '55555555-5555-5555-5555-555555555553';

INSERT INTO delivery_attempts (
  parada_id, attempt_number, started_at, completed_at, status, failure_avoided, avoidance_channel
)
SELECT
  p.id,
  1,
  now() - interval '55 minutes',
  now() - interval '40 minutes',
  'delivered',
  true,
  'whatsapp'
FROM paradas p
WHERE p.id = '55555555-5555-5555-5555-555555555551'
  AND NOT EXISTS (
    SELECT 1 FROM delivery_attempts da
    WHERE da.parada_id = p.id AND da.attempt_number = 1
  );

UPDATE paradas
SET first_attempt_success = true,
    delivered_at = coalesce(delivered_at, now() - interval '40 minutes'),
    on_time = true
WHERE id = '55555555-5555-5555-5555-555555555551';
