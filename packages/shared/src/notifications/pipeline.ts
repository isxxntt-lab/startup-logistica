import {
  STREAMS,
  serializeEvent,
  type DomainEvent,
  type LocationUpdated,
  type NotificationRequested,
  type ParadaCompleted,
  type WebhookReceived,
} from "../events.js";

/** Cliente Redis mínimo: ioredis `xadd` (API y workers). */
export type RedisStreamWriter = {
  xadd: (
    stream: string,
    id: string,
    ...fieldValuePairs: string[]
  ) => Promise<string | number | null>;
};

export async function enqueue(
  redis: RedisStreamWriter,
  stream: string,
  event: DomainEvent,
): Promise<string> {
  const id = await redis.xadd(
    stream,
    "*",
    ...Object.entries(serializeEvent(event)).flat(),
  );
  return String(id ?? "");
}

export async function enqueueNotification(
  redis: RedisStreamWriter,
  event: NotificationRequested,
): Promise<string> {
  return enqueue(redis, STREAMS.notifications, event);
}

export async function enqueueWebhook(
  redis: RedisStreamWriter,
  event: WebhookReceived,
): Promise<string> {
  return enqueue(redis, STREAMS.webhooks, event);
}

export async function enqueueGeofence(
  redis: RedisStreamWriter,
  event: LocationUpdated,
): Promise<string> {
  return enqueue(redis, STREAMS.geofence, event);
}

export async function enqueueRouteProgress(
  redis: RedisStreamWriter,
  event: ParadaCompleted,
): Promise<string> {
  return enqueue(redis, STREAMS.routeProgress, event);
}
