/**
 * Test doubles for the fno sweep (fno/*.test.mjs): a fake account, a windowed scheduler view for the background gate,
 * a fake marketData that answers chains, quotes and history at once and records every call, a fake universe and a
 * fake symbols search. No network, no real timers (a manual clock drives every wait).
 */
import { createManualClock } from "../../ratelimit/fake.mjs";
import { parseFnoConfig } from "../config.mjs";
import { createSweepStore } from "../sweepStore.mjs";
import { createSweeper } from "../sweep.mjs";

export const T0 = Date.parse("2026-11-19T10:00:00+05:30");
export const STRIKES = Array.from({ length: 41 }, (_, i) => 1260 + i * 20);

/**
 * A scheduler stand-in with one sliding 1-second window per class (limit `perSecond`), shared by "quote" and "chain"
 * when `shared`. take() records usage at the clock's time; the lowest remaining after each take is kept.
 */
export function windowScheduler(clock, { perSecond = 10, shared = false, broker = "dhan", maxQuoteBatch = 100 } = {}) {
  const used = new Map();
  const bucket = (cls) => (shared && (cls === "quote" || cls === "chain") ? "group" : cls);
  const live = (cls) => (used.get(bucket(cls)) ?? []).filter((t) => clock.now() - t < 1000);
  let minRemaining = Infinity;
  const takes = [];
  const policy = { brokerId: broker, limits: { quote: { perSecond }, chain: { perSecond }, history: { perSecond } }, groups: shared ? { group: { perSecond, classes: ["quote", "chain"] } } : {}, maxQuoteBatch };
  return {
    policy,
    takes,
    minRemaining: () => minRemaining,
    take(cls, cost = 1, { background = true } = {}) {
      const list = live(cls);
      for (let i = 0; i < cost; i += 1) list.push(clock.now());
      used.set(bucket(cls), list);
      if (background) minRemaining = Math.min(minRemaining, perSecond - list.length);
      takes.push({ cls, cost, at: clock.now(), background });
    },
    headroom(_a, cls) {
      return { remaining: perSecond - live(cls).length, limit: perSecond, resetMs: 1000 };
    },
    headroomWindows(_a, cls) {
      const l = live(cls);
      const resetMs = l.length ? Math.max(1, 1000 - (clock.now() - l[0])) : 0;
      return { windows: [{ bucket: bucket(cls), window: "1s", used: l.length, queued: 0, limit: perSecond, remaining: perSecond - l.length, resetMs }], backoffMs: 0 };
    },
    policyFor: () => policy,
  };
}

/** Option legs for a key from the fake master. */
export const legRows = (u, e) => STRIKES.flatMap((k) => ["CE", "PE"].map((right) => ({ canonical: `NFO:${u}-${e}-${k}-${right}`, underlying: u, expiry: e, strike: k, right, kind: "OPT", lotSize: 500, tickSize: 0.05 })));

/**
 * @param {{ scheduler: ReturnType<typeof windowScheduler>, clock: any, fail?: (kind: string, args: any) => Error | null }} o
 */
