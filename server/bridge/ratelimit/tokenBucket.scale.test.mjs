/**
 * Adaptive scale on the limiter (setScale) and property-style tests for the limiter and the per-key token bucket:
 * no window is ever exceeded, tokens are conserved, a waiting time is honest, and time that moves backwards never
 * mints budget. Seeded random operations, no real clock.
 */
import { describe, expect, it } from "vitest";
import { createCallContext } from "../core/context.mjs";
import { createLogger } from "../core/logger.mjs";
import { createClientLimiter } from "./clientLimiter.mjs";
import { createRateLimiter, windowsFromSpec } from "./tokenBucket.mjs";

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Largest number of stamps in any half-open interval of length `windowMs`. */
function maxInWindow(stamps, windowMs) {
  const s = [...stamps].sort((a, b) => a - b);
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < s.length; hi++) {
    while (s[hi] - s[lo] >= windowMs) lo += 1;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

describe("limiter scale (adaptive back-off)", () => {
  it("lowers every sub-day window to max(1, floor(limit x scale)) and reports it", () => {
    const lim = createRateLimiter(windowsFromSpec({ perSecond: 10, perMinute: 100, perDay: 1000 }), { paddingMs: 0 });
    expect(lim.capacity()).toBe(10);
    lim.setScale(0.5);
    expect(lim.scale()).toBe(0.5);
    expect(lim.capacity()).toBe(5);
    expect(lim.windows(0).map((w) => [w.window, w.limit])).toEqual([["1s", 5], ["1m", 50], ["day", 1000]]); // the day is never scaled
    lim.setScale(0.25);
    expect(lim.windows(0).map((w) => w.limit)).toEqual([2, 25, 1000]);
    lim.setScale(1);
    expect(lim.windows(0).map((w) => w.limit)).toEqual([10, 100, 1000]);
    expect(lim.specs[0].limit).toBe(10); // the policy figure itself is untouched
  });

  it("only ever lowers: scales above 1 or at or below 0 are refused", () => {
    const lim = createRateLimiter(windowsFromSpec({ perSecond: 4 }));
    for (const bad of [0, -1, 1.01, NaN, Infinity, "x"]) expect(() => lim.setScale(bad)).toThrow(RangeError);
    expect(lim.scale()).toBe(1);
  });

  it("stretches the window when flooring would lose rate, so 1 a second at 0.5 really is one per 2 seconds", () => {
    const lim = createRateLimiter(windowsFromSpec({ perSecond: 1 }), { paddingMs: 0 });
    lim.setScale(0.5);
    expect(lim.capacity()).toBe(1);
    lim.take(1, 0);
    expect(lim.waitMs(1, 0)).toBe(2000);
    expect(lim.canTake(1, 1999)).toBe(false);
    expect(lim.canTake(1, 2000)).toBe(true);
    // 3 a second at 0.5: floor(1.5) = 1 unit, stretched to 1 per 0.667 s but never shorter than the window: 1 per second
    const three = createRateLimiter(windowsFromSpec({ perSecond: 3 }), { paddingMs: 0 });
    three.setScale(0.5);
    three.take(1, 0);
    expect(three.waitMs(1, 0)).toBe(1000);
  });

  it("is conservative at every scale: the scaled limiter never admits more than scale x the configured rate over a window, nor more than the policy in any base window", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rand = rng(seed);
      const base = 1 + Math.floor(rand() * 12);
      const lim = createRateLimiter(windowsFromSpec({ perSecond: base }), { paddingMs: 100 });
      const stamps = [];
      let now = 0;
      let scale = 1;
      for (let step = 0; step < 400; step++) {
        now += Math.floor(rand() * 400);
        if (rand() < 0.1) {
          scale = [1, 0.75, 0.5, 0.25][Math.floor(rand() * 4)];
          lim.setScale(scale);
        }
        if (lim.canTake(1, now)) stamps.push(...lim.take(1, now));
      }
      // the broker's own window (1 s) is never exceeded, whatever the scale did
      expect(maxInWindow(stamps, 1000)).toBeLessThanOrEqual(base);
    }
  });
});

