import type { FastifyInstance } from "fastify";
import { redis } from "../redis.js";
import { repartidorChannel } from "@startup-logistica/shared";

const sockets = new Map<string, Set<{ send: (msg: string) => void }>>();

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

export async function registerWs(app: FastifyInstance) {
  const sub = redis.duplicate();
  await sub.psubscribe("canal:repartidor:*");
  sub.on("pmessage", (_pattern, channel, message) => {
    const id = channel.replace("canal:repartidor:", "");
    pushToRepartidor(id, message);
  });

  app.get("/ws/repartidor", { websocket: true }, (socket, request) => {
    const { id } = request.query as { id?: string };
    if (!id) {
      socket.close();
      return;
    }
    let set = sockets.get(id);
    if (!set) {
      set = new Set();
      sockets.set(id, set);
    }
    set.add(socket);
    socket.send(JSON.stringify({ tipo: "conectado", repartidorId: id }));
    socket.on("close", () => {
      set?.delete(socket);
      if (set && set.size === 0) sockets.delete(id);
    });
  });

  app.addHook("onClose", async () => {
    await sub.quit();
  });
}

export { repartidorChannel };
