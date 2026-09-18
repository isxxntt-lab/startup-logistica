import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STREAMS, serializeEvent } from "../events.js";
import { notificationDedupeKey } from "./dedupe.js";
import { enqueueNotification } from "./pipeline.js";

describe("notificationDedupeKey", () => {
  it("concatena parada, canal y motivo", () => {
    assert.equal(
      notificationDedupeKey("p1", "whatsapp", "proximidad_geocerca"),
      "p1:whatsapp:proximidad_geocerca",
    );
  });
});

describe("enqueueNotification", () => {
  it("escribe el evento en stream:notifications", async () => {
    const calls: unknown[][] = [];
    const redis = {
      async xadd(stream: string, id: string, ...fields: string[]) {
        calls.push([stream, id, ...fields]);
        return "1-0";
      },
    };
    const event = {
      type: "NOTIFICATION_REQUESTED" as const,
      paradaId: "p1",
      motivo: "proximidad_geocerca" as const,
    };
    const id = await enqueueNotification(redis, event);
    assert.equal(id, "1-0");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], STREAMS.notifications);
    assert.equal(calls[0][1], "*");
    assert.deepEqual(calls[0].slice(2), Object.entries(serializeEvent(event)).flat());
  });
});
