import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RESUME_ERROR_BACKOFF_MS,
  planResumeErrorRetry,
} from "./resume-backoff.js";

const now = new Date("2026-01-15T12:00:00.000Z");

describe("planResumeErrorRetry (sin VPS ni DB)", () => {
  it("el primer RESUME_ERROR aplaza 30s y deja pending", () => {
    const decision = planResumeErrorRetry(undefined, now);
    assert.equal(decision.status, "pending");
    if (decision.status !== "pending") return;
    assert.equal(decision.attempt, 1);
    assert.equal(decision.delayMs, 30_000);
    assert.equal(decision.delayMs, RESUME_ERROR_BACKOFF_MS[0]);
    assert.equal(decision.nextRetryAt.toISOString(), "2026-01-15T12:00:30.000Z");
  });

  it("el segundo RESUME_ERROR aplaza 2 minutos", () => {
    const decision = planResumeErrorRetry(1, now);
    assert.equal(decision.status, "pending");
    if (decision.status !== "pending") return;
    assert.equal(decision.attempt, 2);
    assert.equal(decision.delayMs, 120_000);
    assert.equal(decision.nextRetryAt.toISOString(), "2026-01-15T12:02:00.000Z");
  });

  it("el tercer RESUME_ERROR aplaza 10 minutos", () => {
    const decision = planResumeErrorRetry(2, now);
    assert.equal(decision.status, "pending");
    if (decision.status !== "pending") return;
    assert.equal(decision.attempt, 3);
    assert.equal(decision.delayMs, 600_000);
    assert.equal(decision.nextRetryAt.toISOString(), "2026-01-15T12:10:00.000Z");
  });

  it("el cuarto RESUME_ERROR marca failed (no sigue en pending)", () => {
    const decision = planResumeErrorRetry(3, now);
    assert.deepEqual(decision, { status: "failed", attempt: 4 });
  });

  it("intentos posteriores al máximo siguen en failed", () => {
    assert.deepEqual(planResumeErrorRetry(99, now), {
      status: "failed",
      attempt: 100,
    });
  });

  it("valores no numéricos o negativos arrancan en el primer backoff", () => {
    for (const previous of [null, "nope", -1, Number.NaN]) {
      const decision = planResumeErrorRetry(previous, now);
      assert.equal(decision.status, "pending");
      if (decision.status !== "pending") return;
      assert.equal(decision.attempt, 1);
      assert.equal(decision.delayMs, 30_000);
    }
  });

  it("acepta resume_attempts serializado como string (payload JSON)", () => {
    const decision = planResumeErrorRetry("1", now);
    assert.equal(decision.status, "pending");
    if (decision.status !== "pending") return;
    assert.equal(decision.attempt, 2);
    assert.equal(decision.delayMs, 120_000);
  });
});
