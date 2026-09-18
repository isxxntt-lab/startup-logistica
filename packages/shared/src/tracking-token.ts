/** Código de negocio: el token de tracking ya no sirve (caducado o usado). */
export const ENLACE_YA_NO_VALIDO = "ENLACE_YA_NO_VALIDO" as const;

/** Cuerpo HTTP de tracking 410. El SPA espera `error: "gone"`. */
export const TRACKING_GONE_ERROR = "gone" as const;

export const TRACKING_ACTIONS = {
  session: "session",
  position: "position",
  confirmPresence: "confirm-presence",
  reschedule: "reschedule",
} as const;

export type TrackingAction =
  (typeof TRACKING_ACTIONS)[keyof typeof TRACKING_ACTIONS];

export function trackingApiPath(
  action: TrackingAction,
): `/api/tracking/${TrackingAction}` {
  return `/api/tracking/${action}`;
}
