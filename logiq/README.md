# Logiq — last mile (microservicios)

Sustituye los stubs de health de Contabo por tres servicios reales: pedidos, flota y routing/geocerca. Stack **Fastify + TypeScript (tsx) + Redis**. Independiente del monorepo `apps/*` (no entra en el workspace de pnpm).

## Qué hay aquí

| Ruta | Puerto interno | Rol |
|---|---|---|
| `services/service-orders` | 3000 | Pedidos en Redis JSON + `stream:orders` |
| `services/service-fleet` | 3001 | Couriers y pings GPS + `stream:locations` |
| `services/service-routing` | 3002 | Asignación, Haversine, `geofence_entered` una vez |
| `packages/shared` | — | Tipos, transiciones, Haversine, claves Redis |
| `gateway/nginx.conf` | 80 | Reverse proxy. Único proceso con `ports` al host |
| `docker-compose.yml` | — | Redis **sin** puertos de host + `requirepass` |

Redes Compose: `edge` (gateway), `app` (gateway↔servicios), `data` (servicios↔Redis). Un compromiso del nginx **no** tiene L3 a Redis.

## Arranque

```bash
cd logiq
cp .env.example .env
# edita REDIS_PASSWORD
docker compose up -d --build
```

Health:

```bash
curl -s http://localhost:8080/health
curl -s http://localhost:8080/health/orders
curl -s http://localhost:8080/health/fleet
curl -s http://localhost:8080/health/routing
```

Los tres servicios son **expose-only** (no `ports:` al host). El smoke local entra por el gateway en `GATEWAY_PORT` (8080).

Atajo del flujo completo:

```bash
BASE=http://localhost:8080 ./scripts/smoke.sh
```

## Contrato HTTP

### service-orders (`:3000`)

| Método | Ruta | Cuerpo |
|---|---|---|
| GET | `/health` | — |
| POST | `/orders` | `{ customerName, addressText, lat, lng, phone? }` |
| GET | `/orders/:id` | — |
| PATCH | `/orders/:id/status` | `{ status }` |

`status`: `pending` → `assigned` → `in_transit` → `delivered`. Desde no terminales también `failed` / `cancelled`. Persistencia: clave `order:{id}` (JSON). Cada alta o cambio hace `XADD stream:orders`.

### service-fleet (`:3001`)

| Método | Ruta | Cuerpo |
|---|---|---|
| GET | `/health` | — |
| POST | `/fleet/couriers` | `{ name, vehicle? }` |
| GET | `/fleet/couriers/:id` | — |
| POST | `/fleet/location` | `{ courierId, lat, lng, accuracyM?, orderId? }` |

Cada ping actualiza `courier:{id}` y hace `XADD stream:locations`.

### service-routing (`:3002`)

| Método | Ruta | Cuerpo |
|---|---|---|
| GET | `/health` | — |
| POST | `/routing/assign` | `{ orderId, courierId }` |
| GET | `/routing/routes/:id` | — |
| POST | `/routing/ingest-location` | mismo payload que `/fleet/location` (MVP síncrono) |

Radio: `GEOFENCE_RADIUS_M` (por defecto **500**). Al acercarse al destino emite **una** vez `geofence_entered` (`SET NX geofence:entered:{routeId}` + `XADD stream:geofence`) y puede pasar el pedido a `in_transit`.

Routing **consume** `stream:locations` (`XREADGROUP cg:routing-locations`). `POST /routing/ingest-location` es el atajo síncrono si no quieres esperar al consumer.

## Smoke curl: pedido → courier → assign → location → geocerca

Coordenadas: Templo de Debod (destino) y un ping a ~40 m. Sol (~1,5 km) queda fuera de 500 m.

