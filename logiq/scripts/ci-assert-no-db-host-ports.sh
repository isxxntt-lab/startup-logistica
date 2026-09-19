#!/usr/bin/env bash
# Falla si Redis o Postgres publican puertos al host (checklist SRE).
set -euo pipefail
set +x

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

python3 <<'PY'
import json, subprocess, sys

blocked = ("redis", "postgres", "postgresql", "db")
cmd = [
    "docker", "compose",
    "-f", "docker-compose.yml",
    "-f", "docker-compose.ci.yml",
    "ps", "--format", "json",
]
raw = subprocess.check_output(cmd, text=True).strip()
if not raw:
    print("FAIL: compose ps vacío", file=sys.stderr)
    sys.exit(1)

rows = []
try:
    parsed = json.loads(raw)
    rows = parsed if isinstance(parsed, list) else [parsed]
except json.JSONDecodeError:
    for line in raw.splitlines():
        if line.strip():
            rows.append(json.loads(line))

leaks = []
for row in rows:
    service = str(row.get("Service") or row.get("Name") or "").lower()
    if not any(token in service for token in blocked):
        continue
    publishers = row.get("Publishers") or []
    published = [
        p for p in publishers
        if p.get("PublishedPort") not in (None, 0, "0", "")
    ]
    ports_field = str(row.get("Ports") or "")
    host_bound = bool(published) or any(
        marker in ports_field for marker in ("0.0.0.0:", "[::]:", ":::")
    )
    if host_bound:
        leaks.append(service)

if leaks:
    print("FAIL: estos servicios no deben publicar puertos al host:", ", ".join(leaks), file=sys.stderr)
    sys.exit(1)

print("ok: Redis/Postgres sin puertos al host")
PY
