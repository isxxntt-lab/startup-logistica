# Orden de merge (#4 → #12 + smoke staging)

PRs de infra ya en vuelo. **No hay features nuevas en #11**: solo el orden, qué mira Grey en el diff, y qué queda en el VPS. Este documento refleja el **restack**: quiet hours (**#9 rebaseado** sobre #11) entra en **#12**. Este PR apila la documentación de **smoke staging E2E** sobre el head de #12.

Orden lineal (Camino A, head más completo):

**#4 → #5 → #6 → #7 → #8 → #10 → #11 → #12 → este PR (smoke staging E2E)**

Quiet hours (#9) **incluye** #8 (non-root), #10 (backup/restore) y #11 (`COPY --chown=101:101` + este orden). #12 añade el rebase + backoff `RESUME_ERROR`.

## Grafo (tras el restack)

```
#4 Docker/Caddy
 └─ #5 checklist, healthcheck, rate-limit poll, auth WS
     └─ #6 read_only, healthchecks, ACME, headers
         └─ #7 auth HTTP /repartidor/*
              └─ #8 USER ≠ 0, nginx :8080
                   └─ #10 backup/restore PostGIS
                        └─ #11 COPY --chown=101:101 + MERGE_ORDER
                             └─ #12: #9 quiet hours rebaseado + backoff RESUME_ERROR
                                  └─ este PR: smoke staging E2E (docs, antes de DNS público)
```

**#9 ya no está solo sobre #7.** El código de quiet hours (`packages/shared`, `apps/workers`, `infra/postgres/04-ops.sql`) no solapa con non-root ni backup. Los conflictos al rebasear fueron de docs y se resolvieron conservando quiet hours **y** backup/non-root/chown:

- `deploy/DEPLOY_PLAN_MANANA.md`
- `deploy/SECURITY_CHECKLIST.md`
- `.env.production.example` (`NOTIFICATION_RETRY_POLL_MS` + `BACKUP_KEEP_DAYS`)
- `README.md`

### Camino A — hecho hasta #12; este PR es docs de smoke

1. Merge **#4 → #5 → #6 → #7 → #8 → #10 → #11** (ya es lineal).
2. **#12**: rebase #9 sobre el head de #11 (`cursor/grey-chown-merge-order-9f1e`) + backoff `RESUME_ERROR`.
3. **Este PR** (sobre el head de #12): `deploy/STAGING_SMOKE.md` y pasos opcionales en `scripts/prod-healthcheck.sh` (`STAGING_BASE` / `STAGING_SMOKE=1`). Smoke **antes** de DNS público.

En git, #9 entra *después* de #11 (vía #12). El número de PR original de quiet hours no cambia el orden de commits.

### Camino B — respetar el número #8 → #9 → #10 (no usado)

1. Merge #4 → #8.
2. Rebase **#9 sobre #8**, mergear #9.
3. Rebase **#10 y #11 sobre #9**, mergear #10 y luego el chown.

Más movimiento de ramas; mismo resultado de código si los docs se resuelven bien.

## Qué verifica Grey en cada PR (diff, no VPS)

| PR | Qué es | Grey mira en el diff |
|---|---|---|
| **#4** | Dockerfiles, `docker-compose.prod.yml`, `Caddyfile`, `.env.production.example` | Imágenes en `apps/api`, `apps/workers`, `apps/web-cliente`. Caddy 80/443. PostGIS/Redis **sin** `ports` al host. **Sin** `02-seed.sql` en prod. `SITE_TRACKING` / `SITE_API`. Arranque prod exige secretos. |
| **#5** | Ops de go-live + huecos de #4 | `deploy/SECURITY_CHECKLIST.md`, `deploy/DEPLOY_PLAN_MANANA.md`, `scripts/prod-healthcheck.sh`. Rate-limit `GET /api/tracking/position` 30/min. Auth de `/ws/repartidor` con API key. |
| **#6** | Endurecer compose | Healthcheck API: `GET /api/ops/health` + fallback `/health`. tmpfs web nginx (`/var/cache/nginx`, `/var/run`, `/var/log/nginx`, `/var/lib/nginx`, `/tmp`). Caddy `80:80`, `443:443`, `443:443/udp`. Tras `reverse_proxy`: HSTS, `nosniff`, `DENY`, `strict-origin-when-cross-origin`, `-Server`. `read_only` + `no-new-privileges`. `ACME_EMAIL` en bloque global Caddy. |
| **#7** | Auth HTTP repartidor | `/repartidor/*` y `POST /events/location_update` con la **misma** API key que el WS: **401** sin clave/inválida, **403** si el recurso no es de esa agencia. |
| **#8** | Non-root | Último `USER` ≠ 0. api/workers `USER 10001:10001`. web `nginxinc/nginx-unprivileged`, `USER 101`, `listen 8080`, compose `expose: ["8080"]`, Caddy `reverse_proxy web:8080`. |
| **#10** | Backup/restore PostGIS | `scripts/backup-postgres.sh` (timestamp, SHA-256, `umask 077`). Restore **destructivo** solo con `CONFIRM=yes` exacto. `PLAN=1` no muta. `scripts/verify-postgis.sql`. Runbook `deploy/BACKUP_RESTORE.md`. |
| **#11** | Follow-up Grey (chown) | En `apps/web-cliente/Dockerfile`: `COPY --from=build --chown=101:101 …/dist /usr/share/nginx/html`. |
| **#9 / #12** | Quiet hours + consentimiento (rebaseado sobre #11) + backoff Grey | Europe/Madrid **22:00–08:00**: WA/SMS **aplazados** (`QUIET_HOURS`, `next_retry_at` = 08:00), **sin** fallback a SMS de noche. Canal `app` (push) **sí** envía. Sin consentimiento → `skipped`. Incluye #8+#10+#11. `RESUME_ERROR`: `next_retry_at` con backoff **30s → 2m → 10m**; `failed` al 4.º intento (no reintenta cada poll). |
| **este PR** | Smoke staging E2E (docs) | `deploy/STAGING_SMOKE.md`: compose up → health/ops → GPS geocerca → notificación dry-run (o `QUIET_HOURS`) → `confirm-presence` → métricas `failureAvoided`/`dwell` → backup + restore `PLAN=1`. `scripts/prod-healthcheck.sh` opcional con `STAGING_BASE` / `STAGING_SMOKE=1`. **Antes de DNS público.** Sin Twilio/Meta reales, sin ACME real, sin VPS. |

Contrato automatizado (sin Docker ni VPS):

```bash
node --test scripts/prod-compose.test.mjs scripts/backup-restore.test.mjs
pnpm --filter @startup-logistica/shared test
pnpm --filter @startup-logistica/workers test
```

## Operacional en el VPS — no es código

Esto **no** se cierra con un merge. No hay diff que lo sustituya. Grey no lo “aprueba” en GitHub; se hace en la máquina.

| Ítem | Por qué no es PR |
|---|---|
| `ACME_EMAIL` **real** en `.env.production` | La plantilla trae placeholder / default `ops@rutacerca.es`. Let's Encrypt necesita un buzón de verdad. El fichero **no** se commitea. |
| Agencia de prod **sin seed** | Compose de prod **no** monta `infra/postgres/02-seed.sql`. Crear agencia a mano (hash SHA-256 de la API key). No usar `demo-api-key`. |
| DNS A/AAAA de `SITE_TRACKING` y `SITE_API` → IP del VPS | Apuntar dominios y abrir 80/443. Caddy saca TLS. |
| Certificados ACME / TLS | Tras DNS correcto. Healthcheck verde **antes** de abrir tráfico público. |
| Secretos CSPRNG | `JWT_MASTER_SECRET`, `OPS_TOKEN`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD` (≥32 bytes). |
| Dry-run de restore | Otra instancia/volumen, **nunca** `pgdata_prod`. `CONFIRM=yes` + `verify-postgis.sql` **antes** de go-live. Detalle: `deploy/BACKUP_RESTORE.md`. |
| Smoke E2E de staging | Compose local + seed. `deploy/STAGING_SMOKE.md`. **Antes** de DNS A/AAAA público. Healthcheck opcional: `STAGING_BASE` + `STAGING_SMOKE=1`. Twilio/Meta vacíos (dry-run). Sin ACME. |

Pasos de arranque: `deploy/DEPLOY_PLAN_MANANA.md`. Smoke staging: `deploy/STAGING_SMOKE.md`. Checklist: `deploy/SECURITY_CHECKLIST.md`.
