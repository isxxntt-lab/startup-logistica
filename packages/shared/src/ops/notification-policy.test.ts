import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  consentFromParada,
  hasChannelConsent,
  isQuietHours,
  isQuietHoursDeferredChannel,
  nextQuietHoursEnd,
  planNotificationDispatch,
  resolveChannelAvailability,
  zonedWallTimeToUtc,
  QUIET_HOURS_TIMEZONE,
} from "./notification-policy.js";

const TZ = QUIET_HOURS_TIMEZONE;

function madrid(isoUtc: string): Date {
  return new Date(isoUtc);
}

describe("isQuietHours Europe/Madrid 22:00–08:00", () => {
  it("invierno (UTC+1): 21:59 no, 22:00 sí, 07:59 sí, 08:00 no", () => {
    assert.equal(isQuietHours(madrid("2026-01-15T20:59:00.000Z"), TZ), false);
    assert.equal(isQuietHours(madrid("2026-01-15T21:00:00.000Z"), TZ), true);
    assert.equal(isQuietHours(madrid("2026-01-15T23:30:00.000Z"), TZ), true);
    assert.equal(isQuietHours(madrid("2026-01-16T06:59:00.000Z"), TZ), true);
    assert.equal(isQuietHours(madrid("2026-01-16T07:00:00.000Z"), TZ), false);
    assert.equal(isQuietHours(madrid("2026-01-16T12:00:00.000Z"), TZ), false);
  });

  it("verano (UTC+2): 22:00 sí, 08:00 no", () => {
    assert.equal(isQuietHours(madrid("2026-07-15T19:59:00.000Z"), TZ), false);
    assert.equal(isQuietHours(madrid("2026-07-15T20:00:00.000Z"), TZ), true);
    assert.equal(isQuietHours(madrid("2026-07-16T05:59:00.000Z"), TZ), true);
    assert.equal(isQuietHours(madrid("2026-07-16T06:00:00.000Z"), TZ), false);
  });

  it("medianoche sigue en franja", () => {
    assert.equal(isQuietHours(madrid("2026-01-15T23:00:00.000Z"), TZ), true);
  });
});

describe("nextQuietHoursEnd", () => {
  it("a las 22:30 de invierno apunta a las 08:00 del día siguiente", () => {
    const at = madrid("2026-01-15T21:30:00.000Z");
    assert.equal(
      nextQuietHoursEnd(at, TZ).toISOString(),
      "2026-01-16T07:00:00.000Z",
    );
  });

  it("a las 00:30 apunta a las 08:00 del mismo día civil", () => {
    const at = madrid("2026-01-15T23:30:00.000Z");
    assert.equal(
      nextQuietHoursEnd(at, TZ).toISOString(),
      "2026-01-16T07:00:00.000Z",
    );
  });

  it("verano: 23:00 CEST → 08:00 CEST", () => {
    const at = madrid("2026-07-15T21:00:00.000Z");
    assert.equal(
      nextQuietHoursEnd(at, TZ).toISOString(),
      "2026-07-16T06:00:00.000Z",
    );
  });

  it("cruza el cambio a CEST (2026-03-29): 22:00 CET → 08:00 CEST", () => {
    const at = zonedWallTimeToUtc(2026, 3, 28, 22, 0, TZ);
    assert.equal(isQuietHours(at, TZ), true);
    assert.equal(
      nextQuietHoursEnd(at, TZ).toISOString(),
      zonedWallTimeToUtc(2026, 3, 29, 8, 0, TZ).toISOString(),
    );
    assert.equal(nextQuietHoursEnd(at, TZ).toISOString(), "2026-03-29T06:00:00.000Z");
  });

  it("cruza el cambio a CET (2026-10-25): 22:00 CEST → 08:00 CET", () => {
    const at = zonedWallTimeToUtc(2026, 10, 24, 22, 0, TZ);
    assert.equal(isQuietHours(at, TZ), true);
    assert.equal(
      nextQuietHoursEnd(at, TZ).toISOString(),
      "2026-10-25T07:00:00.000Z",
    );
  });
});

describe("consentimiento", () => {
  it("solo true cuenta; null/false/undefined = sin consentimiento", () => {
    const consent = consentFromParada({
      consent_whatsapp: true,
      consent_sms: false,
      consent_push: null,
    });
    assert.equal(hasChannelConsent(consent, "whatsapp"), true);
    assert.equal(hasChannelConsent(consent, "sms"), false);
    assert.equal(hasChannelConsent(consent, "app"), false);
    assert.equal(hasChannelConsent({}, "whatsapp"), false);
  });
});

describe("resolveChannelAvailability", () => {
  it("dry-run: WA y SMS si hay teléfono; app solo con token; call nunca", () => {
    const a = resolveChannelAvailability({ telefono: "+34600111222" });
    assert.deepEqual(a, {
      whatsapp: true,
      sms: true,
      call: false,
      app: false,
    });
  });

  it("Twilio configurado sin SMS from: SMS no disponible (no spamear WA fallido a un canal caído)", () => {
    const a = resolveChannelAvailability({
      telefono: "+34600111222",
      twilioSid: "ACxxx",
      twilioToken: "secret",
      twilioWhatsappFrom: "whatsapp:+1415",
      twilioSmsFrom: "",
    });
    assert.equal(a.whatsapp, true);
    assert.equal(a.sms, false);
  });

  it("sin teléfono ningún canal de texto; push si hay token", () => {
    const a = resolveChannelAvailability({
      telefono: "  ",
      pushToken: "fcm-token",
    });
    assert.equal(a.whatsapp, false);
    assert.equal(a.sms, false);
    assert.equal(a.app, true);
  });
});

