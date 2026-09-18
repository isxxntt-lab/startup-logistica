import {
  TRACKING_ACTIONS,
  trackingApiPath,
} from "@startup-logistica/shared/tracking-token";
import type {
  ConfirmPresenceResponse,
  GoneReason,
  RescheduleResponse,
  TrackingPosition,
  TrackingSession,
} from "../types/tracking";

const apiBase = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export class TrackingGoneError extends Error {
  readonly reason: GoneReason;
  readonly status = 410 as const;

  constructor(reason: GoneReason) {
    super("gone");
    this.name = "TrackingGoneError";
    this.reason = reason;
  }
}

export class TrackingHttpError extends Error {
  constructor(
    readonly status: number,
    message = `HTTP ${status}`,
  ) {
    super(message);
    this.name = "TrackingHttpError";
  }
}

export function isTrackingGoneError(err: unknown): err is TrackingGoneError {
  return err instanceof TrackingGoneError;
}

function withToken(path: string, token: string): string {
  const qs = new URLSearchParams({ token });
  return `${apiBase}${path}?${qs.toString()}`;
}

async function parseGoneOrJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as
    | { error?: string; reason?: GoneReason }
    | T
    | null;
  if (res.status === 410) {
    const reason =
      body && typeof body === "object" && "reason" in body && body.reason === "used"
        ? "used"
        : "expired";
    throw new TrackingGoneError(reason);
  }
  if (!res.ok) {
    throw new TrackingHttpError(res.status);
  }
  return body as T;
}

export async function fetchTrackingSession(token: string): Promise<TrackingSession> {
  const res = await fetch(withToken(trackingApiPath(TRACKING_ACTIONS.session), token));
  return parseGoneOrJson<TrackingSession>(res);
}

export async function fetchCourierPosition(
  token: string,
): Promise<TrackingPosition | null> {
  const res = await fetch(withToken(trackingApiPath(TRACKING_ACTIONS.position), token));
  if (res.status === 404) return null;
  return parseGoneOrJson<TrackingPosition>(res);
}

export async function postConfirmPresence(
  token: string,
): Promise<ConfirmPresenceResponse> {
  const res = await fetch(`${apiBase}${trackingApiPath(TRACKING_ACTIONS.confirmPresence)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return parseGoneOrJson<ConfirmPresenceResponse>(res);
}

export async function postReschedule(
  token: string,
  preferredWindow?: string,
): Promise<RescheduleResponse> {
  const res = await fetch(`${apiBase}${trackingApiPath(TRACKING_ACTIONS.reschedule)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      preferred_window: preferredWindow || undefined,
    }),
  });
  return parseGoneOrJson<RescheduleResponse>(res);
}

/** Solo lee el token de la query (?token=). Nunca localStorage. */
export function readTokenFromSearchParams(
  search = typeof window === "undefined" ? "" : window.location.search,
): string | null {
  const value = new URLSearchParams(search).get("token");
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
