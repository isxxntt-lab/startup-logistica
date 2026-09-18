import type { LocationPing, LocationUpdated } from "@startup-logistica/shared";

type GrokPing = {
  event?: string;
  courier_id?: string;
  courierId?: string;
  order_id?: string;
  orderId?: string;
  timestamp?: string;
  location?: {
    lat: number;
    lng?: number;
    lon?: number;
    accuracy_m?: number;
    accuracyM?: number;
    altitude_m?: number;
    altitudeM?: number;
    heading_deg?: number;
    headingDeg?: number;
    speed_mps?: number;
    speedMps?: number;
  };
  lat?: number;
  lon?: number;
  lng?: number;
  rutaId?: string;
};

export function toLocationUpdated(
  body: GrokPing,
  repartidorId: string,
): LocationUpdated {
  const loc = body.location;
  const lat = loc?.lat ?? body.lat ?? 0;
  const lng = loc?.lng ?? loc?.lon ?? body.lng ?? body.lon ?? 0;
  const timestamp = body.timestamp ?? new Date().toISOString();
  const courierId = body.courierId ?? body.courier_id ?? repartidorId;
  const orderId = body.orderId ?? body.order_id;
  const ping: LocationPing["location"] = {
    lat,
    lng,
    accuracyM: loc?.accuracyM ?? loc?.accuracy_m ?? 0,
    altitudeM: loc?.altitudeM ?? loc?.altitude_m,
    headingDeg: loc?.headingDeg ?? loc?.heading_deg,
    speedMps: loc?.speedMps ?? loc?.speed_mps,
  };
  return {
    type: "LOCATION_UPDATED",
    event: "location_update",
    courierId,
    orderId,
    repartidorId,
    rutaId: body.rutaId,
    timestamp,
    location: ping,
    lat,
    lon: lng,
    at: timestamp,
  };
}
