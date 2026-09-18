import {
  enqueue as enqueueOn,
  enqueueGeofence as enqueueGeofenceOn,
  enqueueNotification as enqueueNotificationOn,
  enqueueRouteProgress as enqueueRouteProgressOn,
  enqueueWebhook as enqueueWebhookOn,
  type DomainEvent,
  type LocationUpdated,
  type NotificationRequested,
  type ParadaCompleted,
  type WebhookReceived,
} from "@startup-logistica/shared";
import { redis } from "./redis.js";

export async function enqueue(stream: string, event: DomainEvent): Promise<string> {
  return enqueueOn(redis, stream, event);
}

export async function enqueueNotification(
  event: NotificationRequested,
): Promise<string> {
  return enqueueNotificationOn(redis, event);
}

export async function enqueueWebhook(event: WebhookReceived): Promise<string> {
  return enqueueWebhookOn(redis, event);
}

export async function enqueueGeofence(event: LocationUpdated): Promise<string> {
  return enqueueGeofenceOn(redis, event);
}

export async function enqueueRouteProgress(
  event: ParadaCompleted,
): Promise<string> {
  return enqueueRouteProgressOn(redis, event);
}
