/**
 * SourceRouter with a tiny fake registry, fake accounts and a fake scheduler: ordering, hard filters, purposes, breaker
 * interplay, at-most-two attempts and the trace. No network, no timers.
 */
import { describe, expect, it } from "vitest";
import { createHealthTracker } from "./health.mjs";
import { createSourceRouter } from "./router.mjs";

const T0 = Date.UTC(2026, 9, 19, 4, 0, 0);

const desc = (over) => ({
  id: "src-x",
  name: "Source X",
  kind: "free",
  tier: "opt-in",
  class: "delayed",
  delaySec: 900,
  official: false,
  capabilities: ["quotes", "history", "expiries", "optionChain"],
  limits: { perMinute: 30 },
  terms: { url: "https://example.test/terms", note: "Terms apply." },
  noticeVersion: "n-1",
  ...over,
});
const DELAYED = desc({ id: "web-delayed", name: "Web delayed" });
const EOD = desc({ id: "web-eod", name: "Web end of day", class: "eod", delaySec: null, tier: "byok", noticeVersion: undefined });
const REALTIME_OFFICIAL = desc({ id: "vendor-rt", name: "Vendor real-time", class: "realtime", delaySec: 0, official: true, tier: "byok", noticeVersion: undefined });
const REALTIME_UNOFFICIAL = desc({ id: "scrape-rt", name: "Scraped real-time", class: "realtime", delaySec: 0, official: false });
const PLUGIN_RT = desc({ id: "plug-rt", name: "Plugin real-time", kind: "plugin", tier: "plugin", class: "realtime", delaySec: 0, official: true, noticeVersion: undefined });

function build({ accounts: ids = ["z1"], sources = [], budgets = {}, enabled, opts = {}, healthOpts } = {}) {
  let t = T0;
  const clock = { now: () => t };
  const health = createHealthTracker({ clock, random: () => 0.5, ...healthOpts });
  const accountsFake = {
    calls: [],
    marketDataCandidates(q) {
      this.calls.push(q);
      return ids.filter((id) => (q.allowedAccounts ? q.allowedAccounts.includes(id) : true));
    },
    get: (id) => ({ id, label: `Account ${id}` }),
    adapter: (id) => ({ capabilities: { historical: { intervals: ["1m", "5m", "1d"] } }, id }),
  };
  const scheduler = {
    headroom(id) {
      const b = budgets[id];
      if (b === "throw") throw new Error("unknown account");
      return b ?? { remaining: 1000, limit: 1000, resetMs: 0 };
    },
  };
  const entries = sources.map((d) => ({ descriptor: d, enabled: enabled ? enabled(d.id) : true }));
  const registry = { list: () => entries };
  const router = createSourceRouter({ registry, health, scheduler, accounts: accountsFake, clock, ...opts });
  return { router, health, clock, accounts: accountsFake, advance: (ms) => (t += ms), setBudget: (id, b) => (budgets[id] = b), registry };
}

const ids = (plan) => plan.map((c) => c.id);
const req = (over) => ({ capability: "quotes", allowSources: true, symbols: ["NSE:RELIANCE"], ...over });

describe("candidates", () => {
  it("a candidate has kind, id, descriptor, score and reasons; brokers also carry accountId", () => {
    const { router } = build({ sources: [DELAYED] });
    const [broker, source] = router.select(req());
    expect(broker).toMatchObject({ kind: "broker", id: "z1", accountId: "z1" });
    expect(broker.descriptor).toMatchObject({ kind: "broker", class: "realtime", official: true, delaySec: 0, name: "Account z1" });
    expect(broker.score).toBeGreaterThan(0);
    expect(Array.isArray(broker.reasons)).toBe(true);
    expect(source).toMatchObject({ kind: "source", id: "web-delayed" });
    expect(source.accountId).toBeUndefined();
    expect(source.descriptor).toBe(DELAYED);
  });

  it("asks the accounts for the right broker capability and passes the caller's account restriction", () => {
    const { router, accounts } = build({ accounts: ["z1", "d1"] });
    router.select({ capability: "history", allowedAccounts: ["d1"] });
    expect(accounts.calls.at(-1)).toEqual({ capability: "historical", allowedAccounts: ["d1"] });
    router.select({ capability: "quotes", brokerCapability: "ltp" });
    expect(accounts.calls.at(-1)).toEqual({ capability: "ltp" });
  });

  it("returns nothing when no account and no source can answer", () => {
    const { router } = build({ accounts: [], sources: [] });
    expect(router.select(req())).toEqual([]);
  });

  it("a broker-kind entry in the registry is ignored (broker accounts come from the accounts list)", () => {
    const demo = desc({ id: "demo", kind: "broker", tier: "builtin", class: "realtime", delaySec: 0, official: true });
    const { router } = build({ accounts: [], sources: [demo] });
    expect(router.select(req())).toEqual([]);
  });
});

