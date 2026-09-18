-- Seed de demo (Madrid centro). El hash corresponde a la api key en texto plano: demo-api-key
INSERT INTO agencias (id, nombre, cif, plan, api_key_hash, nombre_saas, telefono_soporte, email_soporte)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'Agencia Demo Madrid',
  'B00000000',
  'pro',
  encode(digest('demo-api-key', 'sha256'), 'hex'),
  'RutaCerca',
  '+34911222333',
  'soporte@rutacerca.es'
);

INSERT INTO repartidores (id, agencia_id, codigo, nombre, telefono, vehiculo, matricula, activo)
VALUES (
  '22222222-2222-2222-2222-222222222222',
  '11111111-1111-1111-1111-111111111111',
  'repartidor_001',
  'Lucía Pérez',
  '+34600000001',
  'furgoneta',
  '1234-LCS',
  true
);

INSERT INTO puntos_recogida (id, agencia_id, nombre, ubicacion, horario, capacidad_diaria)
VALUES (
  '33333333-3333-3333-3333-333333333333',
  '11111111-1111-1111-1111-111111111111',
  'Punto Recogida Sol',
  ST_SetSRID(ST_MakePoint(-3.7038, 40.4168), 4326)::geography,
  '{"lunes_viernes": "09:00-20:00"}'::jsonb,
  80
);

INSERT INTO rutas (id, agencia_id, repartidor_id, fecha, estado, orden_paradas)
VALUES (
  '44444444-4444-4444-4444-444444444444',
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  CURRENT_DATE,
  'en_curso',
  '["55555555-5555-5555-5555-555555555551","55555555-5555-5555-5555-555555555552","55555555-5555-5555-5555-555555555553","55555555-5555-5555-5555-555555555554"]'::jsonb
);

INSERT INTO paradas (
  id, ruta_id, orden, referencia_pedido, cliente_nombre, receptor_nombre,
  cliente_telefono, direccion_texto, ubicacion, geocerca_radio_m, estado,
  first_attempt_success, delivered_at, on_time
) VALUES
(
  '55555555-5555-5555-5555-555555555551',
  '44444444-4444-4444-4444-444444444444',
  1, 'ORD-ALCALA-001', 'Cliente 1', 'Cliente 1',
  '+34611111111', 'Calle de Alcalá 1, Madrid',
  ST_SetSRID(ST_MakePoint(-3.6995, 40.4180), 4326)::geography, 150, 'entregado',
  true, now() - interval '40 minutes', true
),
(
  '55555555-5555-5555-5555-555555555552',
  '44444444-4444-4444-4444-444444444444',
  2, 'ORD-TEST-001', 'Cliente 2', 'Cliente 2',
  '+34611111112', 'Puerta del Sol, Madrid',
  ST_SetSRID(ST_MakePoint(-3.703790, 40.416775), 4326)::geography, 600, 'pendiente',
  false, NULL, NULL
),
(
  '55555555-5555-5555-5555-555555555553',
  '44444444-4444-4444-4444-444444444444',
  3, 'ORD-ESPANA-003', 'Cliente 3', 'Cliente 3',
  '+34611111113', 'Plaza de España, Madrid',
  ST_SetSRID(ST_MakePoint(-3.7122, 40.4233), 4326)::geography, 150, 'pendiente',
  false, NULL, NULL
),
(
  '55555555-5555-5555-5555-555555555554',
  '44444444-4444-4444-4444-444444444444',
  4, 'ORD-DEBOD-004', 'Santiago Demo', 'Santiago Demo',
  '+34611111114', 'Templo de Debod, Madrid',
  ST_SetSRID(ST_MakePoint(-3.7178, 40.4240), 4326)::geography, 150, 'pendiente',
  false, NULL, NULL
);

INSERT INTO delivery_attempts (
  parada_id, attempt_number, started_at, completed_at, status, failure_avoided, avoidance_channel
) VALUES (
  '55555555-5555-5555-5555-555555555551',
  1,
  now() - interval '55 minutes',
  now() - interval '40 minutes',
  'delivered',
  true,
  'whatsapp'
);
