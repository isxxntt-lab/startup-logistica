#!/usr/bin/env python3
"""Carga .env y parsea DATABASE_URL para los scripts de backup/restore.

No imprime secretos. Subcomandos:
  exports <file>     → líneas `export KEY=...` con quoting seguro
  parse-url <url>    → JSON {user,password,host,port,database,sslmode}
  fill-pg            → export PG* desde $DATABASE_URL (sin poner el URI en argv)
  redact <url|dsn>   → DSN con password sustituida por ****
"""

from __future__ import annotations

import json
import os
import re
import shlex
import sys
from pathlib import Path
from typing import Dict
from urllib.parse import parse_qs, unquote, urlparse

KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _strip_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def load_env_file(path: Path) -> Dict[str, str]:
    if not path.is_file():
        raise FileNotFoundError(f"no existe el env file: {path}")
    env: Dict[str, str] = {}
    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            raise ValueError(f"{path}:{lineno}: línea sin '=': {raw!r}")
        key, value = line.split("=", 1)
        key = key.strip()
        if not KEY_RE.match(key):
            raise ValueError(f"{path}:{lineno}: nombre de variable inválido: {key!r}")
        env[key] = _strip_quotes(value.strip())
    return env


def parse_database_url(url: str) -> Dict[str, str]:
    raw = (url or "").strip()
    if not raw:
        raise ValueError("DATABASE_URL vacío")
    parsed = urlparse(raw)
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise ValueError(
            f"DATABASE_URL debe ser postgres:// o postgresql:// (scheme={parsed.scheme!r})"
        )
    database = unquote((parsed.path or "").lstrip("/"))
    if not database:
        raise ValueError("DATABASE_URL no incluye nombre de base (path)")
    query = parse_qs(parsed.query, keep_blank_values=True)
    sslmode = ""
    if "sslmode" in query and query["sslmode"]:
        sslmode = query["sslmode"][0]
    return {
        "user": unquote(parsed.username or ""),
        "password": unquote(parsed.password or ""),
        "host": parsed.hostname or "",
        "port": str(parsed.port or 5432),
        "database": database,
        "sslmode": sslmode,
    }


def redact(text: str) -> str:
    if not text:
        return ""
    redacted = re.sub(
        r"(postgres(?:ql)?://[^:/@\s]+:)([^@/\s]+)(@)",
        r"\1****\3",
        text,
        flags=re.IGNORECASE,
    )
    redacted = re.sub(
        r"(?i)(password\s*=\s*)([^\s]+)",
        r"\1****",
        redacted,
    )
    return redacted


def cmd_exports(path: str) -> None:
    env = load_env_file(Path(path))
    for key, value in env.items():
        sys.stdout.write(f"export {key}={shlex.quote(value)}\n")


def cmd_parse_url(url: str) -> None:
    sys.stdout.write(json.dumps(parse_database_url(url), ensure_ascii=True) + "\n")


def cmd_fill_pg() -> None:
    """Rellena PG* ausentes desde DATABASE_URL (lee el URI del entorno, no de argv)."""
    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        return
    parsed = parse_database_url(url)
    mapping = (
        ("PGUSER", "user"),
        ("PGPASSWORD", "password"),
        ("PGHOST", "host"),
        ("PGPORT", "port"),
        ("PGDATABASE", "database"),
        ("PGSSLMODE", "sslmode"),
    )
    for env_key, parsed_key in mapping:
        if os.environ.get(env_key):
            continue
        value = parsed.get(parsed_key) or ""
        if not value:
            continue
        sys.stdout.write(f"export {env_key}={shlex.quote(value)}\n")


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in {"-h", "--help"}:
        sys.stderr.write(
            "uso: pg_env.py exports <file> | parse-url <url> | fill-pg | redact <text>\n"
        )
        return 2
    cmd = argv[1]
    try:
        if cmd == "exports":
            if len(argv) != 3:
                raise ValueError("uso: pg_env.py exports <file>")
            cmd_exports(argv[2])
            return 0
        if cmd == "parse-url":
            if len(argv) != 3:
                raise ValueError("uso: pg_env.py parse-url <url>")
            cmd_parse_url(argv[2])
            return 0
        if cmd == "fill-pg":
            if len(argv) != 2:
                raise ValueError("uso: pg_env.py fill-pg")
            cmd_fill_pg()
            return 0
        if cmd == "redact":
            if len(argv) != 3:
                raise ValueError("uso: pg_env.py redact <text>")
            sys.stdout.write(redact(argv[2]) + "\n")
            return 0
        raise ValueError(f"comando desconocido: {cmd}")
    except (FileNotFoundError, ValueError, OSError) as exc:
        sys.stderr.write(f"pg_env.py: {exc}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
