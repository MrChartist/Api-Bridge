import { describe, expect, it } from "vitest";
import { DAY_MS, IST_OFFSET_MS, createRateLimiter, istDay, nextIstMidnight, toIstIso, windowName, windowsFromSpec } from "./tokenBucket.mjs";

/** Largest number of stamps in any half-open interval (x - W, x] over the given stamps. */
function maxInAnyWindow(stamps, windowMs) {
  const s = [...stamps].sort((a, b) => a - b);
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < s.length; hi++) {
    while (s[hi] - s[lo] >= windowMs) lo += 1;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

describe("IST helpers", () => {
  it("rolls the day at midnight IST, not UTC", () => {
    const istMidnight = Date.UTC(2026, 9, 19, 0, 0, 0) - IST_OFFSET_MS; // 2026-10-19 00:00 IST
    expect(istDay(istMidnight - 1)).toBe(istDay(istMidnight) - 1);
    expect(nextIstMidnight(istMidnight - 1)).toBe(istMidnight);
    expect(nextIstMidnight(istMidnight)).toBe(istMidnight + DAY_MS);
    expect(toIstIso(istMidnight)).toBe("2026-10-19T00:00:00.000+05:30");
  });

  it("names windows", () => {
    expect(windowName(1000)).toBe("1s");
    expect(windowName(60_000)).toBe("1m");
    expect(windowName(1_800_000)).toBe("30m");
    expect(windowName(3_600_000)).toBe("1h");
    expect(windowName(1500)).toBe("1500ms");
  });

  it("builds windows from a LimitSpec, flooring fractions and skipping blanks", () => {
    expect(windowsFromSpec({ perSecond: 2.9, perMinute: 0, perDay: 100, extraWindows: [{ windowMs: 3_600_000, limit: 1000 }] })).toEqual([
      { name: "1s", windowMs: 1000, limit: 2 },
      { name: "1h", windowMs: 3_600_000, limit: 1000 },
      { name: "day", istDay: true, limit: 100 },
    ]);
    expect(windowsFromSpec({ perSecond: 0.4 })).toEqual([{ name: "1s", windowMs: 1000, limit: 1 }]);
    expect(windowsFromSpec(undefined)).toEqual([]);
  });

  it("rejects nonsense window specs", () => {
    expect(() => createRateLimiter([{ name: "1s", windowMs: 1000, limit: 0 }])).toThrow(RangeError);
    expect(() => createRateLimiter([{ name: "x", windowMs: 0, limit: 1 }])).toThrow(RangeError);
    expect(() => createRateLimiter(null)).toThrow(TypeError);
  });
});

describe("sliding windows", () => {
  it("never lets more than `limit` units into any interval, at random arrival times", () => {
    const lim = createRateLimiter(windowsFromSpec({ perSecond: 3, perMinute: 20 }), { paddingMs: 0 });
    const stamps = [];
    let t = 1_000_000;
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 3000; i++) {
      t += Math.floor(rand() * 400);
      if (lim.canTake(1, t)) stamps.push(...lim.take(1, t));
    }
    expect(stamps.length).toBeGreaterThan(100);
    expect(maxInAnyWindow(stamps, 1000)).toBeLessThanOrEqual(3);
    expect(maxInAnyWindow(stamps, 60_000)).toBeLessThanOrEqual(20);
  });

  it("pads windows so a call exactly one window later still waits", () => {
    const lim = createRateLimiter(windowsFromSpec({ perSecond: 1 }), { paddingMs: 100 });
    lim.take(1, 0);
    expect(lim.canTake(1, 1000)).toBe(false);
    expect(lim.canTake(1, 1099)).toBe(false);
    expect(lim.waitMs(1, 1000)).toBe(100);
    expect(lim.canTake(1, 1100)).toBe(true);
  });

  it("reports wait times that are exactly sufficient", () => {
    const lim = createRateLimiter(windowsFromSpec({ perSecond: 2, perMinute: 3 }), { paddingMs: 0 });
    lim.take(1, 0);
    lim.take(1, 10);
    const w = lim.waitMs(1, 20);
    expect(lim.canTake(1, 20 + w - 1)).toBe(false);
    expect(lim.canTake(1, 20 + w)).toBe(true);
    lim.take(1, 20 + w);
    // The minute window (3) is now full: the next unit waits for the stamp at 0 to leave the minute.
    expect(lim.waitMs(1, 2000)).toBe(60_000 - 2000);
  });

  it("stamps units beyond capacity in the future so later callers wait for the adapter's own pacing", () => {
    const lim = createRateLimiter(windowsFromSpec({ perSecond: 3 }), { paddingMs: 100 });
    expect(lim.canTake(7, 0)).toBe(true); // the first min(7, 3) units fit now
    const stamps = lim.take(7, 0);
    expect(stamps).toEqual([0, 0, 0, 1100, 1100, 1100, 2200]);
    expect(lim.canTake(1, 1500)).toBe(false);
    expect(lim.canTake(1, 2200)).toBe(true);
    expect(maxInAnyWindow([...stamps, ...lim.take(2, 2200)], 1100)).toBeLessThanOrEqual(3);
  });

  it("keeps the log sorted when a shared bucket mixes future reservations and stamps taken now", () => {
    const lim = createRateLimiter(windowsFromSpec({ perSecond: 2 }), { paddingMs: 0 });
    expect(lim.take(5, 0)).toEqual([0, 0, 1000, 1000, 2000]);
    // Another class sharing this bucket checks at 2500 (only the 2000 stamp is live) and takes one now.
    expect(lim.canTake(1, 2500)).toBe(true);
    const all = [0, 0, 1000, 1000, 2000, ...lim.take(1, 2500)];
    expect(maxInAnyWindow(all, 1000)).toBeLessThanOrEqual(2);
    expect(lim.canTake(1, 2600)).toBe(false);
  });

  it("reports the binding window as headroom", () => {
    const lim = createRateLimiter(windowsFromSpec({ perSecond: 10, perMinute: 12 }), { paddingMs: 0 });
    lim.take(10, 0);
    expect(lim.headroom(500)).toMatchObject({ remaining: 0, limit: 10, window: "1s" });
    expect(lim.headroom(1500)).toMatchObject({ remaining: 2, limit: 12, window: "1m", used: 10 });
    expect(lim.windows(1500).map((w) => w.window)).toEqual(["1s", "1m"]);
    expect(lim.capacity()).toBe(10);
    expect(lim.unitsPerMs()).toBeCloseTo(12 / 60_000);
  });

  it("fill() marks every window full (after an upstream throttle)", () => {
    const lim = createRateLimiter(windowsFromSpec({ perSecond: 5 }), { paddingMs: 0 });
    lim.fill(0);
    expect(lim.canTake(1, 999)).toBe(false);
    expect(lim.canTake(1, 1000)).toBe(true);
  });

  it("an empty limiter is unlimited", () => {
    const lim = createRateLimiter([]);
    expect(lim.canTake(1000, 0)).toBe(true);
    expect(lim.headroom(0).remaining).toBe(Infinity);
    expect(lim.capacity()).toBe(Infinity);
  });
});

describe("daily window", () => {
  it("counts per IST calendar day and resets at midnight IST", () => {
    const lim = createRateLimiter(windowsFromSpec({ perDay: 3 }));
    const midnight = Date.UTC(2026, 9, 20) - IST_OFFSET_MS;
    const t = midnight - 60_000;
    lim.take(3, t);
    expect(lim.canTake(1, t + 1000)).toBe(false);
    expect(lim.waitMs(1, t + 1000)).toBe(midnight - (t + 1000));
    expect(lim.canTake(1, midnight)).toBe(true);
    expect(lim.headroom(midnight)).toMatchObject({ remaining: 3, window: "day" });
  });

  it("knows when a request can never fit in a day", () => {
    const lim = createRateLimiter(windowsFromSpec({ perSecond: 10, perDay: 5 }));
    expect(lim.fitsDay(5)).toBe(true);
    expect(lim.fitsDay(6)).toBe(false);
    expect(lim.waitMs(6, 0)).toBe(Infinity);
  });
});
