import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";

const master = process.env.JWT_MASTER_SECRET ?? "dev-only-change-me";

function secretoAgencia(agenciaId: string): string {
  return createHmac("sha256", master).update(agenciaId).digest("hex");
}

export function firmarTokenCliente(paradaId: string, agenciaId: string): string {
  return jwt.sign({ parada_id: paradaId, agencia_id: agenciaId }, secretoAgencia(agenciaId), {
    expiresIn: "48h",
  });
}
