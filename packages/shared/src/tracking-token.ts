/** Código de negocio cuando el enlace de seguimiento ya no vale (caducado o usado). */
export const ENLACE_YA_NO_VALIDO = "ENLACE_YA_NO_VALIDO" as const;

export type EnlaceYaNoValido = typeof ENLACE_YA_NO_VALIDO;

export const TRACKING_ACTIONS = {
  confirmPresence: "confirm-presence",
  reschedule: "reschedule",
  session: "session",
  position: "position",
} as const;

export type TrackingAction =
  (typeof TRACKING_ACTIONS)[keyof typeof TRACKING_ACTIONS];

export function trackingApiPath(action: TrackingAction): string {
  return `/api/tracking/${action}`;
}
