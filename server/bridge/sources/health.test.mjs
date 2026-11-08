/**
 * Source health: decayed averages and the ejection breaker, under a fake clock and a fixed random. No timers, no I/O.
 */
import { describe, expect, it } from "vitest";
import { createHealthTracker, istClock, outcomeKindOf } from "./health.mjs";

function setup(opts = {}) {
  let t = Date.UTC(2026, 9, 19, 4, 0, 0);
  const clock = { now: () => t };
  const advance = (ms) => {
    t += ms;
  };
  // random() = 0.5 gives no jitter (1 + (0.5 * 2 - 1) * 0.2 = 1)
  const health = createHealthTracker({ clock, random: opts.random ?? (() => 0.5) });
  return { health, advance, now: () => t };
}

const hard = (h, id = "a", ms = 100) => h.record(id, { ok: false, ms, kind: "hard" });
const ok = (h, id = "a", ms = 100) => h.record(id, { ok: true, ms, kind: "ok" });

describe("unknown ids", () => {
  it("read as ok with nothing recorded and are tried freely", () => {
    const { health } = setup();
    expect(health.state("nope")).toEqual({ state: "ok", errorRate: 0, p50Ms: null, lastError: null, nextTryAt: null });
    expect(health.canTry("nope")).toBe(true);
    expect(health.samples("nope")).toBe(0);
    expect(Number.isNaN(health.latencyMs("nope"))).toBe(true);
    expect(health.snapshot()).toEqual({});
  });
});

describe("latency", () => {
  it("starts at the first call and reacts to a slow call at once", () => {
    const { health, advance } = setup();
    ok(health, "a", 100);
    expect(health.latencyMs("a")).toBe(100);
    advance(1000);
    ok(health, "a", 4000);
    expect(health.latencyMs("a")).toBe(4000); // peak-sensitive: no smoothing upwards
  });

  it("falls back with a 30 s half-life", () => {
    const { health, advance } = setup();
    ok(health, "a", 1000);
    advance(30_000);
    ok(health, "a", 0);
    // one half-life: halfway from 1000 to 0
    expect(health.latencyMs("a")).toBeCloseTo(500, 5);
    advance(30_000);
    ok(health, "a", 0);
    expect(health.latencyMs("a")).toBeCloseTo(250, 5);
  });

  it("a burst of fast calls barely moves it (time decay, not count decay)", () => {
    const { health } = setup();
    ok(health, "a", 1000);
    for (let i = 0; i < 20; i += 1) ok(health, "a", 0); // all at the same instant
    expect(health.latencyMs("a")).toBe(1000);
  });

  it("p50Ms is the median of recent successful calls and ignores old samples", () => {
    const { health, advance } = setup();
    for (const ms of [10, 30, 20, 1000, 40]) ok(health, "a", ms);
    expect(health.state("a").p50Ms).toBe(30);
    advance(6 * 60_000);
    expect(health.state("a").p50Ms).toBeNull();
  });

  it("a failed call's duration counts toward latency, a rate-limit's does not", () => {
    const { health } = setup();
    ok(health, "a", 100);
    health.record("a", { ok: false, ms: 5000, kind: "hard" });
    expect(health.latencyMs("a")).toBe(5000);
    health.record("a", { ok: false, ms: 9000, kind: "rate-limit" });
    expect(health.latencyMs("a")).toBe(5000);
  });
});

describe("error rate", () => {
  it("one early failure is not read as a 100% failure rate", () => {
    const { health } = setup();
    hard(health);
    expect(health.errorRate("a")).toBe(0.5); // 1 failure, prior of one pseudo-success
  });

  it("rises with failures and falls with successes", () => {
    const { health } = setup();
    for (let i = 0; i < 4; i += 1) ok(health);
    const before = health.errorRate("a");
    hard(health);
    expect(health.errorRate("a")).toBeGreaterThan(before);
    expect(health.errorRate("a")).toBeCloseTo(1 / 6, 5);
    for (let i = 0; i < 10; i += 1) ok(health);
    expect(health.errorRate("a")).toBeLessThan(0.1);
  });

  it("fades with time when nothing new arrives (half-life 60 s)", () => {
    const { health, advance } = setup();
    hard(health);
    hard(health);
    const r0 = health.errorRate("a");
    advance(60_000);
    const r1 = health.errorRate("a");
    expect(r1).toBeLessThan(r0);
    advance(10 * 60_000);
    expect(health.errorRate("a")).toBeLessThan(0.01);
  });

  it("429, auth and not-found are not counted at all", () => {
    const { health } = setup();
    for (const kind of ["rate-limit", "auth", "not-found"]) for (let i = 0; i < 10; i += 1) health.record("a", { ok: false, ms: 5, kind });
    expect(health.errorRate("a")).toBe(0);
    expect(health.state("a").state).toBe("ok");
    expect(health.canTry("a")).toBe(true);
  });

  it("is deterministic: the same calls at the same times give the same numbers", () => {
    const run = () => {
      const { health, advance } = setup();
      for (let i = 0; i < 30; i += 1) {
        advance(1700);
        i % 3 === 0 ? hard(health, "a", 50 + i) : ok(health, "a", 50 + i);
      }
      return health.state("a");
    };
    expect(run()).toEqual(run());
  });
});

