import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

  it("solo Caddy publica 80/443 TCP y 443/udp", () => {
    for (const [name, svc] of Object.entries(services)) {
      const ports = publishedPorts(svc);
      if (name === "caddy") {
        assert.ok(ports.some((p) => p === "80:80"));
        assert.ok(ports.some((p) => p === "443:443"));
        assert.ok(ports.some((p) => p === "443:443/udp"));
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
    const webTmpfs = (services.web.tmpfs ?? []).map((m) => String(m).split(":")[0]);
    for (const path of ["/var/cache/nginx", "/var/run", "/var/log/nginx", "/var/lib/nginx", "/tmp"]) {
      assert.ok(webTmpfs.includes(path), `web tmpfs ${path}`);
    }
  });

  it("healthchecks de web, workers y api", () => {
    assert.ok(services.api.healthcheck?.test, "api healthcheck");
    assert.ok(services.web.healthcheck?.test, "web healthcheck");
    assert.ok(services.workers.healthcheck?.test, "workers healthcheck");
    assert.ok(services.postgres.healthcheck?.test, "postgres healthcheck");
    assert.ok(services.redis.healthcheck?.test, "redis healthcheck");

    const webTest = JSON.stringify(services.web.healthcheck.test);
    assert.match(webTest, /wget/);
    assert.match(webTest, /127\.0\.0\.1:8080/);

    const apiTest = JSON.stringify(services.api.healthcheck.test);
    assert.match(apiTest, /\/api\/ops\/health/);
    assert.match(apiTest, /\/health/);

    const workerTest = JSON.stringify(services.workers.healthcheck.test);
    assert.match(workerTest, /ioredis/);
    assert.match(workerTest, /SELECT 1/);

    assert.equal(services.caddy.depends_on?.web?.condition, "service_healthy");
    assert.equal(services.caddy.depends_on?.api?.condition, "service_healthy");
  });

  it("el snippet de healthcheck de workers resuelve ioredis y pg", {
    skip: !existsSync(join(root, "node_modules")),
  }, () => {
    const out = execFileSync(
      "node",
      [
        "--input-type=module",
        "-e",
        "const pgMod=await import('pg');const Pg=pgMod.default??pgMod;if(typeof Pg.Client!=='function')process.exit(2);const {default:Redis}=await import('ioredis');if(typeof Redis!=='function')process.exit(3);process.stdout.write('ok');",
      ],
      { cwd: join(root, "apps/workers"), encoding: "utf8" },
    );
    assert.equal(out, "ok");
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

  it("SITE_TRACKING y SITE_API envían headers de endurecimiento tras reverse_proxy", () => {
    const tracking = caddyfile.match(
      /\{\$SITE_TRACKING:[^}]+\} \{[\s\S]*?\n\}/,
    );
    const api = caddyfile.match(
      /\{\$SITE_API:[^}]+\} \{[\s\S]*?\n\}/,
    );
    assert.ok(tracking && api, "bloques de sitio");
    for (const block of [tracking[0], api[0]]) {
      const proxyAt = block.indexOf("reverse_proxy");
      const headerAt = block.indexOf("header {");
      assert.ok(proxyAt >= 0 && headerAt > proxyAt, "header tras reverse_proxy");
      assert.match(block, /Strict-Transport-Security/);
      assert.match(block, /X-Content-Type-Options "nosniff"/);
      assert.match(block, /X-Frame-Options "DENY"/);
      assert.match(block, /Referrer-Policy "strict-origin-when-cross-origin"/);
      assert.match(block, /-Server/);
    }
  });
});

function hasDockerCompose() {
  const result = spawnSync("docker", ["compose", "version"], {
    encoding: "utf8",
    timeout: 8000,
  });
  return result.status === 0;
}

function lastUserInstruction(dockerfile) {
  const users = [...dockerfile.matchAll(/^\s*USER\s+(\S+)/gm)].map((m) => m[1]);
  return users.at(-1) ?? "";
}

