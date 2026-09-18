import {
  STREAMS,
  serializeEvent,
  type NotificationRequested,
} from "../events.js";

/** Cliente mínimo de Redis Streams (ioredis `xadd`). */
export type StreamWriter = {
  xadd: (
    stream: string,
    id: string,
    ...fieldValues: string[]
  ) => Promise<string | null>;
};

export type NotificationDedupeParts = {
  paradaId: string;
  channel: string;
  motivo: string;
};

export function notificationDedupeKey(
  paradaId: string,
  channel: string,
  motivo: string,
): string {
  return `${paradaId}:${channel}:${motivo}`;
}

export function notificationDedupeKeyFrom(
  parts: NotificationDedupeParts,
): string {
  return notificationDedupeKey(parts.paradaId, parts.channel, parts.motivo);
}

/**
 * Encola `NOTIFICATION_REQUESTED` en `stream:notifications`.
 * API y workers inyectan su cliente Redis; shared no depende de ioredis.
 */
export async function enqueueNotification(
  redis: StreamWriter,
  event: NotificationRequested,
): Promise<string> {
  const id = await redis.xadd(
    STREAMS.notifications,
    "*",
    ...Object.entries(serializeEvent(event)).flat(),
  );
  if (!id) {
    throw new Error("redis xadd no devolvió id para NOTIFICATION_REQUESTED");
  }
  return id;
}
