# Plan de despliegue — mañana

PRs #1 (web-cliente), #2 (ops) y #3 (README) ya están en `main`. Orden de merge y qué verifica Grey: **`deploy/MERGE_ORDER.md`** (`#4 → #5 → #6 → #7 → #8 → #10 → #11`, con **#9 rebaseado sobre #11**). `ACME_EMAIL` real, agencia sin seed y DNS/TLS son **operacional en el VPS**, no un diff.

1. Merge según `deploy/MERGE_ORDER.md` (o desplegar el SHA que los incluya: non-root, backup/restore, `COPY --chown=101:101` del `dist` de web, quiet hours).
2. Completar `.env.production` desde `.env.production.example` (secretos reales, CSPRNG, `ACME_EMAIL` real). No commitear el fichero. Esto es VPS, no código.
3. DNS: `SITE_TRACKING` y `SITE_API` → IP del VPS; abrir 80/443. TLS/ACME es operacional.
4. Crear agencia de prod a mano (hash SHA-256 de la API key). Prod **no** monta `infra/postgres/02-seed.sql`.
5. Arranque:

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production build
   docker compose -f docker-compose.prod.yml --env-file .env.production up -d
   ```

6. Esperar healthy: `postgres`, `redis`, `api`, `web`, `workers`. Caddy arranca con `service_healthy` de `api` y `web`.
7. `./scripts/prod-healthcheck.sh "https://$SITE_API" "https://$SITE_TRACKING"`
8. **Antes de go-live:** backup inicial + dry-run de restore en staging (otra instancia/volumen, nunca `pgdata_prod`). `CONFIRM=yes ./scripts/restore-postgres.sh <dump>` y `scripts/verify-postgis.sql` (extensión PostGIS, `geography_columns`, `ST_DWithin`). Sin restore verificado no se abre tráfico. Detalle: `deploy/BACKUP_RESTORE.md`.
9. Smoke: tracking `?token=`, **Estaré ahí** (`/api/tracking/confirm-presence`), `POST /api/ops/checks`. `GET /repartidor/<id>/ruta-hoy` sin `x-api-key` debe ser **401**.
10. Revisar `ops_alerts` `open` = 0 críticos (`GET /api/ops/health` → `openCriticalAlerts`).
11. Rollback: `docker compose -f docker-compose.prod.yml --env-file .env.production down` + imagen/`IMAGE` anterior si etiquetaste builds. Datos: restaurar el dump previo (`CONFIRM=yes`).
