#!/usr/bin/env bash
# Restore DESTRUCTIVO de Postgres/PostGIS.
#
# RIESGO: sustituye la base destino. Se pierden filas, extensiones y roles
# de objetos que no estén en el dump. Un restore mal apuntado a producción
# borra paradas, tokens, agencias y geometrías actuales.
#
# No corre sin confirmación explícita:
#   CONFIRM=yes ./scripts/restore-postgres.sh backups/postgres/foo.dump
#
# Staging (dry-run real, no es no-op): apunta ENV_FILE a staging y restaura
# allí un dump de prod. Ver deploy/BACKUP_RESTORE.md.
#
# Variables:
#   CONFIRM=yes              obligatorio (exacto; YES/true no valen)
#   ENV_FILE                 default .env.production
#   DROP_AND_RECREATE=1      default 1; DROP DATABASE + CREATE (recomendado PostGIS)
#   VERIFY=1                 default 1; corre scripts/verify-postgis.sql
#   PLAN=1                   solo imprime el plan (no muta; no pide CONFIRM)
#   RESTORE_VIA              auto | docker | host
#   STOP_APPS=1              docker: para api/workers durante el restore
#   CONFIRM_DELAY_SECONDS    pausa extra tras el aviso (default 0)
set -Eeuo pipefail

SCRIPT_NAME="restore"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/postgres-env.sh
source "${SCRIPT_DIR}/lib/postgres-env.sh"

trap 'log "ERROR en ${BASH_SOURCE[0]##*/}:${LINENO} (exit $?)"' ERR

DUMP_FILE="${1:-${DUMP:-}}"
PLAN="${PLAN:-0}"
DROP_AND_RECREATE="${DROP_AND_RECREATE:-1}"
VERIFY="${VERIFY:-1}"
STOP_APPS="${STOP_APPS:-1}"
CONFIRM_DELAY_SECONDS="${CONFIRM_DELAY_SECONDS:-0}"
PG_RESTORE_BIN="${PG_RESTORE_BIN:-pg_restore}"
PSQL_BIN="${PSQL_BIN:-psql}"
VERIFY_SQL="${VERIFY_SQL:-${ROOT}/scripts/verify-postgis.sql}"

usage() {
  cat <<'EOF' >&2
Restore DESTRUCTIVO de Postgres/PostGIS. Borra la base destino.

  CONFIRM=yes ./scripts/restore-postgres.sh <dump.dump|.sql>

  PLAN=1 ./scripts/restore-postgres.sh <dump>     # no muta
  ENV_FILE=.env.staging CONFIRM=yes ./scripts/restore-postgres.sh <dump>

CONFIRM debe ser exactamente "yes". Ver deploy/BACKUP_RESTORE.md.
EOF
}

detect_dump_format() {
  local file="$1"
  if [[ "$file" == *.sql ]]; then
    printf 'plain\n'
    return
  fi
  if python3 -c 'import sys; p=sys.argv[1]; sys.exit(0 if open(p,"rb").read(5)==b"PGDMP" else 1)' "$file"; then
    printf 'custom\n'
    return
  fi
  if [[ "$file" == *.dump || "$file" == *.backup ]]; then
    printf 'custom\n'
    return
  fi
  die "no pude detectar formato de $file (usa .dump custom o .sql plain)"
}

verify_checksum() {
  local file="$1"
  local sum="${file}.sha256"
  [[ -f "$sum" ]] || {
    log "WARN: no hay ${sum}; salto verificación de integridad"
    return 0
  }
  log "verificando sha256 $(basename "$sum")"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$(dirname "$file")" && sha256sum -c "$(basename "$sum")") >&2
  elif command -v shasum >/dev/null 2>&1; then
    local expected actual
    expected="$(awk '{print $1}' "$sum")"
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
    [[ "$expected" == "$actual" ]] || die "checksum SHA-256 no coincide"
  else
    die "no hay sha256sum/shasum para verificar el dump"
  fi
}

print_risk() {
  cat >&2 <<EOF

************************************************************
  RESTORE DESTRUCTIVO — Postgres / PostGIS
  Dump:     ${DUMP_FILE}
  Destino:  $(conn_summary)
  Backend:  ${BACKEND}
  DROP DB:  ${DROP_AND_RECREATE}
************************************************************
  Esto BORRA el contenido actual de '${PGDATABASE}' y lo
  sustituye por el dump. Paradas, tokens JWT, agencias,
  geometrías geography(Point,4326) y extensión PostGIS del
  destino se pierden si no están en el fichero.

  No es un merge. No hay undo salvo otro dump.

  Confirmación exigida: CONFIRM=yes (exacto).
************************************************************

EOF
}

require_confirm() {
  if [[ "${CONFIRM:-}" == "yes" ]]; then
    return 0
  fi
  print_risk
  log "ABORTADO: falta CONFIRM=yes (recibido CONFIRM=${CONFIRM:-<vacío>})"
  usage
  exit 2
}

psql_docker() {
  compose exec -T postgres psql -U "$POSTGRES_USER" -v ON_ERROR_STOP=1 "$@"
}

drop_and_recreate_docker() {
  log "DROP DATABASE ${POSTGRES_DB} + CREATE (mantenimiento: postgres)"
  psql_docker -d postgres <<SQL
SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
 WHERE datname = '${POSTGRES_DB}'
   AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS ${POSTGRES_DB};
CREATE DATABASE ${POSTGRES_DB} WITH OWNER ${POSTGRES_USER} ENCODING 'UTF8';
SQL
}

