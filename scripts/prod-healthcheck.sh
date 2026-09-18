#!/usr/bin/env bash
# Healthcheck de API/ops (prod o staging).
#
#   ./scripts/prod-healthcheck.sh [API_BASE] [WEB_BASE]
#   STAGING_BASE=http://localhost:3000 ./scripts/prod-healthcheck.sh
#
# Smoke E2E opcional (muta datos seed; ver deploy/STAGING_SMOKE.md):
#   STAGING_BASE=http://localhost:3000 STAGING_SMOKE=1 \
#     AGENCY_API_KEY=demo-api-key ENV_FILE=.env ./scripts/prod-healthcheck.sh
#
# No Twilio/Meta reales. No ACME. STAGING_SMOKE=1 aborta contra
# api.rutacerca.es / seguimiento.rutacerca.es.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

STAGING_BASE="${STAGING_BASE:-}"
STAGING_WEB="${STAGING_WEB:-}"
STAGING_SMOKE="${STAGING_SMOKE:-0}"

if [[ -n "${1:-}" ]]; then
  API_BASE="$1"
elif [[ -n "$STAGING_BASE" ]]; then
  API_BASE="$STAGING_BASE"
else
  API_BASE="https://${SITE_API:-localhost}"
fi
API_BASE="${API_BASE%/}"

WEB_BASE="${2:-}"
if [[ -z "$WEB_BASE" && -n "$STAGING_WEB" ]]; then
  WEB_BASE="$STAGING_WEB"
fi
if [[ -z "$WEB_BASE" && -n "${SITE_TRACKING:-}" ]]; then
  WEB_BASE="https://${SITE_TRACKING}"
fi
WEB_BASE="${WEB_BASE%/}"

OPS_TOKEN_VALUE="${OPS_TOKEN:-}"
API_KEY_VALUE="${AGENCY_API_KEY:-${X_API_KEY:-}}"
STAGING_COURIER_ID="${STAGING_COURIER_ID:-repartidor_001}"
STAGING_ORDER_ID="${STAGING_ORDER_ID:-ORD-TEST-001}"
STAGING_PARADA_ID="${STAGING_PARADA_ID:-55555555-5555-5555-5555-555555555552}"
ENV_FILE="${ENV_FILE:-${ROOT}/.env}"
TS=$(date -Iseconds)
log() { echo "[$TS][healthcheck] $*"; }

is_prod_public_dns() {
  printf '%s' "$1" | grep -Eq 'api\.rutacerca\.es|seguimiento\.rutacerca\.es'
}

json_ok() {
  python3 - "$1" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)
sys.exit(0 if data.get("ok") is True else 1)
PY
}

logs_have_event() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys
from datetime import datetime

path, event, since = sys.argv[1], sys.argv[2], sys.argv[3]

def parse(ts: str):
    if not ts:
        return None
    ts = ts.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(ts)
    except ValueError:
        return None

with open(path, encoding="utf-8") as fh:
    payload = json.load(fh)
rows = payload.get("logs") if isinstance(payload, dict) else payload
if not isinstance(rows, list):
    sys.exit(1)
since_dt = parse(since)
for row in rows:
    if row.get("event") != event:
        continue
    created = parse(str(row.get("created_at") or ""))
    if since_dt is None or created is None or created >= since_dt:
        sys.exit(0)
sys.exit(1)
PY
}

metrics_smoke_ok() {
  python3 - "$1" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)
avoided = data.get("failureAvoided") or {}
dwell = data.get("dwell") or {}
system = data.get("system") or {}
notif = data.get("notifications") or {}
missing = [
    name
    for name, obj, keys in (
        ("failureAvoided", avoided, ("count", "candidates")),
        ("dwell", dwell, ("avgSeconds",)),
        ("system", system, ("inGeofenceNow",)),
        ("notifications", notif, ("sent",)),
    )
    if not isinstance(obj, dict) or any(k not in obj for k in keys)
]
if missing:
    print("métricas incompletas: " + ", ".join(missing), file=sys.stderr)
    sys.exit(1)
print(
    "failureAvoided.count={count} candidates={candidates} "
    "dwell.avgSeconds={avg} inGeofenceNow={geo} notifications.sent={sent}".format(
        count=avoided.get("count"),
        candidates=avoided.get("candidates"),
        avg=dwell.get("avgSeconds"),
        geo=system.get("inGeofenceNow"),
        sent=notif.get("sent"),
    )
)
sys.exit(0)
PY
}

auth_args=()
if [[ -n "$OPS_TOKEN_VALUE" ]]; then
  auth_args=(-H "x-ops-token: $OPS_TOKEN_VALUE")