describe("brokers first", () => {
  it("a real-time broker always outranks a delayed source, even a much healthier one", () => {
    const { router, health } = build({ sources: [DELAYED] });
    for (let i = 0; i < 20; i += 1) health.record("web-delayed", { ok: true, ms: 5 });
    for (let i = 0; i < 2; i += 1) health.record("z1", { ok: false, ms: 900, kind: "hard" });
    expect(ids(router.select(req()))).toEqual(["z1", "web-delayed"]);
  });

  it("data sources are not considered unless the read allows them", () => {
    const { router } = build({ sources: [DELAYED] });
    expect(ids(router.select(req({ allowSources: false })))).toEqual(["z1"]);
    expect(ids(router.select({ capability: "quotes" }))).toEqual(["z1"]);
  });

  it("a source takes the lead when no broker qualifies (no account at all)", () => {
    const { router } = build({ accounts: [], sources: [DELAYED] });
    expect(ids(router.select(req()))).toEqual(["web-delayed"]);
  });

  it("a source takes the lead when every broker is out of budget, and the broker stays as the last resort", () => {
    const { router } = build({ sources: [DELAYED], budgets: { z1: { remaining: 0, limit: 10, resetMs: 800 } } });
    expect(ids(router.select(req()))).toEqual(["web-delayed", "z1"]);
  });

  it("with sources not allowed, a broker without budget is still returned (the scheduler queues or refuses)", () => {
    const { router } = build({ sources: [DELAYED], budgets: { z1: { remaining: 0, limit: 10, resetMs: 800 } } });
    expect(ids(router.select(req({ allowSources: false })))).toEqual(["z1"]);
  });

  it("brokers with budget come before brokers without, and the one that frees up soonest comes first", () => {
    const { router } = build({
      accounts: ["a", "b", "c"],
      budgets: { a: { remaining: 0, limit: 10, resetMs: 5000 }, b: { remaining: 0, limit: 10, resetMs: 1000 }, c: { remaining: 5, limit: 10, resetMs: 0 } },
    });
    expect(ids(router.select({ capability: "quotes" }))).toEqual(["c", "b"]);
    const full = router.trace({ capability: "quotes" });
    expect(full.considered.map((c) => c.id)).toEqual(["c", "b", "a"]);
  });

  it("history: a source goes first when no broker supports the interval", () => {
    const { router } = build({ sources: [DELAYED] });
    const supports = (id, interval) => (interval === "1m" ? true : "this account's broker cannot supply that interval");
    expect(ids(router.select(req({ capability: "history", supports: (id) => supports(id, "3d") })))).toEqual(["web-delayed"]);
    expect(ids(router.select(req({ capability: "history", supports: (id) => supports(id, "1m") })))).toEqual(["z1", "web-delayed"]);
  });
});

