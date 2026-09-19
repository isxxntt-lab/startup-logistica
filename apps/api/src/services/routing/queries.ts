import type { SqlClient } from "@startup-logistica/shared/ops";
import type {
  GeoPoint,
  NearbyCourier,
  StopDistance,
} from "@startup-logistica/shared";

export interface NearbyCouriersParams {
  lat: number;
  lon: number;
  radiusM: number;
  agenciaId?: string | null;
  limit?: number;
}

/**
 * Repartidores activos dentro de un radio (ST_DWithin) ordenados por distancia
 * geodésica real (ST_Distance sobre geography). Aprovecha el índice GIST de
 * `repartidores.ubicacion_actual`.
 */
export async function findNearbyRepartidores(
  db: SqlClient,
  params: NearbyCouriersParams,
): Promise<NearbyCourier[]> {
  const { rows } = await db.query<{
    id: string;
    codigo: string | null;
    nombre: string;
    distance_m: number;
    ultima_actualizacion: string | null;
  }>(
    `SELECT id, codigo, nombre,
            ST_Distance(
              ubicacion_actual,
              ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
            ) AS distance_m,
            ultima_actualizacion
     FROM repartidores
     WHERE activo
       AND ubicacion_actual IS NOT NULL
       AND ($5::uuid IS NULL OR agencia_id = $5)
       AND ST_DWithin(
             ubicacion_actual,
             ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
             $3
           )
     ORDER BY distance_m ASC
     LIMIT $4`,
    [params.lon, params.lat, params.radiusM, params.limit ?? 20, params.agenciaId ?? null],
  );

  return rows.map((r) => ({
    repartidorId: r.id,
    codigo: r.codigo,
    nombre: r.nombre,
    distanceM: Math.round(Number(r.distance_m) * 10) / 10,
    ultimaActualizacion: r.ultima_actualizacion,
  }));
}

/** Ubicación actual de un repartidor, o null si nunca ha reportado GPS. */
export async function getCourierLocation(
  db: SqlClient,
  repartidorId: string,
): Promise<GeoPoint | null> {
  const { rows } = await db.query<{ lat: number; lon: number }>(
    `SELECT ST_Y(ubicacion_actual::geometry) AS lat,
            ST_X(ubicacion_actual::geometry) AS lon
     FROM repartidores
     WHERE id = $1 AND ubicacion_actual IS NOT NULL`,
    [repartidorId],
  );
  const row = rows[0];
  return row ? { lat: Number(row.lat), lon: Number(row.lon) } : null;
}

export interface PendingStopsParams {
  repartidorId: string;
  from: GeoPoint;
}

/**
 * Paradas pendientes de la ruta de hoy de un repartidor, con distancia y
 * pertenencia a geocerca respecto a un punto de referencia (`from`).
 */
export async function pendingStopsWithDistance(
  db: SqlClient,
  params: PendingStopsParams,
): Promise<StopDistance[]> {
  const { rows } = await db.query<{
    id: string;
    referencia_pedido: string | null;
    cliente_nombre: string;
    direccion_texto: string;
    estado: string;
    orden: number;
    geocerca_radio_m: number;
    lat: number;
    lon: number;
    distance_m: number;
    dentro: boolean;
  }>(
    `SELECT p.id, p.referencia_pedido, p.cliente_nombre, p.direccion_texto,
            p.estado, p.orden, p.geocerca_radio_m,
            ST_Y(p.ubicacion::geometry) AS lat,
            ST_X(p.ubicacion::geometry) AS lon,
            ST_Distance(
              p.ubicacion,
              ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography
            ) AS distance_m,
            ST_DWithin(
              p.ubicacion,
              ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
              p.geocerca_radio_m
            ) AS dentro
     FROM paradas p
     JOIN rutas r ON r.id = p.ruta_id
     WHERE r.repartidor_id = $1
       AND r.fecha = (now() AT TIME ZONE 'Europe/Madrid')::date
       AND p.estado IN ('pendiente', 'notificado', 'confirmado')
     ORDER BY distance_m ASC`,
    [params.repartidorId, params.from.lon, params.from.lat],
  );

  return rows.map((r) => ({
    paradaId: r.id,
    referencia: r.referencia_pedido,
    clienteNombre: r.cliente_nombre,
    direccion: r.direccion_texto,
    estado: r.estado,
    orden: r.orden,
    geocercaRadioM: r.geocerca_radio_m,
    lat: Number(r.lat),
    lon: Number(r.lon),
    distanceM: Math.round(Number(r.distance_m) * 10) / 10,
    dentroGeocerca: r.dentro === true,
  }));
}

export interface RouteStopRow {
  paradaId: string;
  referencia: string | null;
  orden: number;
  lat: number;
  lon: number;
}

export interface RoutePendingStops {
  repartidorId: string | null;
  agenciaId: string;
  stops: RouteStopRow[];
}

