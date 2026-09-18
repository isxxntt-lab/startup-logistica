import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NotificationRequested } from "@startup-logistica/shared";
import { planForParada } from "./notification-plan.js";

const day = new Date("2026-01-15T12:00:00.000Z");
const night = new Date("2026-01-15T21:30:00.000Z");

const baseParada = {
  id: "55555555-5555-5555-5555-555555555554",
  cliente_telefono: "+34611111114",
  device_push_token: null,
  consent_whatsapp: true,
  consent_sms: true,
  consent_push: false,
};

const event: NotificationRequested = {
  type: "NOTIFICATION_REQUESTED",
  paradaId: String(baseParada.id),
  motivo: "proximidad_geocerca",
};

describe("planForParada (consumer, sin VPS ni DB)", () => {
  it("de día con consentimiento WA envía WhatsApp", () => {
    const plan = planForParada(baseParada, event, day);
    assert.equal(plan.action, "send");
    if (plan.action === "send") assert.equal(plan.channel, "whatsapp");
  });

  it("de noche aplaza WA/SMS y no dispara fallback a SMS", () => {
    const plan = planForParada(baseParada, event, night);
    assert.equal(plan.action, "defer");
    if (plan.action !== "defer") return;
    assert.equal(plan.channel, "whatsapp");
    assert.equal(plan.skipped.length, 0);
    assert.equal(plan.nextRetryAt.toISOString(), "2026-01-16T07:00:00.000Z");
  });

  it("push con token y consentimiento se envía de noche", () => {
    const plan = planForParada(
      {
        ...baseParada,
        device_push_token: "fcm-demo",
        consent_push: true,
      },
      { ...event, channel: "app" },
      night,
    );
    assert.equal(plan.action, "send");
    if (plan.action === "send") assert.equal(plan.channel, "app");
  });

  it("sin consentimiento WA ni SMS no envía (no spam)", () => {
    const plan = planForParada(
      { ...baseParada, consent_whatsapp: null, consent_sms: false },
      event,
      day,
    );
    assert.equal(plan.action, "skip");
    if (plan.action === "skip") assert.equal(plan.reason, "no_consent");
  });

  it("sin consentimiento WA y con SMS envía solo SMS de día", () => {
    const plan = planForParada(
      { ...baseParada, consent_whatsapp: false, consent_sms: true },
      event,
      day,
    );
    assert.equal(plan.action, "send");
    if (plan.action !== "send") return;
    assert.equal(plan.channel, "sms");
    assert.deepEqual(plan.skipped, [{ channel: "whatsapp", reason: "no_consent" }]);
  });

  it("sin teléfono el canal de texto no está disponible", () => {
    const plan = planForParada(
      { ...baseParada, cliente_telefono: "" },
      event,
      day,
    );
    assert.equal(plan.action, "skip");
    if (plan.action === "skip") {
      assert.ok(
        plan.skipped.some((s) => s.reason === "channel_unavailable"),
      );
    }
  });
});
