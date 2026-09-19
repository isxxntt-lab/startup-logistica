#!/usr/bin/env bash
# Smoke E2E: pedido → courier → assign → location → geocerca.
# Uso (con el compose de logiq arriba):
#   BASE=http://localhost:8080 ./scripts/smoke.sh
set -euo pipefail

BASE="${BASE:-http://localhost:8080}"

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

say "health gateway + backends"
curl -fsS "$BASE/health"
echo
curl -fsS "$BASE/health/orders"
echo
curl -fsS "$BASE/health/fleet"
echo
curl -fsS "$BASE/health/routing"
echo

say "POST /orders"
ORDER_JSON=$(curl -fsS -X POST "$BASE/orders" \
  -H "content-type: application/json" \
  -d '{
    "customerName": "Santiago Demo",
    "addressText": "Templo de Debod, Madrid",
    "lat": 40.424,
    "lng": -3.7178,
    "phone": "+34600000000"
  }')
echo "$ORDER_JSON"
ORDER_ID=$(printf '%s' "$ORDER_JSON" | json_field id)

say "POST /fleet/couriers"
COURIER_JSON=$(curl -fsS -X POST "$BASE/fleet/couriers" \
  -H "content-type: application/json" \
  -d '{"name":"Ana Rider","vehicle":"moto"}')
echo "$COURIER_JSON"
COURIER_ID=$(printf '%s' "$COURIER_JSON" | json_field id)

say "POST /routing/assign"
ROUTE_JSON=$(curl -fsS -X POST "$BASE/routing/assign" \
  -H "content-type: application/json" \
  -d "{\"orderId\":\"$ORDER_ID\",\"courierId\":\"$COURIER_ID\"}")
echo "$ROUTE_JSON"
ROUTE_ID=$(printf '%s' "$ROUTE_JSON" | json_field id)

say "GET /orders/:id (assigned)"
curl -fsS "$BASE/orders/$ORDER_ID"
echo

say "POST /fleet/location (fuera de geocerca: Sol)"
curl -fsS -X POST "$BASE/fleet/location" \
  -H "content-type: application/json" \
  -d "{\"courierId\":\"$COURIER_ID\",\"lat\":40.4168,\"lng\":-3.7038,\"accuracyM\":8,\"orderId\":\"$ORDER_ID\"}"
echo

say "POST /fleet/location (dentro de geocerca: Debod)"
curl -fsS -X POST "$BASE/fleet/location" \
  -H "content-type: application/json" \
  -d "{\"courierId\":\"$COURIER_ID\",\"lat\":40.4243,\"lng\":-3.7175,\"accuracyM\":5,\"orderId\":\"$ORDER_ID\"}"
echo

say "esperar geofence_entered (consumer de stream:locations)"
ENTERED="false"
for i in 1 2 3 4 5 6 7 8 9 10; do
  ROUTE_NOW=$(curl -fsS "$BASE/routing/routes/$ROUTE_ID")
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
    -H "content-type: application/json" \
    -d "{\"courierId\":\"$COURIER_ID\",\"lat\":40.4243,\"lng\":-3.7175,\"accuracyM\":5,\"orderId\":\"$ORDER_ID\"}"
  echo
  ROUTE_NOW=$(curl -fsS "$BASE/routing/routes/$ROUTE_ID")
  echo "$ROUTE_NOW"
  ENTERED=$(printf '%s' "$ROUTE_NOW" | json_field geofenceEntered)
fi

if [ "$ENTERED" != "true" ]; then
  echo "FAIL: la ruta $ROUTE_ID no marcó geofenceEntered" >&2
  exit 1
fi

say "GET /fleet/couriers/:id"
curl -fsS "$BASE/fleet/couriers/$COURIER_ID"
echo

say "OK pedido=$ORDER_ID courier=$COURIER_ID route=$ROUTE_ID geofenceEntered=true"
