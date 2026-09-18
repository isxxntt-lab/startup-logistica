# Plan de despliegue — mañana

PRs #1 (web-cliente), #2 (ops) y #3 (README) ya están en `main`. Orden de merge y qué verifica Grey: **`deploy/MERGE_ORDER.md`** (`#4 → #5 → #6 → #7 → #8 → #10 → #11 → #12`, más **smoke staging**). `ACME_EMAIL` real, agencia sin seed y DNS/TLS son **operacional en el VPS**, no un diff.

1. Merge según `deploy/MERGE_ORDER.md` (o desplegar el SHA que los incluya: non-root, backup/restore, `COPY --chown=101:101` del `dist` de web, quiet hours).
2. Completar `.env.production` desde `.env.production.example` (secretos reales, CSPRNG, `ACME_EMAIL` real). No commitear el fichero. Esto es VPS, no código.
3. **Smoke staging E2E antes de DNS público** — `deploy/STAGING_SMOKE.md` (compose local + seed, Twilio/Meta vacíos, sin ACME, sin VPS): compose up → `/health` + `/api/ops/health` → pings GPS geocerca → notificación dry-run (o `QUIET_HOURS`) → `POST /api/tracking/confirm-presence` → métricas `failureAvoided`/`dwell` → backup + restore `PLAN=1`. Atajo: `STAGING_BASE=http://localhost:3000 STAGING_SMOKE=1 AGENCY_API_KEY=demo-api-key ./scripts/prod-healthcheck.sh`.
4. DNS: `SITE_TRACKING` y `SITE_API` → IP del VPS; abrir 80/443. TLS/ACME es operacional (**después** del smoke, no antes).
5. Crear agencia de prod a mano (hash SHA-256 de la API key). Prod **no** monta `infra/postgres/02-seed.sql`.
6. Arranque:

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production build
   docker compose -f docker-compose.prod.yml --env-file .env.production up -d
   ```

7. Esperar healthy: `postgres`, `redis`, `api`, `web`, `workers`. Caddy arranca con `service_healthy` de `api` y `web`.
8. `./scripts/prod-healthcheck.sh "https://$SITE_API" "https://$SITE_TRACKING"` (sin `STAGING_SMOKE=1`: no muta seed ni corre contra DNS público de staging).
9. **Antes de go-live:** backup inicial + dry-run de restore en staging (otra instancia/volumen, nunca `pgdata_prod`). `CONFIRM=yes ./scripts/restore-postgres.sh <dump>` y `scripts/verify-postgis.sql` (extensión PostGIS, `geography_columns`, `ST_DWithin`). Sin restore verificado no se abre tráfico. Detalle: `deploy/BACKUP_RESTORE.md`. El `PLAN=1` del smoke staging **no** sustituye este restore destructivo en throwaway.
10. Smoke de prod (ya validado en staging): tracking `?token=`, **Estaré ahí** (`/api/tracking/confirm-presence`), `POST /api/ops/checks`. `GET /repartidor/<id>/ruta-hoy` sin `x-api-key` debe ser **401**.
11. Revisar `ops_alerts` `open` = 0 críticos (`GET /api/ops/health` → `openCriticalAlerts`).
12. Rollback: `docker compose -f docker-compose.prod.yml --env-file .env.production down` + imagen/`IMAGE` anterior si etiquetaste builds. Datos: restaurar el dump previo (`CONFIRM=yes`).
