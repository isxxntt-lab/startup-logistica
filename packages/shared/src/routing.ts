/**
 * Contratos y algoritmos de ruteo de última milla.
 *
 * La distancia geodésica "de verdad" la calcula PostGIS (`ST_Distance` sobre
 * `geography`) en la capa de API. Aquí vive el algoritmo de ordenación (vecino
 * más cercano), que es puro y unit-testable: recibe una matriz de distancias ya
 * calculada y devuelve el orden de visita. `haversineMeters` se ofrece como
 * utilidad/estimación en cliente cuando no hay acceso a PostGIS.
 */

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface NearbyCourier {
  repartidorId: string;
  codigo: string | null;
  nombre: string;
  distanceM: number;
  ultimaActualizacion: string | null;
}

export interface StopDistance {
  paradaId: string;
  referencia: string | null;
  clienteNombre: string;
  direccion: string;
  estado: string;
  orden: number;
  geocercaRadioM: number;
  lat: number;
  lon: number;
  distanceM: number;
  dentroGeocerca: boolean;
}

export interface RoutePlanStop {
  paradaId: string;
  referencia: string | null;
  orden: number;
  lat: number;
  lon: number;
  legMeters: number;
  cumulativeMeters: number;
}

export interface RoutePlan {
  rutaId: string;
  start: GeoPoint;
  stops: RoutePlanStop[];
  totalMeters: number;
  optimized: boolean;
}

const EARTH_RADIUS_M = 6_371_000;

/** Distancia geodésica aproximada (Haversine) en metros entre dos puntos. */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface NearestNeighborResult {
  /** Orden de visita de los nodos, excluyendo el nodo de inicio. */
  order: number[];
  totalMeters: number;
}

/**
 * Heurística del vecino más cercano sobre una matriz de distancias simétrica.
 *
 * La matriz incluye el punto de inicio en `startIndex` (por defecto 0) y las
 * paradas en el resto de índices. Devuelve el orden de visita de las paradas
 * (sin el inicio) y la distancia total del recorrido.
 *
 * Es una heurística O(n²) adecuada para el tamaño de una ruta de reparto
 * (decenas de paradas); no garantiza el óptimo global (TSP es NP-difícil).
 */
export function nearestNeighborRoute(
  matrix: number[][],
  startIndex = 0,
): NearestNeighborResult {
  const n = matrix.length;
  if (n === 0) return { order: [], totalMeters: 0 };
  if (startIndex < 0 || startIndex >= n) {
    throw new Error(`startIndex ${startIndex} fuera de rango (n=${n})`);
  }

  const visited = new Array<boolean>(n).fill(false);
  visited[startIndex] = true;
  const order: number[] = [];
  let current = startIndex;
  let totalMeters = 0;

  for (let step = 0; step < n - 1; step += 1) {
    let best = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let candidate = 0; candidate < n; candidate += 1) {
      if (visited[candidate]) continue;
      const d = matrix[current]?.[candidate] ?? Number.POSITIVE_INFINITY;
      if (d < bestDist) {
        bestDist = d;
        best = candidate;
      }
    }
    if (best === -1) break;
    visited[best] = true;
    order.push(best);
    totalMeters += Number.isFinite(bestDist) ? bestDist : 0;
    current = best;
  }

  return { order, totalMeters };
}
