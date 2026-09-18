import {
  nextNotificationChannel,
  type NotificationChannel,
} from "./types.js";

/** Franja legal / operativa de no molestar para SMS y WhatsApp. */
export const QUIET_HOURS_TIMEZONE = "Europe/Madrid";
/** 22:00 inclusive, hora local de `QUIET_HOURS_TIMEZONE`. */
export const QUIET_HOURS_START_MINUTES = 22 * 60;
/** 08:00 exclusive: a las 08:00 ya se puede enviar. */
export const QUIET_HOURS_END_MINUTES = 8 * 60;

/** Canales ruidosos: se aplazan en quiet hours. Push (`app`) no entra. */
export const QUIET_HOURS_DEFERRED_CHANNELS: ReadonlySet<NotificationChannel> =
  new Set(["whatsapp", "sms", "call"]);

export type ChannelConsent = Partial<Record<NotificationChannel, boolean | null>>;

export type SkipReason = "no_consent" | "channel_unavailable";

export type DispatchSkip = {
  channel: NotificationChannel;
  reason: SkipReason;
};

export type DispatchPlan =
  | {
      action: "send";
      channel: NotificationChannel;
      skipped: DispatchSkip[];
    }
  | {
      action: "defer";
      channel: NotificationChannel;
      nextRetryAt: Date;
      reason: "quiet_hours";
      skipped: DispatchSkip[];
    }
  | {
      action: "skip";
      reason: "no_consent" | "channel_unavailable" | "fallback_exhausted";
      skipped: DispatchSkip[];
    };

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const map: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function tzOffsetMs(utcDate: Date, timeZone: string): number {
  const p = zonedParts(utcDate, timeZone);
  const wallAsUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return wallAsUtc - utcDate.getTime();
}

function addCalendarDays(
  year: number,
  month: number,
  day: number,
  days: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/**
 * Interpreta un reloj de pared en `timeZone` y lo convierte a UTC.
 * Reajusta el offset por si el primer guess cae en el hueco/solape de DST.
 */
export function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = tzOffsetMs(new Date(guess), timeZone);
  guess -= offset1;
  const offset2 = tzOffsetMs(new Date(guess), timeZone);
  if (offset2 !== offset1) {
    guess = Date.UTC(year, month - 1, day, hour, minute, 0) - offset2;
  }
  return new Date(guess);
}

export function minutesInTimeZone(
  now: Date,
  timeZone = QUIET_HOURS_TIMEZONE,
): number {
  const p = zonedParts(now, timeZone);
  return p.hour * 60 + p.minute;
}

export function isQuietHours(
  now: Date,
  timeZone = QUIET_HOURS_TIMEZONE,
): boolean {
  const minutes = minutesInTimeZone(now, timeZone);
  return (
    minutes >= QUIET_HOURS_START_MINUTES || minutes < QUIET_HOURS_END_MINUTES
  );
}

export function isQuietHoursDeferredChannel(
  channel: NotificationChannel,
): boolean {
  return QUIET_HOURS_DEFERRED_CHANNELS.has(channel);
}

/** Próximas 08:00 en `timeZone` (si ahora es 07:59 → hoy; si es 08:00 o más → mañana). */
export function nextQuietHoursEnd(
  now: Date,
  timeZone = QUIET_HOURS_TIMEZONE,
): Date {
  const p = zonedParts(now, timeZone);
  const minutes = p.hour * 60 + p.minute + p.second / 60;
  const target =
    minutes < QUIET_HOURS_END_MINUTES
      ? { year: p.year, month: p.month, day: p.day }
      : addCalendarDays(p.year, p.month, p.day, 1);
  return zonedWallTimeToUtc(target.year, target.month, target.day, 8, 0, timeZone);
}

export function hasChannelConsent(
  consent: ChannelConsent,
  channel: NotificationChannel,
): boolean {
  return consent[channel] === true;
}

export function consentFromParada(row: {
  consent_whatsapp?: boolean | null;
  consent_sms?: boolean | null;
  consent_push?: boolean | null;
  consent_call?: boolean | null;
}): ChannelConsent {
  return {
    whatsapp: row.consent_whatsapp,
    sms: row.consent_sms,
    app: row.consent_push,
    call: row.consent_call,
  };
}

/**
 * Disponibilidad del proveedor/destino. En dry-run (sin SID+token Twilio)
 * WhatsApp y SMS se consideran disponibles si hay teléfono — mismo criterio
 * que el consumer actual.
 */
export function resolveChannelAvailability(input: {
  telefono?: string | null;
  pushToken?: string | null;
  twilioSid?: string;
  twilioToken?: string;
  twilioWhatsappFrom?: string;
  twilioSmsFrom?: string;
}): Record<NotificationChannel, boolean> {
  const phone = Boolean(input.telefono && String(input.telefono).trim());
  const twilioReady = Boolean(input.twilioSid && input.twilioToken);
  const dryRun = !twilioReady;
  return {
    whatsapp: phone && (dryRun || Boolean(input.twilioWhatsappFrom)),
    sms: phone && (dryRun || Boolean(input.twilioSmsFrom)),
    call: false,
    app: Boolean(input.pushToken && String(input.pushToken).trim()),
  };
}

/**
 * Recorre la cadena WA → SMS (y el canal pedido si no está en ella).
 * - Sin consentimiento o canal caído: skip de ese canal y fallback al siguiente usable.
 * - Quiet hours: se aplaza el canal ruidoso; no se cae a SMS para no despertar.
 * - `app` (push) se envía aunque sea de noche.
 */
export function planNotificationDispatch(input: {
  channel: NotificationChannel;
  consent: ChannelConsent;
  now?: Date;
  available?: Partial<Record<NotificationChannel, boolean>>;
  timeZone?: string;
}): DispatchPlan {
  const now = input.now ?? new Date();
  const timeZone = input.timeZone ?? QUIET_HOURS_TIMEZONE;
  const skipped: DispatchSkip[] = [];
  let current: NotificationChannel | null = input.channel;

  while (current) {
    if (!hasChannelConsent(input.consent, current)) {
      skipped.push({ channel: current, reason: "no_consent" });
      current = nextNotificationChannel(current);
      continue;
    }
    if (input.available?.[current] === false) {
      skipped.push({ channel: current, reason: "channel_unavailable" });
      current = nextNotificationChannel(current);
      continue;
    }
    if (isQuietHoursDeferredChannel(current) && isQuietHours(now, timeZone)) {
      return {
        action: "defer",
        channel: current,
        nextRetryAt: nextQuietHoursEnd(now, timeZone),
        reason: "quiet_hours",
        skipped,
      };
    }
    return { action: "send", channel: current, skipped };
  }

  const last = skipped[skipped.length - 1];
  const reason =
    skipped.length === 0
      ? "fallback_exhausted"
      : skipped.every((s) => s.reason === "no_consent")
        ? "no_consent"
        : last?.reason === "channel_unavailable"
          ? "channel_unavailable"
          : "fallback_exhausted";
  return { action: "skip", reason, skipped };
}