describe("limiter properties (seeded random operations)", () => {
  it("never exceeds any window and conserves units, for random costs and times that only move forwards", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = rng(seed);
      const perSecond = 1 + Math.floor(rand() * 8);
      const perMinute = perSecond * (5 + Math.floor(rand() * 20));
      const lim = createRateLimiter(windowsFromSpec({ perSecond, perMinute }), { paddingMs: 100 });
      const stamps = [];
      let now = 0;
      let taken = 0;
      for (let step = 0; step < 300; step++) {
        now += Math.floor(rand() * 600);
        const cost = 1 + Math.floor(rand() * 3);
        if (lim.canTake(cost, now)) {
          const s = lim.take(cost, now);
          expect(s).toHaveLength(cost);
          expect(s.every((t) => t >= now)).toBe(true);
          expect([...s].sort((a, b) => a - b)).toEqual(s); // a request's units are stamped in time order
          stamps.push(...s);
          taken += cost;
        }
      }
      expect(stamps).toHaveLength(taken);
      expect(maxInWindow(stamps, 1000)).toBeLessThanOrEqual(perSecond);
      expect(maxInWindow(stamps, 60_000)).toBeLessThanOrEqual(perMinute);
      // what the limiter reports as used is what was stamped inside its (padded) window
      const w = lim.windows(now).find((x) => x.window === "1s");
      expect(w.used).toBe(stamps.filter((t) => t > now - 1100).length);
    }
  });

  it("tells the truth about waiting: after waitMs it can take, and never before", () => {
    for (let seed = 50; seed < 80; seed++) {
      const rand = rng(seed);
      const lim = createRateLimiter(windowsFromSpec({ perSecond: 1 + Math.floor(rand() * 5), perMinute: 30 }), { paddingMs: 50 });
      let now = 0;
      for (let step = 0; step < 100; step++) {
        now += Math.floor(rand() * 300);
        const cost = 1 + Math.floor(rand() * 2);
        const wait = lim.waitMs(cost, now);
        expect(lim.canTake(cost, now)).toBe(wait === 0);
        if (Number.isFinite(wait) && wait > 0) {
          expect(lim.canTake(cost, now + wait - 1)).toBe(false);
          expect(lim.canTake(cost, now + wait)).toBe(true);
        }
        if (wait === 0) lim.take(cost, now);
      }
    }
  });

  it("keeps working when the clock steps backwards: no exception, and the windows stay consistent", () => {
    const rand = rng(99);
    const lim = createRateLimiter(windowsFromSpec({ perSecond: 3 }), { paddingMs: 100 });
    let now = 10_000;
    for (let step = 0; step < 200; step++) {
      now += Math.floor(rand() * 800) - 300; // sometimes back
      const wait = lim.waitMs(1, now);
      if (wait === 0) lim.take(1, now);
      const w = lim.windows(now)[0];
      expect(w.used).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(w.resetMs)).toBe(true);
    }
  });
});

describe("per-key token bucket properties (seeded random operations)", () => {
  const log = createLogger({ level: "silent" });
  const ctx = createCallContext({ source: "rest", key: { id: "prop0000001", label: "p", scopes: ["read"], accounts: "*" }, log });

  it("conserves tokens: admitted requests never exceed burst + rate x elapsed, and remaining stays within 0..burst", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = rng(seed);
      const perSecond = 1 + Math.floor(rand() * 20);
      const burst = 1 + Math.floor(rand() * 30);
      const clock = { t: 5_000_000, now: () => clock.t };
      const lim = createClientLimiter({ perSecond, burst }, clock);
      const start = clock.t;
      let admitted = 0;
      for (let step = 0; step < 500; step++) {
        clock.t += Math.floor(rand() * 250);
        const r = lim.check(ctx);
        if (r.ok) admitted += 1;
        else expect(r.retryAfterMs).toBeGreaterThanOrEqual(1);
        const remaining = Number(/remaining=(\d+)/.exec(r.headers.RateLimit)[1]);
        expect(remaining).toBeGreaterThanOrEqual(0);
        expect(remaining).toBeLessThanOrEqual(burst);
        expect(admitted).toBeLessThanOrEqual(burst + (perSecond * (clock.t - start)) / 1000 + 1e-6);
      }
    }
  });

  it("honours its own Retry-After: a refused caller that waits retryAfterMs is admitted", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rand = rng(seed);
      const clock = { t: 1000, now: () => clock.t };
      const lim = createClientLimiter({ perSecond: 1 + Math.floor(rand() * 10), burst: 1 + Math.floor(rand() * 5) }, clock);
      for (let step = 0; step < 100; step++) {
        const r = lim.check(ctx);
        if (!r.ok) {
          clock.t += r.retryAfterMs;
          expect(lim.check(ctx).ok).toBe(true);
        }
      }
    }
  });

  it("is monotonic: a clock that steps back neither mints tokens nor rewinds the refill point", () => {
    const clock = { t: 100_000, now: () => clock.t };
    const lim = createClientLimiter({ perSecond: 10, burst: 10 }, clock);
    for (let i = 0; i < 10; i++) expect(lim.check(ctx).ok).toBe(true);
    expect(lim.check(ctx).ok).toBe(false);
    clock.t -= 5000; // the clock jumps back five seconds
    expect(lim.check(ctx).ok).toBe(false);
    clock.t += 5000; // and returns: no credit for the time that was replayed
    expect(lim.check(ctx).ok).toBe(false);
    clock.t += 1000;
    let ok = 0;
    for (let i = 0; i < 20; i++) if (lim.check(ctx).ok) ok += 1;
    expect(ok).toBe(10); // exactly one second of refill, not six
  });
});
