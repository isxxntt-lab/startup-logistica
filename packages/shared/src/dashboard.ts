export type IsoDate = string;
export type IsoDateTime = string;

export type DeliveryStatus =
  | "pending"
  | "in_transit"
  | "approaching"
  | "delivered"
  | "failed"
  | "rescheduled";

export type FailureReason =
  | "recipient_absent"
  | "wrong_address"
  | "refused"
  | "access_issue"
  | "other";

export interface LocationPing {
  event: "location_update";
  courierId: string;
  orderId: string;
  timestamp: IsoDateTime;
  location: {
    lat: number;
    lng: number;
    accuracyM: number;
    altitudeM?: number;
    headingDeg?: number;
    speedMps?: number;
  };
}

export interface GeofenceEvent {
  orderId: string;
  courierId: string;
  type: "entered" | "exited" | "at_delivery";
  radiusM: number;
  distanceM: number;
  timestamp: IsoDateTime;
  dwellStartedAt?: IsoDateTime;
  dwellEndedAt?: IsoDateTime;
  dwellSeconds?: number;
}

export interface DeliveryAttempt {
  attemptNumber: number;
  startedAt: IsoDateTime;
  completedAt?: IsoDateTime;
  status: Extract<DeliveryStatus, "delivered" | "failed" | "rescheduled">;
  failureReason?: FailureReason;
  failureAvoided: boolean;
  avoidanceChannel?: "sms" | "whatsapp" | "call" | "app";
  geofenceDwellSeconds?: number;
}

export interface Delivery {
  id: string;
  reference: string;
  courierId: string;
  courierName: string;
  status: DeliveryStatus;
  address: string;
  scheduledDate: IsoDate;
  attempts: DeliveryAttempt[];
  firstAttemptSuccess: boolean;
  createdAt: IsoDateTime;
  deliveredAt?: IsoDateTime;
}

export interface DashboardFilters {
  from: IsoDate;
  to: IsoDate;
  courierId?: string;
  zoneId?: string;
  comparePreviousPeriod?: boolean;
}

export interface DeliveryKpis {
  period: { from: IsoDate; to: IsoDate };
  totalDeliveries: number;
  deliveredCount: number;
  failedCount: number;
  failedDeliveriesAvoided: number;
  failedDeliveriesAvoidedRate: number;
  avgGeofenceDwellSeconds: number;
  avgGeofenceDwellMinutes: number;
  firstAttemptSuccessRate: number;
  firstAttemptSuccessCount: number;
  firstAttemptTotal: number;
  onTimeRate: number;
  avgAttemptsToDeliver: number;
  activeCouriers: number;
  inGeofenceNow: number;
}

export interface KpiTrendPoint {
  date: IsoDate;
  failedDeliveriesAvoided: number;
  avgGeofenceDwellMinutes: number;
  firstAttemptSuccessRate: number;
  deliveredCount: number;
}

export interface DashboardPayload {
  filters: DashboardFilters;
  kpis: DeliveryKpis;
  previousKpis?: DeliveryKpis;
  trend: KpiTrendPoint[];
  recentDeliveries: Delivery[];
  liveInGeofence: Array<{
    orderId: string;
    reference: string;
    courierName: string;
    enteredAt: IsoDateTime;
    dwellSeconds: number;
    etaMinutes?: number;
  }>;
}

export const ESTADO_A_DELIVERY_STATUS: Record<string, DeliveryStatus> = {
  pendiente: "pending",
  notificado: "in_transit",
  confirmado: "approaching",
  entregado: "delivered",
  ausente: "failed",
  reprogramado: "rescheduled",
  reasignado: "rescheduled",
};
