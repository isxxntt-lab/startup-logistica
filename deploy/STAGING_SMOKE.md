# Smoke end-to-end de staging

Secuencia **antes de apuntar DNS público** a producción. Corre contra compose **local** (Postgres+Redis con seed) + API/workers en HTTP. **No** es el VPS de prod, **no** hay Twilio/Meta reales, **no** hay ACME/Let's Encrypt.

Grey mira el runbook y el healthcheck, no un VPS.

| Fuera de alcance | Por qué |
|---|---|
| VPS / `docker-compose.prod.yml` + Caddy | ACME real, dominios públicos, agencia sin seed |
| `TWILIO_*` / `META_*` rellenos | El worker debe ir en **dry-run** (SID+token vacíos) |
| `CONFIRM=yes` restore | El smoke solo hace backup + `PLAN=1` (no muta la base) |
| Secretos CSPRNG / `demo-api-key` en prod | Prod no monta `02-seed.sql`. Aquí se usa la clave **documentada del seed** |

Detalle de backup/restore: `deploy/BACKUP_RESTORE.md`. Orden de merge: `deploy/MERGE_ORDER.md`. Go-live: `deploy/DEPLOY_PLAN_MANANA.md`.

## Prerrequisitos

```bash
cp .env.example .env          # no commitear; no rellenar Twilio/Meta
docker compose up -d          # Postgres :5432 + Redis :6379 + seed Madrid
pnpm install
pnpm dev:api                  # http://localhost:3000
pnpm dev:workers              # consumers geocerca + notificaciones
```

Opcional: `pnpm dev:web` si quieres el SPA en `:5173`. El smoke HTTP no lo necesita.

| Pieza | Valor (seed, no es un secreto inventado) |
|---|---|
| API | `http://localhost:3000` (`STAGING_BASE`) |
| API key | `demo-api-key` (`AGENCY_API_KEY`) — hash en `infra/postgres/02-seed.sql` |
| Courier | `repartidor_001` |
| Pedido / parada | `ORD-TEST-001` / `55555555-5555-5555-5555-555555555552` (Puerta del Sol, radio **600 m**) |
| Twilio / Meta | **vacío** → dry-run (`[notif dry-run]` + `notification_jobs.status=sent`, `payload.dryRun=true`) |
| Horario | Preferible **08:00–22:00 Europe/Madrid**. De noche WA/SMS se aplazan (`QUIET_HOURS`); el smoke lo acepta |

Compose de prod **no** carga el seed: este runbook no aplica allí sin crear agencia a mano (eso es operacional en el VPS).

## Variables

| Variable | Uso |
|---|---|
| `STAGING_BASE` | Origen de la API (default del smoke: `http://localhost:3000`) |
| `STAGING_WEB` | Origen del SPA, opcional (`http://localhost:5173`) |
| `AGENCY_API_KEY` / `OPS_TOKEN` | Auth de `/api/ops/*` y pings. Local: `demo-api-key` |
| `STAGING_SMOKE=1` | Activa los pasos E2E opcionales de `scripts/prod-healthcheck.sh` |
| `ENV_FILE` | Env de Postgres para backup/`PLAN=1` (local: `.env`) |
| `STAGING_BACKUP_DUMP` | Dump existente para `PLAN=1`. Si falta, el script intenta un backup nuevo |
| `STAGING_SKIP_BACKUP=1` | Omite backup/`PLAN=1` (solo si no hay `pg_dump` / compose) |

El healthcheck **aborta** si `STAGING_SMOKE=1` y la URL es `api.rutacerca.es` o `seguimiento.rutacerca.es`.

## Secuencia

Reset de la parada de Sol (idempotente; misma SQL que `pnpm demo:geocerca`):

```bash
docker compose exec -T postgres psql -U logistica -d startup_logistica -v ON_ERROR_STOP=1 <<'SQL'
UPDATE paradas
   SET estado = 'pendiente',
       token_acceso = NULL,
       token_expira_at = NULL,
       delivered_at = NULL,
       first_attempt_success = false
 WHERE referencia_pedido = 'ORD-TEST-001';
DELETE FROM eventos_notificacion
 WHERE parada_id = '55555555-5555-5555-5555-555555555552';
DELETE FROM geofence_events
 WHERE parada_id = '55555555-5555-5555-5555-555555555552';
DELETE FROM location_pings WHERE order_id = 'ORD-TEST-001';
DELETE FROM notification_jobs
 WHERE parada_id = '55555555-5555-5555-5555-555555555552';
DELETE FROM delivery_attempts
 WHERE parada_id = '55555555-5555-5555-5555-555555555552'
   AND status = 'open';
SQL
```

Atajo solo para pings + plantilla: `pnpm demo:geocerca`. Sigue haciendo falta confirm-presence, métricas y `PLAN=1`.

### 1. Compose up

```bash
docker compose up -d
docker compose ps
```

`postgres` y `redis` **healthy**. API y workers **fuera** de este compose (ver prerrequisitos).

### 2. Health / ops

