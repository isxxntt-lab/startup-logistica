import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const backupScript = join(root, "scripts", "backup-postgres.sh");
const restoreScript = join(root, "scripts", "restore-postgres.sh");
const pgEnvPy = join(root, "scripts", "lib", "pg_env.py");
const verifySql = join(root, "scripts", "verify-postgis.sql");
const runbook = join(root, "deploy", "BACKUP_RESTORE.md");
const checklist = join(root, "deploy", "SECURITY_CHECKLIST.md");
const deployPlan = join(root, "deploy", "DEPLOY_PLAN_MANANA.md");

function runPython(args, opts = {}) {
  return spawnSync("python3", [pgEnvPy, ...args], {
    encoding: "utf8",
    ...opts,
  });
}

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "pg-backup-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  return { dir, bin };
}

function writeFake(binDir, name, body) {
  const path = join(binDir, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, {
    encoding: "utf8",
  });
  chmodSync(path, 0o755);
  return path;
}

function writeEnv(dir, extra = "") {
  const path = join(dir, ".env.production");
  writeFileSync(
    path,
    [
      "POSTGRES_USER=rutacerca",
      "POSTGRES_PASSWORD=super-secret-password",
      "POSTGRES_DB=startup_logistica",
      "DATABASE_URL=postgres://rutacerca:super-secret-password@postgres:5432/startup_logistica",
      extra,
    ]
      .filter(Boolean)
      .join("\n") + "\n",
    { encoding: "utf8" },
  );
  return path;
}

function runBackup(envFile, extraEnv, binDir) {
  return spawnSync("bash", [backupScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      ENV_FILE: envFile,
      BACKUP_VIA: "host",
      BACKUP_DIR: join(dirname(envFile), "backups"),
      PG_DUMP_BIN: "pg_dump",
      ...extraEnv,
    },
  });
}

function runRestore(dump, envFile, extraEnv, binDir) {
  return spawnSync("bash", [restoreScript, dump], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      ENV_FILE: envFile,
      RESTORE_VIA: "host",
      STOP_APPS: "0",
      VERIFY: extraEnv?.VERIFY ?? "1",
      PG_RESTORE_BIN: "pg_restore",
      PSQL_BIN: "psql",
      ...extraEnv,
    },
  });
}