describe("state labels", () => {
  it("ok, degraded, open", () => {
    const { health } = setup();
    ok(health);
    expect(health.state("a").state).toBe("ok");
    hard(health);
    expect(health.state("a").state).toBe("degraded"); // 1 of 2 calls failed
    hard(health);
    hard(health); // third in a row
    const s = health.state("a");
    expect(s.state).toBe("open");
    expect(s.nextTryAt).toBeGreaterThan(0);
    expect(s.lastError).toMatchObject({ kind: "hard" });
  });

  it("a source the owner switched off reads as disabled and is never tried", () => {
    const { health } = setup();
    health.setDisabled("a", true);
    expect(health.state("a").state).toBe("disabled");
    expect(health.canTry("a")).toBe(false);
    health.setDisabled("a", false);
    expect(health.canTry("a")).toBe(true);
  });

  it("snapshot lists every id seen", () => {
    const { health } = setup();
    ok(health, "a");
    hard(health, "b");
    expect(Object.keys(health.snapshot()).sort()).toEqual(["a", "b"]);
    expect(health.snapshot().b.errorRate).toBeGreaterThan(0);
  });

  it("reset forgets an id", () => {
    const { health } = setup();
    hard(health, "a");
    health.reset("a");
    expect(health.state("a").errorRate).toBe(0);
  });
});

describe("breaker: opening", () => {
  it("opens on 3 consecutive hard failures", () => {
    const { health } = setup();
    hard(health);
    hard(health);
    expect(health.canTry("a")).toBe(true);
    hard(health);
    expect(health.canTry("a")).toBe(false);
  });

  it("a success in between resets the consecutive count", () => {
    const { health } = setup();
    hard(health);
    hard(health);
    ok(health);
    hard(health);
    hard(health);
    expect(health.canTry("a")).toBe(true);
  });

  it("opens when at least half of at least 6 calls in 60 s failed, even without 3 in a row", () => {
    const { health, advance } = setup();
    // fail, ok, fail, ok, fail (never 3 in a row), then one more ok: 3/6 = 50%
    for (const f of [true, false, true, false, true]) {
      f ? hard(health) : ok(health);
      advance(1000);
    }
    expect(health.canTry("a")).toBe(true); // 5 calls: below the minimum
    ok(health); // 6th call, 3 failures of 6 = 50%
    expect(health.canTry("a")).toBe(true); // a success does not trip it
    hard(health); // 4 of 7, not three in a row
    expect(health.canTry("a")).toBe(false);
  });

  it("does not open on a low failure rate", () => {
    const { health, advance } = setup();
    for (let i = 0; i < 20; i += 1) {
      i % 5 === 0 ? hard(health) : ok(health);
      advance(500);
    }
    expect(health.canTry("a")).toBe(true);
  });

  it("failures older than 60 s do not count toward the rate rule", () => {
    const { health, advance } = setup();
    hard(health);
    ok(health);
    hard(health);
    ok(health);
    hard(health);
    advance(61_000);
    ok(health);
    ok(health);
    ok(health);
    hard(health);
    expect(health.canTry("a")).toBe(true);
  });

  it("429, auth and not-found never open it, however many arrive", () => {
    const { health } = setup();
    for (let i = 0; i < 50; i += 1) {
      health.record("a", { ok: false, kind: "rate-limit" });
      health.record("a", { ok: false, kind: "auth" });
      health.record("a", { ok: false, kind: "not-found" });
    }
    expect(health.canTry("a")).toBe(true);
  });

  it("neutral outcomes do not reset the consecutive-failure count", () => {
    const { health } = setup();
    hard(health);
    hard(health);
    health.record("a", { ok: false, kind: "rate-limit" });
    hard(health);
    expect(health.canTry("a")).toBe(false);
  });

  it("a failed outcome without a kind is a hard failure; ok:true always wins over a kind", () => {
    const { health } = setup();
    health.record("a", { ok: false });
    health.record("a", { ok: false });
    health.record("a", { ok: false });
    expect(health.canTry("a")).toBe(false);
    health.reset("a");
    health.record("a", { ok: true, kind: "hard" });
    expect(health.errorRate("a")).toBe(0);
  });
});

