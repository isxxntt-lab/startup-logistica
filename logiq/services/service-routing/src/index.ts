import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  canTransition,
  keys,
  streams,
  type Courier,
  type Order,
  type OrderStreamEvent,
  type RouteAssignment,
} from "@logiq/shared";
import { config } from "./config.js";
import { consumeLocationStream, ingestLocation } from "./geofence.js";
import { closeRedis, readJson, redis } from "./redis.js";

const app = Fastify({ logger: true });

app.setErrorHandler((err, _req, reply) => {
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  reply.code(status).send({
    error: status >= 500 ? "internal_error" : err.message,
  });
});

app.get("/health", async (_req, reply) => {
  const pong = await redis.ping();
  if (pong !== "PONG") {
    return reply.code(503).send({ ok: false, service: config.serviceName });
  }
  return {
    ok: true,
    service: config.serviceName,
    geofenceRadiusM: config.geofenceRadiusM,
  };
});

app.post<{
  Body: { orderId: string; courierId: string };
}>(
  "/routing/assign",
  {
    schema: {
      body: {
        type: "object",
        required: ["orderId", "courierId"],
        additionalProperties: false,
        properties: {
          orderId: { type: "string", minLength: 1 },
          courierId: { type: "string", minLength: 1 },
        },
      },
    },
  },
  async (req, reply) => {
    const { orderId, courierId } = req.body;
    const [order, courier] = await Promise.all([
      readJson<Order>(keys.order(orderId)),
      readJson<Courier>(keys.courier(courierId)),
    ]);

    if (!order) {
      return reply.code(404).send({ error: "order_not_found" });
    }
    if (!courier) {
      return reply.code(404).send({ error: "courier_not_found" });
    }

    const existingId = await redis.get(keys.orderRoute(orderId));
    if (existingId) {
      const existing = await readJson<RouteAssignment>(keys.route(existingId));
      if (existing) {
        if (existing.courierId === courierId) {
          return existing;
        }
        return reply.code(409).send({
          error: "order_already_assigned",
          routeId: existing.id,
          courierId: existing.courierId,
        });
      }
    }

    if (order.status !== "pending" && order.status !== "assigned") {
      return reply.code(409).send({
        error: "order_not_assignable",
        status: order.status,
      });
    }

    const now = new Date().toISOString();
    const route: RouteAssignment = {
      id: randomUUID(),
      orderId: order.id,
      courierId: courier.id,
      status: "assigned",
      destination: {
        lat: order.lat,
        lng: order.lng,
        addressText: order.addressText,
      },
      assignedAt: now,
      updatedAt: now,
      geofenceEntered: false,
    };

    const nextStatus = canTransition(order.status, "assigned")
      ? "assigned"
      : order.status;
    const updatedOrder: Order = {
      ...order,
      status: nextStatus,
      courierId: courier.id,
      updatedAt: now,
    };
    const event: OrderStreamEvent = {
      type: "order_status_changed",
      order: updatedOrder,
      at: now,
    };

    await redis
      .multi()
      .set(keys.route(route.id), JSON.stringify(route))
      .set(keys.order(updatedOrder.id), JSON.stringify(updatedOrder))
      .set(keys.orderRoute(order.id), route.id)
      .sadd(keys.courierRoutes(courier.id), route.id)
      .xadd(streams.orders, "*", "payload", JSON.stringify(event))
      .exec();

    return reply.code(201).send(route);
  },
);

app.get<{ Params: { id: string } }>(
  "/routing/routes/:id",
  async (req, reply) => {
    const route = await readJson<RouteAssignment>(keys.route(req.params.id));
    if (!route) {
      return reply.code(404).send({ error: "route_not_found" });
    }
    return route;
  },
);

app.post<{
  Body: {
    courierId: string;
    lat: number;
    lng: number;
    accuracyM?: number;
    orderId?: string;
  };
}>(
  "/routing/ingest-location",
  {
    schema: {
      body: {
        type: "object",
        required: ["courierId", "lat", "lng"],
        additionalProperties: false,
        properties: {
          courierId: { type: "string", minLength: 1 },
          lat: { type: "number", minimum: -90, maximum: 90 },
          lng: { type: "number", minimum: -180, maximum: 180 },
          accuracyM: { type: "number", minimum: 0 },
          orderId: { type: "string", minLength: 1 },
        },
      },
    },
  },
  async (req) => ingestLocation(req.body),
);

async function shutdown(signal: string) {
  app.log.info({ signal }, "apagando service-routing");
  await app.close();
  await closeRedis();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
  void consumeLocationStream(app.log).catch((err) => {
    app.log.error(err, "consumer stream:locations detenido");
  });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
