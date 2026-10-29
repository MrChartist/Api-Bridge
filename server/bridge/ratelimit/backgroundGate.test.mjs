/**
 * backgroundGate (docs/spec/README.md §3.1): background work never leaves any window below 50 % of its limit.
 */
import { describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { TOPICS, createEventBus } from "../core/eventBus.mjs";
import { createLogger } from "../core/logger.mjs";
import { MAX_BACKGROUND_SHARE, createBackgroundGate, gateDecision } from "./backgroundGate.mjs";
import { createFakeScheduler, createManualClock } from "./fake.mjs";
import { createScheduler } from "./scheduler.mjs";
import { createRateLimiter } from "./tokenBucket.mjs";

/** Small seeded PRNG (mulberry32) so a failure is reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const win = (limit, remaining, resetMs = 500, window = "1s") => ({ bucket: "quote", window, limit, remaining, resetMs });

describe("gateDecision", () => {
  it("allows only while remaining − cost stays at or above ceil((1 − share) × limit) in every window", () => {
    expect(gateDecision({ windows: [win(10, 6)] }).ok).toBe(true); // 6 − 1 = 5 ≥ 5
    expect(gateDecision({ windows: [win(10, 5)] }).ok).toBe(false); // 4 < 5
    expect(gateDecision({ windows: [win(10, 7)] }, { cost: 2 }).ok).toBe(true);
    expect(gateDecision({ windows: [win(10, 7)] }, { cost: 3 }).ok).toBe(false);
    expect(gateDecision({ windows: [win(3, 3)] }).ok).toBe(true); // floor ceil(1.5) = 2
    expect(gateDecision({ windows: [win(3, 2)] }).ok).toBe(false);
    // Every window counts: a roomy second window does not hide a tight minute window.
    expect(gateDecision({ windows: [win(10, 9), win(200, 100, 30_000, "1m")] }).ok).toBe(false);
  });

  it("a smaller share is stricter; a share above 50 % is clamped to 50 %", () => {
    expect(gateDecision({ windows: [win(10, 6)] }, { share: 0.2 }).ok).toBe(false); // floor 8
    expect(gateDecision({ windows: [win(10, 9)] }, { share: 0.2 }).ok).toBe(true);
    expect(gateDecision({ windows: [win(10, 5)] }, { share: 1 }).ok).toBe(false); // still floor 5
    expect(gateDecision({ windows: [win(10, 10)] }, { share: 0 }).ok).toBe(false);
    expect(MAX_BACKGROUND_SHARE).toBe(0.5);
  });

  it("refuses while the class backs off and reports when to look again", () => {
    expect(gateDecision({ windows: [win(10, 10)], backoffMs: 2000 })).toMatchObject({ ok: false, waitMs: 2000 });
    const d = gateDecision({ windows: [win(10, 4, 300), win(100, 20, 40_000, "1m")] });
    expect(d).toMatchObject({ ok: false, waitMs: 40_000, binding: { window: "1m", floor: 50 } });
    expect(gateDecision({ windows: [win(10, 10)] })).toEqual({ ok: true, waitMs: 0, binding: null });
  });

  it("paper accounts (no broker windows) are always allowed; bad cost is refused", () => {
    expect(gateDecision({ windows: [], backoffMs: 0 }).ok).toBe(true);
    expect(gateDecision({ windows: [{ window: "none", limit: Infinity, remaining: Infinity, resetMs: 0 }] }).ok).toBe(true);
    expect(() => gateDecision({ windows: [] }, { cost: 0 })).toThrow(/cost/);
  });
});

describe("property: background callers never leave a window below 50 %", () => {
  it("over 10,000 random schedules of user and background calls on multi-window class + group buckets", () => {
    const rand = rng(20261029);
    let backgroundTakes = 0;
    for (let run = 0; run < 10_000; run++) {
      const perSecond = 1 + Math.floor(rand() * 20);
      const perMinute = perSecond * (5 + Math.floor(rand() * 60));
      const groupPerSecond = 1 + Math.floor(rand() * 30);
      const cls = createRateLimiter([
        { name: "1s", windowMs: 1000, limit: perSecond },
        { name: "1m", windowMs: 60_000, limit: perMinute },
        ...(rand() < 0.3 ? [{ name: "day", istDay: true, limit: perMinute * 10 }] : []),
      ]);
      const group = createRateLimiter([{ name: "1s", windowMs: 1000, limit: groupPerSecond }]);
      const lims = [cls, group];
      let t = 1_790_000_000_000 + Math.floor(rand() * 86_400_000);
      const scheduler = {
        headroom: () => ({ remaining: 0, limit: 1, resetMs: 0 }),
        headroomWindows: () => ({
          windows: lims.flatMap((l, i) => l.windows(t).map((w) => ({ bucket: String(i), window: w.window, limit: w.limit, remaining: Math.max(0, w.limit - w.used), resetMs: w.resetMs }))),
          backoffMs: 0,
        }),
      };
      const gate = createBackgroundGate({ scheduler });
      const steps = 5 + Math.floor(rand() * 40);
      for (let i = 0; i < steps; i++) {
        t += Math.floor(rand() * (rand() < 0.2 ? 5000 : 200));
        const cost = 1 + Math.floor(rand() * 3);
        const share = rand() < 0.7 ? 0.5 : rand() * 0.9;
        if (rand() < 0.5) {
          // A user call: takes whatever fits (users are not gated).
          if (lims.every((l) => l.canTake(cost, t))) for (const l of lims) l.take(cost, t);
        } else if (gate.allow("acc", "quote", { share, cost })) {
          for (const l of lims) l.take(cost, t);
          backgroundTakes += 1;
          for (const l of lims) {
            for (const w of l.windows(t)) {
              const remaining = w.limit - w.used;
              if (remaining < Math.ceil(0.5 * w.limit)) throw new Error(`run ${run} step ${i}: window ${w.window} left ${remaining} of ${w.limit}`);
            }
          }
        }
      }
    }
    expect(backgroundTakes).toBeGreaterThan(10_000);
  });

  it("with the real scheduler: background calls gated by allow() keep every window (class and group) at ≥ 50 %", async () => {
    const v = (spec) => ({ ...spec, verified: true, source: "https://example.test/limits" });
    const policies = {
      shared: { brokerId: "shared", limits: { quote: v({ perSecond: 10, perMinute: 120 }), order: v({ perSecond: 5 }) }, groups: { all: { classes: ["order", "quote"], ...v({ perSecond: 8 }) } }, maxQuoteBatch: 1, feed: {}, pooling: "unknown" },
    };
    const clock = createManualClock();
    const logger = createLogger({ write: () => {} });
    const bus = createEventBus({ logger, topics: TOPICS });
    const accounts = createFakeAccountManager({ accounts: [{ id: "s1", broker: "shared" }], bus });
    const s = createScheduler({ config: { ratelimit: {} }, logger, bus, clock, accounts }, { policies });
    const gate = createBackgroundGate({ scheduler: s });
    const rand = rng(7);
    let taken = 0;
    for (let i = 0; i < 5000; i++) {
      await clock.advance(Math.floor(rand() * 150));
      if (rand() < 0.1) s.tryAcquire("s1", rand() < 0.5 ? "order" : "quote");
      else if (gate.allow("s1", "quote")) {
        expect(s.tryAcquire("s1", "quote").ok).toBe(true);
        taken += 1;
        for (const w of s.headroomWindows("s1", "quote").windows) expect(w.remaining, `${w.bucket} ${w.window}`).toBeGreaterThanOrEqual(Math.ceil(w.limit / 2));
      }
    }
    expect(taken).toBeGreaterThan(50);
    expect(s.headroomWindows("s1", "quote").windows.map((w) => w.bucket).sort()).toEqual(expect.arrayContaining([expect.stringMatching(/all/), expect.stringMatching(/quote/)]));
    s.stop();
  });

  it("falls back to the contract headroom() when a scheduler has no window list, and works with the fake", () => {
    const g = createBackgroundGate({ scheduler: { headroom: () => ({ remaining: 3, limit: 10, resetMs: 700 }) } });
    expect(g.allow("a", "quote")).toBe(false);
    expect(g.waitMs("a", "quote")).toBe(700);
    const fake = createFakeScheduler();
    const fg = createBackgroundGate({ scheduler: fake });
    expect(fg.allow("a", "quote")).toBe(true);
    fake.throttle("a", "quote", 1500);
    expect(fg.check("a", "quote")).toMatchObject({ ok: false });
    expect(() => createBackgroundGate({})).toThrow(TypeError);
  });
});