describe("contenedores non-root (USER ≠ 0)", () => {
  it("api y workers usan USER 10001:10001 y pnpm start:prod (sin dist multi-stage)", () => {
    for (const rel of ["apps/api/Dockerfile", "apps/workers/Dockerfile"]) {
      const df = readFileSync(join(root, rel), "utf8");
      assert.match(df, /groupadd[^\n]*--gid 10001 app/);
      assert.match(df, /useradd[^\n]*--uid 10001[^\n]*app/);
      assert.match(df, /chown -R app:app \/app/);
      assert.match(df, /USER 10001:10001/);
      assert.equal(lastUserInstruction(df), "10001:10001");
      assert.doesNotMatch(df, /^\s*USER\s+0\b/m);
      assert.doesNotMatch(df, /^\s*USER\s+root\b/m);
      assert.match(df, /CMD \["pnpm", "start:prod"\]/);
      assert.doesNotMatch(df, /node dist/);
    }
    const apiDf = readFileSync(join(root, "apps/api/Dockerfile"), "utf8");
    assert.match(apiDf, /EXPOSE 3000/);
    const workersDf = readFileSync(join(root, "apps/workers/Dockerfile"), "utf8");
    assert.doesNotMatch(workersDf, /EXPOSE /);
  });

  it("web usa nginx-unprivileged USER 101 y listen 8080", () => {
    const df = readFileSync(join(root, "apps/web-cliente/Dockerfile"), "utf8");
    assert.match(df, /nginxinc\/nginx-unprivileged:1\.27-alpine/);
    assert.match(df, /USER 101/);
    assert.equal(lastUserInstruction(df), "101");
    assert.match(
      df,
      /COPY --from=build --chown=101:101 \/app\/apps\/web-cliente\/dist \/usr\/share\/nginx\/html/,
    );
    assert.doesNotMatch(
      df,
      /^COPY --from=build \/app\/apps\/web-cliente\/dist /m,
    );
    assert.match(df, /EXPOSE 8080/);
    assert.doesNotMatch(df, /EXPOSE 80\b/);
    assert.doesNotMatch(df, /^\s*USER\s+0\b/m);
    assert.doesNotMatch(df, /^\s*USER\s+root\b/m);

    const nginx = readFileSync(join(root, "apps/web-cliente/nginx.conf"), "utf8");
    assert.match(nginx, /listen 8080\s*;/);
    assert.doesNotMatch(nginx, /listen 80\b/);
  });

  it("compose expone web:8080 y Caddy hace reverse_proxy web:8080", () => {
    const expose = (services.web.expose ?? []).map(String);
    assert.ok(expose.includes("8080"), "web expose 8080");
    assert.ok(!expose.includes("80"), "web no expone 80");

    const webTest = JSON.stringify(services.web.healthcheck.test);
    assert.match(webTest, /127\.0\.0\.1:8080/);

    const tracking = caddyfile.match(/\{\$SITE_TRACKING:[^}]+\} \{[\s\S]*?\n\}/);
    assert.ok(tracking, "bloque SITE_TRACKING");
    assert.match(tracking[0], /reverse_proxy web:8080/);
    assert.doesNotMatch(tracking[0], /reverse_proxy web:80\b/);
  });

  it("nginx-unprivileged mantiene read_only + tmpfs de nginx", () => {
    assert.equal(services.web.read_only, true);
    const webTmpfs = (services.web.tmpfs ?? []).map((m) => String(m).split(":")[0]);
    for (const path of ["/var/cache/nginx", "/var/run", "/var/log/nginx", "/var/lib/nginx", "/tmp"]) {
      assert.ok(webTmpfs.includes(path), `web tmpfs ${path}`);
    }
  });
});

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

