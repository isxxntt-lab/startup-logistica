import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import Fastify from "fastify";
import {
  apiKeyDesdeHeader,
  autorizarParada,
  autorizarRepartidor,
  protegerParada,
  protegerRepartidor,
  type AuthParadaResult,
  type AuthRepartidorResult,
  type ParadaAutorizada,
} from "./auth-repartidor.js";
import { pool } from "./db.js";

const DEMO_KEY = "demo-api-key";
const DEMO_REPARTIDOR = "22222222-2222-2222-2222-222222222222";
const DEMO_PARADA = "55555555-5555-5555-5555-555555555554";
const AJENO = "00000000-0000-0000-0000-000000000000";

let dbReady = false;
try {
  await pool.query("SELECT 1 FROM repartidores LIMIT 1");
  dbReady = true;
} catch {
  dbReady = false;
}

const denyCourier: AuthRepartidorResult = {
  ok: false,
  status: 403,
  error: "repartidor no autorizado",
};
const denyParada: AuthParadaResult = {
  ok: false,
  status: 403,
  error: "parada no autorizada",
};
const allowCourier: AuthRepartidorResult = {
  ok: true,
  agenciaId: "ag-1",
  repartidorId: DEMO_REPARTIDOR,
};
const paradaOk: ParadaAutorizada = {
  id: DEMO_PARADA,
  ruta_id: "44444444-4444-4444-4444-444444444444",
  orden: 1,
  estado: "pendiente",
  referencia_pedido: "ORD-DEMO",
  repartidor_id: DEMO_REPARTIDOR,
};
const allowParada: AuthParadaResult = {
  ok: true,
  agenciaId: "ag-1",
  parada: paradaOk,
};

async function appConGuards(opts?: {
  autorizarRepartidor?: typeof autorizarRepartidor;
  autorizarParada?: typeof autorizarParada;
}) {
  const app = Fastify({ logger: false });
  const authCourier = opts?.autorizarRepartidor ?? autorizarRepartidor;
  const authParada = opts?.autorizarParada ?? autorizarParada;

  app.get("/repartidor/:id/ruta-hoy", async (request, reply) => {
    const { id } = request.params as { id: string };
    const rid = await protegerRepartidor(request, reply, id, authCourier);
    if (!rid) return;
    return { ok: true, repartidorId: rid };
  });
  app.post("/repartidor/:id/ubicacion", async (request, reply) => {
    const { id } = request.params as { id: string };
    const rid = await protegerRepartidor(request, reply, id, authCourier);
    if (!rid) return;
    return { ok: true, repartidorId: rid };
  });
  app.post("/repartidor/paradas/:paradaId/estado", async (request, reply) => {
    const { paradaId } = request.params as { paradaId: string };
    const parada = await protegerParada(request, reply, paradaId, authParada);
    if (!parada) return;
    return { ok: true, paradaId: parada.id };
  });
  app.post("/events/location_update", async (request, reply) => {
    const body = request.body as { courier_id?: string };
    const rid = await protegerRepartidor(
      request,
      reply,
      body.courier_id,
      authCourier,
    );
    if (!rid) return;
    return { ok: true, repartidorId: rid };
  });
  await app.ready();
  return app;
}

test("apiKeyDesdeHeader lee x-api-key y rechaza vacío", () => {
  assert.equal(apiKeyDesdeHeader({}), undefined);
  assert.equal(apiKeyDesdeHeader({ "x-api-key": "" }), undefined);
  assert.equal(apiKeyDesdeHeader({ "x-api-key": "   " }), undefined);
  assert.equal(apiKeyDesdeHeader({ "x-api-key": "abc" }), "abc");
  assert.equal(apiKeyDesdeHeader({ "x-api-key": "  abc  " }), "abc");
  assert.equal(apiKeyDesdeHeader({ "x-api-key": ["k1", "k2"] }), "k1");
});

test("autorizarRepartidor y autorizarParada dan 401 sin consultar si falta la clave", async () => {
  assert.deepEqual(await autorizarRepartidor({}), {
    ok: false,
    status: 401,
    error: "api key inválida",
  });
  assert.deepEqual(await autorizarRepartidor({ apiKey: "  ", id: "x" }), {
    ok: false,
    status: 401,
    error: "api key inválida",
  });
  assert.deepEqual(await autorizarParada({ paradaId: DEMO_PARADA }), {
    ok: false,
    status: 401,
    error: "api key inválida",
  });
});

const RUTAS_SIN_KEY: Array<{
  method: "GET" | "POST";
  url: string;
  payload?: Record<string, string>;
}> = [
  { method: "GET", url: `/repartidor/${DEMO_REPARTIDOR}/ruta-hoy` },
  { method: "POST", url: `/repartidor/${DEMO_REPARTIDOR}/ubicacion` },
  { method: "POST", url: `/repartidor/paradas/${DEMO_PARADA}/estado` },
  {
    method: "POST",
    url: "/events/location_update",
    payload: { courier_id: "repartidor_001" },
  },
];

