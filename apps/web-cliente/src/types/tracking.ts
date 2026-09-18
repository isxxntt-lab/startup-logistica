import type {
  ConfirmPresenceResponse,
  GoneReason,
  RescheduleResponse,
  TrackingPosition,
  TrackingSession,
  TrackingSessionStatus,
} from "@startup-logistica/shared";

export type TokenGate = "loading" | "valid" | "expired" | "used" | "invalid";

export type RecipientUi =
  | "idle"
  | "confirming"
  | "rescheduling"
  | "will_be_there"
  | "reschedule_requested"
  | "action_error";

export type {
  ConfirmPresenceResponse,
  GoneReason,
  RescheduleResponse,
  TrackingPosition,
  TrackingSession,
  TrackingSessionStatus,
};
