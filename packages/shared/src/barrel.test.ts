import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ENLACE_YA_NO_VALIDO,
  TRACKING_ACTIONS,
  enqueueNotification,
  notificationDedupeKey,
  trackingApiPath,
} from "./index.js";

describe("barrel de @startup-logistica/shared", () => {
  it("reexporta constantes de tracking-token", () => {
    assert.equal(ENLACE_YA_NO_VALIDO, "ENLACE_YA_NO_VALIDO");
    assert.equal(TRACKING_ACTIONS.confirmPresence, "confirm-presence");
    assert.equal(TRACKING_ACTIONS.reschedule, "reschedule");
    assert.equal(trackingApiPath("session"), "/api/tracking/session");
  });

  it("reexporta pipeline de notificaciones y dedupe", async () => {
    assert.equal(
      notificationDedupeKey("p1", "whatsapp", "proximidad_geocerca"),
      "p1:whatsapp:proximidad_geocerca",
    );
    const calls: unknown[][] = [];
    const id = await enqueueNotification(
      {
        xadd: async (...args: unknown[]) => {
          calls.push(args);
          return "1-0";
        },
      },
      {
        type: "NOTIFICATION_REQUESTED",
        paradaId: "p1",
        motivo: "manual",
      },
    );
    assert.equal(id, "1-0");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "stream:notifications");
  });
});
