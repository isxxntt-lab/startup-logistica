# Logiq — last mile (microservicios)

Sustituye los stubs de health de Contabo por tres servicios reales: pedidos, flota y routing/geocerca. Stack **Fastify + TypeScript (tsx) + Redis**. Independiente del monorepo `apps/*` (no entra en el workspace de pnpm).

Auth alineada con Contabo: todas las rutas salvo `GET /health` exigen `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` (comparación en tiempo constante). Sin token o token inválido → **401** `{"error":"unauthorized"}`. Si `INTERNAL_SERVICE_TOKEN` está vacío, el proceso **no arranca**.

## Qué hay aquí

| Ruta | Puerto interno | Rol |
|---|---|---|
| `services/service-orders` | 3000 | Pedidos en Redis JSON + `stream:orders` |
| `services/service-fleet` | 3001 | Couriers y pings GPS + `stream:locations` |
| `services/service-routing` | 3002 | Asignación, Haversine, `geofence_entered` una vez |
| `packages/shared` | — | Tipos, transiciones, Haversine, claves Redis, hook Bearer |
| `gateway/nginx.conf` | 80 | Reverse proxy. Único proceso con `ports` al host |
| `docker-compose.yml` | — | Redis **sin** puertos de host + `requirepass` |

Redes Compose: `edge` (gateway), `app` (gateway↔servicios), `data` (servicios↔Redis). Un compromiso del nginx **no** tiene L3 a Redis.

## Arranque

```bash
cd logiq
cp .env.example .env
# edita REDIS_PASSWORD
openssl rand -hex 32   # pega el valor en INTERNAL_SERVICE_TOKEN
docker compose up -d --build
```

Health (convención Contabo: `/{servicio}/health` → backend `GET /health`, **sin** Bearer):

```bash
curl -s http://localhost:8080/orders/health
curl -s http://localhost:8080/fleet/health
curl -s http://localhost:8080/routing/health
```

Los tres servicios son **expose-only** (no `ports:` al host). El smoke local entra por el gateway en `GATEWAY_PORT` (8080).

Atajo del flujo completo (carga `.env` si `INTERNAL_SERVICE_TOKEN` no está en el entorno):

```bash
BASE=http://localhost:8080 ./scripts/smoke.sh
```

## Contrato HTTP

Todas las rutas de la tabla excepto `GET /health` requieren Bearer. El gateway no añade el token: Contabo (o el cliente) lo envía.

### service-orders (`:3000`)

| Método | Ruta | Auth | Cuerpo |
|---|---|---|---|
| GET | `/health` | público | — |
| POST | `/orders` | Bearer | `{ customerName, addressText, lat, lng, phone? }` |
| GET | `/orders/:id` | Bearer | — |
| PATCH | `/orders/:id/status` | Bearer | `{ status }` |

`status`: `pending` → `assigned` → `in_transit` → `delivered`. Desde no terminales también `failed` / `cancelled`. Persistencia: clave `order:{id}` (JSON). Cada alta o cambio hace `XADD stream:orders`.

### service-fleet (`:3001`)

| Método | Ruta | Auth | Cuerpo |
|---|---|---|---|
| GET | `/health` | público | — |
| POST | `/fleet/couriers` | Bearer | `{ name, vehicle? }` |
| GET | `/fleet/couriers/:id` | Bearer | — |
| POST | `/fleet/location` | Bearer | `{ courierId, lat, lng, accuracyM?, orderId? }` |

Cada ping actualiza `courier:{id}` y hace `XADD stream:locations`.

### service-routing (`:3002`)

| Método | Ruta | Auth | Cuerpo |
|---|---|---|---|
| GET | `/health` | público | — |
| POST | `/routing/assign` | Bearer | `{ orderId, courierId }` |
| GET | `/routing/routes/:id` | Bearer | — |
| POST | `/routing/ingest-location` | Bearer | mismo payload que `/fleet/location` (MVP síncrono) |

Radio: `GEOFENCE_RADIUS_M` (por defecto **500**). Al acercarse al destino emite **una** vez `geofence_entered` (`SET NX geofence:entered:{routeId}` + `XADD stream:geofence`) y puede pasar el pedido a `in_transit`.

Routing **consume** `stream:locations` (`XREADGROUP cg:routing-locations`). `POST /routing/ingest-location` es el atajo síncrono si no quieres esperar al consumer.

## Smoke curl: 401 → pedido → courier → assign → location → geocerca

Coordenadas: Templo de Debod (destino) y un ping a ~40 m. Sol (~1,5 km) queda fuera de 500 m.