```bash
export STAGING_BASE=http://localhost:3000
export AGENCY_API_KEY=demo-api-key

curl -fsS "$STAGING_BASE/health"                 # {"ok":true}
curl -fsS "$STAGING_BASE/api/ops/health"         # ok, openCriticalAlerts, stuckJobs
curl -fsS -o /dev/null -w "%{http_code}\n" "$STAGING_BASE/repartidor/probe/ruta-hoy"
# 401

curl -fsS -H "x-api-key: $AGENCY_API_KEY" "$STAGING_BASE/api/ops/metrics"
curl -fsS -X POST -H "x-api-key: $AGENCY_API_KEY" "$STAGING_BASE/api/ops/checks"
```

Equivale a:

```bash
STAGING_BASE=http://localhost:3000 AGENCY_API_KEY=demo-api-key \
  ./scripts/prod-healthcheck.sh
```

### 3. GPS pings → geocerca

Los tres pings de `packages/shared/src/demo-pings.ts` (`GROK_LOCATION_PINGS`). El 1.º queda **fuera** (~1,2 km al norte); el 2.º entra (radio 600 m); el 3.º es Sol con `speed_mps=0` → `at_delivery`.

```bash
# 1. fuera
curl -fsS -X POST "$STAGING_BASE/events/location_update" \
  -H "Content-Type: application/json" -H "x-api-key: $AGENCY_API_KEY" \
  -d '{"event":"location_update","courier_id":"repartidor_001","order_id":"ORD-TEST-001","timestamp":"2026-09-18T14:40:00+02:00","location":{"lat":40.427555,"lng":-3.70379,"accuracy_m":12.5,"altitude_m":655.0,"heading_deg":180.0,"speed_mps":8.3}}'

# 2. entered
curl -fsS -X POST "$STAGING_BASE/events/location_update" \
  -H "Content-Type: application/json" -H "x-api-key: $AGENCY_API_KEY" \
  -d '{"event":"location_update","courier_id":"repartidor_001","order_id":"ORD-TEST-001","timestamp":"2026-09-18T14:42:30+02:00","location":{"lat":40.421267,"lng":-3.70379,"accuracy_m":8.0,"altitude_m":650.0,"heading_deg":180.0,"speed_mps":6.1}}'

# 3. at_delivery
curl -fsS -X POST "$STAGING_BASE/events/location_update" \
  -H "Content-Type: application/json" -H "x-api-key: $AGENCY_API_KEY" \
  -d '{"event":"location_update","courier_id":"repartidor_001","order_id":"ORD-TEST-001","timestamp":"2026-09-18T14:45:00+02:00","location":{"lat":40.416775,"lng":-3.70379,"accuracy_m":4.2,"altitude_m":648.0,"heading_deg":0.0,"speed_mps":0.0}}'
```

Espera ~2–8 s (worker). Logs:

```bash
curl -fsS -H "x-api-key: $AGENCY_API_KEY" \
  "$STAGING_BASE/api/ops/logs?category=geofence&orderId=ORD-TEST-001&limit=20"
```

| Evento | Esperado |
|---|---|
| `geofence.entered` | Tras el 2.º ping |
| `geofence.at_delivery` | Tras el 3.º (`speed_mps ≤ 0.5`) |
| `delivery_attempts` abierto | `geofence_entered_at` no nulo, `dwell_closed_by` nulo → `system.inGeofenceNow ≥ 1` |

`GET /repartidor/repartidor_001/ruta-hoy` **con** `x-api-key` lista la ruta del día (`Europe/Madrid`). Sin clave: **401**.

### 4. Notificación (dry-run)

Al entrar en geocerca con parada `pendiente`, el worker encola `proximidad_geocerca` / plantilla `aviso_cercania`. **Sin Twilio** el envío es dry-run: consola `[notif dry-run]`, job `sent`, `payload.dryRun=true`. La parada pasa a `notificado` y `failure_avoided_candidate=true`.

```bash
curl -fsS -H "x-api-key: $AGENCY_API_KEY" \
  "$STAGING_BASE/api/ops/logs?category=notification_fallback&orderId=ORD-TEST-001&limit=20"
```

| Situación | Log / job | ¿Pasa el smoke? |
|---|---|---|
| 08:00–22:00 Madrid, Twilio vacío | `notification.sent`, `dryRun` | Sí |
| 22:00–08:00 Madrid | `notification.deferred`, `reason=quiet_hours`, `error_code=QUIET_HOURS`, parada sigue `pendiente` | Sí (no despiertes al destinatario) |
| `TWILIO_ACCOUNT_SID` relleno | Llamada real a Twilio | **No** — vacía las vars y repetir |

No hay fallback WA→SMS de noche. Push (`app`) no aplica: el seed no trae `device_push_token`.

### 5. confirm-presence

El token **no** se pega en logs ni en tickets. Solo query/`Authorization`/body.

```bash
token_json=$(curl -fsS -X POST \
  "$STAGING_BASE/agencia/paradas/55555555-5555-5555-5555-555555555552/token" \
  -H "x-api-key: $AGENCY_API_KEY")
# url y token viven en $token_json — no hacer echo

curl -fsS -X POST "$STAGING_BASE/api/tracking/confirm-presence" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c 'import json,sys; print(json.dumps({"token": json.load(sys.stdin)["token"]}))' <<<"$token_json")"
# {"ok":true,"status":"will_be_there"}
```

