import type { EstadoParada } from "./types.js";

const TRANSICIONES: Record<EstadoParada, readonly EstadoParada[]> = {
  pendiente: ["notificado"],
  notificado: ["confirmado", "entregado", "ausente", "reprogramado", "reasignado"],
  confirmado: ["entregado", "ausente", "reprogramado", "reasignado"],
  entregado: [],
  ausente: ["reprogramado", "reasignado"],
  reprogramado: ["pendiente"],
  reasignado: [],
};

export function puedeTransicionar(
  desde: EstadoParada,
  hacia: EstadoParada,
): boolean {
  return TRANSICIONES[desde].includes(hacia);
}

export class TransicionParadaInvalida extends Error {
  constructor(desde: EstadoParada, hacia: EstadoParada) {
    super(`Transición de parada inválida: ${desde} → ${hacia}`);
    this.name = "TransicionParadaInvalida";
  }
}

export function assertTransicion(
  desde: EstadoParada,
  hacia: EstadoParada,
): void {
  if (!puedeTransicionar(desde, hacia)) {
    throw new TransicionParadaInvalida(desde, hacia);
  }
}

export const ESTADOS_TERMINALES: readonly EstadoParada[] = [
  "entregado",
  "reasignado",
];

export function esEstadoTerminal(estado: EstadoParada): boolean {
  return ESTADOS_TERMINALES.includes(estado);
}