describe("scoring among brokers", () => {
  it("prefers the account with more spare budget", () => {
    const { router } = build({
      accounts: ["a", "b"],
      budgets: { a: { remaining: 2, limit: 10, resetMs: 100 }, b: { remaining: 9, limit: 10, resetMs: 100 } },
    });
    expect(ids(router.select({ capability: "quotes" }))).toEqual(["b", "a"]);
  });

  it("an account's recent errors lower its score", () => {
    const { router, health } = build({ accounts: ["a", "b"] });
    for (let i = 0; i < 4; i += 1) health.record("a", { ok: false, kind: "hard", ms: 10 });
    health.record("a", { ok: true, ms: 10 }); // not three in a row at the end, breaker may be open: check below
    const plan = ids(router.select({ capability: "quotes" }));
    expect(plan[0]).toBe("b");
  });

  it("slower accounts score lower, but never below a quarter of the best", () => {
    const { router, health } = build({ accounts: ["slow", "fast"] });
    health.record("slow", { ok: true, ms: 4000 });
    health.record("fast", { ok: true, ms: 100 });
    const [first, second] = router.select({ capability: "quotes" });
    expect(first.id).toBe("fast");
    expect(second.id).toBe("slow");
    expect(second.score / first.score).toBeCloseTo(0.25, 5);
  });

  it("equal accounts keep configuration order", () => {
    const { router } = build({ accounts: ["a", "b", "c"] });
    expect(ids(router.select({ capability: "quotes" }))).toEqual(["a", "b"]);
  });

  it("the last 10% of a budget counts for half (the soft reserve)", () => {
    const { router } = build({ accounts: ["a", "b"], budgets: { a: { remaining: 8, limit: 100, resetMs: 0 }, b: { remaining: 7, limit: 100, resetMs: 0 } } });
    const [first, second] = router.select({ capability: "quotes" });
    expect(first.id).toBe("a");
    expect(first.score).toBeCloseTo(0.04, 5);
    expect(second.score).toBeCloseTo(0.035, 5);
  });

  it("a scheduler that cannot report headroom is treated as unlimited", () => {
    const { router } = build({ accounts: ["a"], budgets: { a: "throw" } });
    expect(ids(router.select({ capability: "quotes" }))).toEqual(["a"]);
  });

  it("works with a health object that only has state()", () => {
    const states = { a: { state: "open" }, b: { state: "ok", errorRate: 0.5, p50Ms: 50 } };
    const { router } = build({ accounts: ["a", "b"], opts: { health: { state: (id) => states[id] ?? { state: "ok" } } } });
    expect(ids(router.select({ capability: "quotes" }))).toEqual(["b"]);
  });
});

describe("at most two attempts", () => {
  it("caps the plan at 2 candidates", () => {
    const { router } = build({ accounts: ["a", "b", "c"], sources: [DELAYED, EOD] });
    expect(router.select(req()).length).toBe(2);
    expect(ids(router.select(req()))).toEqual(["a", "b"]);
  });

  it("the trace says why a qualified third candidate was not used", () => {
    const { router } = build({ accounts: ["a", "b", "c"] });
    const t = router.trace({ capability: "quotes" });
    expect(t.considered.map((c) => c.verdict)).toEqual(["chosen", "fallback", "skipped"]);
    expect(t.considered[2].reason).toMatch(/at most 2/);
  });
});

describe("data class, purpose and maxAge", () => {
  it.each(["order", "risk", "paper", "alert"])("a %s read never gets a delayed or end-of-day source", (purpose) => {
    const { router } = build({ accounts: [], sources: [DELAYED, EOD] });
    expect(router.select(req({ purpose }))).toEqual([]);
  });

  it.each(["order", "risk", "paper", "alert"])("a %s read with a broker only gets the broker", (purpose) => {
    const { router } = build({ sources: [DELAYED, EOD] });
    expect(ids(router.select(req({ purpose })))).toEqual(["z1"]);
  });

  it("display and analysis reads may use delayed and end-of-day sources", () => {
    for (const purpose of ["display", "analysis"]) {
      const { router } = build({ accounts: [], sources: [DELAYED, EOD] });
      expect(ids(router.select(req({ purpose })))).toEqual(["web-delayed", "web-eod"]);
    }
  });

  it("an unknown purpose is treated as strict", () => {
    const { router } = build({ accounts: [], sources: [DELAYED, EOD, REALTIME_OFFICIAL] });
    expect(ids(router.select(req({ purpose: "whatever" })))).toEqual(["vendor-rt"]);
  });

  it("a strict read accepts an official real-time source but not an unofficial or plugin one", () => {
    const { router } = build({ accounts: [], sources: [REALTIME_UNOFFICIAL, PLUGIN_RT, REALTIME_OFFICIAL] });
    expect(ids(router.select(req({ purpose: "order" })))).toEqual(["vendor-rt"]);
    expect(ids(router.select(req({ purpose: "alert" })))).toEqual(["vendor-rt"]);
    // a display read may use all three (two attempts at most)
    expect(ids(router.select(req({ purpose: "display" })))).toEqual(["scrape-rt", "plug-rt"]);
    const alone = build({ accounts: [], sources: [REALTIME_UNOFFICIAL] });
    expect(ids(alone.router.select(req({ purpose: "display" })))).toEqual(["scrape-rt"]);
    expect(alone.router.select(req({ purpose: "paper" }))).toEqual([]);
  });

  it("sources are ordered most current class first, then by score", () => {
    const { router } = build({ accounts: [], sources: [EOD, DELAYED, REALTIME_UNOFFICIAL] });
    expect(ids(router.select(req({ allowSources: true })))).toEqual(["scrape-rt", "web-delayed"]);
    expect(router.trace(req()).considered.map((c) => c.id)).toEqual(["scrape-rt", "web-delayed", "web-eod"]);
  });

  it("maxAgeMs filters delayed sources that cannot be that fresh", () => {
    const { router } = build({ accounts: [], sources: [DELAYED, EOD] });
    expect(router.select(req({ maxAgeMs: 2000 }))).toEqual([]);
    expect(ids(router.select(req({ maxAgeMs: 20 * 60_000 })))).toEqual(["web-delayed"]);
    expect(ids(router.select(req({ maxAgeMs: 24 * 3600_000 })))).toEqual(["web-delayed", "web-eod"]);
    expect(ids(router.select(req({ maxAgeMs: undefined })))).toEqual(["web-delayed", "web-eod"]);
  });

  it("maxAgeMs never filters a real-time broker", () => {
    const { router } = build({ sources: [DELAYED] });
    expect(ids(router.select(req({ maxAgeMs: 0 })))).toEqual(["z1"]);
  });

  it("capability filter: a source that does not offer the read is skipped", () => {
    const quotesOnly = desc({ id: "q-only", capabilities: ["quotes"] });
    const { router } = build({ accounts: [], sources: [quotesOnly] });
    expect(ids(router.select(req({ capability: "quotes" })))).toEqual(["q-only"]);
    expect(router.select(req({ capability: "optionChain" }))).toEqual([]);
  });
});

