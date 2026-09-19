import type { FastifyInstance } from "fastify";
import { checkDbReadiness } from "@startup-logistica/shared/db";
import { pool } from "../db.js";

export async function healthRoutes(app: FastifyInstance) {
  // Liveness: el proceso responde. No toca dependencias externas.
  app.get("/health", async () => ({ ok: true }));

  // Readiness: comprueba conectividad con Postgres y que PostGIS esté instalado.
  // Devuelve 503 si la base no está lista para que orquestadores/balanceadores
  // no enruten tráfico a una instancia sin base de datos.
  app.get("/health/ready", async (_request, reply) => {
    const db = await checkDbReadiness(pool);
    const ready = db.ok && db.postgis;
    reply.code(ready ? 200 : 503);
    return { ok: ready, db };
  });
}
