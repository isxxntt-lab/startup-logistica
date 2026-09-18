import type { EstadoParada } from "./types.js";
import { ENLACE_YA_NO_VALIDO } from "./tracking-token.js";

export { ENLACE_YA_NO_VALIDO, TRACKING_ACTIONS, trackingApiPath } from "./tracking-token.js";
export type { TrackingAction } from "./tracking-token.js";

export type GoneReason = "expired" | "used";

export type TrackingGoneBody = {
  error: "gone";
  reason: GoneReason;
  code: typeof ENLACE_YA_NO_VALIDO;
};

export function trackingGoneBody(reason: GoneReason): TrackingGoneBody {
  return { error: "gone", reason, code: ENLACE_YA_NO_VALIDO };
}

export type TrackingSessionStatus =
  | "pending"
  | "will_be_there"
  | "rescheduled";

export type TrackingSession = {
  status: TrackingSessionStatus;
  clienteNombre: string;
  direccionTexto: string;
  referenciaPedido?: string;
  delivery: {
    lat: number;
    lng: number;
  };
  eta?: string;
};

export type TrackingPosition = {
  lat: number;
  lng: number;
  updatedAt: string;
};

export type ConfirmPresenceResponse = {
  ok: true;
  status: "will_be_there";
  eta?: string;
};

export type RescheduleResponse = {
  ok: true;
  status: "reschedule_requested";
};

export function recipientSessionStatus(
  estado: EstadoParada,
): TrackingSessionStatus | "used" {
  if (estado === "confirmado") return "will_be_there";
  if (estado === "reprogramado") return "rescheduled";
  if (estado === "entregado" || estado === "reasignado") return "used";
  return "pending";
}

export function canConfirmPresence(estado: EstadoParada): boolean {
  return (
    estado === "pendiente" ||
    estado === "notificado" ||
    estado === "confirmado"
  );
}

export function canReschedule(estado: EstadoParada): boolean {
  return (
    estado === "pendiente" ||
    estado === "notificado" ||
    estado === "confirmado" ||
    estado === "ausente" ||
    estado === "reprogramado"
  );
}