test("HTTP /repartidor/* y location_update responden 401 sin x-api-key", async () => {
  const app = await appConGuards();
  try {
    for (const ruta of RUTAS_SIN_KEY) {
      const res = await app.inject({
        method: ruta.method,
        url: ruta.url,
        payload: ruta.payload,
      });
      assert.equal(res.statusCode, 401, `${ruta.method} ${ruta.url}`);
      assert.deepEqual(res.json(), { error: "api key inválida" });
    }
  } finally {
    await app.close();
  }
});

test("HTTP /repartidor/* responde 403 con clave presente pero recurso ajeno", async () => {
  const app = await appConGuards({
    autorizarRepartidor: async () => denyCourier,
    autorizarParada: async () => denyParada,
  });
  try {
    const rutaHoy = await app.inject({
      method: "GET",
      url: `/repartidor/${AJENO}/ruta-hoy`,
      headers: { "x-api-key": "cualquier-clave" },
    });
    assert.equal(rutaHoy.statusCode, 403);
    assert.deepEqual(rutaHoy.json(), { error: "repartidor no autorizado" });

    const parada = await app.inject({
      method: "POST",
      url: `/repartidor/paradas/${AJENO}/estado`,
      headers: { "x-api-key": "cualquier-clave" },
    });
    assert.equal(parada.statusCode, 403);
    assert.deepEqual(parada.json(), { error: "parada no autorizada" });
  } finally {
    await app.close();
  }
});

test("HTTP /repartidor/* deja pasar con clave e identidad de la misma agencia", async () => {
  const app = await appConGuards({
    autorizarRepartidor: async () => allowCourier,
    autorizarParada: async () => allowParada,
  });
  try {
    const rutaHoy = await app.inject({
      method: "GET",
      url: `/repartidor/${DEMO_REPARTIDOR}/ruta-hoy`,
      headers: { "x-api-key": DEMO_KEY },
    });
    assert.equal(rutaHoy.statusCode, 200);
    assert.deepEqual(rutaHoy.json(), { ok: true, repartidorId: DEMO_REPARTIDOR });

    const parada = await app.inject({
      method: "POST",
      url: `/repartidor/paradas/${DEMO_PARADA}/estado`,
      headers: { "x-api-key": DEMO_KEY },
    });
    assert.equal(parada.statusCode, 200);
    assert.deepEqual(parada.json(), { ok: true, paradaId: DEMO_PARADA });
  } finally {
    await app.close();
  }
});

test("las rutas reales de repartidor usan los guards de API key", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "routes/repartidor.ts"),
    "utf8",
  );
  assert.match(src, /protegerRepartidor/);
  assert.match(src, /protegerParada/);
  const courierGuards = src.match(/protegerRepartidor\(/g) ?? [];
  const paradaGuards = src.match(/protegerParada\(/g) ?? [];
  assert.equal(courierGuards.length, 3, "ubicacion, location_update y ruta-hoy");
  assert.equal(paradaGuards.length, 1, "POST estado de parada");
});

test("autorizarRepartidor rechaza clave inventada (401) e id ajeno (403)", {
  skip: !dbReady,
}, async () => {
  assert.deepEqual(
    await autorizarRepartidor({
      apiKey: "clave-inventada",
      id: DEMO_REPARTIDOR,
    }),
    { ok: false, status: 401, error: "api key inválida" },
  );
  assert.deepEqual(
    await autorizarRepartidor({ apiKey: DEMO_KEY, id: AJENO }),
    { ok: false, status: 403, error: "repartidor no autorizado" },
  );
  assert.deepEqual(
    await autorizarParada({ apiKey: DEMO_KEY, paradaId: AJENO }),
    { ok: false, status: 403, error: "parada no autorizada" },
  );
});

test("autorizarRepartidor acepta uuid o código de la agencia de la API key", {
  skip: !dbReady,
}, async () => {
  const porUuid = await autorizarRepartidor({
    apiKey: DEMO_KEY,
    id: DEMO_REPARTIDOR,
  });
  assert.equal(porUuid.ok, true);
  if (porUuid.ok) assert.equal(porUuid.repartidorId, DEMO_REPARTIDOR);

  const porCodigo = await autorizarRepartidor({
    apiKey: DEMO_KEY,
    id: "repartidor_001",
  });
  assert.equal(porCodigo.ok, true);
  if (porCodigo.ok) assert.equal(porCodigo.repartidorId, DEMO_REPARTIDOR);

  const parada = await autorizarParada({
    apiKey: DEMO_KEY,
    paradaId: DEMO_PARADA,
  });
  assert.equal(parada.ok, true);
  if (parada.ok) {
    assert.equal(parada.parada.id, DEMO_PARADA);
    assert.equal(parada.parada.repartidor_id, DEMO_REPARTIDOR);
  }
});
