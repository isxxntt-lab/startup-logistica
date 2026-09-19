import Fastify from "fastify";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { healthRoutes } from "./routes/health.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { clienteRoutes } from "./routes/cliente.js";
import { trackingRoutes } from "./routes/tracking.js";
import { repartidorRoutes } from "./routes/repartidor.js";
import { agenciaRoutes } from "./routes/agencia.js";
import { routingRoutes } from "./routes/routing.js";
import { opsRoutes, registerOps } from "./routes/ops.js";
import { registerWs } from "./ws/gateway.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: config.corsOrigin });
await app.register(formbody);
await app.register(websocket);
await app.register(rateLimit, {
  max: 100,
  timeWindow: "1 minute",
});

await registerOps(app);
await app.register(healthRoutes);
await app.register(webhookRoutes);
await app.register(clienteRoutes);
await app.register(trackingRoutes);
await app.register(repartidorRoutes);
await app.register(agenciaRoutes);
await app.register(routingRoutes);
await app.register(opsRoutes);
await registerWs(app);

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
