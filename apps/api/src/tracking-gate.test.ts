import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gateFromJwtError, gateFromParada } from "./tracking-gate.js";

describe("gateFromJwtError", () => {
  it("marca JWT caducado como 410 expired", () => {
    assert.deepEqual(gateFromJwtError({ name: "TokenExpiredError" }), {
      kind: "gone",
      reason: "expired",
    });
  });

  it("marca firma inválida como 401", () => {
    assert.deepEqual(gateFromJwtError({ name: "JsonWebTokenError" }), {
      kind: "invalid",
      status: 401,
    });
  });
});

describe("gateFromParada", () => {
  const now = new Date("2026-09-18T12:00:00.000Z");

  it("devuelve 404 si no hay parada", () => {
    assert.deepEqual(
      gateFromParada({ found: false, tokenExpiraAt: null, now }),
      { kind: "invalid", status: 404 },
    );
  });

  it("devuelve 410 expired si token_expira_at ya pasó", () => {
    assert.deepEqual(
      gateFromParada({
        found: true,
        estado: "notificado",
        tokenExpiraAt: new Date("2026-09-17T12:00:00.000Z"),
        now,
      }),
      { kind: "gone", reason: "expired" },
    );
  });

  it("devuelve 410 used en estados terminales", () => {
    assert.deepEqual(
      gateFromParada({
        found: true,
        estado: "entregado",
        tokenExpiraAt: new Date("2026-09-20T12:00:00.000Z"),
        now,
      }),
      { kind: "gone", reason: "used" },
    );
  });

  it("acepta parada pendiente como sesión válida", () => {
    assert.deepEqual(
      gateFromParada({
        found: true,
        estado: "pendiente",
        tokenExpiraAt: new Date("2026-09-20T12:00:00.000Z"),
        now,
      }),
      { kind: "ok", sessionStatus: "pending" },
    );
  });

  it("mapea confirmado a will_be_there", () => {
    assert.deepEqual(
      gateFromParada({
        found: true,
        estado: "confirmado",
        tokenExpiraAt: null,
        now,
      }),
      { kind: "ok", sessionStatus: "will_be_there" },
    );
  });
});