describe("breaker: cooldown and probe", () => {
  const trip = (health) => {
    hard(health);
    hard(health);
    hard(health);
  };

  it("stays closed to calls for 15 s, then lets exactly one probe through", () => {
    const { health, advance, now } = setup();
    const t0 = now();
    trip(health);
    expect(health.nextTryAt("a")).toBe(t0 + 15_000);
    advance(14_999);
    expect(health.canTry("a")).toBe(false);
    advance(1);
    expect(health.canTry("a")).toBe(true); // half-open
    expect(health.state("a").state).toBe("degraded");
    health.claim("a");
    expect(health.canTry("a")).toBe(false); // the probe is in flight
    expect(health.state("a").nextTryAt).toBeGreaterThan(now());
  });

  it("a successful probe closes the breaker and clears the old failures", () => {
    const { health, advance } = setup();
    trip(health);
    advance(15_000);
    health.claim("a");
    ok(health);
    // closed again; the recent failures still show in the error rate, so it reads as degraded rather than ok
    expect(health.state("a").state).toBe("degraded");
    expect(health.canTry("a")).toBe(true);
    hard(health);
    hard(health);
    expect(health.canTry("a")).toBe(true); // two new failures are not enough: the count started again
  });

  it("a failed probe re-opens it with a doubled cooldown", () => {
    const { health, advance, now } = setup();
    trip(health);
    advance(15_000);
    health.claim("a");
    const t = now();
    hard(health);
    expect(health.canTry("a")).toBe(false);
    expect(health.nextTryAt("a")).toBe(t + 30_000);
  });

  it("cooldown doubles each time up to 5 minutes", () => {
    const { health, advance, now } = setup();
    const cooldowns = [];
    trip(health);
    for (let i = 0; i < 8; i += 1) {
      const until = health.nextTryAt("a");
      cooldowns.push(until - now());
      advance(until - now());
      health.claim("a");
      hard(health);
    }
    expect(cooldowns).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
  });

  it("a probe that never reports frees its slot after 10 s", () => {
    const { health, advance } = setup();
    trip(health);
    advance(15_000);
    health.claim("a");
    expect(health.canTry("a")).toBe(false);
    advance(10_000);
    expect(health.canTry("a")).toBe(true);
  });

  it("release frees the probe slot at once (the caller went away)", () => {
    const { health, advance } = setup();
    trip(health);
    advance(15_000);
    health.claim("a");
    health.release("a");
    expect(health.canTry("a")).toBe(true);
  });

  it("a 429 on the probe frees the slot but does not close or re-open the breaker", () => {
    const { health, advance } = setup();
    trip(health);
    advance(15_000);
    health.claim("a");
    health.record("a", { ok: false, kind: "rate-limit" });
    expect(health.canTry("a")).toBe(true);
    expect(health.state("a").state).toBe("degraded");
  });

  it("jitter keeps the cooldown within +-20% and uses the injected random", () => {
    const lo = setup({ random: () => 0 });
    trip(lo.health);
    expect(lo.health.nextTryAt("a") - lo.now()).toBe(12_000);
    const hi = setup({ random: () => 1 });
    trip(hi.health);
    expect(hi.health.nextTryAt("a") - hi.now()).toBe(18_000);
  });

  it("ejection counts fade by one per 10 clean minutes", () => {
    const { health, advance, now } = setup();
    trip(health);
    advance(15_000);
    health.claim("a");
    hard(health); // ejections = 2, next cooldown 30 s
    advance(30_000);
    health.claim("a");
    ok(health); // closed again
    advance(25 * 60_000); // far more than 2 x 10 minutes clean
    ok(health);
    trip(health);
    expect(health.nextTryAt("a") - now()).toBe(15_000); // back to the base cooldown
  });

  it("a success while open (a forced probe) closes it", () => {
    const { health } = setup();
    trip(health);
    expect(health.canTry("a")).toBe(false);
    ok(health);
    expect(health.canTry("a")).toBe(true);
  });

  it("claim has no effect on a closed breaker", () => {
    const { health } = setup();
    ok(health);
    health.claim("a");
    expect(health.canTry("a")).toBe(true);
  });

  it("ids are independent", () => {
    const { health } = setup();
    trip(health);
    expect(health.canTry("b")).toBe(true);
  });
});

describe("helpers", () => {
  it("outcomeKindOf maps Bridge error codes, and ignores a cancelled caller", () => {
    expect(outcomeKindOf({ code: "UPSTREAM_RATE_LIMITED" })).toBe("rate-limit");
    expect(outcomeKindOf({ code: "RATE_LIMITED" })).toBe("rate-limit");
    expect(outcomeKindOf({ code: "SESSION_EXPIRED" })).toBe("auth");
    expect(outcomeKindOf({ code: "SYMBOL_NOT_FOUND" })).toBe("not-found");
    expect(outcomeKindOf({ code: "CAPABILITY_UNSUPPORTED" })).toBe("not-found");
    expect(outcomeKindOf({ code: "UPSTREAM_ERROR" })).toBe("hard");
    expect(outcomeKindOf({ code: "UPSTREAM_TIMEOUT" })).toBe("hard");
    expect(outcomeKindOf({ code: "BROKER_UNAVAILABLE" })).toBe("hard");
    expect(outcomeKindOf(new Error("boom"))).toBe("hard");
    expect(outcomeKindOf({ name: "AbortError" })).toBeNull();
  });

  it("istClock formats Indian time", () => {
    expect(istClock(Date.UTC(2026, 9, 19, 9, 2))).toBe("14:32 IST");
    expect(istClock(Number.NaN)).toBe("");
  });

  it("works without a clock (real time) and without options", () => {
    const h = createHealthTracker();
    h.record("a", { ok: true, ms: 5 });
    expect(h.state("a").state).toBe("ok");
  });
});