export function fakeMarketData({ scheduler, clock, fail = () => null, oi = 50_000 }) {
  const calls = [];
  const take = (cls, cost, opts) => scheduler.take(cls, cost, { background: opts?.priority === "background" });
  return {
    calls,
    async optionChain(p, opts) {
      calls.push({ kind: "chain", p, opts, at: clock.now() });
      const e = fail("chain", p);
      if (e) throw e;
      if (opts?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      take("chain", 1, opts);
      const rows = STRIKES.slice(10, 31).map((k) => ({ strike: k, ce: { symbol: `NFO:${p.underlying}-${p.expiry}-${k}-CE`, ltp: 10, bid: 9.9, ask: 10.1, oi: 1000, oiChange: 50, volume: 1 }, pe: { symbol: `NFO:${p.underlying}-${p.expiry}-${k}-PE`, ltp: 10, bid: 9.9, ask: 10.1, oi: 1000, oiChange: null, volume: 1 } }));
      return { underlying: p.underlying, expiry: p.expiry, underlyingLtp: 1652.3, atmStrike: 1660, lotSize: 500, rows, freshness: { source: "broker" } };
    },
    async quotes(list, opts) {
      calls.push({ kind: "quote", n: list.length, opts, at: clock.now() });
      const e = fail("quote", list);
      if (e) throw e;
      take("quote", Math.ceil(list.length / scheduler.policy.maxQuoteBatch), opts);
      return { items: list.map((symbol) => ({ symbol, ltp: symbol.startsWith("NSE:") ? 1652.3 : 12, bid: 11.9, ask: 12.1, oi, volume: 10, close: 11, freshness: { source: "broker", accountId: "acc-1" } })), errors: [] };
    },
    async history(p, opts) {
      calls.push({ kind: "history", p, opts, at: clock.now() });
      take("history", 1, opts);
      const closes = Array.from({ length: 40 }, (_, i) => 100 * Math.exp(0.01 * Math.sin(i)));
      return { candles: closes.map((close, i) => ({ time: i, open: close, high: close, low: close, close })) };
    },
  };
}

export function fakeUniverse({ indices = ["NIFTY"], stocks = ["RELIANCE", "SBIN"] } = {}) {
  const exp = { NIFTY: ["2026-11-24", "2026-12-01", "2026-12-29"] };
  return {
    names: async () => ({ indices, stocks }),
    facts: async (u) => ({ expiries: exp[u] ?? ["2026-11-23", "2026-12-29"], strikeStep: 20 }),
    list: async () => ({ items: [...indices, ...stocks].map((u) => ({ underlying: u, spot: `NSE:${u}` })) }),
  };
}

export const fakeSymbols = () => ({
  async search(q) {
    return { items: q.kind === "OPT" ? legRows(q.underlying, q.expiry) : [], nextCursor: null };
  },
});

export const fakeAccounts = (broker = "dhan") => ({
  marketDataCandidates: () => ["acc-1"],
  get: () => ({ id: "acc-1", broker }),
  capabilities: () => ({ capabilities: ["quotes", "optionChain", "historical"] }),
});

/** A sweeper wired to the fakes. */
export function sweepHarness({ cfg = {}, dir = null, clock = createManualClock(T0), perSecond = 10, shared = false, broker = "dhan", fail, universe, bus, maxQuoteBatch, symbols, recorder, backupData, oi, reference: refExtra = {} } = {}) {
  const scheduler = windowScheduler(clock, { perSecond, shared, broker, maxQuoteBatch });
  const marketData = fakeMarketData({ scheduler, clock, fail, oi });
  const events = [];
  const store = createSweepStore(dir, { now: () => clock.now(), memory: !dir });
  const reference = { session: () => ({ state: "OPEN", open: "09:15", close: "15:30" }), rate: () => ({ value: 0.065 }), ...refExtra };
  const sweeper = createSweeper({
    cfg: parseFnoConfig(cfg),
    clock,
    scheduler,
    accounts: fakeAccounts(broker),
    marketData,
    symbols: symbols ?? fakeSymbols(),
    reference,
    recorder,
    backupData,
    universe: universe ?? fakeUniverse(),
    store,
    bus: bus ?? { emit: (topic, payload) => events.push({ topic, payload, at: clock.now() }) },
  });
  /** Let the run make progress: advance the manual clock in small steps until idle (or `maxMs`). */
  const settle = async (maxMs = 120_000, step = 50) => {
    let done = false;
    sweeper.idle().then(() => {
      done = true;
    });
    for (let t = 0; t < maxMs && !done; t += step) await clock.advance(step);
    await sweeper.idle();
  };
  return { clock, scheduler, marketData, store, sweeper, events, settle };
}
