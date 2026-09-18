import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import {
  GLOBAL_RATE_LIMIT,
  TRACKING_POSITION_RATE_LIMIT,
  trackingPositionRateLimitKey,
} from "./rate-limit-config.js";

describe("rate-limit poll tracking", () => {
  it("30/min cubre el poll de 8s con margen", () => {
    const pollsPorMinuto = 60_000 / 8_000;
    assert.ok(TRACKING_POSITION_RATE_LIMIT.max >= pollsPorMinuto * 2);
    assert.equal(TRACKING_POSITION_RATE_LIMIT.timeWindow, "1 minute");
    assert.equal(GLOBAL_RATE_LIMIT.max, 100);
  });

  it("la clave separa tokens distintos detrás de la misma IP", () => {
    const a = trackingPositionRateLimitKey({ ip: "1.1.1.1", token: "aaa" });
    const b = trackingPositionRateLimitKey({ ip: "1.1.1.1", token: "bbb" });
    const c = trackingPositionRateLimitKey({ ip: "1.1.1.1" });
    assert.notEqual(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^1\.1\.1\.1:/);
  });

  it("la ruta de posición responde 429 al superar el cupo", async () => {
    const app = Fastify({ logger: false });
    await app.register(rateLimit, GLOBAL_RATE_LIMIT);
    app.get(
      "/api/tracking/position",
      {
        config: {
          rateLimit: {
            max: 3,
            timeWindow: "1 minute",
            keyGenerator: (request) =>
              trackingPositionRateLimitKey({
                ip: request.ip,
                token: (request.query as { token?: string }).token,
              }),
          },
        },
      },
      async () => ({ ok: true }),
    );
    await app.ready();

    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({
        method: "GET",
        url: "/api/tracking/position?token=tok-a",
      });
      assert.equal(res.statusCode, 200, `req ${i} debería ser 200`);
    }
    const blocked = await app.inject({
      method: "GET",
      url: "/api/tracking/position?token=tok-a",
    });
    assert.equal(blocked.statusCode, 429);

    const otherToken = await app.inject({
      method: "GET",
      url: "/api/tracking/position?token=tok-b",
    });
    assert.equal(otherToken.statusCode, 200);

    await app.close();
  });
});
