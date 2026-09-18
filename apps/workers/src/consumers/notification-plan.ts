import type { NotificationRequested } from "@startup-logistica/shared";
import {
  consentFromParada,
  planNotificationDispatch,
  resolveChannelAvailability,
  type DispatchPlan,
  type NotificationChannel,
} from "@startup-logistica/shared/ops";

const twilioSid = process.env.TWILIO_ACCOUNT_SID ?? "";
const twilioToken = process.env.TWILIO_AUTH_TOKEN ?? "";
const twilioFrom = process.env.TWILIO_WHATSAPP_FROM ?? "";
const twilioSmsFrom = process.env.TWILIO_SMS_FROM ?? "";

export function asChannel(value: string | undefined | null): NotificationChannel {
  if (value === "sms" || value === "call" || value === "app") return value;
  return "whatsapp";
}

export function destinationForChannel(
  channel: NotificationChannel,
  parada: Record<string, unknown>,
): string {
  if (channel === "app") return String(parada.device_push_token ?? "");
  return String(parada.cliente_telefono ?? "");
}

export function planForParada(
  parada: Record<string, unknown>,
  event: NotificationRequested,
  now: Date = new Date(),
): DispatchPlan {
  return planNotificationDispatch({
    channel: asChannel(event.channel),
    consent: consentFromParada({
      consent_whatsapp: parada.consent_whatsapp as boolean | null | undefined,
      consent_sms: parada.consent_sms as boolean | null | undefined,
      consent_push: parada.consent_push as boolean | null | undefined,
    }),
    now,
    available: resolveChannelAvailability({
      telefono: (parada.cliente_telefono as string | null | undefined) ?? null,
      pushToken: (parada.device_push_token as string | null | undefined) ?? null,
      twilioSid,
      twilioToken,
      twilioWhatsappFrom: twilioFrom,
      twilioSmsFrom,
    }),
  });
}