describe("which sources are on", () => {
  it("a source that is off is never a candidate", () => {
    const { router } = build({ accounts: [], sources: [DELAYED, EOD], enabled: (id) => id === "web-eod" });
    expect(ids(router.select(req()))).toEqual(["web-eod"]);
  });

  it("with no entry flag a source counts as off unless isEnabled says otherwise", () => {
    const entries = [{ descriptor: DELAYED }];
    const mk = (extra) => createSourceRouter({ registry: { list: () => entries, ...extra.registry }, health: createHealthTracker(), scheduler: {}, accounts: { marketDataCandidates: () => [] }, clock: { now: () => T0 }, ...extra.opts });
    expect(mk({}).select(req())).toEqual([]);
    expect(ids(mk({ opts: { isEnabled: (id) => id === "web-delayed" } }).select(req()))).toEqual(["web-delayed"]);
    expect(ids(mk({ registry: { isEnabled: () => true } }).select(req()))).toEqual(["web-delayed"]);
  });

  it("a source whose own quota is used up is skipped", () => {
    const { router } = build({ accounts: [], sources: [DELAYED, EOD], opts: { sourceSpare: (id) => (id === "web-delayed" ? 0 : 0.5) } });
    expect(ids(router.select(req()))).toEqual(["web-eod"]);
  });

  it("uses the scheduler's budget for a source's pseudo account when it has one, and tolerates it having none", () => {
    const { router } = build({ accounts: [], sources: [DELAYED, EOD], budgets: { "src:web-delayed": { remaining: 0, limit: 10, resetMs: 500 }, "src:web-eod": "throw" } });
    expect(ids(router.select(req()))).toEqual(["web-eod"]);
  });

  it("a registry that throws does not break routing", () => {
    const router = createSourceRouter({ registry: { list: () => { throw new Error("boom"); } }, health: createHealthTracker(), scheduler: {}, accounts: { marketDataCandidates: () => ["z1"] }, clock: { now: () => T0 } });
    expect(ids(router.select(req()))).toEqual(["z1"]);
  });
});

