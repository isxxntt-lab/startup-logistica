# Backup y restore de Postgres/PostGIS (producción)

Runbook operativo. Los scripts **no** publican PostGIS: el dump sale por `docker compose exec` a la red `internal`, o por `DATABASE_URL`/`PG*` si hay cliente en el host (túnel SSH, staging).

| Pieza | Rol |
|---|---|
| `scripts/backup-postgres.sh` | `pg_dump` (custom o plain) con timestamp, checksum SHA-256 y metadatos |
| `scripts/restore-postgres.sh` | Restore **destructivo**. Exige `CONFIRM=yes` |
| `scripts/verify-postgis.sql` | Comprueba extensión PostGIS, `geography`, GIST y `ST_DWithin` |
| `.env.production` | Origen de `DATABASE_URL` o `PG*` / `POSTGRES_*` (no está en git) |

## Riesgo

Un restore **no fusiona**. `DROP DATABASE` + `CREATE DATABASE` (default) borra paradas, tokens de destinatario, agencias, geometrías `geography(Point, 4326)` y la extensión PostGIS del destino. El único undo es otro dump. Por eso el script aborta con código 2 si `CONFIRM` no es exactamente `yes` (`YES`, `true` o `1` no valen).

Nunca apuntes un dump de prueba a producción. El dry-run de go-live se hace en **staging** (u otro Postgres throwaway), no contra el volumen `pgdata_prod`.

## Frecuencia sugerida

| Cuándo | Qué |
|---|---|
| Diario (madrugada, p. ej. 03:15 Europe/Madrid) | Backup automático custom |
| Antes de cada deploy / migración SQL | Backup manual y retención extra (no lo borre el prune) |
| Tras crear la agencia real de prod | Primer dump “día 0” |
| Tras un incidente de datos | Backup de estado actual **antes** de tocar nada |

Cron en el VPS (ajusta la ruta del clone):

```cron
15 3 * * * root cd /opt/startup-logistica && ENV_FILE=.env.production BACKUP_KEEP_DAYS=14 ./scripts/backup-postgres.sh >> /var/log/rutacerca-pg-backup.log 2>&1
```

El dump diario no sustituye un offsite: si el VPS muere, los ficheros en el mismo disco no sirven.

## Retención

| Copia | Retención |
|---|---|
| Local (`BACKUP_DIR`, default `./backups/postgres`) | 14 días (`BACKUP_KEEP_DAYS=14` en el cron) |
| Offsite (otro disco, VPS o bucket privado) | 30 días o 4 dumps semanales + 1 mensual |
| Pre-deploy | Hasta validar el release (no aplicar prune a esos nombres) |

Permisos: los scripts usan `umask 077` (ficheros `600`, directorio `700`). El dump contiene hashes de API keys, teléfonos y geometrías. No lo copies a Slack ni a un volume world-readable.

Offsite mínimo, sin introducir un vendor en este repo:

```bash
rsync -a --chmod=600 backups/postgres/ backup-host:/var/backups/rutacerca/postgres/
```

## Backup

Desde el directorio del repo, con `.env.production` poblado:

```bash
./scripts/backup-postgres.sh
```

Equivale a `FORMAT=custom` (archivo `.dump` para `pg_restore`, comprimido). Plain SQL:

```bash
FORMAT=plain ./scripts/backup-postgres.sh
```

`custom` es el formato por defecto: permite `--exit-on-error`, no reescribe a mano el SQL de PostGIS y pesa menos. Usa `plain` solo si necesitas auditar el SQL.

El script:

1. Carga `ENV_FILE` (default `.env.production`) vía `scripts/lib/pg_env.py` (`DATABASE_URL` o `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`).
2. Elige backend `auto`: `docker compose exec postgres` si el servicio está up; si no, `pg_dump` del host.
3. Escribe `backups/postgres/<db>_<YYYYMMDDTHHMMSSZ>.dump` + `.sha256` + `.meta.json`.
4. Sale con código ≠ 0 si el dump está vacío, falla `pg_dump` o no hay checksum.

Overrides útiles:

```bash
ENV_FILE=.env.production
BACKUP_DIR=/var/backups/rutacerca/postgres
BACKUP_VIA=docker          # fuerza compose; host = postgresql-client
COMPOSE_FILE=docker-compose.prod.yml
FORMAT=custom              # o plain
BACKUP_KEEP_DAYS=14
```

En producción PostGIS **no publica ports**. `BACKUP_VIA=docker` es el camino normal en el VPS:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres pg_dump ...
```

Los scripts encapsulan eso. No hace falta exponer `5432`.

Staging / laptop (compose local con `5432` publicado):

```bash
ENV_FILE=.env BACKUP_VIA=host ./scripts/backup-postgres.sh
```

Logs a stderr; la última línea de stdout es la ruta del dump (útil para encadenar).

## Restore

```bash
# Solo el plan (no muta, no pide CONFIRM)
PLAN=1 ./scripts/restore-postgres.sh backups/postgres/startup_logistica_20260101T031500Z.dump

