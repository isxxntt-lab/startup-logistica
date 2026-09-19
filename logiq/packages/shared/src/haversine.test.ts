import assert from "node:assert/strict";
import { test } from "node:test";
import { haversineMeters, isWithinGeofence } from "./haversine.js";

const DEBOD = { lat: 40.424, lng: -3.7178 };
const NEAR_DEBOD = { lat: 40.4243, lng: -3.7175 };
const SOL = { lat: 40.4168, lng: -3.7038 };

test("Haversine: un punto junto al Templo de Debod queda dentro de 500 m", () => {
  const { inside, distanceM } = isWithinGeofence(NEAR_DEBOD, DEBOD, 500);
  assert.ok(distanceM > 0);
  assert.ok(distanceM < 80);
  assert.equal(inside, true);
});

test("Haversine: Sol queda fuera de la geocerca de 500 m de Debod", () => {
  const distanceM = haversineMeters(SOL, DEBOD);
  assert.ok(distanceM > 1000);
  assert.equal(isWithinGeofence(SOL, DEBOD, 500).inside, false);
});

test("Haversine: distancia de un punto a sí mismo es 0", () => {
  assert.equal(haversineMeters(DEBOD, DEBOD), 0);
});
