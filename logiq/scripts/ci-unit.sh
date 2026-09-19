#!/usr/bin/env bash
# Mismo conjunto que el job "unit" de .github/workflows/logiq.yml.
# Uso (desde cualquier cwd):
#   ./logiq/scripts/ci-unit.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== @logiq/shared: npm ci + typecheck + test =="
cd "$ROOT/packages/shared"
npm ci
npm run typecheck
npm test

for svc in service-orders service-fleet service-routing; do
  echo "== @logiq/${svc}: npm ci + typecheck =="
  cd "$ROOT/services/$svc"
  npm ci
  npm run typecheck
done

echo "== CI unit OK =="
