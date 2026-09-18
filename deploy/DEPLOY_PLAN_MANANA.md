# Plan de despliegue — mañana

PRs #1 (web-cliente), #2 (ops) y #3 (README) ya están en `main`. La infra de contenedores está en **PR #4** (`cursor/prod-docker-caddy-81b7`). Este follow-up no toca Dockerfiles ni compose.

1. Merge PR #4 y este follow-up (o desplegar el SHA que los incluya).
2. Completar `.env.production` desde `.env.production.example` (secretos reales, CSPRNG). No commitear el fichero.
3. DNS: `SITE_TRACKING` y `SITE_API` → IP del VPS; abrir 80/443.
4. Crear agencia de prod a mano (hash SHA-256 de la API key). Prod **no** monta `infra/postgres/02-seed.sql`.
5. Arranque:

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production build
   docker compose -f docker-compose.prod.yml --env-file .env.production up -d
   ```

6. Esperar healthy: `api`, `postgres`, `redis`. `web` no tiene healthcheck en #4; Caddy arranca con `service_started`.
7. `./scripts/prod-healthcheck.sh "https://$SITE_API" "https://$SITE_TRACKING"`
8. Smoke: tracking `?token=`, **Estaré ahí** (`/api/tracking/confirm-presence`), `POST /api/ops/checks`.
9. Revisar `ops_alerts` `open` = 0 críticos (`GET /api/ops/health` → `openCriticalAlerts`).
10. Rollback: `docker compose -f docker-compose.prod.yml --env-file .env.production down` + imagen/`IMAGE` anterior si etiquetaste builds.
