import { autorizarRepartidor } from "../auth-repartidor.js";

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
 * (uuid o código) pertenezca a esa agencia. Misma política que HTTP
 * `/repartidor/*` (`autorizarRepartidor`); el socket no distingue 401/403.
 */
export async function autorizarRepartidorWs(opts: {
  apiKey?: string;
  id?: string;
}): Promise<string | null> {
  const result = await autorizarRepartidor(opts);
  return result.ok ? result.repartidorId : null;
}
