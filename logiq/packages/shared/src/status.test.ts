import assert from "node:assert/strict";
import { test } from "node:test";
import { canTransition, isOrderStatus } from "./types.js";

test("transiciones válidas del pedido", () => {
  assert.equal(canTransition("pending", "assigned"), true);
  assert.equal(canTransition("assigned", "in_transit"), true);
  assert.equal(canTransition("in_transit", "delivered"), true);
  assert.equal(canTransition("pending", "cancelled"), true);
});

test("estados terminales no avanzan", () => {
  assert.equal(canTransition("delivered", "failed"), false);
  assert.equal(canTransition("failed", "pending"), false);
  assert.equal(canTransition("cancelled", "assigned"), false);
});

test("mismo estado es idempotente", () => {
  assert.equal(canTransition("pending", "pending"), true);
});

test("isOrderStatus valida el contrato", () => {
  assert.equal(isOrderStatus("pending"), true);
  assert.equal(isOrderStatus("lost"), false);
});
