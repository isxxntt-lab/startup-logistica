import { pool } from "../db.js";
import { agenciaPorClave } from "../auth-agencia.js";

export type WsAuthMessage = {
  tipo?: string;
  apiKey?: string;
  id?: string;
};

export function parseWsAuthMessage(raw: unknown): WsAuthMessage | null {
  let text: string;
  if (typeof raw === "string") text = raw;
  else if (raw instanceof Buffer) text = raw.toString("utf8");
  else if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString("utf8");
  else return null;
  try {
    const parsed = JSON.parse(text) as WsAuthMessage;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * El canal WS del repartidor exige API key de agencia y que `id`
 * (uuid o código) pertenezca a esa agencia.
 */
export async function autorizarRepartidorWs(opts: {
  apiKey?: string;
  id?: string;
}): Promise<string | null> {
  const apiKey = opts.apiKey?.trim();
  const id = opts.id?.trim();
  if (!apiKey || !id) return null;

  const agencia = await agenciaPorClave(apiKey);
  if (!agencia) return null;

  const { rows } = await pool.query<{ id: string }>(
    `SELECT id::text AS id
     FROM repartidores
     WHERE agencia_id = $1
       AND activo = true
       AND (id::text = $2 OR codigo = $2)
     LIMIT 1`,
    [agencia.id, id],
  );
  return rows[0]?.id ?? null;
}