```bash
BASE=http://localhost:8080

# 1) Pedido
ORDER=$(curl -s -X POST "$BASE/orders" \
  -H 'content-type: application/json' \
  -d '{
    "customerName": "Santiago Demo",
    "addressText": "Templo de Debod, Madrid",
    "lat": 40.424,
    "lng": -3.7178,
    "phone": "+34600000000"
  }')
echo "$ORDER"
ORDER_ID=$(printf '%s' "$ORDER" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.parse(s).id))')

# 2) Courier
COURIER=$(curl -s -X POST "$BASE/fleet/couriers" \
  -H 'content-type: application/json' \
  -d '{"name":"Ana Rider","vehicle":"moto"}')
echo "$COURIER"
COURIER_ID=$(printf '%s' "$COURIER" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.parse(s).id))')

# 3) Asignar
ROUTE=$(curl -s -X POST "$BASE/routing/assign" \
  -H 'content-type: application/json' \
  -d "{\"orderId\":\"$ORDER_ID\",\"courierId\":\"$COURIER_ID\"}")
echo "$ROUTE"
ROUTE_ID=$(printf '%s' "$ROUTE" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.parse(s).id))')

# 4) Ping lejos (Sol) — no entra en geocerca
curl -s -X POST "$BASE/fleet/location" \
  -H 'content-type: application/json' \
  -d "{\"courierId\":\"$COURIER_ID\",\"lat\":40.4168,\"lng\":-3.7038,\"accuracyM\":8,\"orderId\":\"$ORDER_ID\"}"

# 5) Ping junto al destino — emite geofence_entered (una vez)
curl -s -X POST "$BASE/fleet/location" \
  -H 'content-type: application/json' \
  -d "{\"courierId\":\"$COURIER_ID\",\"lat\":40.4243,\"lng\":-3.7175,\"accuracyM\":5,\"orderId\":\"$ORDER_ID\"}"

# Esperar al consumer (o usar el ingest síncrono de abajo)
sleep 2
curl -s "$BASE/routing/routes/$ROUTE_ID"
# {"geofenceEntered":true,"status":"geofence_entered",...}

# Alternativa MVP síncrona (no hace falta si el consumer ya corrió):
# curl -s -X POST "$BASE/routing/ingest-location" \
#   -H 'content-type: application/json' \
#   -d "{\"courierId\":\"$COURIER_ID\",\"lat\":40.4243,\"lng\":-3.7175,\"orderId\":\"$ORDER_ID\"}"

curl -s "$BASE/orders/$ORDER_ID"
curl -s "$BASE/fleet/couriers/$COURIER_ID"
```

Un segundo ping dentro del radio **no** vuelve a emitir: la clave `geofence:entered:{routeId}` ya existe.

## Redis

| Clave / stream | Uso |
|---|---|
| `order:{id}` | Documento JSON del pedido |
| `courier:{id}` | Courier + último GPS |
| `route:{id}` | Asignación + destino + flag de geocerca |
| `idx:order:{id}:route` | Ruta activa del pedido |
| `idx:courier:{id}:routes` | SET de rutas del courier |
| `geofence:entered:{routeId}` | Dedupe (`SET NX`) |
| `stream:orders` | Altas y cambios de pedido |
| `stream:locations` | Pings |
| `stream:geofence` | `geofence_entered` |

Redis **no** publica `6379` al host. Arranca con `--requirepass` (`REDIS_PASSWORD`). El healthcheck usa `REDISCLI_AUTH`.

## Imágenes

Cada servicio: `node:20-alpine`, `USER 10001:10001` (no root), `tsx` en runtime, `GET /health` (incluye `PING` a Redis). Build context = este directorio `logiq/`.

```bash
docker compose build
```

Pruebas del paquete compartido (Haversine + FSM, sin Docker):

```bash
cd packages/shared && npm install && npm test
```

## Caddy opcional (TLS)

Este compose **no** incluye Caddy. Nginx en `8080` basta para el smoke. En un VPS (Contabo u otro) pon Caddy delante del gateway, o sustituye nginx y deja Redis + servicios en la red interna:

```caddy
orders.example.com {
	reverse_proxy gateway:80
}
```

Caddy publicaría `80`/`443`; Redis y los tres servicios seguirían **sin** `ports` al host. No mezcles este stack con el `docker-compose.prod.yml` del monorepo (`apps/api` usa el mismo puerto 3000 **dentro** de *su* red, no con Logiq).

## Desarrollo local (sin gateway)

Los servicios no escuchan en el host. Para iterar con `tsx watch` tendrías que publicar Redis (no es el default) o entrar a la red Compose:

```bash
docker compose exec service-orders wget -qO- http://127.0.0.1:3000/health
```
