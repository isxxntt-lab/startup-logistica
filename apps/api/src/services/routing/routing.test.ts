import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import {
  haversineMeters,
  nearestNeighborRoute,
} from "@startup-logistica/shared";
import {
  distanceMatrix,
  findNearbyRepartidores,
} from "./queries.js";
import { nearbyCouriers, nextStops, planRoute } from "./index.js";

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://logistica:logistica@localhost:5432/startup_logistica",
});

const AGENCIA = "11111111-1111-1111-1111-111111111111";
const RUTA = "44444444-4444-4444-4444-444444444444";
const REPARTIDOR = "22222222-2222-2222-2222-222222222222";
const SOL = { lat: 40.4168, lon: -3.7038 };

// --- Unitarias del algoritmo (sin base de datos) --------------------------

test("nearestNeighborRoute: recorre en cadena la matriz más barata", () => {
  const matrix = [
    [0, 1, 5, 9],
    [1, 0, 1, 5],
    [5, 1, 0, 1],
    [9, 5, 1, 0],
  ];
  const { order, totalMeters } = nearestNeighborRoute(matrix, 0);
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(totalMeters, 3);
});

test("nearestNeighborRoute: reordena frente al orden secuencial", () => {
  const matrix = [
    [0, 10, 1, 5],
    [10, 0, 9, 6],
    [1, 9, 0, 4],
    [5, 6, 4, 0],
  ];
  const { order, totalMeters } = nearestNeighborRoute(matrix, 0);
  assert.deepEqual(order, [2, 3, 1]);
  assert.equal(totalMeters, 11);
});

test("nearestNeighborRoute: casos borde (vacío y un nodo)", () => {
  assert.deepEqual(nearestNeighborRoute([], 0), { order: [], totalMeters: 0 });
  assert.deepEqual(nearestNeighborRoute([[0]], 0), { order: [], totalMeters: 0 });
});

test("haversineMeters: Sol → Templo de Debod ≈ 1.5 km", () => {
  const debod = { lat: 40.424, lon: -3.7178 };
  const d = haversineMeters(SOL, debod);
  assert.ok(d > 1200 && d < 1800, `distancia inesperada: ${d}`);
});

// --- Integrales contra PostGIS --------------------------------------------

before(async () => {
  // El repartidor seed reporta ubicación en Puerta del Sol.
  await pool.query(
    `UPDATE repartidores
     SET ubicacion_actual = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
         ultima_actualizacion = now()
     WHERE id = $1`,
    [REPARTIDOR, SOL.lon, SOL.lat],
  );
});

after(async () => {
  await pool.end();
});

test("distanceMatrix: simétrica y con diagonal cero (ST_Distance)", async () => {
  const matrix = await distanceMatrix(pool, [
    SOL,
    { lat: 40.4233, lon: -3.7122 }, // Plaza de España
    { lat: 40.424, lon: -3.7178 }, // Templo de Debod
  ]);
  assert.equal(matrix.length, 3);
  assert.equal(matrix[0][0], 0);
  assert.equal(matrix[1][2], matrix[2][1]);
  assert.ok(matrix[0][1] > 0, "Sol y Plaza España deberían distar > 0");
});

test("findNearbyRepartidores: encuentra al repartidor dentro del radio", async () => {
  const couriers = await findNearbyRepartidores(pool, {
    lat: SOL.lat,
    lon: SOL.lon,
    radiusM: 500,
    agenciaId: AGENCIA,
  });
  assert.ok(couriers.length >= 1);
  assert.equal(couriers[0].repartidorId, REPARTIDOR);
  assert.ok(couriers[0].distanceM < 500);
});

test("findNearbyRepartidores: radio pequeño lejano no devuelve nada", async () => {
  const couriers = await findNearbyRepartidores(pool, {
    lat: 41.3874, // Barcelona
    lon: 2.1686,
    radiusM: 1000,
    agenciaId: AGENCIA,
  });
  assert.equal(couriers.length, 0);
});

test("nextStops: paradas pendientes ordenadas por proximidad al GPS", async () => {
  const result = await nextStops(REPARTIDOR);
  assert.ok(result, "debería haber resultado con ubicación seed");
  assert.ok(result.stops.length >= 1);
  // Ordenadas de menor a mayor distancia.
  for (let i = 1; i < result.stops.length; i += 1) {
    assert.ok(result.stops[i].distanceM >= result.stops[i - 1].distanceM);
  }
});

test("planRoute: optimiza el orden de las paradas pendientes de la ruta", async () => {
  const { plan, currentTotalMeters } = await planRoute({
    rutaId: RUTA,
    agenciaId: AGENCIA,
    start: SOL,
  });
  assert.equal(plan.optimized, true);
  assert.ok(plan.stops.length >= 2);
  // Distancia acumulada monótona creciente.
  for (let i = 1; i < plan.stops.length; i += 1) {
    assert.ok(
      plan.stops[i].cumulativeMeters >= plan.stops[i - 1].cumulativeMeters,
    );
  }
  assert.ok(plan.totalMeters > 0);
  assert.ok(currentTotalMeters >= 0);
});

test("planRoute: agencia ajena no puede optimizar la ruta", async () => {
  await assert.rejects(
    planRoute({
      rutaId: RUTA,
      agenciaId: "99999999-9999-9999-9999-999999999999",
      start: SOL,
    }),
    /ruta no encontrada/,
  );
});
