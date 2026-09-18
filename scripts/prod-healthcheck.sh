#!/usr/bin/env bash
set -euo pipefail

API_BASE="${1:-https://${SITE_API:-localhost}}"
WEB_BASE="${2:-}"
if [[ -z "$WEB_BASE" && -n "${SITE_TRACKING:-}" ]]; then
  WEB_BASE="https://${SITE_TRACKING}"
fi

OPS_TOKEN_VALUE="${OPS_TOKEN:-}"
API_KEY_VALUE="${AGENCY_API_KEY:-${X_API_KEY:-}}"
TS=$(date -Iseconds)
log() { echo "[$TS][healthcheck] $*"; }

json_ok() {
  python3 - "$1" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)
sys.exit(0 if data.get("ok") is True else 1)
PY
}

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

auth_args=()
if [[ -n "$OPS_TOKEN_VALUE" ]]; then
  auth_args=(-H "x-ops-token: $OPS_TOKEN_VALUE")
elif [[ -n "$API_KEY_VALUE" ]]; then
  auth_args=(-H "x-api-key: $API_KEY_VALUE")
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

log "OK"
