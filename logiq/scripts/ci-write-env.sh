#!/usr/bin/env bash
# Escribe logiq/.env desde INTERNAL_SERVICE_TOKEN y REDIS_PASSWORD del entorno
# (secretos de GitHub Actions en CI). Nunca imprime valores. No commitear .env.
set -euo pipefail
set +x

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"

if [ -z "${INTERNAL_SERVICE_TOKEN:-}" ] || [ -z "${REDIS_PASSWORD:-}" ]; then
  echo "Faltan INTERNAL_SERVICE_TOKEN y/o REDIS_PASSWORD." >&2
  echo "Blue: Settings → Secrets and variables → Actions. Ver logiq/README.md (CI)." >&2
  exit 1
fi

umask 077
# printf no hace echo del archivo. No usar set -x ni cat "$ENV_FILE".
{
  printf 'REDIS_PASSWORD=%s\n' "$REDIS_PASSWORD"
  printf 'INTERNAL_SERVICE_TOKEN=%s\n' "$INTERNAL_SERVICE_TOKEN"
  printf 'GEOFENCE_RADIUS_M=%s\n' "${GEOFENCE_RADIUS_M:-500}"
  printf 'GATEWAY_PORT=%s\n' "${GATEWAY_PORT:-8080}"
} > "$ENV_FILE"

# Confirma que el archivo existe y no está vacío, sin leer secretos a stdout.
python3 - "$ENV_FILE" <<'PY'
import os, sys
path = sys.argv[1]
if os.path.getsize(path) < 40:
    sys.stderr.write("FAIL: .env demasiado corto\n")
    sys.exit(1)
print("ok: .env escrito (valores no se muestran)")
PY
