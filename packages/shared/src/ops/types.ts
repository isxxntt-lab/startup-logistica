export type OpsLogLevel = "debug" | "info" | "warn" | "error";

export type OpsLogCategory =
  | "webhook"
  | "delivery_status"
  | "notification_fallback"
  | "geofence"
  | "tracking_token"
  | "system";

export type OpsAlertSeverity = "warning" | "critical";
export type OpsAlertStatus = "open" | "ack" | "resolved";

export type OpsAlertCode =
  | "BG_JOB_STUCK"
  | "BG_JOB_FAIL_RATE"
  | "FALLBACK_CHAIN_EXHAUSTED"
  | "CLIENT_RESPONSE_DELAY"
  | "WEBHOOK_ERROR_SPIKE"
  | "DWELL_ANOMALY";

export interface LogOpsInput {
  level: OpsLogLevel;
  category: OpsLogCategory;
  event: string;
  orderId?: string | null;
  attemptNumber?: number | null;
  correlationId?: string;
  actor?: string | null;
  payload?: Record<string, unknown>;
  durationMs?: number | null;
}

export interface OpsAlertCandidate {
  severity: OpsAlertSeverity;
  code: OpsAlertCode;
  title: string;
  message: string;
  orderId?: string | null;
  payload?: Record<string, unknown>;
  dedupeKey: string;
}

export interface OpsMetrics {
  system: {
    healthy: boolean;
    openAlerts: number;
    pendingNotificationJobs: number;
    stuckJobs: number;
    inGeofenceNow: number;
  };
  failureAvoided: {
    count: number;
    rate: number;
    candidates: number;
    confirmedButFailed: number;
  };
  dwell: {
    avgSeconds: number | null;
    avgMinutes: number | null;
    p50Seconds: number | null;
    p95Seconds: number | null;
    closedByDelivered: number;
    closedByExited: number;
  };
  notifications: {
    sent: number;
    failed: number;
    skipped: number;
    fallbacksUsed: number;
  };
  generatedAt: string;
}

export interface OpsHealth {
  ok: boolean;
  openCriticalAlerts: number;
  stuckJobs: number;
}

export interface OpsLogRow {
  id: string;
  created_at: string;
  level: OpsLogLevel;
  category: OpsLogCategory;
  event: string;
  order_id: string | null;
  attempt_number: number | null;
  correlation_id: string;
  actor: string | null;
  payload: Record<string, unknown>;
  duration_ms: number | null;
}

export interface SqlQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number | null;
}

export interface SqlClient {
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => Promise<SqlQueryResult<T>>;
}

export type NotificationChannel = "whatsapp" | "sms" | "call" | "app";
export type NotificationJobStatus =
  | "pending"
  | "sent"
  | "failed"
  | "skipped"
  | "retry";

export const NOTIFICATION_FALLBACK_CHAIN: NotificationChannel[] = [
  "whatsapp",
  "sms",
];

export function nextNotificationChannel(
  channel: NotificationChannel,
): NotificationChannel | null {
  const idx = NOTIFICATION_FALLBACK_CHAIN.indexOf(channel);
  if (idx < 0 || idx >= NOTIFICATION_FALLBACK_CHAIN.length - 1) return null;
  return NOTIFICATION_FALLBACK_CHAIN[idx + 1] ?? null;
}

export const OPS_CLIENT_RESPONSE_DELAY_MINUTES_DEFAULT = 20;
export const OPS_STUCK_JOB_MINUTES = 15;
export const OPS_FAIL_RATE_WINDOW_MINUTES = 15;
export const OPS_FAIL_RATE_MIN_JOBS = 10;
export const OPS_FAIL_RATE_THRESHOLD = 0.3;
export const OPS_WEBHOOK_SPIKE_WINDOW_MINUTES = 5;
export const OPS_WEBHOOK_SPIKE_THRESHOLD = 5;
export const OPS_DWELL_ANOMALY_MINUTES = 45;
