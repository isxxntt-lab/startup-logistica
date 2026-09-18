import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";
import { firmarTokenCliente } from "../jwt.js";
import { config } from "../config.js";
import { enqueueNotification } from "../queue.js";
import { agenciaPorApiKey } from "../auth-agencia.js";
import { buildDashboard } from "../services/dashboard.js";

const crearParadaSchema = z.object({
  orden: z.number().int().positive(),
  cliente_nombre: z.string(),
  cliente_telefono: z.string(),
  direccion_texto: z.string(),
  lat: z.number(),
  lon: z.number(),
  referencia_pedido: z.string().optional(),
});

export async function agenciaRoutes(app: FastifyInstance) {
  app.get("/agencia/dashboard", async (request, reply) => {
    const agencia = await agenciaPorApiKey(request);
    if (!agencia) return reply.code(401).send({ error: "api key inválida" });
    const q = request.query as Record<string, string | undefined>;
    const today = new Date().toISOString().slice(0, 10);
    const filters = {
      from: q.from ?? today,
      to: q.to ?? today,
      courierId: q.courierId,
      zoneId: q.zoneId,
      comparePreviousPeriod: q.comparePreviousPeriod === "true",
    };
    return buildDashboard(agencia.id, filters);
  });

  app.post("/agencia/paradas/:id/token", async (request, reply) => {
    const agencia = await agenciaPorApiKey(request);
    if (!agencia) return reply.code(401).send({ error: "api key inválida" });

    const { id } = request.params as { id: string };
    const { rows } = await pool.query(
      `SELECT p.id, r.agencia_id
       FROM paradas p
       JOIN rutas r ON r.id = p.ruta_id
       WHERE p.id = $1 AND r.agencia_id = $2`,
      [id, agencia.id],
    );
    const parada = rows[0];
    if (!parada) return reply.code(404).send({ error: "parada no encontrada" });

    const token = firmarTokenCliente({
      parada_id: parada.id,
      agencia_id: parada.agencia_id,
    });
    const expira = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await pool.query(
      `UPDATE paradas SET token_acceso = $2, token_expira_at = $3 WHERE id = $1`,
      [id, token, expira],
    );

    return {
      token,
      url: `${config.publicWebUrl}/?token=${encodeURIComponent(token)}`,
      expira_at: expira.toISOString(),
    };
  });

  app.post("/agencia/paradas/:id/notificar", async (request, reply) => {
    const agencia = await agenciaPorApiKey(request);
    if (!agencia) return reply.code(401).send({ error: "api key inválida" });
    const { id } = request.params as { id: string };
    await enqueueNotification({
      type: "NOTIFICATION_REQUESTED",
      paradaId: id,
      motivo: "manual",
    });
    return { ok: true };
  });

  app.post("/agencia/rutas/:rutaId/paradas", async (request, reply) => {
    const agencia = await agenciaPorApiKey(request);
    if (!agencia) return reply.code(401).send({ error: "api key inválida" });
    const { rutaId } = request.params as { rutaId: string };
    const body = crearParadaSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }

    const { rows: rutas } = await pool.query(
      `SELECT id FROM rutas WHERE id = $1 AND agencia_id = $2`,
      [rutaId, agencia.id],
    );
    if (!rutas[0]) return reply.code(404).send({ error: "ruta no encontrada" });

    const { rows } = await pool.query(
      `INSERT INTO paradas (
         ruta_id, orden, referencia_pedido, cliente_nombre, cliente_telefono, direccion_texto, ubicacion
       ) VALUES (
         $1, $2, $3, $4, $5, $6, ST_SetSRID(ST_MakePoint($7, $8), 4326)::geography
       )
       RETURNING id`,
      [
        rutaId,
        body.data.orden,
        body.data.referencia_pedido ?? null,
        body.data.cliente_nombre,
        body.data.cliente_telefono,
        body.data.direccion_texto,
        body.data.lon,
        body.data.lat,
      ],
    );
    return { id: rows[0].id };
  });
}