describe("scripts/lib/pg_env.py", () => {
  it("parsea DATABASE_URL con password URL-encoded", () => {
    const url = "postgres://rutacerca:p%40ss%3Aw@db.internal:5433/startup_logistica?sslmode=require";
    const result = runPython(["parse-url", url]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.user, "rutacerca");
    assert.equal(parsed.password, "p@ss:w");
    assert.equal(parsed.host, "db.internal");
    assert.equal(parsed.port, "5433");
    assert.equal(parsed.database, "startup_logistica");
    assert.equal(parsed.sslmode, "require");
  });

  it("redacta el password de un URI", () => {
    const result = runPython([
      "redact",
      "postgres://rutacerca:super-secret-password@postgres:5432/startup_logistica",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /postgres:\/\/rutacerca:\*\*\*\*@postgres:5432\/startup_logistica/);
    assert.doesNotMatch(result.stdout, /super-secret-password/);
  });

  it("emite exports con quoting seguro", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-"));
    const file = join(dir, ".env");
    writeFileSync(
      file,
      [
        "# comentario",
        "export FOO=bar",
        "PASSWORD=abc def",
        "DATABASE_URL=postgres://u:p@h:5432/db",
      ].join("\n"),
      { encoding: "utf8" },
    );
    const result = runPython(["exports", file]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^export FOO=bar$/m);
    assert.match(result.stdout, /export PASSWORD='abc def'|export PASSWORD=abc\\ def/);
    assert.match(result.stdout, /export DATABASE_URL=/);
  });

  it("fill-pg rellena PG* desde DATABASE_URL en el entorno", () => {
    const result = runPython(["fill-pg"], {
      env: {
        ...process.env,
        DATABASE_URL:
          "postgres://rutacerca:p%40ss@db.internal:5433/startup_logistica?sslmode=require",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /export PGUSER=rutacerca/);
    assert.match(result.stdout, /export PGPASSWORD='p@ss'|export PGPASSWORD=p@ss/);
    assert.match(result.stdout, /export PGHOST=db.internal/);
    assert.match(result.stdout, /export PGPORT=5433/);
    assert.match(result.stdout, /export PGDATABASE=startup_logistica/);
    assert.match(result.stdout, /export PGSSLMODE=require/);
  });

  it("falla si el env file no existe", () => {
    const result = runPython(["exports", join(tmpdir(), "missing.env")]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no existe/);
  });
});

describe("artefactos de backup/restore", () => {
  it("los scripts existen, son ejecutables y usan set -euo pipefail", () => {
    for (const path of [backupScript, restoreScript]) {
      assert.ok(existsSync(path), path);
      const src = readFileSync(path, "utf8");
      assert.match(src, /^#!/);
      assert.match(src, /set -Eeuo pipefail/);
    }
  });

  it("backup documenta .env.production, DATABASE_URL/PG* y timestamp", () => {
    const src = readFileSync(backupScript, "utf8");
    assert.match(src, /\.env\.production/);
    assert.match(src, /DATABASE_URL/);
    assert.match(src, /pg_dump/);
    assert.match(src, /%Y%m%dT%H%M%SZ/);
    assert.match(src, /FORMAT:-custom/);
  });

  it("restore exige CONFIRM=yes y documenta el riesgo destructivo", () => {
    const src = readFileSync(restoreScript, "utf8");
    assert.match(src, /CONFIRM=yes/);
    assert.match(src, /RESTORE DESTRUCTIVO/);
    assert.match(src, /DROP DATABASE/);
    assert.match(src, /verify-postgis\.sql/);
  });

  it("verify-postgis.sql cubre extensión, geography y ST_DWithin", () => {
    const src = readFileSync(verifySql, "utf8");
    assert.match(src, /ON_ERROR_STOP/);
    assert.match(src, /pg_extension/);
    assert.match(src, /PostGIS_Full_Version/);
    assert.match(src, /geography_columns/);
    assert.match(src, /ST_DWithin/);
    assert.match(src, /paradas/);
  });

  it("el runbook cubre frecuencia, retención, staging y PostGIS", () => {
    const src = readFileSync(runbook, "utf8");
    assert.match(src, /Frecuencia/);
    assert.match(src, /Retención/);
    assert.match(src, /14 días/);
    assert.match(src, /staging/i);
    assert.match(src, /ST_DWithin/);
    assert.match(src, /CONFIRM=yes/);
    assert.match(src, /go-live/);
  });

  it("SECURITY_CHECKLIST y DEPLOY_PLAN exigen dry-run de restore antes de go-live", () => {
    const sec = readFileSync(checklist, "utf8");
    const plan = readFileSync(deployPlan, "utf8");
    assert.match(sec, /backup/i);
    assert.match(sec, /dry-run/i);
    assert.match(sec, /restore/i);
    assert.match(sec, /PostGIS/);
    assert.match(plan, /backup/i);
    assert.match(plan, /restore/i);
    assert.match(plan, /staging/i);
  });
});

describe("backup-postgres.sh (sin Postgres real)", () => {
  it("falla ≠ 0 si falta el env file", () => {
    const { dir, bin } = makeWorkspace();
    const result = runBackup(join(dir, "missing.env"), {}, bin);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no existe ENV_FILE/);
  });

  it("genera dump timestamped, sha256 y no filtra el password", () => {
    const { dir, bin } = makeWorkspace();
    const envFile = writeEnv(dir);
    writeFake(
      bin,
      "pg_dump",
      `
outfile=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --file) outfile="$2"; shift 2 ;;
    --file=*) outfile="\${1#*=}"; shift ;;
    *) shift ;;
  esac
done
[[ -n "$outfile" ]] || { echo "pg_dump fake: falta --file" >&2; exit 1; }
printf 'PGDMP' > "$outfile"
printf 'fake-custom-dump' >> "$outfile"
`,
    );
    const result = runBackup(envFile, {}, bin);
    assert.equal(result.status, 0, result.stderr);
    const dumpPath = result.stdout.trim().split("\n").at(-1);
    assert.ok(dumpPath && existsSync(dumpPath), `dump stdout=${result.stdout}`);
    assert.match(dumpPath, /startup_logistica_\d{8}T\d{6}Z\.dump$/);
    assert.equal(readFileSync(dumpPath).subarray(0, 5).toString("utf8"), "PGDMP");
    assert.ok(existsSync(`${dumpPath}.sha256`));
    assert.ok(existsSync(`${dumpPath}.meta.json`));
    const meta = JSON.parse(readFileSync(`${dumpPath}.meta.json`, "utf8"));
    assert.equal(meta.format, "custom");
    assert.equal(meta.database, "startup_logistica");
    const logs = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(logs, /super-secret-password/);
    assert.match(result.stderr, /dump OK/);
  });

  it("propaga el fallo de pg_dump", () => {
    const { dir, bin } = makeWorkspace();
    const envFile = writeEnv(dir);
    writeFake(bin, "pg_dump", `echo "boom" >&2; exit 7`);
    const result = runBackup(envFile, {}, bin);
    assert.notEqual(result.status, 0);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ERROR/);
  });
});

describe("restore-postgres.sh (sin Postgres real)", { concurrency: false }, () => {
  function seedDump(dir) {
    const dump = join(dir, "sample.dump");
    writeFileSync(dump, Buffer.concat([Buffer.from("PGDMP"), Buffer.from("fake")]));
    return dump;
  }

  it("sin CONFIRM=yes sale 2 y no llama a pg_restore", () => {
    const { dir, bin } = makeWorkspace();
    const envFile = writeEnv(dir);
    const dump = seedDump(dir);
    writeFake(bin, "pg_restore", `echo "NO_DEBERIA_CORRER" >&2; exit 0`);
    writeFake(bin, "psql", `echo "NO_DEBERIA_CORRER" >&2; exit 0`);
    const result = runRestore(dump, envFile, { CONFIRM: "" }, bin);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /CONFIRM=yes/);
    assert.match(result.stderr, /DESTRUCTIVO/);
    assert.doesNotMatch(result.stderr, /NO_DEBERIA_CORRER/);
  });

  it("CONFIRM=YES (mayúsculas) no vale", () => {
    const { dir, bin } = makeWorkspace();
    const envFile = writeEnv(dir);
    const dump = seedDump(dir);
    writeFake(bin, "pg_restore", `exit 0`);
    writeFake(bin, "psql", `exit 0`);
    const result = runRestore(dump, envFile, { CONFIRM: "YES" }, bin);
    assert.equal(result.status, 2, result.stderr);
  });

  it("PLAN=1 no muta y no exige CONFIRM", () => {
    const { dir, bin } = makeWorkspace();
    const envFile = writeEnv(dir);
    const dump = seedDump(dir);
    writeFake(bin, "pg_restore", `echo RAN >&2; exit 1`);
    writeFake(bin, "psql", `echo RAN >&2; exit 1`);
    const result = runRestore(dump, envFile, { PLAN: "1" }, bin);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /PLAN OK/);
    assert.doesNotMatch(result.stderr, /^RAN$/m);
  });

  it("CONFIRM=yes corre drop + pg_restore + verify sin filtrar el password", () => {
    const { dir, bin } = makeWorkspace();
    const envFile = writeEnv(dir);
    const dump = seedDump(dir);
    const stamp = join(dir, "calls.log");
    writeFake(
      bin,
      "psql",
      `
echo "psql $*" >> ${stamp}
if [[ "$*" == *verify-postgis.sql* || "$*" == *-f* ]]; then
  echo "verify-postgis OK"
  exit 0
fi
cat >/dev/null
exit 0
`,
    );
    writeFake(
      bin,
      "pg_restore",
      `
echo "pg_restore $*" >> ${stamp}
exit 0
`,
    );
    const result = runRestore(
      dump,
      envFile,
      { CONFIRM: "yes", VERIFY_SQL: verifySql },
      bin,
    );
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(stamp, "utf8");
    assert.match(calls, /pg_restore/);
    assert.match(result.stderr, /OK restore/);
    assert.match(result.stderr, /verificación PostGIS OK/);
    const logs = `${result.stdout}\n${result.stderr}\n${calls}`;
    assert.doesNotMatch(logs, /super-secret-password/);
  });
});
