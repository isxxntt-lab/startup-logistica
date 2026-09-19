#!/usr/bin/env bash
# Escribe logiq/.env para el smoke. Prefiere secretos de Actions; si faltan,
# genera valores efímeros de job con openssl. Nunca imprime valores. No commitear .env.
set -euo pipefail
set +x

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"

if [ -z "${INTERNAL_SERVICE_TOKEN:-}" ]; then
  INTERNAL_SERVICE_TOKEN="$(openssl rand -hex 32)"
  echo "ok: INTERNAL_SERVICE_TOKEN efímero de job (Blue puede fijar secreto de repo)"
else
  echo "ok: INTERNAL_SERVICE_TOKEN desde secreto de repo"
fi

if [ -z "${REDIS_PASSWORD:-}" ]; then
  REDIS_PASSWORD="$(openssl rand -hex 24)"
  echo "ok: REDIS_PASSWORD efímero de job (Blue puede fijar secreto de repo)"
else
  echo "ok: REDIS_PASSWORD desde secreto de repo"
fi

umask 077
{
  printf 'REDIS_PASSWORD=%s\n' "$REDIS_PASSWORD"
  printf 'INTERNAL_SERVICE_TOKEN=%s\n' "$INTERNAL_SERVICE_TOKEN"
  printf 'GEOFENCE_RADIUS_M=%s\n' "${GEOFENCE_RADIUS_M:-500}"
  printf 'GATEWAY_PORT=%s\n' "${GATEWAY_PORT:-8080}"
} > "$ENV_FILE"

python3 - "$ENV_FILE" <<'PY'
import os, sys
path = sys.argv[1]
if os.path.getsize(path) < 40:
    sys.stderr.write("FAIL: .env demasiado corto\n")
    sys.exit(1)
print("ok: .env escrito (valores no se muestran)")
PY
