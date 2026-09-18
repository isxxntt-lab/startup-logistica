import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  assertTransicion,
  type EstadoParada,
} from "@startup-logistica/shared";
import { pool } from "../db.js";
import { peekAgenciaId, verificarTokenCliente } from "../jwt.js";
import { redisPub } from "../redis.js";
import { repartidorChannel } from "@startup-logistica/shared";

const respuestaSchema = z.object({
  accion: z.enum(["confirmado", "ausente", "reprogramado", "reasignado"]),
  notas: z.string().max(500).optional(),
  punto_recogida_id: z.string().uuid().optional(),
  ventana_alternativa: z.string().optional(),
});

async function autenticarCliente(token: string | undefined) {
  if (!token) {
    throw Object.assign(new Error("token requerido"), { statusCode: 401 });
  }
  const agenciaId = peekAgenciaId(token);
  if (!agenciaId) {
    throw Object.assign(new Error("token inválido"), { statusCode: 401 });
  }
  verificarTokenCliente(token, agenciaId);

  const { rows } = await pool.query(
    `SELECT p.*, r.repartidor_id, r.agencia_id,
            ST_Y(p.ubicacion::geometry) AS lat,
            ST_X(p.ubicacion::geometry) AS lon
     FROM paradas p
     JOIN rutas r ON r.id = p.ruta_id
     WHERE p.token_acceso = $1`,
    [token],
  );
  const parada = rows[0];
  if (!parada) {
    throw Object.assign(new Error("token revocado"), { statusCode: 401 });
  }
  if (parada.token_expira_at && new Date(parada.token_expira_at) < new Date()) {
    throw Object.assign(new Error("token caducado"), { statusCode: 401 });
  }
  return parada;
}

export async function clienteRoutes(app: FastifyInstance) {
  app.get("/cliente/parada", async (request, reply) => {
    const token =
      (request.headers.authorization?.replace(/^Bearer\s+/i, "") as
        | string
        | undefined) || (request.query as { token?: string }).token;
    try {
      const parada = await autenticarCliente(token);
      return {
        id: parada.id,
        cliente_nombre: parada.cliente_nombre,
        direccion_texto: parada.direccion_texto,
        estado: parada.estado,
        lat: Number(parada.lat),
        lon: Number(parada.lon),
        notas_cliente: parada.notas_cliente,
      };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 401;
      return reply.code(status).send({ error: (err as Error).message });
    }
  });

  app.get("/cliente/puntos-recogida", async (request, reply) => {
    const token =
      (request.headers.authorization?.replace(/^Bearer\s+/i, "") as
        | string
        | undefined) || (request.query as { token?: string }).token;
    try {
      const parada = await autenticarCliente(token);
      const { rows } = await pool.query(
        `SELECT pr.id, pr.nombre, pr.horario,
                ST_Y(pr.ubicacion::geometry) AS lat,
                ST_X(pr.ubicacion::geometry) AS lon,
                ST_Distance(pr.ubicacion, p.ubicacion) AS distancia_m
         FROM puntos_recogida pr
         JOIN paradas p ON p.id = $1
         WHERE pr.agencia_id = $2
         ORDER BY pr.ubicacion <-> p.ubicacion
         LIMIT 8`,
        [parada.id, parada.agencia_id],
      );
      return { puntos: rows };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 401;
      return reply.code(status).send({ error: (err as Error).message });
    }
  });

  app.post("/cliente/parada/respuesta", async (request, reply) => {
    const token =
      (request.headers.authorization?.replace(/^Bearer\s+/i, "") as
        | string
        | undefined) || (request.query as { token?: string }).token;
    const parsed = respuestaSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const parada = await autenticarCliente(token);
      const hacia = parsed.data.accion as EstadoParada;
      assertTransicion(parada.estado, hacia);

      await pool.query(
        `UPDATE paradas
         SET estado = $2,
             notas_cliente = COALESCE($3, notas_cliente),
             punto_recogida_id = COALESCE($4, punto_recogida_id)
         WHERE id = $1`,
        [
          parada.id,
          hacia,
          parsed.data.notas ?? null,
          parsed.data.punto_recogida_id ?? null,
        ],
      );

      const payload = JSON.stringify({
        tipo: "cliente_respuesta",
        paradaId: parada.id,
        accion: hacia,
        ventana_alternativa: parsed.data.ventana_alternativa ?? null,
      });
      await redisPub.publish(
        repartidorChannel(parada.repartidor_id),
        payload,
      );

      return { ok: true, estado: hacia };
    } catch (err) {
      const status =
        (err as { name?: string }).name === "TransicionParadaInvalida"
          ? 409
          : ((err as { statusCode?: number }).statusCode ?? 400);
      return reply.code(status).send({ error: (err as Error).message });
    }
  });
}
