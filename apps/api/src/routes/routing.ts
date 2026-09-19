import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";
import { agenciaPorApiKey } from "../auth-agencia.js";
import {
  nearbyCouriers,
  nextStops,
  planRoute,
  RutaNoEncontrada,
} from "../services/routing/index.js";

const cercanosSchema = z.object({
  lat: z.coerce.number().gte(-90).lte(90),
  lon: z.coerce.number().gte(-180).lte(180),
  radiusM: z.coerce.number().positive().max(100_000).default(5_000),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const optimizarSchema = z.object({
  persist: z.boolean().optional(),
  start: z
    .object({
      lat: z.number().gte(-90).lte(90),
      lon: z.number().gte(-180).lte(180),
    })
    .optional(),
});

async function resolveRepartidor(idOrCodigo: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT id FROM repartidores WHERE id::text = $1 OR codigo = $1`,
    [idOrCodigo],
  );
  return rows[0]?.id ?? null;
}

export async function routingRoutes(app: FastifyInstance) {
  // Repartidores cercanos a un punto (ST_DWithin + ST_Distance). Auth agencia.
  app.get("/agencia/repartidores-cercanos", async (request, reply) => {
    const agencia = await agenciaPorApiKey(request);
    if (!agencia) return reply.code(401).send({ error: "api key inválida" });
    const parsed = cercanosSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const couriers = await nearbyCouriers({
      ...parsed.data,
      agenciaId: agencia.id,
    });
    return { couriers };
  });

  // Próximas paradas del repartidor ordenadas por proximidad a su GPS actual.
  app.get("/repartidor/:id/proximas-paradas", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repartidorId = await resolveRepartidor(id);
    if (!repartidorId) {
      return reply.code(404).send({ error: "repartidor no encontrado" });
    }
    const result = await nextStops(repartidorId);
    if (!result) {
      return reply
        .code(409)
        .send({ error: "el repartidor aún no ha reportado ubicación" });
    }
    return result;
  });

  // Optimiza el orden de reparto de una ruta (vecino más cercano). Auth agencia.
  app.post("/agencia/rutas/:rutaId/optimizar", async (request, reply) => {
    const agencia = await agenciaPorApiKey(request);
    if (!agencia) return reply.code(401).send({ error: "api key inválida" });
    const { rutaId } = request.params as { rutaId: string };
    const parsed = optimizarSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return await planRoute({
        rutaId,
        agenciaId: agencia.id,
        start: parsed.data.start,
        persist: parsed.data.persist,
      });
    } catch (err) {
      if (err instanceof RutaNoEncontrada) {
        return reply.code(404).send({ error: err.message });
      }
      throw err;
    }
  });
}