describe("breaker interplay", () => {
  const trip = (health, id) => {
    for (let i = 0; i < 3; i += 1) health.record(id, { ok: false, ms: 10, kind: "hard" });
  };

  it("an ejected broker is skipped in favour of the next", () => {
    const { router, health } = build({ accounts: ["a", "b"] });
    trip(health, "a");
    expect(ids(router.select({ capability: "quotes" }))).toEqual(["b"]);
  });

  it("an ejected source is skipped", () => {
    const { router, health } = build({ accounts: [], sources: [DELAYED, EOD] });
    trip(health, "web-delayed");
    expect(ids(router.select(req()))).toEqual(["web-eod"]);
  });

  it("429s do not eject anything", () => {
    const { router, health } = build({ accounts: ["a", "b"] });
    for (let i = 0; i < 20; i += 1) health.record("a", { ok: false, kind: "rate-limit" });
    expect(ids(router.select({ capability: "quotes" }))).toEqual(["a", "b"]);
  });

  it("when the last candidate is ejected it still gets one probe per 5 s, never fully blind", () => {
    const { router, health, advance } = build({ accounts: ["a"] });
    trip(health, "a");
    const first = router.select({ capability: "quotes" });
    expect(ids(first)).toEqual(["a"]);
    expect(first[0].reasons[0]).toMatch(/last resort/);
    expect(router.select({ capability: "quotes" })).toEqual([]); // the probe was just used
    advance(4999);
    expect(router.select({ capability: "quotes" })).toEqual([]);
    advance(1);
    expect(ids(router.select({ capability: "quotes" }))).toEqual(["a"]);
  });

  it("a half-open candidate is claimed by the first select, so a concurrent one does not probe it too", () => {
    const { router, health, advance } = build({ accounts: ["a"] });
    trip(health, "a");
    advance(15_000);
    expect(ids(router.select({ capability: "quotes" }))).toEqual(["a"]); // the probe
    // while that probe is in flight, nobody else is sent to it, and it is not forced either
    expect(router.select({ capability: "quotes" })).toEqual([]);
    advance(6000);
    expect(router.select({ capability: "quotes" })).toEqual([]);
    advance(4000); // the probe timed out without an answer: another may try
    expect(ids(router.select({ capability: "quotes" }))).toEqual(["a"]);
  });

  it("a trace never claims the probe", () => {
    const { router, health, advance } = build({ accounts: ["a", "b"] });
    trip(health, "a");
    advance(15_000);
    router.trace({ capability: "quotes" });
    router.trace({ capability: "quotes" });
    expect(health.canTry("a")).toBe(true);
  });
});

describe("deadline", () => {
  it("a broker whose budget frees up after the deadline is dropped when another can answer", () => {
    const { router } = build({ accounts: ["a", "b"], budgets: { a: { remaining: 0, limit: 10, resetMs: 5000 } } });
    expect(ids(router.select({ capability: "quotes", deadlineMs: 1000 }))).toEqual(["b"]);
    expect(ids(router.select({ capability: "quotes", deadlineMs: 6000 }))).toEqual(["b", "a"]);
  });

  it("but is kept as the last resort when nothing else can answer", () => {
    const { router } = build({ accounts: ["a"], budgets: { a: { remaining: 0, limit: 10, resetMs: 5000 } } });
    expect(ids(router.select({ capability: "quotes", deadlineMs: 1000 }))).toEqual(["a"]);
  });

  it("a source that usually takes longer than the deadline is dropped", () => {
    const { router, health } = build({ accounts: ["z1"], sources: [DELAYED, EOD] });
    health.record("web-delayed", { ok: true, ms: 3000 });
    health.record("web-eod", { ok: true, ms: 100 });
    // the slow source is dropped, the quick one stays as the second attempt
    expect(ids(router.select(req({ deadlineMs: 500 })))).toEqual(["z1", "web-eod"]);
    expect(ids(router.select(req({ only: "sources", deadlineMs: 500 })))).toEqual(["web-eod"]);
    expect(ids(router.select(req({ only: "sources", deadlineMs: 5000 })))).toEqual(["web-delayed", "web-eod"]);
  });
});

