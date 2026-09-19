import { timingSafeEqual } from "node:crypto";

export const UNAUTHORIZED_BODY = { error: "unauthorized" } as const;

/** Token interno de servicio. Vacío o ausente → el proceso no debe arrancar. */
export function requireInternalServiceToken(
  value = process.env.INTERNAL_SERVICE_TOKEN,
): string {
  const token = value?.trim() ?? "";
  if (!token) {
    throw new Error(
      "Falta INTERNAL_SERVICE_TOKEN. Genera un secreto con: openssl rand -hex 32",
    );
  }
  return token;
}

export function isPublicHealthRequest(method: string, url: string): boolean {
  const path = url.split("?")[0];
  return method === "GET" && path === "/health";
}

export function parseBearerToken(
  header: string | string[] | undefined,
): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return match?.[1];
}

/** Comparación en tiempo constante. Longitudes distintas → false (sin timingSafeEqual). */
export function timingSafeEqualString(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function bearerMatches(
  header: string | string[] | undefined,
  expectedToken: string,
): boolean {
  if (!expectedToken) return false;
  const presented = parseBearerToken(header);
  if (!presented) return false;
  return timingSafeEqualString(presented, expectedToken);
}

type AuthRequest = {
  method: string;
  url: string;
  headers: { authorization?: string | string[] };
};

type AuthReply = {
  code: (status: number) => { send: (payload: unknown) => unknown };
};

/**
 * Hook Fastify `onRequest`: GET /health público; el resto exige
 * `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`.
 * Si el token esperado está vacío, responde 500 (fail-closed).
 */
export function createInternalAuthHook(expectedToken: string) {
  return async function internalAuthHook(
    req: AuthRequest,
    reply: AuthReply,
  ): Promise<unknown> {
    if (isPublicHealthRequest(req.method, req.url)) {
      return;
    }
    if (!expectedToken) {
      return reply.code(500).send({ error: "internal_error" });
    }
    if (!bearerMatches(req.headers.authorization, expectedToken)) {
      return reply.code(401).send(UNAUTHORIZED_BODY);
    }
  };
}
