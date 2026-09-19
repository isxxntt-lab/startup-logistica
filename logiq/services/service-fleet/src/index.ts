import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  keys,
  streams,
  type Courier,
  type LocationStreamEvent,
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
  Body: { name: string; vehicle?: string };
}>(
  "/fleet/couriers",
  {
    schema: {
      body: {
        type: "object",
        required: ["name"],
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1 },
          vehicle: { type: "string", minLength: 1 },
        },
      },
    },
  },
  async (req, reply) => {
    const now = new Date().toISOString();
    const courier: Courier = {
      id: randomUUID(),
      name: req.body.name.trim(),
      createdAt: now,
      updatedAt: now,
    };
    if (req.body.vehicle) {
      courier.vehicle = req.body.vehicle.trim();
    }
    await redis.set(keys.courier(courier.id), JSON.stringify(courier));
    return reply.code(201).send(courier);
  },
);

app.get<{ Params: { id: string } }>(
  "/fleet/couriers/:id",
  async (req, reply) => {
    const courier = await readJson<Courier>(keys.courier(req.params.id));
    if (!courier) {
      return reply.code(404).send({ error: "courier_not_found" });
    }
    return courier;
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
  "/fleet/location",
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
  async (req, reply) => {
    const courier = await readJson<Courier>(keys.courier(req.body.courierId));
    if (!courier) {
      return reply.code(404).send({ error: "courier_not_found" });
    }

    const now = new Date().toISOString();
    const lastLocation = {
      lat: req.body.lat,
      lng: req.body.lng,
      at: now,
      ...(req.body.accuracyM !== undefined
        ? { accuracyM: req.body.accuracyM }
        : {}),
      ...(req.body.orderId ? { orderId: req.body.orderId } : {}),
    };
    const updated: Courier = {
      ...courier,
      lastLocation,
      updatedAt: now,
    };

    const event: LocationStreamEvent = {
      type: "location_ping",
      courierId: courier.id,
      lat: req.body.lat,
      lng: req.body.lng,
      at: now,
      ...(req.body.accuracyM !== undefined
        ? { accuracyM: req.body.accuracyM }
        : {}),
      ...(req.body.orderId ? { orderId: req.body.orderId } : {}),
    };

    await redis
      .multi()
      .set(keys.courier(updated.id), JSON.stringify(updated))
      .xadd(streams.locations, "*", "payload", JSON.stringify(event))
      .exec();

    return { ok: true, courier: updated, event };
  },
);

async function shutdown(signal: string) {
  app.log.info({ signal }, "apagando service-fleet");
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
