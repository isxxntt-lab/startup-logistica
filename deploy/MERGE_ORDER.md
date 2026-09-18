# Orden de merge (#4 → #10)

PRs de infra ya en vuelo. **No hay features nuevas aquí**: solo el orden, qué mira Grey en el diff, y qué queda en el VPS.

Orden acordado:

**#4 → #5 → #6 → #7 → #8 → #9 → #10**

Luego este follow-up (chown del `dist` de web + este documento), apilado sobre **#10**.

## Grafo actual (por qué #9 necesita rebase)

```
#4 Docker/Caddy
 └─ #5 checklist, healthcheck, rate-limit poll, auth WS
     └─ #6 read_only, healthchecks, ACME, headers
         └─ #7 auth HTTP /repartidor/*
              ├─ #9 quiet hours + consentimiento WA/SMS   ← solo sobre #7
              └─ #8 USER ≠ 0, nginx :8080
                   └─ #10 backup/restore PostGIS
                        └─ este PR (COPY --chown=101:101 + MERGE_ORDER)
```

**#9 no incluye #8 ni #10.** Si se mergea #8 (o #10) antes que #9, **#9 hay que rebasearlo**.

Conflictos esperados al rebasear #9 sobre #10 (docs, no lógica):

- `deploy/DEPLOY_PLAN_MANANA.md`
- `deploy/SECURITY_CHECKLIST.md`
- `.env.production.example` (`NOTIFICATION_RETRY_POLL_MS` en #9 vs `BACKUP_KEEP_DAYS` en #10)
- `README.md`

El código de quiet hours (`packages/shared`, `apps/workers`, `infra/postgres/04-ops.sql`) no solapa con non-root ni backup.

### Camino A — head más completo (recomendado en este run)

Este PR ya está sobre **#10**. No deshacer ese stack:

1. Merge **#4 → #5 → #6 → #7 → #8 → #10** (ya es lineal) y este follow-up.
2. **Rebase #9 sobre ese head** (`cursor/grey-chown-merge-order-9f1e` o `main` tras el merge) y mergear #9.
3. Resolver los cuatro ficheros de docs: conservar quiet hours **y** backup/non-root/chown.

En git, #9 entra *después* de #10. El número de PR no cambia; el orden de commits sí.

### Camino B — respetar el número #8 → #9 → #10

1. Merge #4 → #8.
2. Rebase **#9 sobre #8**, mergear #9.
3. Rebase **#10 y este PR sobre #9**, mergear #10 y luego el chown.

Más movimiento de ramas; mismo resultado de código si los docs se resuelven bien.

## Qué verifica Grey en cada PR (diff, no VPS)

| PR | Qué es | Grey mira en el diff |
|---|---|---|
| **#4** | Dockerfiles, `docker-compose.prod.yml`, `Caddyfile`, `.env.production.example` | Imágenes en `apps/api`, `apps/workers`, `apps/web-cliente`. Caddy 80/443. PostGIS/Redis **sin** `ports` al host. **Sin** `02-seed.sql` en prod. `SITE_TRACKING` / `SITE_API`. Arranque prod exige secretos. |
| **#5** | Ops de go-live + huecos de #4 | `deploy/SECURITY_CHECKLIST.md`, `deploy/DEPLOY_PLAN_MANANA.md`, `scripts/prod-healthcheck.sh`. Rate-limit `GET /api/tracking/position` 30/min. Auth de `/ws/repartidor` con API key. |
| **#6** | Endurecer compose | Healthcheck API: `GET /api/ops/health` + fallback `/health`. tmpfs web nginx (`/var/cache/nginx`, `/var/run`, `/var/log/nginx`, `/var/lib/nginx`, `/tmp`). Caddy `80:80`, `443:443`, `443:443/udp`. Tras `reverse_proxy`: HSTS, `nosniff`, `DENY`, `strict-origin-when-cross-origin`, `-Server`. `read_only` + `no-new-privileges`. `ACME_EMAIL` en bloque global Caddy. |
| **#7** | Auth HTTP repartidor | `/repartidor/*` y `POST /events/location_update` con la **misma** API key que el WS: **401** sin clave/inválida, **403** si el recurso no es de esa agencia. |
| **#8** | Non-root | Último `USER` ≠ 0. api/workers `USER 10001:10001`. web `nginxinc/nginx-unprivileged`, `USER 101`, `listen 8080`, compose `expose: ["8080"]`, Caddy `reverse_proxy web:8080`. |
| **#9** | Quiet hours + consentimiento | Europe/Madrid **22:00–08:00**: WA/SMS **aplazados** (`QUIET_HOURS`, `next_retry_at` = 08:00), **sin** fallback a SMS de noche. Canal `app` (push) **sí** envía. Sin consentimiento → `skipped`. |
| **#10** | Backup/restore PostGIS | `scripts/backup-postgres.sh` (timestamp, SHA-256, `umask 077`). Restore **destructivo** solo con `CONFIRM=yes` exacto. `PLAN=1` no muta. `scripts/verify-postgis.sql`. Runbook `deploy/BACKUP_RESTORE.md`. |
| **Este PR** | Follow-up Grey | En `apps/web-cliente/Dockerfile`: `COPY --from=build --chown=101:101 …/dist /usr/share/nginx/html`. Este fichero. |

Contrato automatizado (sin Docker ni VPS):

```bash
node --test scripts/prod-compose.test.mjs scripts/backup-restore.test.mjs
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

Pasos de arranque: `deploy/DEPLOY_PLAN_MANANA.md`. Checklist: `deploy/SECURITY_CHECKLIST.md`.
