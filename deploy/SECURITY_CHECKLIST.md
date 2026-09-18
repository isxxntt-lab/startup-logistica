# Checklist seguridad producción

Infra Docker/Caddy: PR #4. Este follow-up cubre ops docs, healthcheck, rate-limit del poll y auth de `/ws/repartidor`.

## Cubierto en código / compose (#4 + este PR)

- [x] `.env.production` no está en git; solo `.env.production.example`
- [x] Postgres/Redis sin `ports` públicos (red `internal` en `docker-compose.prod.yml`)
- [x] Arranque en `NODE_ENV=production` exige `DATABASE_URL`, `REDIS_URL`, `JWT_MASTER_SECRET`, `PUBLIC_WEB_URL`
- [x] CORS restringido con `CORS_ORIGIN`
- [x] Tokens de tracking: TTL 48h + `token_expira_at`; logs con huella (`tokenPrefix`/`tokenHash`), nunca el JWT completo
- [x] `/api/ops/health` público; métricas/logs/checks con `x-api-key` o `x-ops-token`
- [x] Rate limit del poll `GET /api/tracking/position` (30/min por IP+token; el SPA poll-ea cada 8s)
- [x] `/ws/repartidor` autentica con API key de agencia (header `x-api-key` o mensaje `{ tipo: "auth", apiKey, id }`)

## Operacional (hacer en el VPS, no es diff)

- [ ] `JWT_MASTER_SECRET`, `OPS_TOKEN`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD` generados con CSPRNG (≥32 bytes)
- [ ] API key de agencia real (prod **no** carga `02-seed.sql`; no usar `demo-api-key`)
- [ ] DNS A/AAAA de `SITE_TRACKING` y `SITE_API` al VPS; Caddy TLS (Let's Encrypt)
- [ ] Email ACME en Caddy (hoy no hay `ACME_EMAIL` en el Caddyfile de #4)
- [ ] Healthchecks verdes (`./scripts/prod-healthcheck.sh`) **antes** de abrir DNS público
- [ ] Quiet hours / consentimiento WA/SMS revisados con negocio (el worker aún no implementa franja horaria)
- [ ] Backup de Postgres + restore de prueba
- [ ] Rotar `x-api-key` / `OPS_TOKEN` y restringir quién llama a `/api/ops/*`

## Endurecimiento compose pendiente (no reescribir #4 en este PR)

- [ ] `read_only: true` + `no-new-privileges` + `tmpfs` en api/web/workers
- [ ] Healthcheck de `web`/`workers` (hoy Caddy espera `web` con `service_started`)
