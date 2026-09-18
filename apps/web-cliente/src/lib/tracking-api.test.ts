import { describe, expect, it } from "vitest";
import {
  TrackingGoneError,
  fetchTrackingSession,
  postConfirmPresence,
  postReschedule,
  readTokenFromSearchParams,
} from "./tracking-api";

describe("readTokenFromSearchParams", () => {
  it("lee solo ?token= y ignora vacío", () => {
    expect(readTokenFromSearchParams("?token=abc")).toBe("abc");
    expect(readTokenFromSearchParams("?foo=1")).toBeNull();
    expect(readTokenFromSearchParams("?token=")).toBeNull();
    expect(readTokenFromSearchParams("")).toBeNull();
  });
});

describe("tracking-api 410", () => {
  it("session 410 used lanza TrackingGoneError", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "gone", reason: "used" }), {
        status: 410,
        headers: { "Content-Type": "application/json" },
      });
    await expect(fetchTrackingSession("tok")).rejects.toMatchObject({
      name: "TrackingGoneError",
      reason: "used",
      status: 410,
    } satisfies Partial<TrackingGoneError>);
  });

  it("confirm-presence 410 expired", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "gone", reason: "expired" }), {
        status: 410,
      });
    await expect(postConfirmPresence("tok")).rejects.toMatchObject({
      reason: "expired",
    });
  });

  it("Estaré ahí llama /api/tracking/confirm-presence", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input, init) => {
      urls.push(String(input));
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ token: "tok" });
      return new Response(
        JSON.stringify({ ok: true, status: "will_be_there" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    await expect(postConfirmPresence("tok")).resolves.toEqual({
      ok: true,
      status: "will_be_there",
    });
    expect(urls.join(" ")).toContain("/api/tracking/confirm-presence");
  });

  it("reschedule llama /api/tracking/reschedule y no confirm-presence", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input, init) => {
      urls.push(String(input));
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ token: "tok", preferred_window: "18:00" });
      return new Response(JSON.stringify({ ok: true, status: "reschedule_requested" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    await expect(postReschedule("tok", "18:00")).resolves.toEqual({
      ok: true,
      status: "reschedule_requested",
    });
    expect(urls.join(" ")).toContain("/api/tracking/reschedule");
    expect(urls.join(" ")).not.toContain("confirm-presence");
  });
});
