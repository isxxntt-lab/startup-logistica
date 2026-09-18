# Checklist seguridad producción

Infra Docker/Caddy: PR #4. Follow-up #5: ops docs, healthcheck HTTP, rate-limit del poll y auth de `/ws/repartidor`. #6 endurece compose (read_only, healthchecks, redes) y ACME en Caddy. #7 cierra auth HTTP de `/repartidor/*`. Non-root: PR #8. Este PR: backup + restore de Postgres/PostGIS.

## Cubierto en código / compose (#4–#8 + backup/restore)

- [x] `.env.production` no está en git; solo `.env.production.example`
- [x] Postgres/Redis sin `ports` públicos (solo red `internal` en `docker-compose.prod.yml`)
- [x] API en `edge` + `internal` (Caddy la alcanza por `edge`; datos por `internal`)
- [x] Caddy solo en `edge` (80/443); no tiene L3 a PostGIS/Redis
- [x] Arranque en `NODE_ENV=production` exige `DATABASE_URL`, `REDIS_URL`, `JWT_MASTER_SECRET`, `PUBLIC_WEB_URL`
- [x] CORS restringido con `CORS_ORIGIN`
- [x] Tokens de tracking: TTL 48h + `token_expira_at`; logs con huella (`tokenPrefix`/`tokenHash`), nunca el JWT completo
- [x] `/api/ops/health` público; métricas/logs/checks con `x-api-key` o `x-ops-token`
- [x] Rate limit del poll `GET /api/tracking/position` (30/min por IP+token; el SPA poll-ea cada 8s)
- [x] `/ws/repartidor` autentica con API key de agencia (header `x-api-key` o mensaje `{ tipo: "auth", apiKey, id }`)
- [x] HTTP `/repartidor/*` (y `POST /events/location_update`) exige la misma API key: 401 sin clave/clave inválida, 403 si el recurso no es de esa agencia
- [x] `read_only: true` + `no-new-privileges` + `tmpfs` en caddy/web/api/workers/redis (Postgres no es read-only: escribe el datadir)
- [x] Healthchecks de `web` (HTTP nginx :8080) y `workers` (ping Redis + `SELECT 1` en Postgres)
- [x] Email ACME en Caddy (`ACME_EMAIL` / bloque global `{ email ... }`)
- [x] USER ≠ 0 en api/workers (`USER 10001:10001`, usuario `app`) y web (`nginxinc/nginx-unprivileged`, `USER 101`, `listen 8080`)
- [x] Scripts de backup/restore PostGIS (`scripts/backup-postgres.sh`, `scripts/restore-postgres.sh`) + runbook `deploy/BACKUP_RESTORE.md`

## Operacional (hacer en el VPS, no es diff)

- [ ] `JWT_MASTER_SECRET`, `OPS_TOKEN`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD` generados con CSPRNG (≥32 bytes)
- [ ] API key de agencia real (prod **no** carga `02-seed.sql`; no usar `demo-api-key`)
- [ ] DNS A/AAAA de `SITE_TRACKING` y `SITE_API` al VPS; Caddy TLS (Let's Encrypt) con `ACME_EMAIL` real
- [ ] Healthchecks verdes (`./scripts/prod-healthcheck.sh`) **antes** de abrir DNS público
- [ ] Dry-run de restore en staging (u otro Postgres throwaway, **nunca** `pgdata_prod`): backup → `CONFIRM=yes` restore → `scripts/verify-postgis.sql` (`PostGIS_Version`, `geography_columns`, `ST_DWithin`) **antes** de go-live

## Pendiente (fuera de este PR)

- [ ] Quiet hours / consentimiento WA–SMS (el worker no implementa franja horaria)
- [ ] TTL tracking 48h: el gate y la huella en logs ya existen; no se cambia la política en este PR
- [ ] Rotar `x-api-key` / `OPS_TOKEN` y restringir quién llama a `/api/ops/*`