elif [[ -n "$API_KEY_VALUE" ]]; then
  auth_args=(-H "x-api-key: $API_KEY_VALUE")
fi

curl_auth() {
  if [[ ${#auth_args[@]} -gt 0 ]]; then
    curl -fsS "${auth_args[@]}" "$@"
  else
    curl -fsS "$@"
  fi
}

post_location_ping() {
  local body="$1"
  curl -fsS -X POST "$API_BASE/events/location_update" \
    -H "Content-Type: application/json" \
    -H "x-api-key: $API_KEY_VALUE" \
    -d "$body" | tee /tmp/staging-ping.json >/dev/null
  json_ok /tmp/staging-ping.json
}

wait_for_log_event() {
  local category="$1"
  local event="$2"
  local since="$3"
  local order="$4"
  local i
  for i in $(seq 1 20); do
    curl_auth "$API_BASE/api/ops/logs?category=${category}&orderId=${order}&limit=50" \
      > /tmp/staging-ops-logs.json
    if logs_have_event /tmp/staging-ops-logs.json "$event" "$since"; then
      log "OK log ${category}/${event}"
      return 0
    fi
    sleep 0.4
  done
  return 1
}

run_staging_smoke() {
  if is_prod_public_dns "$API_BASE" || { [[ -n "$WEB_BASE" ]] && is_prod_public_dns "$WEB_BASE"; }; then
    log "FAIL: STAGING_SMOKE=1 no corre contra DNS público de prod ($API_BASE $WEB_BASE)"
    exit 1
  fi
  if [[ -z "$API_KEY_VALUE" ]]; then
    log "FAIL: STAGING_SMOKE=1 exige AGENCY_API_KEY u OPS_TOKEN (seed local: demo-api-key)"
    exit 1
  fi
  if [[ ${#auth_args[@]} -eq 0 ]]; then
    auth_args=(-H "x-api-key: $API_KEY_VALUE")
  fi

  local since
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  log "smoke E2E STAGING_BASE=$API_BASE order=$STAGING_ORDER_ID (sin Twilio/ACME)"

  log "POST /events/location_update (3 pings Grok / geocerca Sol 600 m)"
  post_location_ping '{"event":"location_update","courier_id":"'"$STAGING_COURIER_ID"'","order_id":"'"$STAGING_ORDER_ID"'","timestamp":"2026-09-18T14:40:00+02:00","location":{"lat":40.427555,"lng":-3.70379,"accuracy_m":12.5,"altitude_m":655.0,"heading_deg":180.0,"speed_mps":8.3}}'
  sleep 0.4
  post_location_ping '{"event":"location_update","courier_id":"'"$STAGING_COURIER_ID"'","order_id":"'"$STAGING_ORDER_ID"'","timestamp":"2026-09-18T14:42:30+02:00","location":{"lat":40.421267,"lng":-3.70379,"accuracy_m":8.0,"altitude_m":650.0,"heading_deg":180.0,"speed_mps":6.1}}'
  sleep 0.4
  post_location_ping '{"event":"location_update","courier_id":"'"$STAGING_COURIER_ID"'","order_id":"'"$STAGING_ORDER_ID"'","timestamp":"2026-09-18T14:45:00+02:00","location":{"lat":40.416775,"lng":-3.70379,"accuracy_m":4.2,"altitude_m":648.0,"heading_deg":0.0,"speed_mps":0.0}}'

  if wait_for_log_event geofence geofence.entered "$since" "$STAGING_ORDER_ID"; then
    :
  else
    log "FAIL: no llegó geofence.entered (¿workers arriba? ver deploy/STAGING_SMOKE.md)"
    exit 1
  fi
  if wait_for_log_event geofence geofence.at_delivery "$since" "$STAGING_ORDER_ID"; then
    :
  else
    log "WARN: sin at_delivery (worker lento); entered sí llegó"
  fi

  log "notificación dry-run o QUIET_HOURS"
  if wait_for_log_event notification_fallback notification.sent "$since" "$STAGING_ORDER_ID"; then
    :
  elif wait_for_log_event notification_fallback notification.deferred "$since" "$STAGING_ORDER_ID"; then
    log "OK quiet hours (deferred) — no se llama a Twilio"
  else
    log "FAIL: ni notification.sent ni notification.deferred (¿workers / Twilio relleno?)"
    exit 1
  fi

  log "POST /agencia/paradas/$STAGING_PARADA_ID/token (JWT no se imprime)"
  curl -fsS -X POST "$API_BASE/agencia/paradas/${STAGING_PARADA_ID}/token" \
    -H "x-api-key: $API_KEY_VALUE" > /tmp/staging-token.json
  python3 - /tmp/staging-token.json <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    data = json.load(fh)
token = data.get("token")
if not token:
    sys.exit(1)
open("/tmp/staging-confirm.json", "w", encoding="utf-8").write(
    json.dumps({"token": token})
)
PY

  log "POST /api/tracking/confirm-presence"
  curl -fsS -X POST "$API_BASE/api/tracking/confirm-presence" \
    -H "Content-Type: application/json" \
    --data-binary @/tmp/staging-confirm.json | tee /tmp/staging-presence.json
  json_ok /tmp/staging-presence.json
  python3 - /tmp/staging-presence.json <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    data = json.load(fh)
sys.exit(0 if data.get("status") == "will_be_there" else 1)
PY
  rm -f /tmp/staging-confirm.json /tmp/staging-token.json

  log "GET /api/ops/metrics (failureAvoided / dwell)"
  curl_auth "$API_BASE/api/ops/metrics" | tee /tmp/ops-metrics-smoke.json
  metrics_smoke_ok /tmp/ops-metrics-smoke.json

  if [[ "${STAGING_SKIP_BACKUP:-0}" == "1" ]]; then
    log "WARN: STAGING_SKIP_BACKUP=1 — skip backup / PLAN=1"
    return 0
  fi

  local dump="${STAGING_BACKUP_DUMP:-}"
  if [[ -z "$dump" ]]; then
    if [[ ! -f "$ENV_FILE" ]]; then
      log "FAIL: no hay ENV_FILE=$ENV_FILE ni STAGING_BACKUP_DUMP (o usa STAGING_SKIP_BACKUP=1)"
      exit 1
    fi
    log "backup-postgres.sh ENV_FILE=$ENV_FILE"
    dump="$(ENV_FILE="$ENV_FILE" BACKUP_VIA="${BACKUP_VIA:-auto}" "$ROOT/scripts/backup-postgres.sh" | tail -n 1)"
  fi
  if [[ "$dump" != /* ]]; then
    dump="${ROOT}/${dump}"
  fi
  [[ -f "$dump" ]] || {
    log "FAIL: no existe el dump para PLAN=1: $dump"
    exit 1
  }
  log "PLAN=1 restore-postgres.sh $(basename "$dump") (no muta)"
  PLAN=1 ENV_FILE="$ENV_FILE" "$ROOT/scripts/restore-postgres.sh" "$dump"
}

if [[ "$STAGING_SMOKE" == "1" ]]; then
  if is_prod_public_dns "$API_BASE" || { [[ -n "$WEB_BASE" ]] && is_prod_public_dns "$WEB_BASE"; }; then
    log "FAIL: STAGING_SMOKE=1 no corre contra DNS público de prod ($API_BASE $WEB_BASE)"
    exit 1
  fi
fi

log "GET $API_BASE/health"
curl -fsS "$API_BASE/health" | tee /tmp/health.json
json_ok /tmp/health.json

log "GET $API_BASE/api/ops/health"
curl -fsS "$API_BASE/api/ops/health" | tee /tmp/ops-health.json
json_ok /tmp/ops-health.json

if [[ -n "$WEB_BASE" ]]; then
  log "GET $WEB_BASE/"
  curl -fsS -o /tmp/web-index.html -w "web_http %{http_code}\n" "$WEB_BASE/"
fi

log "GET $API_BASE/repartidor/probe/ruta-hoy (expect 401)"
unauth_code=$(curl -sS -o /tmp/repartidor-unauth.json -w "%{http_code}" "$API_BASE/repartidor/probe/ruta-hoy")
if [[ "$unauth_code" != "401" ]]; then
  log "FAIL: /repartidor/* sin x-api-key debía ser 401, fue $unauth_code"
  exit 1
fi

if [[ ${#auth_args[@]} -gt 0 ]]; then
  log "GET $API_BASE/api/ops/metrics"
  curl -fsS "${auth_args[@]}" "$API_BASE/api/ops/metrics" | tee /tmp/ops-metrics.json
  log "POST $API_BASE/api/ops/checks"
  curl -fsS -X POST "${auth_args[@]}" "$API_BASE/api/ops/checks" | tee /tmp/ops-checks.json
  json_ok /tmp/ops-checks.json
else
  log "WARN: OPS_TOKEN y AGENCY_API_KEY vacíos — skip metrics/checks"
fi

if [[ "$STAGING_SMOKE" == "1" ]]; then
  run_staging_smoke
elif [[ -n "$STAGING_BASE" ]]; then
  log "STAGING_BASE activo; smoke E2E off (STAGING_SMOKE=1 para GPS/notif/confirm/metrics/PLAN=1 — deploy/STAGING_SMOKE.md)"
fi

log "OK"
