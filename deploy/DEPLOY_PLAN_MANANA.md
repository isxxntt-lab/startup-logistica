# Plan de despliegue — mañana

PRs #1 (web-cliente), #2 (ops) y #3 (README) ya están en `main`. Infra de contenedores: **PR #4**. Go-live ops + auth WS: **PR #5**. Compose endurecido: **PR #6**. Este follow-up cierra auth HTTP de `/repartidor/*`.

1. Merge PR #4, #5, #6 y este follow-up (o desplegar el SHA que los incluya).
2. Completar `.env.production` desde `.env.production.example` (secretos reales, CSPRNG, `ACME_EMAIL` real). No commitear el fichero.
3. DNS: `SITE_TRACKING` y `SITE_API` → IP del VPS; abrir 80/443.
4. Crear agencia de prod a mano (hash SHA-256 de la API key). Prod **no** monta `infra/postgres/02-seed.sql`.
5. Arranque:

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production build
   docker compose -f docker-compose.prod.yml --env-file .env.production up -d
   ```

6. Esperar healthy: `postgres`, `redis`, `api`, `web`, `workers`. Caddy arranca con `service_healthy` de `api` y `web`.
7. `./scripts/prod-healthcheck.sh "https://$SITE_API" "https://$SITE_TRACKING"`
8. Smoke: tracking `?token=`, **Estaré ahí** (`/api/tracking/confirm-presence`), `POST /api/ops/checks`. `GET /repartidor/<id>/ruta-hoy` sin `x-api-key` debe ser **401**.
9. Revisar `ops_alerts` `open` = 0 críticos (`GET /api/ops/health` → `openCriticalAlerts`).
10. Rollback: `docker compose -f docker-compose.prod.yml --env-file .env.production down` + imagen/`IMAGE` anterior si etiquetaste builds.
