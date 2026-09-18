import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWsAuthMessage, autorizarRepartidorWs } from "./auth.js";
import { pool } from "../db.js";

const DEMO_KEY = "demo-api-key";
const DEMO_REPARTIDOR = "22222222-2222-2222-2222-222222222222";

let dbReady = false;
try {
  await pool.query("SELECT 1 FROM repartidores LIMIT 1");
  dbReady = true;
} catch {
  dbReady = false;
}

test("parseWsAuthMessage acepta JSON de auth y rechaza basura", () => {
  assert.deepEqual(parseWsAuthMessage('{"tipo":"auth","apiKey":"k","id":"1"}'), {
    tipo: "auth",
    apiKey: "k",
    id: "1",
  });
  assert.equal(parseWsAuthMessage("no-json"), null);
  assert.deepEqual(
    parseWsAuthMessage(Buffer.from('{"tipo":"auth","id":"x"}')),
    { tipo: "auth", id: "x" },
  );
});

test("autorizarRepartidorWs rechaza sin clave, clave mala o id ajeno", {
  skip: !dbReady,
}, async () => {
  assert.equal(await autorizarRepartidorWs({}), null);
  assert.equal(await autorizarRepartidorWs({ apiKey: DEMO_KEY }), null);
  assert.equal(
    await autorizarRepartidorWs({ apiKey: "clave-inventada", id: DEMO_REPARTIDOR }),
    null,
  );
  assert.equal(
    await autorizarRepartidorWs({
      apiKey: DEMO_KEY,
      id: "00000000-0000-0000-0000-000000000000",
    }),
    null,
  );
});

test("autorizarRepartidorWs acepta uuid o código de la agencia de la API key", {
  skip: !dbReady,
}, async () => {
  assert.equal(
    await autorizarRepartidorWs({ apiKey: DEMO_KEY, id: DEMO_REPARTIDOR }),
    DEMO_REPARTIDOR,
  );
  assert.equal(
    await autorizarRepartidorWs({ apiKey: DEMO_KEY, id: "repartidor_001" }),
    DEMO_REPARTIDOR,
  );
});
