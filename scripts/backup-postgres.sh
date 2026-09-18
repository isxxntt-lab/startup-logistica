#!/usr/bin/env bash
# Dump de Postgres/PostGIS para producción.
#
# Uso:
#   ./scripts/backup-postgres.sh
#   ENV_FILE=.env.production BACKUP_DIR=/var/backups/rutacerca FORMAT=custom ./scripts/backup-postgres.sh
#
# Variables:
#   ENV_FILE          default: .env.production (DATABASE_URL o PG*)
#   FORMAT            custom (pg_restore, recomendado) | plain (SQL)
#   BACKUP_DIR        default: ./backups/postgres
#   BACKUP_KEEP_DAYS  si se define, borra dumps locales más antiguos
#   BACKUP_VIA        auto | docker | host
#   COMPOSE_FILE      override del compose (prod vs local)
#
# Exit ≠ 0 si falla el dump, el env o el checksum.
set -Eeuo pipefail

SCRIPT_NAME="backup"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/postgres-env.sh
source "${SCRIPT_DIR}/lib/postgres-env.sh"

trap 'log "ERROR en ${BASH_SOURCE[0]##*/}:${LINENO} (exit $?)"' ERR

FORMAT="${FORMAT:-custom}"
BACKUP_DIR="${BACKUP_DIR:-${ROOT}/backups/postgres}"
PG_DUMP_BIN="${PG_DUMP_BIN:-pg_dump}"
umask 077

case "$FORMAT" in
  custom | c)
    FORMAT=custom
    EXT=dump
    ;;
  plain | sql | p)
    FORMAT=plain
    EXT=sql
    ;;
  *)
    die "FORMAT debe ser custom o plain (recibido: $FORMAT)"
    ;;
esac

init_pg_context

if [[ "$BACKUP_DIR" != /* ]]; then
  BACKUP_DIR="${ROOT}/${BACKUP_DIR}"
fi
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SAFE_DB="$(printf '%s' "$PGDATABASE" | tr -c 'A-Za-z0-9._-' '_')"
OUT_FILE="${BACKUP_DIR}/${SAFE_DB}_${STAMP}.${EXT}"
META_FILE="${OUT_FILE}.meta.json"
SUM_FILE="${OUT_FILE}.sha256"

dump_via_docker() {
  log "pg_dump vía docker compose exec postgres (format=${FORMAT})"
  local -a dump_args=(
    -U "$POSTGRES_USER"
    -d "$POSTGRES_DB"
    --format="$FORMAT"
    --no-password
    --verbose
  )
  if [[ "$FORMAT" == "custom" ]]; then
    dump_args+=(--compress=6)
  fi
  compose exec -T postgres pg_dump "${dump_args[@]}" >"$OUT_FILE" || die "pg_dump vía docker falló (exit $?)"
}

dump_via_host() {
  command -v "$PG_DUMP_BIN" >/dev/null 2>&1 || die "no está '$PG_DUMP_BIN' en PATH (instala postgresql-client o usa BACKUP_VIA=docker)"
  log "pg_dump en host $(conn_summary) format=${FORMAT}"
  local -a dump_args=(
    --format="$FORMAT"
    --no-password
    --verbose
    --file="$OUT_FILE"
  )
  if [[ "$FORMAT" == "custom" ]]; then
    dump_args+=(--compress=6)
  fi
  "$PG_DUMP_BIN" "${dump_args[@]}" || die "pg_dump falló (exit $?)"
}

log "inicio dump db=${PGDATABASE} format=${FORMAT}"
log "salida ${OUT_FILE}"

case "$BACKEND" in
  docker) dump_via_docker ;;
  host) dump_via_host ;;
  *) die "backend desconocido: $BACKEND" ;;
esac

if [[ ! -s "$OUT_FILE" ]]; then
  die "el dump está vacío: $OUT_FILE"
fi

if [[ "$FORMAT" == "custom" ]]; then
  if ! python3 -c 'import sys; p=sys.argv[1]; sys.exit(0 if open(p,"rb").read(5)==b"PGDMP" else 1)' "$OUT_FILE"; then
    log "WARN: el dump custom no empieza por magia PGDMP; revisa el fichero"
  fi
fi

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$(dirname "$OUT_FILE")" && sha256sum "$(basename "$OUT_FILE")") >"$SUM_FILE"
elif command -v shasum >/dev/null 2>&1; then
  (cd "$(dirname "$OUT_FILE")" && shasum -a 256 "$(basename "$OUT_FILE")") >"$SUM_FILE"
else
  die "no hay sha256sum ni shasum; no se puede firmar el dump"
fi

python3 - "$META_FILE" "$OUT_FILE" "$FORMAT" "$BACKEND" <<'PY'
import json, os, sys, time
from pathlib import Path
meta_path, dump_path, fmt, backend = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
size = Path(dump_path).stat().st_size
payload = {
    "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "format": fmt,
    "backend": backend,
    "database": os.environ.get("PGDATABASE"),
    "host": os.environ.get("PGHOST"),
    "port": os.environ.get("PGPORT"),
    "user": os.environ.get("PGUSER"),
    "bytes": size,
    "file": os.path.basename(dump_path),
    "postgis": "el dump incluye CREATE EXTENSION postgis si existía en origen",
}
Path(meta_path).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY
chmod 600 "$OUT_FILE" "$SUM_FILE" "$META_FILE"

BYTES="$(wc -c <"$OUT_FILE" | tr -d ' ')"
log "dump OK bytes=${BYTES} sha256=$(cut -d' ' -f1 "$SUM_FILE")"
log "meta ${META_FILE}"

if [[ -n "${BACKUP_KEEP_DAYS:-}" ]]; then
  if [[ ! "$BACKUP_KEEP_DAYS" =~ ^[0-9]+$ ]]; then
    die "BACKUP_KEEP_DAYS debe ser un entero (días)"
  fi
  log "retención local: borra dumps .${EXT} de más de ${BACKUP_KEEP_DAYS} días en ${BACKUP_DIR}"
  find "$BACKUP_DIR" -maxdepth 1 -type f -name "*.${EXT}" -mtime "+${BACKUP_KEEP_DAYS}" -print -delete >&2 || true
  find "$BACKUP_DIR" -maxdepth 1 -type f \( -name "*.${EXT}.sha256" -o -name "*.${EXT}.meta.json" \) -mtime "+${BACKUP_KEEP_DAYS}" -delete || true
fi

log "OK ${OUT_FILE}"
printf '%s\n' "$OUT_FILE"
