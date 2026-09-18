import type { FastifyInstance } from "fastify";
import { redis } from "../redis.js";
import { repartidorChannel } from "@startup-logistica/shared";
import { autorizarRepartidorWs, parseWsAuthMessage } from "./auth.js";

const sockets = new Map<string, Set<{ send: (msg: string) => void }>>();

const WS_AUTH_TIMEOUT_MS = 5_000;

export function pushToRepartidor(repartidorId: string, payload: string) {
  const set = sockets.get(repartidorId);
  if (!set) return;
  for (const ws of set) {
    try {
      ws.send(payload);
    } catch {
      /* conexión ya cerrada */
    }
  }
}

type WsSocket = {
  send: (msg: string) => void;
  close: (code?: number, reason?: string) => void;
  once: (event: "message", listener: (raw: unknown) => void) => void;
  on: (event: "close", listener: () => void) => void;
};

function deny(socket: WsSocket, reason = "no autorizado") {
  try {
    socket.send(JSON.stringify({ tipo: "error", error: reason }));
  } catch {
    /* ignore */
  }
  socket.close(1008, reason);
}

function attach(repartidorId: string, socket: WsSocket) {
  let set = sockets.get(repartidorId);
  if (!set) {
    set = new Set();
    sockets.set(repartidorId, set);
  }
  set.add(socket);
  socket.send(JSON.stringify({ tipo: "conectado", repartidorId }));
  socket.on("close", () => {
    set?.delete(socket);
    if (set && set.size === 0) sockets.delete(repartidorId);
  });
}

export async function registerWs(app: FastifyInstance) {
  const sub = redis.duplicate();
  await sub.psubscribe("canal:repartidor:*");
  sub.on("pmessage", (_pattern: string, channel: string, message: string) => {
    const id = channel.replace("canal:repartidor:", "");
    pushToRepartidor(id, message);
  });

  app.get("/ws/repartidor", { websocket: true }, (socket, request) => {
    const ws = socket as unknown as WsSocket;
    const idQuery = (request.query as { id?: string }).id;
    const headerKey = request.headers["x-api-key"];
    const headerApiKey = typeof headerKey === "string" ? headerKey : undefined;

    const complete = (apiKey: string | undefined, id: string | undefined) => {
      void autorizarRepartidorWs({ apiKey, id }).then((repartidorId) => {
        if (!repartidorId) {
          deny(ws);
          return;
        }
        attach(repartidorId, ws);
      });
    };

    if (headerApiKey && idQuery) {
      complete(headerApiKey, idQuery);
      return;
    }

    const timer = setTimeout(() => {
      deny(ws, "auth timeout");
    }, WS_AUTH_TIMEOUT_MS);

    ws.once("message", (raw) => {
      clearTimeout(timer);
      const parsed = parseWsAuthMessage(raw);
      if (!parsed || parsed.tipo !== "auth") {
        deny(ws);
        return;
      }
      complete(parsed.apiKey ?? headerApiKey, parsed.id ?? idQuery);
    });
  });

  app.addHook("onClose", async () => {
    await sub.quit();
  });
}

export { repartidorChannel, WS_AUTH_TIMEOUT_MS };