Válido en `pendiente` / `notificado` / `confirmado`. Tras quiet hours la parada puede seguir `pendiente`: el POST igual vale.

Opcional SPA: abre la `url` del JSON (`http://localhost:5173/?token=…`) y **Estaré ahí**. Mismo endpoint.

`GET /api/tracking/session?token=` → `will_be_there`. `GET /api/tracking/position?token=` → coords del 3.º ping (rate-limit 30/min).

### 6. Métricas `failureAvoided` / `dwell`

```bash
curl -fsS -H "x-api-key: $AGENCY_API_KEY" "$STAGING_BASE/api/ops/metrics"
```

| Campo | Tras este smoke (con seed) |
|---|---|
| `failureAvoided.candidates` | ≥ 1 si hubo envío (dry-run). De noche puede no subir: `markApproachNotified` solo corre al enviar |
| `failureAvoided.count` | El seed ya trae 1 (`ORD-ALCALA-001`). **Este** pedido no incrementa `count` hasta `POST /repartidor/paradas/:id/estado` `{estado:entregado}` con la parada `notificado`/`confirmado` |
| `system.inGeofenceNow` | ≥ 1 mientras el attempt sigue `open` |
| `dwell.avgSeconds` / `p50Seconds` | Pueden ser `null` hasta cerrar dwell (`exited` o `entregado`). Los `geofence_events` sí tienen `dwell_seconds` en `at_delivery` |
| `notifications.sent` | ≥ 1 en horario diurno dry-run; de noche mira `pendingNotificationJobs` / log `deferred` |

Opcional, para cerrar dwell y `failureAvoided.count` de `ORD-TEST-001`:

```bash
curl -fsS -X POST \
  "$STAGING_BASE/repartidor/paradas/55555555-5555-5555-5555-555555555552/estado" \
  -H "Content-Type: application/json" -H "x-api-key: $AGENCY_API_KEY" \
  -d '{"estado":"entregado"}'
```

No forma parte del mínimo: confirma presencia + métricas con attempt abierto ya validan el camino.

### 7. Backup + restore `PLAN=1`

`PLAN=1` está en `scripts/restore-postgres.sh`: imprime destino/formato y **no** llama a `pg_restore`. No pide `CONFIRM=yes`. **No** restores contra `pgdata_prod`.

```bash
# Dump local (Postgres publicado en :5432)
ENV_FILE=.env BACKUP_VIA=host ./scripts/backup-postgres.sh
# última línea de stdout = ruta del .dump

ENV_FILE=.env PLAN=1 ./scripts/restore-postgres.sh backups/postgres/<dump>.dump
# stderr: PLAN OK (sin cambios)
```

Sin `pg_dump` en el PATH: `BACKUP_VIA=docker` con el compose **local** (servicio `postgres`). Sigue sin tocar el VPS.

Criterio: exit 0, texto `PLAN OK`, ningún `pg_restore` real. El dry-run **destructivo** (`CONFIRM=yes` en **otro** volumen) es go-live, no este smoke: `deploy/BACKUP_RESTORE.md`.

## Healthcheck opcional

Pasos 2–7 (salvo el reset SQL) se pueden automatizar:

```bash
STAGING_BASE=http://localhost:3000 \
STAGING_WEB=http://localhost:5173 \
STAGING_SMOKE=1 \
AGENCY_API_KEY=demo-api-key \
ENV_FILE=.env \
  ./scripts/prod-healthcheck.sh
```

Sin `STAGING_SMOKE=1`, `STAGING_BASE` solo sustituye el origen de `/health` + ops (mismo contrato que prod, en HTTP local).

Tests estáticos (sin Docker, sin VPS, sin Twilio):

```bash
node --test scripts/prod-compose.test.mjs scripts/backup-restore.test.mjs
bash -n scripts/prod-healthcheck.sh
```

`PROD_SMOKE_BASE` / `STAGING_BASE` en `apps/api/src/prod-smoke.test.ts` cubren `/health`, `/api/ops/health` y el 401 de `/repartidor/*` si la API está arriba.

## Criterio de paso (mínimo)

1. Compose local healthy; `/health` y `/api/ops/health` con `ok`.
2. `/repartidor/*` sin API key → 401.
3. Tres pings → `geofence.entered` (y `at_delivery` si el worker alcanzó el 3.º).
4. Notificación **dry-run** `sent` **o** `deferred`/`QUIET_HOURS`. Nada hacia Twilio/Meta.
5. `confirm-presence` → `will_be_there`.
6. `GET /api/ops/metrics` expone `failureAvoided` y `dwell`; con envío diurno, `candidates ≥ 1` y/o `inGeofenceNow ≥ 1`.
7. `PLAN=1` del restore sobre un dump de **staging** → `PLAN OK`, base intacta.
8. **No** se ha apuntado DNS público ni se ha pedido un cert ACME.

Si esto es verde, se puede seguir el plan de mañana (`deploy/DEPLOY_PLAN_MANANA.md`) con DNS/TLS **después**, no antes.
