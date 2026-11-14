/**
 * Rate-limit refusals say whose limit was hit: scope, retryAfterMs and limit in the problem body, and a Retry-After
 * header that is jittered upward by up to 25 % and never earlier than the true wait.
 */
import { describe, expect, it } from "vitest";
import { BridgeError, REFUSAL_SCOPES, jitteredRetryAfterSeconds, problemHeaders, toProblem } from "./errors.mjs";

describe("refusal problems", () => {
  it("carry scope, retryAfterMs and limit next to the standard members, and keep both codes at 429", () => {
    const mine = new BridgeError("RATE_LIMITED", "Too fast.", { retryAfterMs: 1500, scope: "client", limit: { name: "perSecond", remaining: 0, resetMs: 1500 } });
    expect(toProblem(mine, { requestId: "req_1" })).toMatchObject({ status: 429, code: "RATE_LIMITED", retryable: true, retryAfterMs: 1500, scope: "client", limit: { name: "perSecond", remaining: 0, resetMs: 1500 } });
    const shared = new BridgeError("UPSTREAM_RATE_LIMITED", "Budget full.", { retryAfterMs: 2300, scope: "upstream", limit: { name: "zerodha-main:quote:1s", remaining: 0, resetMs: 480 } });
    expect(toProblem(shared)).toMatchObject({ status: 429, code: "UPSTREAM_RATE_LIMITED", scope: "upstream", limit: { name: "zerodha-main:quote:1s" } });
  });

  it("accept exactly the four scopes", () => {
    expect([...REFUSAL_SCOPES]).toEqual(["client", "upstream", "queue", "consumer-cap"]);
    for (const scope of REFUSAL_SCOPES) expect(new BridgeError("RATE_LIMITED", undefined, { scope }).scope).toBe(scope);
    expect(() => new BridgeError("RATE_LIMITED", undefined, { scope: "somewhere" })).toThrow(RangeError);
  });

  it("leave errors without a scope exactly as they were", () => {
    const plain = toProblem(new BridgeError("RATE_LIMITED", undefined, { retryAfterMs: 1000 }));
    expect(plain).not.toHaveProperty("scope");
    expect(plain).not.toHaveProperty("limit");
    expect(problemHeaders(new BridgeError("RATE_LIMITED", undefined, { retryAfterMs: 1200 }))["Retry-After"]).toBe("2");
  });
});

describe("Retry-After jitter", () => {
  it("adds 0 to 25 % to the whole-second wait and rounds up", () => {
    expect(jitteredRetryAfterSeconds(1000, () => 0)).toBe(1);
    expect(jitteredRetryAfterSeconds(1000, () => 0.999)).toBe(2); // 1.25 s rounds up
    expect(jitteredRetryAfterSeconds(10_000, () => 0)).toBe(10);
    expect(jitteredRetryAfterSeconds(10_000, () => 0.5)).toBe(12); // 11.25 s
    expect(jitteredRetryAfterSeconds(10_000, () => 0.9999)).toBe(13); // 12.4997 s
    expect(jitteredRetryAfterSeconds(1, () => 0)).toBe(1);
    expect(jitteredRetryAfterSeconds(0, () => 0.5)).toBe(1);
  });

  it("never goes below the true wait, and never above 125 % of it rounded up", () => {
    for (let ms = 1; ms <= 90_000; ms += 137) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
        const s = jitteredRetryAfterSeconds(ms, () => r);
        expect(s).toBeGreaterThanOrEqual(Math.ceil(ms / 1000));
        expect(s).toBeLessThanOrEqual(Math.ceil((ms * 1.25) / 1000));
      }
    }
  });

  it("spreads clients that were refused together over more than one second", () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(problemHeaders(new BridgeError("UPSTREAM_RATE_LIMITED", undefined, { retryAfterMs: 8000, scope: "upstream" }))["Retry-After"]);
    expect(seen.size).toBeGreaterThan(1);
    for (const v of seen) {
      expect(Number(v)).toBeGreaterThanOrEqual(8);
      expect(Number(v)).toBeLessThanOrEqual(10);
    }
  });
});
