# Startup Logística — Anti-entregas fallidas

MVP event-driven (Fastify + Redis Streams + PostgreSQL/PostGIS) para last mile B2B en España.

## Requisitos

- Node.js 20+
- pnpm 9
- Docker Desktop (Postgres PostGIS + Redis)

En esta máquina, al crear el repo, **aún no había Node, Git ni Docker en el PATH**. Instálalos y vuelve a abrir la terminal.

## Arranque

```bash
copy .env.example .env
docker compose up -d
pnpm install
pnpm dev:api
pnpm dev:workers
pnpm dev:web
pnpm dev:repartidor
```

- API: http://localhost:3000/health
- Web cliente: http://localhost:5173/?token=…
- App repartidor demo: http://localhost:5174

## Demo

API key de la agencia seed: `demo-api-key`

Generar enlace del cliente para una parada:

```bash
curl -X POST http://localhost:3000/agencia/paradas/55555555-5555-5555-5555-555555555554/token ^
  -H "x-api-key: demo-api-key"
```

Abre la `url` que devuelve. Marcar entregas en la app del repartidor dispara el evento de **progreso de ruta** (no geoespacial): si faltan exactamente 3 paradas, el worker encola WhatsApp.

## Piezas

| Paquete | Rol |
|---|---|
| `packages/shared` | Tipos, nombres de streams, máquina de estados de `paradas` |
| `apps/api` | HTTP + WebSocket + encolado. Los webhooks solo validan firma y hacen `XADD` |
| `apps/workers` | Consumer groups: notificaciones, webhooks inbound, geocerca `ST_DWithin`, progreso de ruta |
| `apps/web-cliente` | SPA sin login (`?token=` en la URL) + Leaflet |
| `apps/web-repartidor` | Simulador para probar GPS y WS |

Sin credenciales Twilio, las notificaciones se registran en modo dry-run en consola y en `eventos_notificacion`.
