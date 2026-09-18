import {
  CONSUMER_GROUPS,
  STREAMS,
  type DomainEvent,
} from "@startup-logistica/shared";
import { applyOpsSchema, initOps } from "@startup-logistica/shared/ops";
import { consumeStream } from "./consume.js";
import { handleNotification } from "./consumers/notifications.js";
import { handleWebhook } from "./consumers/webhooks.js";
import { handleGeofence } from "./consumers/geofence.js";
import { handleRouteProgress } from "./consumers/route-progress.js";
import { pool } from "./db.js";

initOps(pool);
await applyOpsSchema(pool);

const consumerName = `worker-${process.pid}`;

await consumeStream({
  stream: STREAMS.notifications,
  group: CONSUMER_GROUPS.notifications,
  consumer: consumerName,
  handler: async (event: DomainEvent) => {
    if (event.type === "NOTIFICATION_REQUESTED") await handleNotification(event);
  },
});

await consumeStream({
  stream: STREAMS.webhooks,
  group: CONSUMER_GROUPS.webhooks,
  consumer: consumerName,
  handler: async (event: DomainEvent) => {
    if (event.type === "WEBHOOK_RECEIVED") await handleWebhook(event);
  },
});

await consumeStream({
  stream: STREAMS.geofence,
  group: CONSUMER_GROUPS.geofence,
  consumer: consumerName,
  handler: async (event: DomainEvent) => {
    if (event.type === "LOCATION_UPDATED") await handleGeofence(event);
  },
});

await consumeStream({
  stream: STREAMS.routeProgress,
  group: CONSUMER_GROUPS.routeProgress,
  consumer: consumerName,
  handler: async (event: DomainEvent) => {
    if (event.type === "PARADA_COMPLETED") await handleRouteProgress(event);
  },
});