drop_and_recreate_host() {
  log "DROP DATABASE ${PGDATABASE} + CREATE vía ${PSQL_BIN}"
  PGDATABASE=postgres "$PSQL_BIN" -v ON_ERROR_STOP=1 <<SQL
SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
 WHERE datname = '${PGDATABASE}'
   AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS ${PGDATABASE};
CREATE DATABASE ${PGDATABASE} WITH OWNER CURRENT_USER ENCODING 'UTF8';
SQL
}

restore_custom_docker() {
  log "pg_restore custom por stdin → postgres container"
  compose exec -T postgres pg_restore \
    --dbname="$POSTGRES_DB" \
    --username="$POSTGRES_USER" \
    --no-owner \
    --no-acl \
    --exit-on-error \
    --verbose \
    <"$DUMP_FILE" || die "pg_restore vía docker falló (exit $?)"
}

restore_plain_docker() {
  log "psql plain SQL por stdin → postgres container"
  psql_docker -d "$POSTGRES_DB" <"$DUMP_FILE"
}

restore_custom_host() {
  command -v "$PG_RESTORE_BIN" >/dev/null 2>&1 || die "no está '$PG_RESTORE_BIN' en PATH"
  log "pg_restore host $(conn_summary)"
  "$PG_RESTORE_BIN" \
    --dbname="$PGDATABASE" \
    --no-owner \
    --no-acl \
    --exit-on-error \
    --verbose \
    "$DUMP_FILE" || die "pg_restore falló (exit $?)"
}

restore_plain_host() {
  command -v "$PSQL_BIN" >/dev/null 2>&1 || die "no está '$PSQL_BIN' en PATH"
  log "psql host $(conn_summary)"
  "$PSQL_BIN" -v ON_ERROR_STOP=1 -f "$DUMP_FILE"
}

maybe_stop_apps() {
  [[ "$STOP_APPS" == "1" ]] || return 0
  [[ "$BACKEND" == "docker" ]] || {
    log "WARN: STOP_APPS=1 ignorado (backend host). Para API/workers a mano antes del restore."
    return 0
  }
  local svc
  for svc in api workers; do
    if compose config --services 2>/dev/null | grep -qx "$svc"; then
      log "docker compose stop $svc"
      compose stop "$svc"
    fi
  done
}

maybe_start_apps() {
  [[ "$STOP_APPS" == "1" ]] || return 0
  [[ "$BACKEND" == "docker" ]] || return 0
  local svc
  for svc in api workers; do
    if compose config --services 2>/dev/null | grep -qx "$svc"; then
      log "docker compose start $svc"
      compose start "$svc"
    fi
  done
}

run_verify() {
  [[ "$VERIFY" == "1" ]] || {
    log "VERIFY=0: salto scripts/verify-postgis.sql"
    return 0
  }
  [[ -f "$VERIFY_SQL" ]] || die "no existe $VERIFY_SQL"
  log "verificando PostGIS con $(basename "$VERIFY_SQL")"
  if [[ "$BACKEND" == "docker" ]]; then
    psql_docker -d "$POSTGRES_DB" -f - <"$VERIFY_SQL"
  else
    command -v "$PSQL_BIN" >/dev/null 2>&1 || die "no está '$PSQL_BIN' para VERIFY=1"
    "$PSQL_BIN" -v ON_ERROR_STOP=1 -f "$VERIFY_SQL"
  fi
  log "verificación PostGIS OK"
}

if [[ -z "$DUMP_FILE" ]]; then
  usage
  die "indica el dump (argumento 1 o DUMP=...)" 2
fi
if [[ "$DUMP_FILE" != /* ]]; then
  DUMP_FILE="${ROOT}/${DUMP_FILE}"
fi
[[ -f "$DUMP_FILE" ]] || die "no existe el dump: $DUMP_FILE"

init_pg_context
DUMP_FORMAT="$(detect_dump_format "$DUMP_FILE")"
BYTES="$(wc -c <"$DUMP_FILE" | tr -d ' ')"
log "dump $(basename "$DUMP_FILE") format=${DUMP_FORMAT} bytes=${BYTES}"

if [[ "$PLAN" == "1" ]]; then
  print_risk
  log "PLAN (no se ejecuta): checksum si hay .sha256; STOP_APPS=${STOP_APPS}; DROP_AND_RECREATE=${DROP_AND_RECREATE}; restore ${DUMP_FORMAT} sobre ${PGDATABASE}; VERIFY=${VERIFY}"
  log "para ejecutar: CONFIRM=yes $0 $(basename "$DUMP_FILE")"
  log "PLAN OK (sin cambios)"
  exit 0
fi

require_confirm
print_risk

if [[ "$CONFIRM_DELAY_SECONDS" =~ ^[0-9]+$ ]] && [[ "$CONFIRM_DELAY_SECONDS" -gt 0 ]]; then
  log "esperando ${CONFIRM_DELAY_SECONDS}s (CONFIRM_DELAY_SECONDS)"
  sleep "$CONFIRM_DELAY_SECONDS"
fi

verify_checksum "$DUMP_FILE"
maybe_stop_apps

if [[ "$DROP_AND_RECREATE" == "1" ]]; then
  case "$BACKEND" in
    docker) drop_and_recreate_docker ;;
    host) drop_and_recreate_host ;;
  esac
else
  log "WARN: DROP_AND_RECREATE=0 — restore sobre la base existente (PostGIS puede chocar si ya hay extensión)"
fi

case "$BACKEND-$DUMP_FORMAT" in
  docker-custom) restore_custom_docker ;;
  docker-plain) restore_plain_docker ;;
  host-custom) restore_custom_host ;;
  host-plain) restore_plain_host ;;
  *) die "combinación backend/format no soportada: $BACKEND $DUMP_FORMAT" ;;
esac

run_verify
maybe_start_apps
log "OK restore $(basename "$DUMP_FILE") → $(conn_summary)"
