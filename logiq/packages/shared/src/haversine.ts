import type { LatLng } from "./types.js";

/** Radio medio de la Tierra en metros (esfera WGS84 aproximada). */
export const EARTH_RADIUS_M = 6_371_000;

function toRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Distancia en metros entre dos puntos WGS84 con la fórmula de Haversine. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isWithinGeofence(
  current: LatLng,
  destination: LatLng,
  radiusM: number,
): { inside: boolean; distanceM: number } {
  const distanceM = haversineMeters(current, destination);
  return { inside: distanceM <= radiusM, distanceM };
}
