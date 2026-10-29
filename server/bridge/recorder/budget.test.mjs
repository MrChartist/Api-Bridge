/**
 * Recorder REST budget (docs/spec/p1-01-recorder.md §5.1 rules 3, 4, 7): caps at floor(share × limit) on every
 * second, minute, day, extra and group window; rule 4 on 1/s classes; and the property test — over 10,000 random
 * schedules the recorder never exceeds any cap and never leaves fewer than 1 token in a per-second window.
 */
import { describe, expect, it } from "vitest";
import { DEMO_POLICY } from "../demo/demoMode.mjs";
import { resolvePolicy } from "../ratelimit/policy.mjs";
import { budgetCaps, createRecorderBudget, restRule, windowsFor } from "./budget.mjs";

const mkClock = (t = 0) => {
  const c = { t, now: () => c.t };
  return c;
};

describe("caps (rule 3)", () => {
  it("Upstox: 25/s, 250/min, 1,000/30 min on the class and the shared group → ≈ 33 calls/min", () => {
    const caps = budgetCaps(resolvePolicy("upstox"), "chain", 0.5);
    expect(caps.windows.filter((w) => w.bucket === "group:standard").map((w) => [w.windowMs, w.limit, w.cap])).toEqual([
      [1000, 50, 25],
      [60_000, 500, 250],
      [1_800_000, 2000, 1000],
    ]);
    expect(caps.windows.some((w) => w.bucket === "class:chain")).toBe(true);
    expect(caps.perMinute).toBe(33);
  });
  it("Fyers: 2/s, 25/min and a 2,500/day quota", () => {
    const caps = budgetCaps(resolvePolicy("fyers"), "chain", 0.5);
    expect(caps.perMinute).toBe(25);
    expect(caps.perDay).toBe(2500);
  });
  it("Dhan chain 1/s + 20/min: broker 20/min, recorder caps 0/s and 10/min", () => {
    const caps = budgetCaps(resolvePolicy("dhan"), "chain", 0.5);
    expect(caps.brokerPerMinute).toBe(20);
    expect(caps.windows.find((w) => w.windowMs === 1000).cap).toBe(0);
  });
  it("demo: chain 5/s and the quote family 10/s, 400/min → 2/s and 200/min", () => {
    const p = resolvePolicy("demo", {}, { demo: DEMO_POLICY });
    const caps = budgetCaps(p, "chain", 0.5);
    expect(caps.windows.map((w) => [w.bucket, w.windowMs, w.cap])).toEqual([
      ["class:chain", 1000, 2],
      ["group:quoteFamily", 1000, 5],
      ["group:quoteFamily", 60_000, 200],
    ]);
    expect(caps.perMinute).toBe(120);
  });
  it("share is clamped to 0.5", () => {
    expect(budgetCaps(resolvePolicy("upstox"), "chain", 0.9).windows[0].cap).toBe(25);
  });
});

describe("rule 4: never take the last token", () => {
  it("1/s classes are off (Dhan chain, Zerodha quote group) unless allowSingleTokenRest", () => {
    expect(restRule(resolvePolicy("dhan"), "chain")).toMatchObject({ allowed: false, singleToken: true, perSecond: 1 });
    expect(restRule(resolvePolicy("zerodha"), "chain")).toMatchObject({ allowed: false, perSecond: 1 });
    const on = restRule(resolvePolicy("zerodha"), "chain", { allowSingleTokenRest: true });
    expect(on.allowed).toBe(true);
    expect(on.why).toMatch(/may wait up to 1 s/);
  });
  it("classes with ≥ 2/s are allowed", () => {
    expect(restRule(resolvePolicy("upstox"), "chain").allowed).toBe(true);
    expect(restRule(resolvePolicy("fyers"), "chain").allowed).toBe(true);
    expect(restRule(resolvePolicy("paper"), "chain").allowed).toBe(false);
  });
});

describe("limiter", () => {
  it("takes up to the cap per window and reports when the next call fits", () => {
    const clock = mkClock(0);
    const b = createRecorderBudget({ policy: resolvePolicy("upstox"), endpointClass: "chain", share: 0.5, clock });
    let n = 0;
    while (b.tryTake()) n++;
    expect(n).toBe(25);
    expect(b.waitMs()).toBe(1000);
    clock.t = 1000;
    expect(b.tryTake()).toBe(true);
    expect(b.usedLastMinute()).toBe(26);
  });
  it("rule 7: an upstream throttle halves every cap for 10 minutes", () => {
    const clock = mkClock(0);
    const b = createRecorderBudget({ policy: resolvePolicy("upstox"), endpointClass: "chain", share: 0.5, clock });
    b.throttle();
    let n = 0;
    while (b.tryTake()) n++;
    expect(n).toBe(12);
    expect(b.perMinute()).toBe(16);
    clock.t = 600_001;
    expect(b.perMinute()).toBe(33);
  });
  it("a zero cap refuses for good (Dhan per-second floor(1/2) = 0)", () => {
    const b = createRecorderBudget({ policy: resolvePolicy("dhan"), endpointClass: "chain", share: 0.5, clock: mkClock(0) });
    expect(b.tryTake()).toBe(false);
    expect(b.waitMs()).toBe(Infinity);
  });
});

describe("property: 10,000 random schedules", () => {
  /** Small deterministic PRNG. */
  const rng = (seed) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const policies = [
    ["upstox", resolvePolicy("upstox"), "chain"],
    ["fyers", resolvePolicy("fyers"), "chain"],
    ["demo", resolvePolicy("demo", {}, { demo: DEMO_POLICY }), "chain"],
    ["angelone", resolvePolicy("angelone"), "quote"],
    ["flattrade", resolvePolicy("flattrade"), "chain"],
  ];

  it("never exceeds any cap and never leaves < 1 token in a per-second window", () => {
    const rand = rng(42);
    let schedules = 0;
    while (schedules < 10_000) {
      for (const [, policy, cls] of policies) {
        schedules += 1;
        const clock = mkClock(Math.floor(rand() * 1e9));
        const share = 0.05 + rand() * 0.45;
        const b = createRecorderBudget({ policy, endpointClass: cls, share, clock });
        const taken = [];
        const steps = 5 + Math.floor(rand() * 40);
        for (let i = 0; i < steps; i++) {
          clock.t += Math.floor(rand() * (rand() < 0.5 ? 300 : 20_000));
          const n = 1 + Math.floor(rand() * 3);
          if (b.tryTake(n)) for (let k = 0; k < n; k++) taken.push(clock.t);
        }
        for (const w of windowsFor(policy, cls)) {
          const cap = Math.floor(Math.min(share, 0.5) * w.limit);
          for (const t of taken) {
            const inWindow = taken.filter((x) => x > t - w.windowMs && x <= t).length;
            if (inWindow > cap) throw new Error(`cap broken on ${w.bucket} ${w.windowMs}`);
            if (w.windowMs === 1000 && w.limit - inWindow < 1) throw new Error("left < 1 token in a second");
          }
        }
      }
    }
    expect(schedules).toBeGreaterThanOrEqual(10_000);
  });
});
