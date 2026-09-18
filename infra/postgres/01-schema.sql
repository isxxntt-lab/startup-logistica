CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE agencias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre TEXT NOT NULL,
  cif TEXT UNIQUE NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
  api_key_hash TEXT NOT NULL,
  whatsapp_business_id TEXT,
  nombre_saas TEXT NOT NULL DEFAULT 'RutaCerca',
  telefono_soporte TEXT NOT NULL DEFAULT '+34900000000',
  email_soporte TEXT NOT NULL DEFAULT 'soporte@rutacerca.es',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE repartidores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agencia_id UUID NOT NULL REFERENCES agencias(id) ON DELETE CASCADE,
  codigo TEXT UNIQUE,
  nombre TEXT NOT NULL,
  telefono TEXT NOT NULL,
  vehiculo TEXT,
  matricula TEXT,
  ubicacion_actual GEOGRAPHY(Point, 4326),
  ultima_actualizacion TIMESTAMPTZ,
  device_push_token TEXT,
  activo BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE rutas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agencia_id UUID NOT NULL REFERENCES agencias(id) ON DELETE CASCADE,
  repartidor_id UUID NOT NULL REFERENCES repartidores(id),
  fecha DATE NOT NULL,
  estado TEXT NOT NULL DEFAULT 'planificada'
    CHECK (estado IN ('planificada', 'en_curso', 'finalizada')),
  hora_inicio TIMESTAMPTZ,
  hora_fin_estimada TIMESTAMPTZ,
  orden_paradas JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE puntos_recogida (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agencia_id UUID NOT NULL REFERENCES agencias(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  ubicacion GEOGRAPHY(Point, 4326) NOT NULL,
  horario JSONB NOT NULL DEFAULT '{}'::jsonb,
  capacidad_diaria INT
);

CREATE TABLE paradas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ruta_id UUID NOT NULL REFERENCES rutas(id) ON DELETE CASCADE,
  orden INT NOT NULL,
  referencia_pedido TEXT,
  cliente_nombre TEXT NOT NULL,
  cliente_telefono TEXT NOT NULL,
  direccion_texto TEXT NOT NULL,
  ubicacion GEOGRAPHY(Point, 4326) NOT NULL,
  geocerca_radio_m INT NOT NULL DEFAULT 150,
  estado TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN (
      'pendiente', 'notificado', 'confirmado', 'entregado',
      'ausente', 'reprogramado', 'reasignado'
    )),
  token_acceso TEXT UNIQUE,
  token_expira_at TIMESTAMPTZ,
  punto_recogida_id UUID REFERENCES puntos_recogida(id),
  notas_cliente TEXT,
  receptor_nombre TEXT,
  enlace_pod TEXT,
  first_attempt_success BOOLEAN NOT NULL DEFAULT false,
  on_time BOOLEAN,
  failure_reason TEXT CHECK (
    failure_reason IS NULL OR failure_reason IN (
      'recipient_absent', 'wrong_address', 'refused', 'access_issue', 'other'
    )
  ),
  delivered_at TIMESTAMPTZ,
  prueba_ausencia_foto_url TEXT,
  prueba_ausencia_gps GEOGRAPHY(Point, 4326),
  prueba_ausencia_timestamp TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ruta_id, orden)
);

CREATE TABLE eventos_notificacion (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parada_id UUID NOT NULL REFERENCES paradas(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('whatsapp', 'sms', 'push_repartidor')),
  proveedor TEXT NOT NULL CHECK (proveedor IN ('twilio', 'meta', 'fcm')),
  proveedor_message_id TEXT,
  payload_enviado JSONB,
  estado_envio TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (estado_envio IN ('pendiente', 'enviado', 'entregado', 'leido', 'fallido')),
  respuesta_cliente JSONB,
  enviado_at TIMESTAMPTZ,
  actualizado_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_paradas_ubicacion ON paradas USING GIST (ubicacion);
CREATE INDEX idx_repartidores_ubicacion ON repartidores USING GIST (ubicacion_actual);
CREATE INDEX idx_puntos_recogida_ubicacion ON puntos_recogida USING GIST (ubicacion);
CREATE INDEX idx_paradas_ruta_orden ON paradas (ruta_id, orden);
CREATE INDEX idx_paradas_token ON paradas (token_acceso);
CREATE INDEX idx_paradas_estado ON paradas (estado);
CREATE INDEX idx_repartidores_agencia ON repartidores (agencia_id);
CREATE INDEX idx_rutas_repartidor_fecha ON rutas (repartidor_id, fecha);
CREATE UNIQUE INDEX uniq_evento_proveedor_msgid
  ON eventos_notificacion (proveedor, proveedor_message_id)
  WHERE proveedor_message_id IS NOT NULL;

CREATE TABLE location_pings (
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

CREATE TABLE geofence_events (
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

CREATE TABLE delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parada_id UUID NOT NULL REFERENCES paradas(id) ON DELETE CASCADE,
  attempt_number INT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('delivered', 'failed', 'rescheduled')),
  failure_reason TEXT,
  failure_avoided BOOLEAN NOT NULL DEFAULT false,
  avoidance_channel TEXT CHECK (
    avoidance_channel IS NULL OR avoidance_channel IN ('sms', 'whatsapp', 'call', 'app')
  ),
  geofence_dwell_seconds INT
);

CREATE INDEX idx_paradas_referencia ON paradas (referencia_pedido);
CREATE INDEX idx_location_pings_repartidor ON location_pings (repartidor_id, captured_at DESC);
CREATE INDEX idx_geofence_events_parada ON geofence_events (parada_id, timestamp DESC);
CREATE INDEX idx_delivery_attempts_parada ON delivery_attempts (parada_id, attempt_number);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_paradas_updated_at
BEFORE UPDATE ON paradas
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