# Ejecución real
CONFIRM=yes ./scripts/restore-postgres.sh backups/postgres/startup_logistica_20260101T031500Z.dump
```

Default `DROP_AND_RECREATE=1`: termina backends, `DROP DATABASE`, `CREATE DATABASE`, `pg_restore --no-owner --no-acl --exit-on-error`. Luego `scripts/verify-postgis.sql`.

Con compose de prod, `STOP_APPS=1` (default) hace `docker compose stop api workers` durante el restore y los vuelve a arrancar. Postgres y Redis siguen up.

| Variable | Default | Efecto |
|---|---|---|
| `CONFIRM` | (vacío) | Debe ser `yes` o el script sale 2 |
| `DROP_AND_RECREATE` | `1` | `0` restaura sobre la base existente (PostGIS puede chocar) |
| `VERIFY` | `1` | Corre `verify-postgis.sql` |
| `STOP_APPS` | `1` | Para api/workers en compose |
| `CONFIRM_DELAY_SECONDS` | `0` | Pausa extra tras el aviso (p. ej. `5` en prod) |
| `RESTORE_VIA` | `auto` | Igual que `BACKUP_VIA` |

Si existe `foo.dump.sha256`, se verifica **antes** de tocar la base.

## Dry-run de restore en staging (obligatorio pre go-live)

“Dry-run” aquí **no** es un no-op: es restaurar un dump de **producción** (o de un ensayo con el mismo schema PostGIS) sobre una base que **no** sea `pgdata_prod`.

1. En el VPS de prod: `./scripts/backup-postgres.sh` y copia el `.dump` + `.sha256` a staging (rsync, no chat).
2. Staging tiene su propio `.env.staging` / `.env` con `DATABASE_URL` de **otro** Postgres (otro compose, otro volumen, otro host). Nunca el de prod.
3. Plan:

   ```bash
   ENV_FILE=.env.staging PLAN=1 ./scripts/restore-postgres.sh /ruta/prod.dump
   ```

   Comprueba que el destino redacted es el host de staging.

4. Restore:

   ```bash
   ENV_FILE=.env.staging CONFIRM=yes ./scripts/restore-postgres.sh /ruta/prod.dump
   ```

5. El script corre `verify-postgis.sql`. Completa a mano lo de la sección siguiente.
6. Smoke de app contra staging: `deploy/STAGING_SMOKE.md` (health/ops, GPS geocerca, notificación dry-run, `confirm-presence`, métricas `failureAvoided`/`dwell`, restore `PLAN=1`). Este apartado (`CONFIRM=yes`) es el restore **destructivo** en throwaway; `PLAN=1` no lo sustituye.
7. Solo si esto es verde se marca el ítem de go-live en `deploy/SECURITY_CHECKLIST.md` y `deploy/DEPLOY_PLAN_MANANA.md`. **DNS público después del smoke**, no antes.

Throwaway en el mismo VPS (si aún no hay staging): segundo compose con **otro** `name:` y volumen distinto, o un `postgis/postgis:16-3.4` temporal. No uses `pgdata_prod`.

## Cómo verificar PostGIS tras el restore

Automático (`VERIFY=1`):

```bash
# Lo lanza restore. A mano:
docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f - < scripts/verify-postgis.sql
```

El SQL falla (psql ≠ 0) si:

- no existe `CREATE EXTENSION postgis`
- faltan filas en `geography_columns` para `paradas`, `repartidores`, `puntos_recogida`
- falta `public.paradas`
- `ST_DWithin` de dos puntos en Madrid (Sol / Debod) no devuelve true a 600 m

Checklist humano:

| Check | Esperado |
|---|---|
| `SELECT PostGIS_Full_Version();` | 3.4.x en la imagen `postgis/postgis:16-3.4` |
| `SELECT extname, extversion FROM pg_extension;` | `postgis` y `pgcrypto` |
| `SELECT * FROM geography_columns;` | `ubicacion` / `ubicacion_actual`, SRID **4326**, tipo Point |
| Índices GIST | `idx_paradas_ubicacion`, `idx_repartidores_ubicacion`, `idx_puntos_recogida_ubicacion` |
| `ST_DWithin` / `ST_Distance` | el smoke del SQL; con filas reales, una geocerca de 150 m sobre una parada seed o de prod |
| Conteos | `agencias` ≥ 1 en prod real; 0 filas no invalida el schema, sí un dump “día 0” vacío de negocio |

Si `PostGIS_Full_Version()` funciona pero `geography_columns` está vacío, el restore no trajo el schema (`01-schema.sql`): **no** abras DNS.

## Fallos frecuentes

| Síntoma | Qué hacer |
|---|---|
| `no existe ENV_FILE=.env.production` | Copia la plantilla o pasa `ENV_FILE=.env` |
| `CONFIRM=yes` aborta con código 2 | El valor no era exactamente `yes` |
| `pg_dump` / `pg_restore` no está | `BACKUP_VIA=docker` en el VPS, o `postgresql-client` en el host |
| Restore choca con `extension postgis already exists` | Deja `DROP_AND_RECREATE=1` (default) |
| Checksum no coincide | No restaures ese fichero; repe el dump |
| Apps siguen escribiendo durante el dump | Aceptable para este tamaño (dump consistente a nivel de snapshot MVCC). Para restore, deja `STOP_APPS=1` |

## Fuera de alcance

Redis (AOF/`redisdata_prod`), Caddy/`caddy_data` (certs), Twilio/Meta, quiet hours y auth de repartidor no se respaldan aquí. Un restore de Postgres no reconstruye streams Redis.
