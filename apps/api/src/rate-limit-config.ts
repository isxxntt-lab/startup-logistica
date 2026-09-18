import { createHash } from "node:crypto";

/** Tope global por IP (webhooks van con `rateLimit: false`). */
export const GLOBAL_RATE_LIMIT = {
  max: 100,
  timeWindow: "1 minute" as const,
};

/**
 * Poll de posición del destinatario: 8s → ~7.5 req/min.
 * 30/min deja margen a reintentos y doble montaje, y corta bucles abusivos.
 */
export const TRACKING_POSITION_RATE_LIMIT = {
  max: 30,
  timeWindow: "1 minute" as const,
};

export function trackingPositionRateLimitKey(input: {
  ip: string;
  token?: string;
}): string {
  const token = input.token?.trim();
  const tokenPart =
    token && token.length > 0
      ? createHash("sha256").update(token).digest("hex").slice(0, 16)
      : "anon";
  return `${input.ip}:${tokenPart}`;
}