describe("planNotificationDispatch", () => {
  const available = {
    whatsapp: true,
    sms: true,
    call: false,
    app: true,
  };
  const allConsent = {
    whatsapp: true,
    sms: true,
    app: true,
    call: false,
  };
  const day = madrid("2026-01-15T12:00:00.000Z");
  const night = madrid("2026-01-15T21:30:00.000Z");

  it("de día con consentimiento envía el canal pedido", () => {
    const plan = planNotificationDispatch({
      channel: "whatsapp",
      consent: allConsent,
      now: day,
      available,
    });
    assert.deepEqual(plan, { action: "send", channel: "whatsapp", skipped: [] });
  });

  it("de noche aplaza WA hasta las 08:00 y no cae a SMS", () => {
    const plan = planNotificationDispatch({
      channel: "whatsapp",
      consent: allConsent,
      now: night,
      available,
    });
    assert.equal(plan.action, "defer");
    if (plan.action !== "defer") return;
    assert.equal(plan.channel, "whatsapp");
    assert.equal(plan.reason, "quiet_hours");
    assert.equal(plan.skipped.length, 0);
    assert.equal(plan.nextRetryAt.toISOString(), "2026-01-16T07:00:00.000Z");
  });

  it("push (app) de noche se envía", () => {
    const plan = planNotificationDispatch({
      channel: "app",
      consent: allConsent,
      now: night,
      available,
    });
    assert.deepEqual(plan, { action: "send", channel: "app", skipped: [] });
    assert.equal(isQuietHoursDeferredChannel("app"), false);
  });

  it("sin consentimiento WA, con SMS: skip WA y envía SMS de día (un solo canal, no spam)", () => {
    const plan = planNotificationDispatch({
      channel: "whatsapp",
      consent: { whatsapp: false, sms: true, app: false },
      now: day,
      available,
    });
    assert.equal(plan.action, "send");
    if (plan.action !== "send") return;
    assert.equal(plan.channel, "sms");
    assert.deepEqual(plan.skipped, [{ channel: "whatsapp", reason: "no_consent" }]);
  });

  it("sin consentimiento WA, con SMS, de noche: skip WA y aplaza SMS", () => {
    const plan = planNotificationDispatch({
      channel: "whatsapp",
      consent: { whatsapp: null, sms: true },
      now: night,
      available,
    });
    assert.equal(plan.action, "defer");
    if (plan.action !== "defer") return;
    assert.equal(plan.channel, "sms");
    assert.deepEqual(plan.skipped, [{ channel: "whatsapp", reason: "no_consent" }]);
  });

  it("sin consentimiento en WA ni SMS: skip, no envía nada", () => {
    const plan = planNotificationDispatch({
      channel: "whatsapp",
      consent: { whatsapp: false, sms: false, app: true },
      now: day,
      available,
    });
    assert.equal(plan.action, "skip");
    if (plan.action !== "skip") return;
    assert.equal(plan.reason, "no_consent");
    assert.equal(plan.skipped.length, 2);
  });

  it("WA no disponible, SMS sí: fallback a SMS", () => {
    const plan = planNotificationDispatch({
      channel: "whatsapp",
      consent: allConsent,
      now: day,
      available: { whatsapp: false, sms: true, app: false, call: false },
    });
    assert.equal(plan.action, "send");
    if (plan.action !== "send") return;
    assert.equal(plan.channel, "sms");
    assert.deepEqual(plan.skipped, [
      { channel: "whatsapp", reason: "channel_unavailable" },
    ]);
  });

  it("cadena agotada si WA y SMS no están disponibles", () => {
    const plan = planNotificationDispatch({
      channel: "whatsapp",
      consent: allConsent,
      now: day,
      available: { whatsapp: false, sms: false, app: true, call: false },
    });
    assert.equal(plan.action, "skip");
    if (plan.action !== "skip") return;
    assert.equal(plan.reason, "channel_unavailable");
  });

  it("call no está implementado: skip sin arrastrar a WA (no está en la cadena)", () => {
    const plan = planNotificationDispatch({
      channel: "call",
      consent: { call: true, whatsapp: true, sms: true },
      now: day,
      available,
    });
    assert.equal(plan.action, "skip");
    if (plan.action !== "skip") return;
    assert.deepEqual(plan.skipped, [
      { channel: "call", reason: "channel_unavailable" },
    ]);
  });

  it("consentimiento missing (undefined) no envía el canal", () => {
    const plan = planNotificationDispatch({
      channel: "sms",
      consent: {},
      now: day,
      available,
    });
    assert.equal(plan.action, "skip");
    if (plan.action !== "skip") return;
    assert.equal(plan.reason, "no_consent");
  });
});
