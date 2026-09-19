import { Redis } from "ioredis";
import { config } from "./config.js";

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  connectTimeout: 3000,
  lazyConnect: false,
});

/** Conexión aparte: XREADGROUP BLOCK no puede compartir el cliente HTTP. */
export const redisConsumer = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
  connectTimeout: 3000,
  lazyConnect: false,
});

export async function readJson<T>(key: string): Promise<T | null> {
  const raw = await redis.get(key);
  if (!raw) return null;
  return JSON.parse(raw) as T;
}

export async function closeRedis(): Promise<void> {
  redis.disconnect();
  redisConsumer.disconnect();
}