describe("exploration", () => {
  it("a source with no history gets a neutral prior, slightly below proven ones", () => {
    const a = desc({ id: "src-a", name: "A" });
    const b = desc({ id: "src-b", name: "B" });
    const { router, health } = build({ accounts: [], sources: [a, b] });
    expect(ids(router.select(req({ only: "sources" })))).toEqual(["src-a", "src-b"]); // equal: config order
    for (let i = 0; i < 10; i += 1) health.record("src-b", { ok: true, ms: 50 });
    const plan = router.select(req({ only: "sources" }));
    expect(ids(plan)).toEqual(["src-b", "src-a"]);
    expect(plan[1].score).toBeCloseTo(0.9, 5);
    expect(plan[0].score).toBeGreaterThan(plan[1].score);
  });

  it("a new source still gets tried when it is the only one", () => {
    const { router } = build({ accounts: [], sources: [DELAYED] });
    expect(ids(router.select(req()))).toEqual(["web-delayed"]);
  });

  it("a proven-bad source loses to a new one", () => {
    const a = desc({ id: "src-a", name: "A" });
    const b = desc({ id: "src-b", name: "B" });
    const { router, health } = build({ accounts: [], sources: [a, b] });
    for (let i = 0; i < 12; i += 1) {
      health.record("src-a", { ok: i % 2 === 0, ms: 50, kind: "hard" });
    }
    expect(health.canTry("src-a")).toBe(true);
    expect(ids(router.select(req({ only: "sources" })))).toEqual(["src-b", "src-a"]);
  });
});

describe("only", () => {
  it("only: sources skips the broker accounts, only: brokers skips the sources", () => {
    const { router, accounts } = build({ sources: [DELAYED] });
    expect(ids(router.select(req({ only: "sources" })))).toEqual(["web-delayed"]);
    const before = accounts.calls.length;
    router.select(req({ only: "sources" }));
    expect(accounts.calls.length).toBe(before); // the accounts were not even asked
    expect(ids(router.select(req({ only: "brokers" })))).toEqual(["z1"]);
  });
});

