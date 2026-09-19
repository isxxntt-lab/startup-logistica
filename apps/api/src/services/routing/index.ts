import {
  nearestNeighborRoute,
  type GeoPoint,
  type NearbyCourier,
  type RoutePlan,
  type RoutePlanStop,
  type StopDistance,
} from "@startup-logistica/shared";
import { pool } from "../../db.js";
import {
  distanceMatrix,
  findNearbyRepartidores,
  getCourierLocation,
  getPickupPoint,
  getRoutePendingStops,
  pendingStopsWithDistance,
  persistRouteOrder,
  type NearbyCouriersParams,
} from "./queries.js";

export * from "./queries.js";

/** Repartidores cercanos a un punto, acotados a una agencia. */
export async function nearbyCouriers(
  params: NearbyCouriersParams,
): Promise<NearbyCourier[]> {
  return findNearbyRepartidores(pool, params);
}

export interface NextStopsResult {
  repartidorId: string;
  from: GeoPoint;
  stops: StopDistance[];
}

/**
 * Próximas paradas de un repartidor ordenadas por proximidad a su ubicación
 * actual. Devuelve null si el repartidor aún no ha reportado GPS.
 */
export async function nextStops(
  repartidorId: string,
): Promise<NextStopsResult | null> {
  const from = await getCourierLocation(pool, repartidorId);
  if (!from) return null;
  const stops = await pendingStopsWithDistance(pool, { repartidorId, from });
  return { repartidorId, from, stops };
}

export interface PlanRouteParams {
  rutaId: string;
  agenciaId: string;
  start?: GeoPoint;
  persist?: boolean;
}

export interface PlanRouteResult {
  plan: RoutePlan;
  currentTotalMeters: number;
  persisted: boolean;
}

export class RutaNoEncontrada extends Error {
  constructor() {
    super("ruta no encontrada");
    this.name = "RutaNoEncontrada";
  }
}

/**
 * Calcula un orden de reparto optimizado (vecino más cercano) para las paradas
 * pendientes de una ruta, usando una matriz de distancias PostGIS. El punto de
 * inicio es, por orden de preferencia: `start` explícito → ubicación actual del
 * repartidor → punto de recogida de la agencia → primera parada.
 */
export async function planRoute(
  params: PlanRouteParams,
): Promise<PlanRouteResult> {
  const route = await getRoutePendingStops(pool, params.rutaId);
  if (!route || route.agenciaId !== params.agenciaId) {
    throw new RutaNoEncontrada();
  }

  const stops = route.stops;
  const start = await resolveStart(params, route.repartidorId, stops);

  // Distancia del recorrido en el orden actual (por `orden`), para comparar.
  const currentPoints: GeoPoint[] = [start, ...stops];
  const currentMatrix = await distanceMatrix(pool, currentPoints);
  const currentTotalMeters = sequentialTotal(currentMatrix);

  // Orden optimizado (vecino más cercano) sobre la misma matriz aumentada.
  const { order } = nearestNeighborRoute(currentMatrix, 0);

  const planStops: RoutePlanStop[] = [];
  let cumulative = 0;
  let prevPointIndex = 0; // 0 = start
  for (const pointIndex of order) {
    const leg = currentMatrix[prevPointIndex]?.[pointIndex] ?? 0;
    cumulative += leg;
    const stop = stops[pointIndex - 1];
    planStops.push({
      paradaId: stop.paradaId,
      referencia: stop.referencia,
      orden: stop.orden,
      lat: stop.lat,
      lon: stop.lon,
      legMeters: Math.round(leg * 10) / 10,
      cumulativeMeters: Math.round(cumulative * 10) / 10,
    });
    prevPointIndex = pointIndex;
  }

  let persisted = false;
  if (params.persist && planStops.length > 0) {
    await persistRouteOrder(
      pool,
      params.rutaId,
      planStops.map((s) => s.paradaId),
    );
    persisted = true;
  }

  return {
    plan: {
      rutaId: params.rutaId,
      start,
      stops: planStops,
      totalMeters: Math.round(cumulative * 10) / 10,
      optimized: true,
    },
    currentTotalMeters: Math.round(currentTotalMeters * 10) / 10,
    persisted,
  };
}

async function resolveStart(
  params: PlanRouteParams,
  repartidorId: string | null,
  stops: { lat: number; lon: number }[],
): Promise<GeoPoint> {
  if (params.start) return params.start;
  if (repartidorId) {
    const loc = await getCourierLocation(pool, repartidorId);
    if (loc) return loc;
  }
  const pickup = await getPickupPoint(pool, params.agenciaId);
  if (pickup) return pickup;
  if (stops[0]) return { lat: stops[0].lat, lon: stops[0].lon };
  return { lat: 0, lon: 0 };
}

/** Distancia total visitando los puntos en su orden secuencial (0,1,2,…). */
function sequentialTotal(matrix: number[][]): number {
  let total = 0;
  for (let i = 0; i < matrix.length - 1; i += 1) {
    total += matrix[i]?.[i + 1] ?? 0;
  }
  return total;
}
