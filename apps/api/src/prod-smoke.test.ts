import assert from "node:assert/strict";
import { test } from "node:test";

const base = (process.env.STAGING_BASE || process.env.PROD_SMOKE_BASE)?.replace(
  /\/$/,
  "",
);

test("prod smoke: GET /health", { skip: !base }, async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.ok, true);
  const body = (await res.json()) as { ok?: boolean };
  assert.equal(body.ok, true);
});

test("prod smoke: GET /api/ops/health", { skip: !base }, async () => {
  const res = await fetch(`${base}/api/ops/health`);
  assert.equal(res.ok, true);
  const body = (await res.json()) as {
    ok?: boolean;
    openCriticalAlerts?: number;
  };
  assert.equal(typeof body.ok, "boolean");
  assert.equal(typeof body.openCriticalAlerts, "number");
});

test("prod smoke: GET /repartidor/:id/ruta-hoy sin x-api-key → 401", {
  skip: !base,
}, async () => {
  const res = await fetch(
    `${base}/repartidor/00000000-0000-0000-0000-000000000000/ruta-hoy`,
  );
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error?: string };
  assert.equal(body.error, "api key inválida");
});

test("prod smoke: GET /api/ops/metrics (OPS_TOKEN o AGENCY_API_KEY)", {
  skip: !base || !(process.env.OPS_TOKEN || process.env.AGENCY_API_KEY),
}, async () => {
  const headers = new Headers();
  if (process.env.OPS_TOKEN) headers.set("x-ops-token", process.env.OPS_TOKEN);
  else headers.set("x-api-key", process.env.AGENCY_API_KEY ?? "");
  const res = await fetch(`${base}/api/ops/metrics`, { headers });
  assert.equal(res.ok, true);
});
