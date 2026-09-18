export const STREAMS = {
  notifications: "stream:notifications",
  webhooks: "stream:webhooks",
  geofence: "stream:geofence",
  routeProgress: "stream:route-progress",
} as const;

export const CONSUMER_GROUPS = {
  notifications: "cg:notifications",
  webhooks: "cg:webhooks",
  geofence: "cg:geofence",
  routeProgress: "cg:route-progress",
} as const;

export const repartidorChannel = (repartidorId: string) =>
  `canal:repartidor:${repartidorId}`;

export type NotificationRequested = {
  type: "NOTIFICATION_REQUESTED";
  paradaId: string;
  motivo:
    | "proximidad_geocerca"
    | "faltan_n_paradas"
    | "manual"
    | "entrega_confirmada";
  paradasRestantes?: number;
  minutosRestantes?: number;
  eta?: string;
};

export type WebhookReceived = {
  type: "WEBHOOK_RECEIVED";
  proveedor: "twilio" | "meta";
  proveedorMessageId?: string;
  rawBody: string;
  receivedAt: string;
};

export type LocationUpdated = {
  type: "LOCATION_UPDATED";
  event?: "location_update";
  courierId: string;
  orderId?: string;
  repartidorId: string;
  rutaId?: string;
  timestamp: string;
  location: {
    lat: number;
    lng: number;
    accuracyM: number;
    altitudeM?: number;
    headingDeg?: number;
    speedMps?: number;
  };
  lat: number;
  lon: number;
  at: string;
};

export type ParadaCompleted = {
  type: "PARADA_COMPLETED";
  rutaId: string;
  paradaId: string;
  orden: number;
  repartidorId: string;
};

export type DomainEvent =
  | NotificationRequested
  | WebhookReceived
  | LocationUpdated
  | ParadaCompleted;

export function serializeEvent(event: DomainEvent): Record<string, string> {
  return { payload: JSON.stringify(event) };
}

export function parseEvent(fields: Record<string, string>): DomainEvent {
  return JSON.parse(fields.payload) as DomainEvent;
}
