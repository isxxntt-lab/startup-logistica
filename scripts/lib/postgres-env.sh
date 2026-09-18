# shellcheck shell=bash
# Librería para backup/restore de Postgres/PostGIS.
# Sourcear desde los scripts; no ejecutar.

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "postgres-env.sh: hay que sourcearlo, no ejecutarlo" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PG_ENV_PY="${ROOT}/scripts/lib/pg_env.py"

log() {
  printf '[%s][%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${SCRIPT_NAME:-postgres}" "$*" >&2
}

die() {
  local code="${2:-1}"
  log "ERROR: $1"
  exit "$code"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "falta el comando '$1' en PATH"
}

assert_sql_ident() {
  local name="$1"
  local label="$2"
  [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "$label no es un identificador SQL seguro: ${name:-<vacío>}"
}

redact() {
  python3 "$PG_ENV_PY" redact "$1"
}

load_env_file() {
  local file="$1"
  [[ -n "$file" ]] || die "ENV_FILE vacío"
  [[ -f "$file" ]] || die "no existe ENV_FILE=$file (copia .env.production.example o pasa ENV_FILE=...)"
  need_cmd python3
  # shellcheck disable=SC1090
  eval "$(python3 "$PG_ENV_PY" exports "$file")"
  log "env cargado: $file"
}

apply_database_url() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    return 0
  fi
  # fill-pg lee DATABASE_URL del entorno (el password no va en argv de python).
  # shellcheck disable=SC1090
  eval "$(python3 "$PG_ENV_PY" fill-pg)" || die "DATABASE_URL inválida: $(redact "$DATABASE_URL")"
  return 0
}

require_pg_target() {
  apply_database_url
  if [[ -z "${PGDATABASE:-}" ]]; then
    die "hace falta DATABASE_URL o PGDATABASE (y PGUSER/PGHOST) en el env"
  fi
  if [[ -z "${PGUSER:-}" ]]; then
    die "hace falta PGUSER o un DATABASE_URL con usuario"
  fi
  PGHOST="${PGHOST:-localhost}"
  PGPORT="${PGPORT:-5432}"
  export PGUSER PGHOST PGPORT PGDATABASE
  if [[ -n "${PGPASSWORD:-}" ]]; then
    export PGPASSWORD
  fi
  return 0
}

conn_summary() {
  printf '%s@%s:%s/%s' "${PGUSER}" "${PGHOST}" "${PGPORT}" "${PGDATABASE}"
}

default_compose_file() {
  if [[ -n "${COMPOSE_FILE:-}" ]]; then
    printf '%s\n' "$COMPOSE_FILE"
    return
  fi
  local base
  base="$(basename "${ENV_FILE:-}")"
  if [[ "$base" == ".env.production" || "$base" == *prod* ]]; then
    printf '%s\n' "${ROOT}/docker-compose.prod.yml"
  else
    printf '%s\n' "${ROOT}/docker-compose.yml"
  fi
}

compose() {
  local -a args=(docker compose -f "$COMPOSE_FILE")
  if [[ -n "${ENV_FILE:-}" && -f "${ENV_FILE}" ]]; then
    args+=(--env-file "$ENV_FILE")
  fi
  "${args[@]}" "$@"
}

compose_postgres_running() {
  command -v docker >/dev/null 2>&1 || return 1
  [[ -f "$COMPOSE_FILE" ]] || return 1
  local services
  services="$(compose ps --status running --services 2>/dev/null || true)"
  grep -qx "postgres" <<<"$services"
}

detect_backend() {
  local via="${BACKUP_VIA:-${RESTORE_VIA:-auto}}"
  case "$via" in
    docker | host)
      printf '%s\n' "$via"
      return
      ;;
    auto) ;;
    *)
      die "BACKUP_VIA/RESTORE_VIA debe ser auto|docker|host (recibido: $via)"
      ;;
  esac
  if compose_postgres_running; then
    printf '%s\n' docker
    return
  fi
  if command -v "${PG_DUMP_BIN:-pg_dump}" >/dev/null 2>&1 || command -v "${PSQL_BIN:-psql}" >/dev/null 2>&1; then
    printf '%s\n' host
    return
  fi
  die "no hay backend: levanta compose ($COMPOSE_FILE) o instala postgresql-client. Override: BACKUP_VIA=docker|host"
}

init_pg_context() {
  SCRIPT_NAME="${SCRIPT_NAME:-postgres}"
  ENV_FILE="${ENV_FILE:-${ROOT}/.env.production}"
  if [[ "$ENV_FILE" != /* ]]; then
    ENV_FILE="${ROOT}/${ENV_FILE}"
  fi
  load_env_file "$ENV_FILE"
  require_pg_target
  POSTGRES_USER="${POSTGRES_USER:-$PGUSER}"
  POSTGRES_DB="${POSTGRES_DB:-$PGDATABASE}"
  export POSTGRES_USER POSTGRES_DB
  assert_sql_ident "$PGUSER" PGUSER
  assert_sql_ident "$PGDATABASE" PGDATABASE
  assert_sql_ident "$POSTGRES_USER" POSTGRES_USER
  assert_sql_ident "$POSTGRES_DB" POSTGRES_DB
  if [[ "$POSTGRES_DB" != "$PGDATABASE" ]]; then
    log "WARN: POSTGRES_DB=${POSTGRES_DB} distinto de PGDATABASE=${PGDATABASE}; docker usa POSTGRES_DB"
  fi
  COMPOSE_FILE="$(default_compose_file)"
  if [[ "$COMPOSE_FILE" != /* ]]; then
    COMPOSE_FILE="${ROOT}/${COMPOSE_FILE}"
  fi
  BACKEND="$(detect_backend)"
  log "destino $(conn_summary) backend=${BACKEND} compose=$(basename "$COMPOSE_FILE")"
}