/** Paradas pendientes de una ruta (por `orden`) con sus coordenadas. */
export async function getRoutePendingStops(
  db: SqlClient,
  rutaId: string,
): Promise<RoutePendingStops | null> {
  const { rows: rutaRows } = await db.query<{
    repartidor_id: string | null;
    agencia_id: string;
  }>(
    `SELECT repartidor_id, agencia_id FROM rutas WHERE id = $1`,
    [rutaId],
  );
  const ruta = rutaRows[0];
  if (!ruta) return null;

  const { rows } = await db.query<{
    id: string;
    referencia_pedido: string | null;
    orden: number;
    lat: number;
    lon: number;
  }>(
    `SELECT p.id, p.referencia_pedido, p.orden,
            ST_Y(p.ubicacion::geometry) AS lat,
            ST_X(p.ubicacion::geometry) AS lon
     FROM paradas p
     WHERE p.ruta_id = $1
       AND p.estado IN ('pendiente', 'notificado', 'confirmado')
     ORDER BY p.orden ASC`,
    [rutaId],
  );

  return {
    repartidorId: ruta.repartidor_id,
    agenciaId: ruta.agencia_id,
    stops: rows.map((r) => ({
      paradaId: r.id,
      referencia: r.referencia_pedido,
      orden: r.orden,
      lat: Number(r.lat),
      lon: Number(r.lon),
    })),
  };
}

/** Punto de recogida de una agencia (origen de ruta por defecto). */
export async function getPickupPoint(
  db: SqlClient,
  agenciaId: string,
): Promise<GeoPoint | null> {
  const { rows } = await db.query<{ lat: number; lon: number }>(
    `SELECT ST_Y(ubicacion::geometry) AS lat, ST_X(ubicacion::geometry) AS lon
     FROM puntos_recogida
     WHERE agencia_id = $1
     ORDER BY capacidad_diaria DESC NULLS LAST
     LIMIT 1`,
    [agenciaId],
  );
  const row = rows[0];
  return row ? { lat: Number(row.lat), lon: Number(row.lon) } : null;
}

/**
 * Matriz de distancias geodésicas (metros) entre una lista de puntos, calculada
 * en una sola consulta con PostGIS. `matrix[i][j]` = ST_Distance(points[i], points[j]).
 */
export async function distanceMatrix(
  db: SqlClient,
  points: GeoPoint[],
): Promise<number[][]> {
  const n = points.length;
  const matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  if (n < 2) return matrix;

  const lons = points.map((p) => p.lon);
  const lats = points.map((p) => p.lat);
  const { rows } = await db.query<{ i: number; j: number; d: number }>(
    `WITH pts AS (
       SELECT (ord - 1)::int AS idx,
              ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography AS g
       FROM unnest($1::float8[], $2::float8[]) WITH ORDINALITY AS t(lon, lat, ord)
     )
     SELECT a.idx AS i, b.idx AS j, ST_Distance(a.g, b.g) AS d
     FROM pts a JOIN pts b ON b.idx > a.idx`,
    [lons, lats],
  );

  for (const row of rows) {
    const d = Math.round(Number(row.d) * 10) / 10;
    matrix[row.i][row.j] = d;
    matrix[row.j][row.i] = d;
  }
  return matrix;
}

/**
 * Persiste un nuevo orden para las paradas pendientes, reutilizando los "slots"
 * de `orden` que ya ocupaban. Esto preserva la posición de las paradas ya
 * completadas y respeta el UNIQUE (ruta_id, orden). También reconstruye
 * `rutas.orden_paradas` con la secuencia completa resultante.
 */
export async function persistRouteOrder(
  db: SqlClient,
  rutaId: string,
  orderedParadaIds: string[],
): Promise<void> {
  if (orderedParadaIds.length === 0) return;

  const { rows: slotRows } = await db.query<{ orden: number }>(
    `SELECT orden FROM paradas
     WHERE ruta_id = $1 AND id = ANY($2::uuid[])
     ORDER BY orden ASC`,
    [rutaId, orderedParadaIds],
  );
  const slots = slotRows.map((r) => Number(r.orden));

  // Desplaza solo las paradas a reordenar fuera de su rango para esquivar el UNIQUE.
  await db.query(
    `UPDATE paradas SET orden = orden + 100000
     WHERE ruta_id = $1 AND id = ANY($2::uuid[])`,
    [rutaId, orderedParadaIds],
  );
  for (let i = 0; i < orderedParadaIds.length; i += 1) {
    await db.query(`UPDATE paradas SET orden = $2 WHERE id = $1 AND ruta_id = $3`, [
      orderedParadaIds[i],
      slots[i],
      rutaId,
    ]);
  }

  const { rows: allRows } = await db.query<{ id: string }>(
    `SELECT id FROM paradas WHERE ruta_id = $1 ORDER BY orden ASC`,
    [rutaId],
  );
  await db.query(`UPDATE rutas SET orden_paradas = $2::jsonb WHERE id = $1`, [
    rutaId,
    JSON.stringify(allRows.map((r) => r.id)),
  ]);
}
