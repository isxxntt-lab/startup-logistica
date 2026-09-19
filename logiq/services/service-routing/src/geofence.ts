import {
  canTransition,
  consumerGroups,
  isWithinGeofence,
  keys,
  streams,
  type Courier,
  type GeofenceStreamEvent,
  type LocationStreamEvent,
  type Order,
  type OrderStreamEvent,
  type RouteAssignment,
} from "@logiq/shared";
import { config } from "./config.js";
import { readJson, redis, redisConsumer } from "./redis.js";

export type IngestResult = {
  courierId: string;
  checked: number;
  geofenceEntered: boolean;
  emitted: boolean;
  routes: Array<{
    routeId: string;
    orderId: string;
    distanceM: number;
    inside: boolean;
    geofenceEntered: boolean;
    emitted: boolean;
  }>;
};

function parseLocation(raw: unknown): LocationStreamEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const event = raw as Partial<LocationStreamEvent>;
  if (
    typeof event.courierId !== "string" ||
    typeof event.lat !== "number" ||
    typeof event.lng !== "number"
  ) {
    return null;
  }
  return {
    type: "location_ping",
    courierId: event.courierId,
    lat: event.lat,
    lng: event.lng,
    accuracyM: event.accuracyM,
    orderId: event.orderId,
    at: typeof event.at === "string" ? event.at : new Date().toISOString(),
  };
}

async function resolveRouteIds(
  courierId: string,
  orderId?: string,
): Promise<string[]> {
  if (orderId) {
    const routeId = await redis.get(keys.orderRoute(orderId));
    return routeId ? [routeId] : [];
  }
  return redis.smembers(keys.courierRoutes(courierId));
}

async function maybeAdvanceOrderInTransit(order: Order, at: string): Promise<Order> {
  if (!canTransition(order.status, "in_transit") || order.status === "in_transit") {
    return order;
  }
  const updated: Order = { ...order, status: "in_transit", updatedAt: at };
  const event: OrderStreamEvent = {
    type: "order_status_changed",
    order: updated,
    at,
  };
  await redis
    .multi()
    .set(keys.order(updated.id), JSON.stringify(updated))
    .xadd(streams.orders, "*", "payload", JSON.stringify(event))
    .exec();
  return updated;
}

export async function processLocationPing(
  input: LocationStreamEvent,
): Promise<IngestResult> {
  const radiusM = config.geofenceRadiusM;
  const routeIds = await resolveRouteIds(input.courierId, input.orderId);
  const results: IngestResult["routes"] = [];
  let anyEntered = false;
  let anyEmitted = false;

  for (const routeId of routeIds) {
    const route = await readJson<RouteAssignment>(keys.route(routeId));
    if (!route || route.courierId !== input.courierId) continue;

    const { inside, distanceM } = isWithinGeofence(
      { lat: input.lat, lng: input.lng },
      route.destination,
      radiusM,
    );

    const now = input.at;
    const next: RouteAssignment = {
      ...route,
      lastDistanceM: distanceM,
      updatedAt: now,
    };

    let emitted = false;
    if (inside) {
      const claimed = await redis.set(
        keys.geofenceEntered(route.id),
        now,
        "NX",
      );
      if (claimed === "OK") {
        next.geofenceEntered = true;
        next.geofenceEnteredAt = now;
        next.status = "geofence_entered";

        const geofenceEvent: GeofenceStreamEvent = {
          type: "geofence_entered",
          routeId: route.id,
          orderId: route.orderId,
          courierId: route.courierId,
          lat: input.lat,
          lng: input.lng,
          distanceM,
          radiusM,
          at: now,
        };

        await redis
          .multi()
          .set(keys.route(route.id), JSON.stringify(next))
          .xadd(streams.geofence, "*", "payload", JSON.stringify(geofenceEvent))
          .exec();

        const order = await readJson<Order>(keys.order(route.orderId));
        if (order) {
          await maybeAdvanceOrderInTransit(order, now);
        }

        emitted = true;
        anyEmitted = true;
      } else {
        next.geofenceEntered = true;
        next.geofenceEnteredAt = route.geofenceEnteredAt ?? now;
        next.status = "geofence_entered";
        await redis.set(keys.route(route.id), JSON.stringify(next));
      }
      anyEntered = true;
    } else {
      await redis.set(keys.route(route.id), JSON.stringify(next));
    }

    results.push({
      routeId: route.id,
      orderId: route.orderId,
      distanceM,
      inside,
      geofenceEntered: next.geofenceEntered,
      emitted,
    });
  }

  return {
    courierId: input.courierId,
    checked: results.length,
    geofenceEntered: anyEntered,
    emitted: anyEmitted,
    routes: results,
  };
}

export async function ingestLocation(body: {
  courierId: string;
  lat: number;
  lng: number;
  accuracyM?: number;
  orderId?: string;
}): Promise<IngestResult> {
  const courier = await readJson<Courier>(keys.courier(body.courierId));
  if (!courier) {
    const err = Object.assign(new Error("courier_not_found"), {
      statusCode: 404,
    });
    throw err;
  }

  return processLocationPing({
    type: "location_ping",
    courierId: body.courierId,
    lat: body.lat,
    lng: body.lng,
    accuracyM: body.accuracyM,
    orderId: body.orderId,
    at: new Date().toISOString(),
  });
}

export async function consumeLocationStream(log: {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}): Promise<void> {
  try {
    await redisConsumer.xgroup(
      "CREATE",
      streams.locations,
      consumerGroups.routingLocations,
      "0",
      "MKSTREAM",
    );
    log.info({ stream: streams.locations }, "grupo de consumo creado");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("BUSYGROUP")) {
      throw err;
    }
  }

  while (true) {
    try {
      const batch = await redisConsumer.xreadgroup(
        "GROUP",
        consumerGroups.routingLocations,
        config.consumerName,
        "BLOCK",
        2000,
        "COUNT",
        20,
        "STREAMS",
        streams.locations,
        ">",
      );

      if (!batch) continue;

      for (const [, entries] of batch) {
        for (const [id, fields] of entries) {
          const raw = fields[1];
          let payload: unknown = null;
          try {
            payload = JSON.parse(raw);
          } catch {
            payload = null;
          }
          const event = parseLocation(payload);
          if (event) {
            const result = await processLocationPing(event);
            if (result.emitted) {
              log.info(result, "geofence_entered emitido desde stream");
            }
          }
          await redisConsumer.xack(
            streams.locations,
            consumerGroups.routingLocations,
            id,
          );
        }
      }
    } catch (err) {
      log.error(err, "error leyendo stream:locations");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
