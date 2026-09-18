import {
  STREAMS,
  serializeEvent,
  enqueueNotification as enqueueNotificationToStream,
  type DomainEvent,
} from "@startup-logistica/shared";
import { redis } from "./redis.js";

export async function enqueue(stream: string, event: DomainEvent): Promise<string> {
  return redis.xadd(stream, "*", ...Object.entries(serializeEvent(event)).flat());
}

export async function enqueueNotification(
  event: Extract<DomainEvent, { type: "NOTIFICATION_REQUESTED" }>,
): Promise<string> {
  return enqueueNotificationToStream(redis, event);
}

export async function enqueueWebhook(
  event: Extract<DomainEvent, { type: "WEBHOOK_RECEIVED" }>,
): Promise<string> {
  return enqueue(STREAMS.webhooks, event);
}

export async function enqueueGeofence(
  event: Extract<DomainEvent, { type: "LOCATION_UPDATED" }>,
): Promise<string> {
  return enqueue(STREAMS.geofence, event);
}

export async function enqueueRouteProgress(
  event: Extract<DomainEvent, { type: "PARADA_COMPLETED" }>,
): Promise<string> {
  return enqueue(STREAMS.routeProgress, event);
}