```bash
BASE=http://localhost:8080
TOKEN="$INTERNAL_SERVICE_TOKEN"   # el mismo que en .env / Contabo

# Health público (prefijo Contabo; nginx reescribe a GET /health)
curl -s "$BASE/orders/health"

# Sin Bearer → 401 {"error":"unauthorized"}
curl -s -o /tmp/anon.json -w '%{http_code}\n' -X POST "$BASE/orders" \
  -H 'content-type: application/json' \
  -d '{"customerName":"x","addressText":"y","lat":40.424,"lng":-3.7178}'
# 401

# Con Bearer → 201
ORDER=$(curl -s -X POST "$BASE/orders" \
  -H "Authorization: Bearer $TOKEN" \
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

COURIER=$(curl -s -X POST "$BASE/fleet/couriers" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"Ana Rider","vehicle":"moto"}')
COURIER_ID=$(printf '%s' "$COURIER" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.parse(s).id))')

ROUTE=$(curl -s -X POST "$BASE/routing/assign" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"orderId\":\"$ORDER_ID\",\"courierId\":\"$COURIER_ID\"}")
ROUTE_ID=$(printf '%s' "$ROUTE" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.parse(s).id))')

curl -s -X POST "$BASE/fleet/location" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"courierId\":\"$COURIER_ID\",\"lat\":40.4168,\"lng\":-3.7038,\"accuracyM\":8,\"orderId\":\"$ORDER_ID\"}"

curl -s -X POST "$BASE/fleet/location" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"courierId\":\"$COURIER_ID\",\"lat\":40.4243,\"lng\":-3.7175,\"accuracyM\":5,\"orderId\":\"$ORDER_ID\"}"

sleep 2
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/routing/routes/$ROUTE_ID"
# {"geofenceEntered":true,"status":"geofence_entered",...}
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

Pruebas del paquete compartido (Haversine + FSM + Bearer, sin Docker):

```bash
cd packages/shared && npm install && npm test
```

## CI (GitHub Actions)

Workflow: [`.github/workflows/logiq.yml`](../.github/workflows/logiq.yml). Independiente del monorepo **pnpm** (`apps/*`): Logiq usa **npm** + `package-lock.json`. No hay secretos de repo; el job genera `INTERNAL_SERVICE_TOKEN` y `REDIS_PASSWORD` con `openssl rand` a partir de `.env.example` (nunca se commitea `.env`).

**Triggers:** `push` y `pull_request` a `main` si cambia `logiq/**` o el propio workflow; también `workflow_dispatch`. Cambios solo en `apps/*` no disparan este CI.

| Job | Qué hace |
|---|---|
| `unit` | `npm ci` + `typecheck` en `packages/shared` y los tres servicios; `npm test` en shared (Haversine, FSM, Bearer). No hay ESLint en Logiq: el “lint” es `tsc --noEmit`. Los servicios no tienen script `test`. |
| `docker-build` | `docker build` de las tres imágenes (matriz, **sin push** a registry). Caza roturas de Dockerfile / `npm ci`. |
| `smoke` | Tras unit + imágenes: compose con Redis + gateway; `scripts/smoke.sh` (health público, POST anónimo → 401, Bearer → 201, geocerca). Corre en `ubuntu-latest` con Docker del runner. |

Si el smoke de compose se vuelve inestable en runners de GitHub, se puede marcar el job como opcional y dejar verdes `unit` + `docker-build`.

Re-ejecutar en local (mismo criterio que Actions):

```bash
cd logiq
./scripts/ci-unit.sh

docker build -f services/service-orders/Dockerfile -t logiq-service-orders:ci .
docker build -f services/service-fleet/Dockerfile -t logiq-service-fleet:ci .
docker build -f services/service-routing/Dockerfile -t logiq-service-routing:ci .

cp .env.example .env
# OPENSSL: openssl rand -hex 32 → INTERNAL_SERVICE_TOKEN
#          openssl rand -hex 24 → REDIS_PASSWORD
docker compose up -d --build --wait
BASE=http://127.0.0.1:8080 ./scripts/smoke.sh
docker compose down -v
```

## Caddy opcional (TLS)

Este compose **no** incluye Caddy. Nginx en `8080` basta para el smoke. En un VPS (Contabo u otro) pon Caddy delante del gateway, o sustituye nginx y deja Redis + servicios en la red interna.

Contabo ya aplica el mismo contrato: Bearer en escrituras/lecturas de negocio y `/{servicio}/health` con strip de prefijo hacia `GET /health`.

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
