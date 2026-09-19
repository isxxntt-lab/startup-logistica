import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bearerMatches,
  createInternalAuthHook,
  isPublicHealthRequest,
  parseBearerToken,
  requireInternalServiceToken,
  timingSafeEqualString,
} from "./auth.js";

test("requireInternalServiceToken rechaza vacío", () => {
  assert.throws(() => requireInternalServiceToken(""), /INTERNAL_SERVICE_TOKEN/);
  assert.throws(() => requireInternalServiceToken("   "), /INTERNAL_SERVICE_TOKEN/);
  assert.equal(requireInternalServiceToken("  abc  "), "abc");
});

test("timingSafeEqualString", () => {
  assert.equal(timingSafeEqualString("secret", "secret"), true);
  assert.equal(timingSafeEqualString("secret", "Secret"), false);
  assert.equal(timingSafeEqualString("short", "longer-token"), false);
});

test("parseBearerToken", () => {
  assert.equal(parseBearerToken("Bearer abc"), "abc");
  assert.equal(parseBearerToken("bearer abc"), "abc");
  assert.equal(parseBearerToken("Bearer"), undefined);
  assert.equal(parseBearerToken("Basic abc"), undefined);
  assert.equal(parseBearerToken(undefined), undefined);
});

test("bearerMatches", () => {
  assert.equal(bearerMatches("Bearer tok", "tok"), true);
  assert.equal(bearerMatches("Bearer other", "tok"), false);
  assert.equal(bearerMatches(undefined, "tok"), false);
  assert.equal(bearerMatches("Bearer tok", ""), false);
});

test("GET /health es público", () => {
  assert.equal(isPublicHealthRequest("GET", "/health"), true);
  assert.equal(isPublicHealthRequest("GET", "/health?ready=1"), true);
  assert.equal(isPublicHealthRequest("POST", "/health"), false);
  assert.equal(isPublicHealthRequest("GET", "/orders"), false);
});

test("hook: sin Bearer en POST → 401 unauthorized", async () => {
  const hook = createInternalAuthHook("tok");
  let status = 0;
  let body: unknown;
  await hook(
    { method: "POST", url: "/orders", headers: {} },
    {
      code(code) {
        status = code;
        return {
          send(payload) {
            body = payload;
            return payload;
          },
        };
      },
    },
  );
  assert.equal(status, 401);
  assert.deepEqual(body, { error: "unauthorized" });
});

test("hook: GET /health no exige token", async () => {
  const hook = createInternalAuthHook("tok");
  let called = false;
  await hook(
    { method: "GET", url: "/health", headers: {} },
    {
      code() {
        called = true;
        return { send() {} };
      },
    },
  );
  assert.equal(called, false);
});
