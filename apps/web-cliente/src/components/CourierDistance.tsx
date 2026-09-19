import { haversineMeters } from "@startup-logistica/shared/routing";
import type { TrackingPosition } from "../types/tracking";

type LatLng = { lat: number; lng: number };

type Props = {
  delivery: LatLng;
  courier: TrackingPosition | null;
};

function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters / 10) * 10} m`;
}

/**
 * Distancia en vivo entre el repartidor y el punto de entrega. Se recalcula en
 * cada actualización de posición (poll ~8s) usando la distancia geodésica de
 * `@startup-logistica/shared/routing`.
 */
export function CourierDistance({ delivery, courier }: Props) {
  if (!courier) {
    return (
      <p className="courier-distance muted" role="status">
        Esperando la ubicación del repartidor…
      </p>
    );
  }

  const meters = haversineMeters(
    { lat: courier.lat, lon: courier.lng },
    { lat: delivery.lat, lon: delivery.lng },
  );
  const updated = new Date(courier.updatedAt).toLocaleTimeString();

  return (
    <p className="courier-distance" role="status">
      El repartidor está a <strong>{formatDistance(meters)}</strong> de tu entrega
      <span className="courier-distance-time"> · actualizado {updated}</span>
    </p>
  );
}
