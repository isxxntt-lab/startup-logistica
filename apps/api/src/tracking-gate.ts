import type { EstadoParada } from "@startup-logistica/shared";
import { recipientSessionStatus } from "@startup-logistica/shared";
import type { TrackingSessionStatus } from "@startup-logistica/shared";

export type TrackingAuthFailure =
  | { kind: "invalid"; status: 401 | 404 }
  | { kind: "gone"; reason: "expired" | "used" };

export type TrackingAuthOk = {
  kind: "ok";
  sessionStatus: TrackingSessionStatus;
};

export function gateFromJwtError(err: { name?: string }): TrackingAuthFailure {
  if (err.name === "TokenExpiredError") {
    return { kind: "gone", reason: "expired" };
  }
  return { kind: "invalid", status: 401 };
}

export function gateFromParada(opts: {
  found: boolean;
  tokenExpiraAt: Date | string | null;
  estado?: EstadoParada;
  now?: Date;
}): TrackingAuthFailure | TrackingAuthOk {
  if (!opts.found || !opts.estado) {
    return { kind: "invalid", status: 404 };
  }
  const now = opts.now ?? new Date();
  const expira =
    opts.tokenExpiraAt instanceof Date
      ? opts.tokenExpiraAt
      : opts.tokenExpiraAt
        ? new Date(opts.tokenExpiraAt)
        : null;
  if (expira && expira < now) {
    return { kind: "gone", reason: "expired" };
  }
  const sessionStatus = recipientSessionStatus(opts.estado);
  if (sessionStatus === "used") {
    return { kind: "gone", reason: "used" };
  }
  return { kind: "ok", sessionStatus };
}
