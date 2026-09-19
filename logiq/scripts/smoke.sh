#!/usr/bin/env bash
# Smoke E2E: 401 anónimo → pedido → courier → assign → location → geocerca.
# Uso (con el compose de logiq arriba):
#   set -a && source .env && set +a
#   BASE=http://localhost:8080 ./scripts/smoke.sh
set -euo pipefail
set +x

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${INTERNAL_SERVICE_TOKEN:-}" ] && [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
  set +x
fi

: "${INTERNAL_SERVICE_TOKEN:?Set INTERNAL_SERVICE_TOKEN (openssl rand -hex 32)}"
BASE="${BASE:-http://localhost:8080}"
AUTH_HEADER="Authorization: Bearer ${INTERNAL_SERVICE_TOKEN}"

json_field() {
  node -e '
    const fs = require("fs");
    const key = process.argv[1];
    const raw = fs.readFileSync(0, "utf8");
    const data = JSON.parse(raw);
    const parts = key.split(".");
    let cur = data;
    for (const p of parts) {
      if (cur == null) process.exit(2);
      cur = cur[p];
    }
    if (cur === undefined || cur === null) process.exit(2);
    process.stdout.write(String(cur));
  ' "$1"
}

say() { printf '\n== %s ==\n' "$*"; }

expect_http() {
  local got="$1" want="$2" label="$3"
  if [ "$got" != "$want" ]; then
    echo "FAIL: $label HTTP $got (esperado $want)" >&2
    exit 1
  fi
}

expect_health() {
  local path="$1"
  local slug="${path//\//_}"
  local body="/tmp/logiq-health${slug}.json"
  local code
  code=$(curl -sS -o "$body" -w '%{http_code}' "$BASE$path")
  echo "GET $path HTTP $code $(cat "$body")"
  expect_http "$code" "200" "GET $path"
}

say "health Contabo /{servicio}/health (público, sin Bearer) → 200"
expect_health "/orders/health"
expect_health "/fleet/health"
expect_health "/routing/health"

say "POST /orders anónimo → 401"
ANON_CODE=$(curl -sS -o /tmp/logiq-anon.json -w '%{http_code}' -X POST "$BASE/orders" \
  -H "content-type: application/json" \
  -d '{
    "customerName": "Santiago Demo",
    "addressText": "Templo de Debod, Madrid",
    "lat": 40.424,
    "lng": -3.7178
  }')
echo "HTTP $ANON_CODE $(cat /tmp/logiq-anon.json)"
expect_http "$ANON_CODE" "401" "POST /orders anónimo"
ANON_ERR=$(json_field error </tmp/logiq-anon.json)
if [ "$ANON_ERR" != "unauthorized" ]; then
  echo "FAIL: body 401 debe ser {\"error\":\"unauthorized\"}" >&2
  exit 1
fi

say "POST /orders con Bearer → 201"
ORDER_CODE=$(curl -sS -o /tmp/logiq-order.json -w '%{http_code}' -X POST "$BASE/orders" \
  -H "$AUTH_HEADER" \
  -H "content-type: application/json" \
  -d '{
    "customerName": "Santiago Demo",
    "addressText": "Templo de Debod, Madrid",
    "lat": 40.424,
    "lng": -3.7178,
    "phone": "+34600000000"
  }')
cat /tmp/logiq-order.json
echo
expect_http "$ORDER_CODE" "201" "POST /orders autenticado"
ORDER_ID=$(json_field id </tmp/logiq-order.json)

say "POST /fleet/couriers"
COURIER_JSON=$(curl -fsS -X POST "$BASE/fleet/couriers" \
  -H "$AUTH_HEADER" \
  -H "content-type: application/json" \
  -d '{"name":"Ana Rider","vehicle":"moto"}')
echo "$COURIER_JSON"
COURIER_ID=$(printf '%s' "$COURIER_JSON" | json_field id)

say "POST /routing/assign"
ROUTE_JSON=$(curl -fsS -X POST "$BASE/routing/assign" \
  -H "$AUTH_HEADER" \
  -H "content-type: application/json" \
  -d "{\"orderId\":\"$ORDER_ID\",\"courierId\":\"$COURIER_ID\"}")
echo "$ROUTE_JSON"
ROUTE_ID=$(printf '%s' "$ROUTE_JSON" | json_field id)

say "GET /orders/:id (assigned)"
curl -fsS -H "$AUTH_HEADER" "$BASE/orders/$ORDER_ID"
echo

say "POST /fleet/location (fuera de geocerca: Sol)"
curl -fsS -X POST "$BASE/fleet/location" \
  -H "$AUTH_HEADER" \
  -H "content-type: application/json" \
  -d "{\"courierId\":\"$COURIER_ID\",\"lat\":40.4168,\"lng\":-3.7038,\"accuracyM\":8,\"orderId\":\"$ORDER_ID\"}"
echo

say "POST /fleet/location (dentro de geocerca: Debod)"
curl -fsS -X POST "$BASE/fleet/location" \
  -H "$AUTH_HEADER" \
  -H "content-type: application/json" \
  -d "{\"courierId\":\"$COURIER_ID\",\"lat\":40.4243,\"lng\":-3.7175,\"accuracyM\":5,\"orderId\":\"$ORDER_ID\"}"
echo

say "esperar geofence_entered (consumer de stream:locations)"
ENTERED="false"
for i in 1 2 3 4 5 6 7 8 9 10; do
  ROUTE_NOW=$(curl -fsS -H "$AUTH_HEADER" "$BASE/routing/routes/$ROUTE_ID")
  ENTERED=$(printf '%s' "$ROUTE_NOW" | json_field geofenceEntered || true)
  if [ "$ENTERED" = "true" ]; then
    echo "$ROUTE_NOW"
    break
  fi
  sleep 1
done

if [ "$ENTERED" != "true" ]; then
  say "fallback síncrono POST /routing/ingest-location"
  curl -fsS -X POST "$BASE/routing/ingest-location" \
    -H "$AUTH_HEADER" \
    -H "content-type: application/json" \
    -d "{\"courierId\":\"$COURIER_ID\",\"lat\":40.4243,\"lng\":-3.7175,\"accuracyM\":5,\"orderId\":\"$ORDER_ID\"}"
  echo
  ROUTE_NOW=$(curl -fsS -H "$AUTH_HEADER" "$BASE/routing/routes/$ROUTE_ID")
  echo "$ROUTE_NOW"
  ENTERED=$(printf '%s' "$ROUTE_NOW" | json_field geofenceEntered)
fi

if [ "$ENTERED" != "true" ]; then
  echo "FAIL: la ruta $ROUTE_ID no marcó geofenceEntered" >&2
  exit 1
fi

say "GET /fleet/couriers/:id"
curl -fsS -H "$AUTH_HEADER" "$BASE/fleet/couriers/$COURIER_ID"
echo

say "OK pedido=$ORDER_ID courier=$COURIER_ID route=$ROUTE_ID geofenceEntered=true"