describe("orden de merge y operacional VPS", () => {
  it("MERGE_ORDER documenta #4→#11, #9 rebaseado sobre #11 y que el VPS no es diff", () => {
    const src = readFileSync(join(root, "deploy", "MERGE_ORDER.md"), "utf8");
    assert.match(src, /#4 → #5 → #6 → #7 → #8 → #10 → #11/);
    assert.match(src, /#9 rebaseado/);
    assert.match(src, /incluye.*#8.*#10.*#11/s);
    assert.match(src, /RESUME_ERROR/);
    assert.match(src, /30s → 2m → 10m/);
    assert.match(src, /COPY --from=build --chown=101:101/);
    assert.match(src, /Operacional en el VPS — no es código/);
    assert.match(src, /ACME_EMAIL/);
    assert.match(src, /02-seed\.sql/);
    assert.match(src, /SITE_TRACKING/);
    assert.match(src, /SITE_API/);
    assert.match(src, /no usar `demo-api-key`/i);
  });

  it("MERGE_ORDER y DEPLOY_PLAN exigen smoke staging antes de DNS público", () => {
    const merge = readFileSync(join(root, "deploy", "MERGE_ORDER.md"), "utf8");
    const plan = readFileSync(join(root, "deploy", "DEPLOY_PLAN_MANANA.md"), "utf8");
    const checklist = readFileSync(
      join(root, "deploy", "SECURITY_CHECKLIST.md"),
      "utf8",
    );
    assert.match(merge, /#12 → este PR \(smoke staging E2E\)/);
    assert.match(merge, /STAGING_SMOKE\.md/);
    assert.match(merge, /Antes de DNS público/);
    assert.match(plan, /Smoke staging E2E antes de DNS público/);
    assert.match(plan, /STAGING_SMOKE\.md/);
    assert.match(plan, /STAGING_BASE/);
    assert.match(checklist, /STAGING_SMOKE\.md/);
    assert.match(checklist, /antes de DNS/i);
  });
});

describe("smoke staging E2E (docs + healthcheck, sin VPS)", () => {
  const smokeDoc = join(root, "deploy", "STAGING_SMOKE.md");
  const healthcheck = join(root, "scripts", "prod-healthcheck.sh");

  it("STAGING_SMOKE.md cubre la secuencia compose → metrics → PLAN=1", () => {
    const src = readFileSync(smokeDoc, "utf8");
    assert.match(src, /docker compose up/);
    assert.match(src, /\/health/);
    assert.match(src, /\/api\/ops\/health/);
    assert.match(src, /location_update/);
    assert.match(src, /GROK_LOCATION_PINGS|40\.416775/);
    assert.match(src, /dry-run/);
    assert.match(src, /QUIET_HOURS/);
    assert.match(src, /confirm-presence/);
    assert.match(src, /failureAvoided/);
    assert.match(src, /dwell/);
    assert.match(src, /PLAN=1/);
    assert.match(src, /backup-postgres\.sh/);
    assert.doesNotMatch(src, /TWILIO_ACCOUNT_SID=AC/);
    assert.doesNotMatch(src, /ACME_EMAIL=\S+@gmail/);
    assert.match(src, /antes de apuntar DNS público/i);
  });

  it("prod-healthcheck.sh acepta STAGING_BASE y aborta smoke contra DNS de prod", () => {
    const src = readFileSync(healthcheck, "utf8");
    assert.match(src, /STAGING_BASE/);
    assert.match(src, /STAGING_SMOKE/);
    assert.match(src, /confirm-presence/);
    assert.match(src, /PLAN=1/);
    assert.match(src, /api\.rutacerca\.es/);

    const syntax = spawnSync("bash", ["-n", healthcheck], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);

    const refused = spawnSync("bash", [healthcheck], {
      encoding: "utf8",
      env: {
        ...process.env,
        STAGING_SMOKE: "1",
        STAGING_BASE: "https://api.rutacerca.es",
        AGENCY_API_KEY: "demo-api-key",
      },
    });
    assert.equal(refused.status, 1, refused.stderr + refused.stdout);
    assert.match(`${refused.stdout}\n${refused.stderr}`, /DNS público de prod/);
    assert.doesNotMatch(
      `${refused.stdout}\n${refused.stderr}`,
      /GET https:\/\/api\.rutacerca\.es\/health/,
    );
  });
});