describe("trace", () => {
  it("explains every source in plain words", () => {
    const { router } = build({
      accounts: ["a", "b"],
      sources: [DELAYED, EOD, REALTIME_UNOFFICIAL, desc({ id: "off", name: "Switched off" })],
      enabled: (id) => id !== "off",
      budgets: { a: { remaining: 9, limit: 10, resetMs: 0 }, b: { remaining: 4, limit: 10, resetMs: 0 } },
    });
    const t = router.trace({ capability: "quotes", purpose: "order", allowSources: true, symbols: ["NSE:RELIANCE"], maxAgeMs: 2000 });
    const byId = Object.fromEntries(t.considered.map((c) => [c.id, c]));
    expect(byId.a).toMatchObject({ kind: "broker", verdict: "chosen" });
    expect(byId.a.reason).toMatch(/^chosen: most spare budget/);
    expect(byId.b).toMatchObject({ verdict: "fallback" });
    expect(byId["web-delayed"]).toMatchObject({ verdict: "skipped", reason: "skipped: needs real-time, this source is delayed 15 min" });
    expect(byId["web-eod"].reason).toBe("skipped: needs real-time, this source only has end-of-day data");
    expect(byId["scrape-rt"].reason).toMatch(/^skipped: order reads accept only official real-time sources/);
    expect(byId.off.reason).toMatch(/switched off/);
    for (const c of t.considered) expect(c.health).toMatchObject({ state: expect.any(String), errorRate: expect.any(Number) });
    expect(t.class).toBe("realtime");
    expect(t.request).toMatchObject({ capability: "quotes", purpose: "order", symbols: ["NSE:RELIANCE"], maxAgeMs: 2000, allowBackup: true });
    expect(typeof t.note).toBe("string");
  });

  it("says when a breaker is open and until when", () => {
    const { router, health, advance } = build({ accounts: [], sources: [DELAYED, EOD] });
    for (let i = 0; i < 3; i += 1) health.record("web-delayed", { ok: false, ms: 5, kind: "hard" });
    advance(1000);
    const t = router.trace(req());
    const byId = Object.fromEntries(t.considered.map((c) => [c.id, c]));
    expect(byId["web-delayed"].reason).toMatch(/^skipped: breaker open until \d\d:\d\d IST/);
    expect(byId["web-delayed"].health).toMatchObject({ state: "open", lastError: { kind: "hard" } });
    expect(byId["web-eod"].verdict).toBe("chosen");
  });

  it("says a delayed source answered, and that it is labelled", () => {
    const { router } = build({ accounts: [], sources: [DELAYED] });
    const t = router.trace(req());
    expect(t.considered[0]).toMatchObject({ id: "web-delayed", verdict: "chosen" });
    expect(t.considered[0].reason).toMatch(/no real-time broker account can answer/);
    expect(t.considered[0].reason).toMatch(/delayed 15 min, not official/);
    expect(t.class).toBe("delayed");
    expect(t.note).toMatch(/delayed data/);
    expect(t.note).toMatch(/never use it/);
  });

  it("with nothing available says what to do", () => {
    const { router } = build({ accounts: [], sources: [DELAYED] });
    const t = router.trace(req({ purpose: "order" }));
    expect(t.class).toBeNull();
    expect(t.note).toMatch(/Nothing can answer/);
    expect(t.considered).toHaveLength(1);
    expect(t.considered[0].verdict).toBe("skipped");
  });

  it("when sources are not allowed the trace says how to allow them", () => {
    const { router } = build({ sources: [DELAYED] });
    const t = router.trace({ capability: "quotes", allowSources: false });
    const row = t.considered.find((c) => c.id === "web-delayed");
    expect(row.reason).toMatch(/backup=true|automatic fallback/);
    expect(t.request.allowBackup).toBe(false);
  });

  it("explains a breaker that has a probe in flight, a budget that is used up and a deadline", () => {
    const { router, health, advance } = build({ accounts: ["a", "b", "c"], budgets: { b: { remaining: 0, limit: 10, resetMs: 5000 } } });
    for (let i = 0; i < 3; i += 1) health.record("a", { ok: false, kind: "hard" });
    advance(15_000);
    health.claim("a");
    const t = router.trace({ capability: "quotes", deadlineMs: 1000 });
    const byId = Object.fromEntries(t.considered.map((c) => [c.id, c]));
    expect(byId.a.reason).toMatch(/probe call is already in flight/);
    expect(byId.b.reason).toMatch(/budget frees up in 5 s, later than the 1 s/);
    expect(byId.c.verdict).toBe("chosen");
  });

  it("a trace with the strict-purpose plugin and unofficial reasons names the cause", () => {
    const { router } = build({ accounts: [], sources: [PLUGIN_RT, REALTIME_UNOFFICIAL] });
    const t = router.trace(req({ purpose: "risk" }));
    const byId = Object.fromEntries(t.considered.map((c) => [c.id, c]));
    expect(byId["plug-rt"].reason).toMatch(/risk reads accept only official real-time sources, and this one is a plugin/);
    expect(byId["scrape-rt"].reason).toMatch(/not official/);
  });

  it("explains the maxAge skip", () => {
    const { router } = build({ accounts: [], sources: [DELAYED] });
    const t = router.trace(req({ maxAgeMs: 2000 }));
    expect(t.considered[0].reason).toBe("skipped: you asked for data at most 2 s old, and this source is delayed 15 min");
  });

  it("makes no upstream calls: only reads headroom and candidates", () => {
    const calls = [];
    const router = createSourceRouter({
      registry: { list: () => [{ descriptor: DELAYED, enabled: true }] },
      health: createHealthTracker(),
      scheduler: { headroom: (id, cls) => (calls.push(["headroom", id, cls]), { remaining: 5, limit: 10, resetMs: 0 }), schedule: () => calls.push(["schedule"]) },
      accounts: { marketDataCandidates: () => ["z1"], get: () => ({}) },
      clock: { now: () => T0 },
    });
    router.trace({ capability: "quotes", allowSources: true });
    expect(calls.some((c) => c[0] === "schedule")).toBe(false);
  });
});

describe("performance and hygiene", () => {
  it("select with 1000 symbols does not touch each symbol and stays fast", () => {
    const { router } = build({ accounts: ["a", "b", "c"], sources: [DELAYED, EOD] });
    const symbols = Array.from({ length: 1000 }, (_, i) => `NSE:S${i}`);
    router.select({ capability: "quotes", symbols, allowSources: true });
    const t0 = process.hrtime.bigint();
    const N = 2000;
    for (let i = 0; i < N; i += 1) router.select({ capability: "quotes", symbols, allowSources: true });
    const perCallUs = Number(process.hrtime.bigint() - t0) / 1000 / N;
    expect(perCallUs).toBeLessThan(250); // generous: it is a few microseconds on a laptop
  });

  it("the shared reasons arrays cannot be changed by a caller", () => {
    const { router } = build({ sources: [DELAYED] });
    const [broker, source] = router.select(req());
    expect(() => broker.reasons.push("x")).toThrow();
    expect(() => source.reasons.push("x")).toThrow();
  });
});
