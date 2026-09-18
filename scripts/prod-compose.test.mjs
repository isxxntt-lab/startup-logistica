import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const composePath = join(root, "docker-compose.prod.yml");
const caddyPath = join(root, "Caddyfile");
const envExamplePath = join(root, ".env.production.example");

function loadYaml(path) {
  const raw = execFileSync(
    "python3",
    [
      "-c",
      "import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))",
      path,
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(raw);
}

function publishedPorts(service) {
  const ports = service.ports ?? [];
  return ports.map((p) => (typeof p === "string" ? p : JSON.stringify(p)));
}

function networksOf(service) {
  const nets = service.networks;
  if (Array.isArray(nets)) return nets;
  if (nets && typeof nets === "object") return Object.keys(nets);
  return [];
}

function hasNoNewPrivileges(service) {
  const opts = service.security_opt ?? [];
  return opts.some((opt) => String(opt).includes("no-new-privileges"));
}

const compose = loadYaml(composePath);
const services = compose.services ?? {};
const caddyfile = readFileSync(caddyPath, "utf8");
const envExample = readFileSync(envExamplePath, "utf8");

describe("docker-compose.prod.yml: redes y puertos", () => {
  it("PostGIS y Redis no publican ports al host", () => {
    assert.deepEqual(publishedPorts(services.postgres), []);
    assert.deepEqual(publishedPorts(services.redis), []);
    assert.ok(!Object.hasOwn(services.postgres, "ports"));
    assert.ok(!Object.hasOwn(services.redis, "ports"));
  });

  it("solo Caddy publica 80/443", () => {
    for (const [name, svc] of Object.entries(services)) {
      const ports = publishedPorts(svc);
      if (name === "caddy") {
        assert.ok(ports.some((p) => p.includes("80:80")));
        assert.ok(ports.some((p) => p.includes("443:443")));
        continue;
      }
      assert.equal(ports.length, 0, `${name} no debe publicar ports`);
    }
  });

  it("API está en edge+internal para que Caddy la alcance y llegue a datos", () => {
    const nets = networksOf(services.api).sort();
    assert.deepEqual(nets, ["edge", "internal"]);
  });

  it("Caddy y web están en edge; datos y workers solo en internal", () => {
    assert.deepEqual(networksOf(services.caddy), ["edge"]);
    assert.deepEqual(networksOf(services.web), ["edge"]);
    assert.deepEqual(networksOf(services.workers), ["internal"]);
    assert.deepEqual(networksOf(services.postgres), ["internal"]);
    assert.deepEqual(networksOf(services.redis), ["internal"]);
  });

  it("Caddy no comparte red con PostGIS/Redis", () => {
    const caddyNets = new Set(networksOf(services.caddy));
    for (const name of ["postgres", "redis", "workers"]) {
      const overlap = networksOf(services[name]).filter((n) => caddyNets.has(n));
      assert.deepEqual(overlap, [], `caddy no debe solaparse con ${name}`);
    }
  });
});

describe("docker-compose.prod.yml: endurecimiento y healthchecks", () => {
  it("read_only donde el filesystem de la imagen puede ser inmutable", () => {
    for (const name of ["caddy", "web", "api", "workers", "redis"]) {
      assert.equal(services[name].read_only, true, `${name} read_only`);
    }
    assert.notEqual(services.postgres.read_only, true);
  });

  it("no-new-privileges en todos los servicios", () => {
    for (const [name, svc] of Object.entries(services)) {
      assert.ok(hasNoNewPrivileges(svc), `${name} no-new-privileges`);
    }
  });

  it("tmpfs /tmp en servicios read_only", () => {
    for (const name of ["caddy", "web", "api", "workers", "redis"]) {
      const mounts = services[name].tmpfs ?? [];
      const serialized = mounts.map((m) => (typeof m === "string" ? m : JSON.stringify(m)));
      assert.ok(
        serialized.some((m) => m.startsWith("/tmp")),
        `${name} tmpfs /tmp`,
      );
    }
    const webTmpfs = (services.web.tmpfs ?? []).map(String);
    assert.ok(webTmpfs.some((m) => m.startsWith("/var/cache/nginx")));
    assert.ok(webTmpfs.some((m) => m.startsWith("/run")));
  });

  it("healthchecks de web, workers y api", () => {
    assert.ok(services.api.healthcheck?.test, "api healthcheck");
    assert.ok(services.web.healthcheck?.test, "web healthcheck");
    assert.ok(services.workers.healthcheck?.test, "workers healthcheck");
    assert.ok(services.postgres.healthcheck?.test, "postgres healthcheck");
    assert.ok(services.redis.healthcheck?.test, "redis healthcheck");

    const webTest = JSON.stringify(services.web.healthcheck.test);
    assert.match(webTest, /wget|127\.0\.0\.1/);

    const workerTest = JSON.stringify(services.workers.healthcheck.test);
    assert.match(workerTest, /ioredis/);
    assert.match(workerTest, /SELECT 1/);

    assert.equal(services.caddy.depends_on?.web?.condition, "service_healthy");
    assert.equal(services.caddy.depends_on?.api?.condition, "service_healthy");
  });

  it("Caddy recibe ACME_EMAIL y no monta el seed demo", () => {
    assert.equal(
      services.caddy.environment?.ACME_EMAIL,
      "${ACME_EMAIL:-ops@rutacerca.es}",
    );
    const pgVols = (services.postgres.volumes ?? []).map(String);
    assert.ok(!pgVols.some((v) => v.includes("02-seed.sql")));
    assert.ok(pgVols.some((v) => v.includes("01-schema.sql")));
  });
});

describe("Caddyfile: ACME_EMAIL en bloque global", () => {
  it("declara email con placeholder ACME_EMAIL antes de los site blocks", () => {
    const global = caddyfile.match(/\{[\s\S]*?\n\}/);
    assert.ok(global, "bloque global");
    assert.match(global[0], /email\s+\{\$ACME_EMAIL(?::[^}]+)?\}/);
    const emailAt = caddyfile.indexOf("email {$ACME_EMAIL");
    const siteAt = caddyfile.indexOf("{$SITE_TRACKING");
    assert.ok(emailAt >= 0 && emailAt < siteAt);
  });

  it("la plantilla de env documenta ACME_EMAIL", () => {
    assert.match(envExample, /^ACME_EMAIL=/m);
  });
});

function hasDockerCompose() {
  const result = spawnSync("docker", ["compose", "version"], {
    encoding: "utf8",
    timeout: 8000,
  });
  return result.status === 0;
}

describe("docker compose config (si hay binario)", () => {
  it("el YAML interpola sin error con un env de prueba", {
    skip: !hasDockerCompose(),
  }, () => {
    const envFile = join(root, "scripts", "prod-compose.test.env");
    const result = execFileSync(
      "docker",
      [
        "compose",
        "-f",
        composePath,
        "--env-file",
        envFile,
        "config",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, COMPOSE_IGNORE_ORPHANS: "1" },
      },
    );
    assert.match(result, /read_only:\s*true/);
    assert.match(result, /ACME_EMAIL/);
  });
});
