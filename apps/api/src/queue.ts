import {
  STREAMS,
  serializeEvent,
  type DomainEvent,
} from "@startup-logistica/shared";
import { redis } from "./redis.js";

export async function enqueue(stream: string, event: DomainEvent): Promise<string> {
  const id = await redis.xadd(
    stream,
    "*",
    ...Object.entries(serializeEvent(event)).flat(),
  );
  if (id === null) {
    throw new Error(`No se pudo encolar el evento en ${stream}: XADD devolvió null`);
  }
  return id;
}

export async function enqueueNotification(
  event: Extract<DomainEvent, { type: "NOTIFICATION_REQUESTED" }>,
): Promise<string> {
  return enqueue(STREAMS.notifications, event);
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
