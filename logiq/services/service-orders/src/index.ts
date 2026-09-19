import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  canTransition,
  isOrderStatus,
  keys,
  streams,
  type Order,
  type OrderStatus,
  type OrderStreamEvent,
} from "@logiq/shared";
import { config } from "./config.js";
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
  return { ok: true, service: config.serviceName };
});

app.post<{
  Body: {
    customerName: string;
    addressText: string;
    lat: number;
    lng: number;
    phone?: string;
  };
}>(
  "/orders",
  {
    schema: {
      body: {
        type: "object",
        required: ["customerName", "addressText", "lat", "lng"],
        additionalProperties: false,
        properties: {
          customerName: { type: "string", minLength: 1 },
          addressText: { type: "string", minLength: 1 },
          lat: { type: "number", minimum: -90, maximum: 90 },
          lng: { type: "number", minimum: -180, maximum: 180 },
          phone: { type: "string", minLength: 1 },
        },
      },
    },
  },
  async (req, reply) => {
    const now = new Date().toISOString();
    const order: Order = {
      id: randomUUID(),
      customerName: req.body.customerName.trim(),
      addressText: req.body.addressText.trim(),
      lat: req.body.lat,
      lng: req.body.lng,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    if (req.body.phone) {
      order.phone = req.body.phone.trim();
    }

    const event: OrderStreamEvent = {
      type: "order_created",
      order,
      at: now,
    };

    await redis
      .multi()
      .set(keys.order(order.id), JSON.stringify(order))
      .xadd(streams.orders, "*", "payload", JSON.stringify(event))
      .exec();

    return reply.code(201).send(order);
  },
);

app.get<{ Params: { id: string } }>("/orders/:id", async (req, reply) => {
  const order = await readJson<Order>(keys.order(req.params.id));
  if (!order) {
    return reply.code(404).send({ error: "order_not_found" });
  }
  return order;
});

app.patch<{
  Params: { id: string };
  Body: { status: string };
}>(
  "/orders/:id/status",
  {
    schema: {
      body: {
        type: "object",
        required: ["status"],
        additionalProperties: false,
        properties: {
          status: { type: "string" },
        },
      },
    },
  },
  async (req, reply) => {
    if (!isOrderStatus(req.body.status)) {
      return reply.code(400).send({
        error: "invalid_status",
        allowed: [
          "pending",
          "assigned",
          "in_transit",
          "delivered",
          "failed",
          "cancelled",
        ],
      });
    }

    const next = req.body.status as OrderStatus;
    const order = await readJson<Order>(keys.order(req.params.id));
    if (!order) {
      return reply.code(404).send({ error: "order_not_found" });
    }

    if (!canTransition(order.status, next)) {
      return reply.code(409).send({
        error: "invalid_transition",
        from: order.status,
        to: next,
      });
    }

    if (order.status === next) {
      return order;
    }

    const now = new Date().toISOString();
    const updated: Order = { ...order, status: next, updatedAt: now };
    const event: OrderStreamEvent = {
      type: "order_status_changed",
      order: updated,
      at: now,
    };

    await redis
      .multi()
      .set(keys.order(updated.id), JSON.stringify(updated))
      .xadd(streams.orders, "*", "payload", JSON.stringify(event))
      .exec();

    return updated;
  },
);

async function shutdown(signal: string) {
  app.log.info({ signal }, "apagando service-orders");
  await app.close();
  await closeRedis();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
