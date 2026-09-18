import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import type { ClienteJwtClaims } from "@startup-logistica/shared";
import { config } from "./config.js";

export function secretoAgencia(agenciaId: string): string {
  return createHmac("sha256", config.jwtMasterSecret)
    .update(agenciaId)
    .digest("hex");
}

export function firmarTokenCliente(
  claims: Omit<ClienteJwtClaims, "exp">,
  ttlHoras = 48,
): string {
  return jwt.sign(claims, secretoAgencia(claims.agencia_id), {
    expiresIn: `${ttlHoras}h`,
  });
}

export function verificarTokenCliente(
  token: string,
  agenciaId: string,
): ClienteJwtClaims {
  return jwt.verify(token, secretoAgencia(agenciaId)) as ClienteJwtClaims;
}

export function peekAgenciaId(token: string): string | null {
  const decoded = jwt.decode(token);
  if (!decoded || typeof decoded === "string") return null;
  const agenciaId = (decoded as ClienteJwtClaims).agencia_id;
  return agenciaId ?? null;
}
