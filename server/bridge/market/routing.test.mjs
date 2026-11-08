/**
 * MarketDataService with the source router: purposes (orders, risk, paper and alerts are never answered from a delayed
 * source, a stale value or a refresh in progress), failover between pooled brokers and to a labelled data source,
 * health recording and ejection, the failure cache, and the original backup seam when only deps.backupData exists.
 * Published fakes only; no network, no sleeps.
 */
import { describe, expect, it } from "vitest";
import { BridgeError } from "../core/errors.mjs";
import { T0, buildMarket, priceForToken, stubAdapter } from "./__fixtures__/helpers.mjs";
import { createMarketDataService } from "./marketDataService.mjs";

const POOLED = { zerodha: { pooling: "allowed" }, dhan: { pooling: "allowed" } };

/** A BackupDataService facade double that answers with 15-minute-old data and records every call. */
function fakeBackup({ rows, delaySec = 900, fail } = {}) {
  const calls = [];
  // A facade with a management list() serves the source it was asked for; a bare one has its own provider name.
  const provider = (opts) => (rows ? opts?.sourceId : undefined) ?? "web-delayed";
  const at = () => T0 - delaySec * 1000;
  const svc = {
    calls,
    autoFallback: () => false,
    status: () => ({ enabled: true }),
    async quotes(symbols, opts) {
      calls.push(["quotes", [...symbols], opts]);
      if (fail) throw fail;
      return { items: symbols.map((symbol) => ({ symbol, fields: { ltp: 77.7 }, at: at(), provider: provider(opts) })), errors: [] };
    },
    async history(req, opts) {
      calls.push(["history", req, opts]);
      if (fail) throw fail;
      return { symbol: req.symbol, interval: req.interval, candles: [{ time: Math.floor(T0 / 1000) - 3600, open: 1, high: 2, low: 1, close: 2, volume: 10 }], partial: false, provider: provider(opts), at: at() };
    },
    async expiries(underlying, opts) {
      calls.push(["expiries", underlying, opts]);
      if (fail) throw fail;
      return { underlying, expiries: ["2026-10-27"], provider: provider(opts), at: at() };
    },
    async optionChain(underlying, expiry, opts) {
      calls.push(["optionChain", underlying, expiry, opts]);
      if (fail) throw fail;
      return { underlying, expiry, underlyingLtp: 25000, rows: [{ strike: 25000, ce: { ltp: 100 }, pe: { ltp: 90 } }], provider: provider(opts), at: at() };
    },
  };
  if (rows) svc.list = () => rows;
  return svc;
}

const failing = (code = "UPSTREAM_ERROR", message = "upstream down") => async () => {
  const e = new Error(message);
  e.code = code;
  throw e;
};

function failingAdapter(id, code) {
  return stubAdapter(id, {
    overrides: {
      fetchQuotes: failing(code),
      fetchLTP: failing(code),
      fetchDepth: failing(code),
      fetchHistorical: failing(code),
      fetchExpiryList: failing(code),
      fetchOptionChain: failing(code),
    },
  });
}

/** Drive the manual clock until `p` settles: a failover starts a second batch window after the first. */
async function drive(clock, p) {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 40 && !done; i += 1) await clock.advance(30);
  return p;
}

/** Two pooled brokers (zerodha-main first), a facade, and the service built over them. */
function pooled({ backup, zerodha, dhan, market } = {}) {
  const z = zerodha ?? stubAdapter("zerodha");
  const d = dhan ?? stubAdapter("dhan");
  const base = buildMarket({
    market,
    policies: POOLED,
    accounts: [
      { id: "zerodha-main", broker: "zerodha", adapter: z, creds: { apiKey: "k" }, pooling: true },
      { id: "dhan-main", broker: "dhan", adapter: d, creds: { clientId: "1" }, pooling: true },
    ],
  });
  const md = backup ? createMarketDataService({ ...base.deps, backupData: backup }) : base.md;
  return { ...base, md, zerodha: z, dhan: d, backup, settle: (p) => drive(base.clock, p) };
}

/** One broker account plus a facade. */
function single({ backup, zerodha, market } = {}) {
  const z = zerodha ?? stubAdapter("zerodha");
  const base = buildMarket({ market, accounts: [{ id: "zerodha-main", broker: "zerodha", adapter: z, creds: { apiKey: "k" } }] });
  const md = backup ? createMarketDataService({ ...base.deps, backupData: backup }) : base.md;
  return { ...base, md, zerodha: z, backup, settle: (p) => drive(base.clock, p) };
}

const quoteCalls = (adapter) => adapter.calls.filter((c) => c[0] === "fetchQuotes");
const rlThrottle = (scheduler, accountId) => scheduler.throttle(accountId, "quote", 600_000);

describe("purpose option", () => {
  it("accepts every purpose and defaults to display; rejects others", async () => {
    const { md, settle } = single();
    for (const purpose of ["display", "analysis", "alert", "paper", "risk", "order"]) {
      const r = await settle(md.ltp(["NSE:RELIANCE"], { purpose, maxAgeMs: 0 }));
      expect(r.items).toHaveLength(1);
    }
    await expect(md.ltp(["NSE:RELIANCE"], { purpose: "trading" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("orders, risk, paper and alerts are never answered from a delayed source", () => {
  for (const purpose of ["order", "risk", "paper", "alert"]) {
    it(`${purpose}: a failing broker with a backup allowed still ends in an error, and the backup is never asked`, async () => {
      const backup = fakeBackup();
      const { md, settle } = single({ backup, zerodha: failingAdapter("zerodha", "UPSTREAM_ERROR") });
      const opts = { purpose, allowBackup: true };
      const q = await settle(md.quotes(["NSE:RELIANCE"], opts));
      expect(q.items).toEqual([]);
      expect(q.errors[0]).toMatchObject({ code: "UPSTREAM_ERROR" });
      const l = await settle(md.ltp(["NSE:INFY"], opts));
      expect(l.items).toEqual([]);
      await expect(md.history({ symbol: "NSE:NIFTY", interval: "1d", countback: 5 }, opts)).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
      await expect(md.expiries("ZZTEST", opts)).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
      await expect(md.optionChain({ underlying: "NIFTY", expiry: "2026-10-27" }, opts)).rejects.toBeTruthy();
      expect(backup.calls).toEqual([]);
    });

    it(`${purpose}: with no broker account at all it fails rather than use a delayed source`, async () => {
      const backup = fakeBackup();
      const base = buildMarket({ accounts: [] });
      const md = createMarketDataService({ ...base.deps, backupData: backup });
      const r = await base.settle(md.quotes(["NSE:RELIANCE"], { purpose, allowBackup: true }));
      expect(r.items).toEqual([]);
      expect(r.errors[0].code).toBe("BROKER_UNAVAILABLE");
      expect(backup.calls).toEqual([]);
    });

    it(`${purpose}: never serves a stale cached value or starts a stale-while-revalidate refresh`, async () => {
      const { md, settle, clock, scheduler, zerodha } = single();
      await settle(md.quotes(["NSE:RELIANCE"]));
      await clock.advance(10_000); // older than the quote target (2 s), inside the 60 s stale window
      rlThrottle(scheduler, "zerodha-main");
      const display = await settle(md.quotes(["NSE:RELIANCE"]));
      expect(display.items[0].freshness).toMatchObject({ source: "cache", stale: true });
      const strict = await settle(md.quotes(["NSE:RELIANCE"], { purpose }));
      expect(strict.items).toEqual([]);
      expect(strict.errors[0].code).toBe("UPSTREAM_RATE_LIMITED");
      scheduler.reset();
      const swr = await settle(md.quotes(["NSE:RELIANCE"], { purpose, staleWhileRevalidate: true }));
      expect(swr.items[0].freshness.source).toBe("broker"); // read live, not answered from the old value
      expect(swr.items[0].freshness.revalidating).toBeUndefined();
      expect(quoteCalls(zerodha).length).toBeGreaterThanOrEqual(2);
    });
  }

  it("the same failure for a display read does use the backup, and says what it is", async () => {
    const backup = fakeBackup();
    const { md, settle } = single({ backup, zerodha: failingAdapter("zerodha", "UPSTREAM_ERROR") });
    const r = await settle(md.quotes(["NSE:RELIANCE"], { purpose: "display", allowBackup: true }));
    expect(r.errors).toEqual([]);
    expect(r.items[0]).toMatchObject({ symbol: "NSE:RELIANCE", ltp: 77.7 });
    expect(r.items[0].freshness).toMatchObject({ source: "backup", provider: "web-delayed", class: "delayed", delaySec: 900, official: false, confidence: "low", stale: false, accountId: null });
    expect(r.items[0].freshness.flags).toEqual([]);
    expect(backup.calls).toHaveLength(1);
    expect(backup.calls[0][2]).toMatchObject({ sourceId: "backup" });
  });

  it("an order read that a broker answers is unaffected by purpose", async () => {
    const { md, settle } = single({ backup: fakeBackup() });
    const r = await settle(md.ltp(["NSE:RELIANCE"], { purpose: "order", allowBackup: true }));
    expect(r.items[0]).toMatchObject({ ltp: priceForToken("Z3") });
    expect(r.items[0].freshness.source).toBe("broker");
  });
});

describe("data sources as router-chosen fallback", () => {
  it("only allowBackup reads reach a source; the default read does not", async () => {
    const backup = fakeBackup();
    const { md, settle } = single({ backup, zerodha: failingAdapter("zerodha", "UPSTREAM_ERROR") });
    const r = await settle(md.ltp(["NSE:RELIANCE"]));
    expect(r.items).toEqual([]);
    expect(backup.calls).toEqual([]);
  });

  it("maxAgeMs stricter than the source's delay keeps it out", async () => {
    const backup = fakeBackup();
    const { md, settle } = single({ backup, zerodha: failingAdapter("zerodha", "UPSTREAM_ERROR") });
    const r = await settle(md.ltp(["NSE:RELIANCE"], { allowBackup: true, maxAgeMs: 2000 }));
    expect(r.items).toEqual([]);
    expect(backup.calls).toEqual([]);
    const ok = await settle(md.ltp(["NSE:INFY"], { allowBackup: true, maxAgeMs: 20 * 60_000 }));
    expect(ok.items[0].freshness).toMatchObject({ source: "backup", class: "delayed" });
  });

  it("never blends: each symbol of one read comes from exactly one source, labelled on its own", async () => {
    const z = stubAdapter("zerodha", {
      overrides: {
        async fetchQuotes(creds, refs) {
          if (refs.some((r) => r.token === "Z4")) throw Object.assign(new Error("down"), { code: "UPSTREAM_ERROR" });
          return { status: "success", data: refs.map((r) => ({ token: r.token, exchange: r.exchange, ltp: priceForToken(r.token), open: null, high: null, low: null, close: null, volume: null, oi: null, bid: null, ask: null })) };
        },
      },
    });
    const { md, settle, scheduler } = single({ backup: fakeBackup(), zerodha: z });
    scheduler.policyFor = (id) => ({ maxQuoteBatch: 1, limits: {}, feed: {}, pooling: "unknown", brokerId: id });
    const r = await settle(md.ltp(["NSE:RELIANCE", "NSE:INFY"], { allowBackup: true }));
    expect(r.errors).toEqual([]);
    const by = Object.fromEntries(r.items.map((i) => [i.symbol, i]));
    expect(by["NSE:RELIANCE"]).toMatchObject({ ltp: priceForToken("Z3") });
    expect(by["NSE:RELIANCE"].freshness).toMatchObject({ source: "broker", accountId: "zerodha-main" });
    expect(by["NSE:RELIANCE"].freshness.provider).toBeUndefined();
    expect(by["NSE:INFY"]).toMatchObject({ ltp: 77.7 });
    expect(by["NSE:INFY"].freshness).toMatchObject({ source: "backup", provider: "web-delayed", class: "delayed", accountId: null, broker: null });
  });

  it("a data source answers first when no broker account can", async () => {
    const backup = fakeBackup();
    const base = buildMarket({ accounts: [] });
    const md = createMarketDataService({ ...base.deps, backupData: backup });
    const r = await base.settle(md.quotes(["NSE:RELIANCE"], { allowBackup: true }));
    expect(r.items[0].freshness).toMatchObject({ source: "backup", provider: "web-delayed", class: "delayed" });
    expect(md.stats().backup).toBe(1);
  });

  it("a data source goes first when every broker is out of budget, and a stale cached value still beats it", async () => {
    const backup = fakeBackup();
    const { md, settle, scheduler, zerodha, clock } = single({ backup });
    await settle(md.quotes(["NSE:INFY"])); // cached
    await clock.advance(10_000);
    rlThrottle(scheduler, "zerodha-main");
    const r = await settle(md.quotes(["NSE:INFY", "NSE:RELIANCE"], { allowBackup: true }));
    const bySymbol = Object.fromEntries(r.items.map((i) => [i.symbol, i]));
    expect(bySymbol["NSE:INFY"].freshness).toMatchObject({ source: "cache", stale: true }); // stale realtime beats delayed
    expect(bySymbol["NSE:RELIANCE"].freshness).toMatchObject({ source: "backup", class: "delayed" });
    expect(backup.calls).toHaveLength(1);
    expect(backup.calls[0][1]).toEqual(["NSE:RELIANCE"]);
    expect(quoteCalls(zerodha)).toHaveLength(1); // only the first, cached read
  });

  it("history: the source is chosen through the router and labelled (not cached)", async () => {
    const backup = fakeBackup();
    const { md } = single({ backup, zerodha: failingAdapter("zerodha", "UPSTREAM_ERROR") });
    const h = await md.history({ symbol: "NSE:NIFTY", interval: "1d", countback: 5 }, { allowBackup: true });
    expect(h.freshness).toMatchObject({ source: "backup", provider: "web-delayed", class: "delayed", delaySec: 900, official: false });
    expect(backup.calls[0][0]).toBe("history");
    expect(backup.calls[0][1]).toMatchObject({ symbol: "NSE:NIFTY", interval: "1d", sourceId: "backup" });
    expect(md.cache.size).toBe(0);
  });

  it("history: a source takes it when no broker offers the interval, and the broker explains if the source fails", async () => {
    const dailyOnly = stubAdapter("zerodha", { capabilities: { auth: { kind: "apiKeyToken" }, testConnection: true, quotes: true, ltp: true, historical: { intervals: ["1d"] } } });
    const backup = fakeBackup();
    const { md, zerodha } = single({ backup, zerodha: dailyOnly });
    const h = await md.history({ symbol: "NSE:NIFTY", interval: "5m", countback: 3 }, { allowBackup: true });
    expect(h.freshness.source).toBe("backup");
    expect(zerodha.calls.filter((c) => c[0] === "fetchHistorical")).toEqual([]);
    // without backup the broker's own explanation comes back
    const noBackup = single({ zerodha: dailyOnly });
    await expect(noBackup.md.history({ symbol: "NSE:NIFTY", interval: "5m", countback: 3 })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    // source also fails: the caller still gets the broker's explanation, not the source's error
    const bad = single({ backup: fakeBackup({ fail: new BridgeError("UPSTREAM_ERROR", "source down") }), zerodha: dailyOnly });
    await expect(bad.md.history({ symbol: "NSE:NIFTY", interval: "5m", countback: 3 }, { allowBackup: true })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  });

  it("expiries: falls back to a labelled source when the broker fails and the master has none", async () => {
    const backup = fakeBackup();
    const { md } = single({ backup, zerodha: failingAdapter("zerodha", "UPSTREAM_ERROR") });
    // an underlying the instrument master does not list
    const e = await md.expiries("ZZTEST", { allowBackup: true });
    expect(e.expiries).toEqual(["2026-10-27"]);
    expect(e.freshness).toMatchObject({ source: "backup", provider: "web-delayed", class: "delayed" });
  });

  it("option chain: falls back to a labelled source", async () => {
    const backup = fakeBackup();
    const { md } = single({ backup, zerodha: failingAdapter("zerodha", "UPSTREAM_ERROR"), market: { chain: { source: "broker" } } });
    const c = await md.optionChain({ underlying: "NIFTY", expiry: "2026-10-27" }, { allowBackup: true });
    expect(c.freshness).toMatchObject({ source: "backup", class: "delayed", official: false });
    expect(c.underlyingLtp).toBe(25000);
    expect(backup.calls[0][0]).toBe("optionChain");
  });

  it("a source failure leaves the original broker error in place", async () => {
    const backup = fakeBackup({ fail: new BridgeError("UPSTREAM_ERROR", "source down") });
    const { md, settle } = single({ backup, zerodha: failingAdapter("zerodha", "UPSTREAM_ERROR") });
    const r = await settle(md.ltp(["NSE:RELIANCE"], { allowBackup: true }));
    expect(r.items).toEqual([]);
    expect(r.errors[0]).toMatchObject({ code: "UPSTREAM_ERROR", message: "upstream down" });
  });

  it("a source that does not know the symbol is remembered as not-found, so it is not asked again", async () => {
    const backup = fakeBackup();
    backup.quotes = async (symbols, opts) => {
      backup.calls.push(["quotes", [...symbols], opts]);
      return { items: [], errors: [] };
    };
    const base = buildMarket({ accounts: [] });
    const md = createMarketDataService({ ...base.deps, backupData: backup });
    const r1 = await base.settle(md.ltp(["NSE:RELIANCE"], { allowBackup: true }));
    expect(r1.errors[0].code).toBe("SYMBOL_NOT_FOUND");
    const r2 = await base.settle(md.ltp(["NSE:RELIANCE"], { allowBackup: true }));
    expect(r2.errors[0].code).toBe("SYMBOL_NOT_FOUND");
    expect(backup.calls).toHaveLength(1);
  });

  it("a pinned read never moves to another account or to a source", async () => {
    const backup = fakeBackup();
    const { md, settle, dhan, scheduler } = pooled({ backup, zerodha: failingAdapter("zerodha", "UPSTREAM_ERROR") });
    const r = await settle(md.ltp(["NSE:RELIANCE"], { accountId: "zerodha-main", allowBackup: true }));
    expect(r.items).toEqual([]);
    expect(r.errors[0].code).toBe("UPSTREAM_ERROR");
    expect(backup.calls).toEqual([]);
    expect(quoteCalls(dhan)).toHaveLength(0);
    expect(scheduler.calls.map((c) => c.accountId)).toEqual(["zerodha-main"]); // the pinned account only
  });
});

describe("failover between pooled brokers", () => {
  it("a failing first account is followed by the next, each called once (failover is the retry)", async () => {
    const z = failingAdapter("zerodha", "UPSTREAM_ERROR");
    let zCalls = 0;
    const base = z.fetchQuotes;
    z.fetchQuotes = async (...a) => {
      zCalls += 1;
      return base(...a);
    };
    const { md, settle, dhan, scheduler } = pooled({ zerodha: z });
    const r = await settle(md.quotes(["NSE:RELIANCE"]));
    expect(r.errors).toEqual([]);
    expect(r.items[0].freshness).toMatchObject({ source: "broker", accountId: "dhan-main", broker: "dhan" });
    expect(zCalls).toBe(1);
    expect(quoteCalls(dhan)).toHaveLength(1);
    expect(scheduler.calls.map((c) => c.accountId)).toEqual(["zerodha-main", "dhan-main"]);
  });

  it("a 429 on the first account is not retried there: the second account answers", async () => {
    const z = failingAdapter("zerodha", "UPSTREAM_RATE_LIMITED");
    const { md, settle, dhan, scheduler } = pooled({ zerodha: z });
    const r = await settle(md.ltp(["NSE:RELIANCE"]));
    expect(r.items[0].freshness.accountId).toBe("dhan-main");
    expect(scheduler.calls.filter((c) => c.accountId === "zerodha-main")).toHaveLength(1);
    expect(quoteCalls(dhan)).toHaveLength(1);
  });

  it("at most two attempts: both failing ends in the first error, with no third call", async () => {
    const { md, settle, scheduler } = pooled({ zerodha: failingAdapter("zerodha", "UPSTREAM_ERROR"), dhan: failingAdapter("dhan", "UPSTREAM_TIMEOUT") });
    const r = await settle(md.ltp(["NSE:RELIANCE"]));
    expect(r.items).toEqual([]);
    expect(r.errors[0].code).toBe("UPSTREAM_ERROR");
    expect(scheduler.calls).toHaveLength(2);
  });

  it("an error a source cannot fix is not failed over (validation of the symbol stays validation)", async () => {
    const { md, settle, scheduler } = pooled();
    const r = await settle(md.ltp(["NOT A SYMBOL"]));
    expect(r.errors[0].code).toBe("VALIDATION_FAILED");
    expect(scheduler.calls).toEqual([]);
  });

  it("the best account is chosen by spare budget and recorded health, not config order", async () => {
    const { md, settle, scheduler, dhan, zerodha } = pooled();
    const real = scheduler.headroom;
    scheduler.headroom = (id, cls) => (id === "zerodha-main" ? { remaining: 1, limit: 100, resetMs: 500 } : real(id, cls));
    const r = await settle(md.ltp(["NSE:RELIANCE"], { maxAgeMs: 0 }));
    expect(r.items[0].freshness.accountId).toBe("dhan-main");
    expect(quoteCalls(dhan)).toHaveLength(1);
    expect(quoteCalls(zerodha)).toHaveLength(0);
  });
});

describe("health and ejection", () => {
  it("records every real broker call, with the elapsed time, and shows it in the shared tracker", async () => {
    const { md, settle } = single();
    await settle(md.ltp(["NSE:RELIANCE"]));
    const s = md.sourceHealth.state("zerodha-main");
    expect(s.state).toBe("ok");
    expect(md.sourceHealth.samples("zerodha-main")).toBe(1);
  });

  it("three hard failures in a row eject the account: the next read goes to the other one first", async () => {
    const { md, settle, clock, scheduler } = pooled({ zerodha: failingAdapter("zerodha", "UPSTREAM_ERROR") });
    for (let i = 0; i < 3; i += 1) {
      // pinned reads reach the account whatever its score, so these are three real failures in a row
      await settle(md.ltp(["NSE:RELIANCE"], { accountId: "zerodha-main", maxAgeMs: 0 }));
      await clock.advance(3000); // past the failure cache's 2 s
    }
    expect(md.sourceHealth.state("zerodha-main").state).toBe("open");
    scheduler.reset();
    const r = await settle(md.ltp(["NSE:RELIANCE"], { maxAgeMs: 0 }));
    expect(r.items[0].freshness.accountId).toBe("dhan-main");
    expect(scheduler.calls.map((c) => c.accountId)).toEqual(["dhan-main"]); // the ejected account is not even tried
  });

  it("a failing account is tried less as its error rate rises, before it is ejected", async () => {
    const { md, settle, clock, scheduler } = pooled({ zerodha: failingAdapter("zerodha", "UPSTREAM_ERROR") });
    await settle(md.ltp(["NSE:RELIANCE"], { maxAgeMs: 0 })); // zerodha first (config order), fails, dhan answers
    await clock.advance(3000);
    scheduler.reset();
    await settle(md.ltp(["NSE:RELIANCE"], { maxAgeMs: 0 }));
    expect(scheduler.calls.map((c) => c.accountId)).toEqual(["dhan-main"]);
  });

  it("after the cooldown one probe goes through, and a success closes the breaker", async () => {
    const z = stubAdapter("zerodha");
    let broken = true;
    const real = z.fetchQuotes;
    z.fetchQuotes = async (...a) => (broken ? failing("UPSTREAM_ERROR")() : real(...a));
    const { md, settle, clock } = single({ zerodha: z });
    for (let i = 0; i < 3; i += 1) {
      await settle(md.ltp(["NSE:RELIANCE"], { maxAgeMs: 0 }));
      await clock.advance(3000);
    }
    expect(md.sourceHealth.canTry("zerodha-main")).toBe(false);
    broken = false;
    await clock.advance(20_000); // past the cooldown (15 s +-20%)
    const probe = await settle(md.ltp(["NSE:RELIANCE"], { maxAgeMs: 0 }));
    expect(probe.items[0].freshness.accountId).toBe("zerodha-main");
    expect(md.sourceHealth.canTry("zerodha-main")).toBe(true);
    expect(["ok", "degraded"]).toContain(md.sourceHealth.state("zerodha-main").state);
  });

  it("429s never eject an account", async () => {
    const { md, settle, clock } = pooled({ zerodha: failingAdapter("zerodha", "UPSTREAM_RATE_LIMITED") });
    for (let i = 0; i < 8; i += 1) {
      await settle(md.ltp(["NSE:RELIANCE"], { maxAgeMs: 0 }));
      await clock.advance(3000);
    }
    expect(md.sourceHealth.canTry("zerodha-main")).toBe(true);
    expect(md.sourceHealth.errorRate("zerodha-main")).toBe(0);
  });

  it("a single broker is never fully ejected: one probe at a time keeps the read honest", async () => {
    const { md, settle, clock } = single({ zerodha: failingAdapter("zerodha", "UPSTREAM_ERROR") });
    for (let i = 0; i < 3; i += 1) {
      await settle(md.ltp(["NSE:RELIANCE"], { maxAgeMs: 0 }));
      await clock.advance(3000);
    }
    expect(md.sourceHealth.state("zerodha-main").state).toBe("open");
    const r = await settle(md.ltp(["NSE:RELIANCE"], { maxAgeMs: 0 }));
    // the router lets one forced probe through, and it fails like the others
    expect(r.errors[0].code).toBe("UPSTREAM_ERROR");
    const r2 = await settle(md.ltp(["NSE:RELIANCE"], { maxAgeMs: 0 }));
    expect(r2.errors[0].code).toBe("BROKER_UNAVAILABLE"); // within 5 s of the probe: nothing is sent
  });

  it("source calls are recorded under the source id, and a 429 from a source is neutral", async () => {
    const backup = fakeBackup({ fail: new BridgeError("UPSTREAM_RATE_LIMITED", "slow down") });
    const base = buildMarket({ accounts: [] });
    const md = createMarketDataService({ ...base.deps, backupData: backup });
    for (let i = 0; i < 5; i += 1) await base.settle(md.ltp(["NSE:RELIANCE"], { allowBackup: true }));
    expect(md.sourceHealth.state("backup")).toMatchObject({ state: "ok", errorRate: 0, lastError: { kind: "rate-limit" } });
    const hard = fakeBackup({ fail: new BridgeError("UPSTREAM_ERROR", "down") });
    const md2 = createMarketDataService({ ...base.deps, backupData: hard });
    for (let i = 0; i < 3; i += 1) {
      await base.settle(md2.ltp([`NSE:STK0${i + 1}`], { allowBackup: true }));
    }
    expect(md2.sourceHealth.state("backup").state).toBe("open");
  });
});

describe("failure cache", () => {
  it("a failing symbol is not sent to the same account again for a moment, then it is", async () => {
    const z = failingAdapter("zerodha", "UPSTREAM_ERROR");
    let calls = 0;
    const real = z.fetchQuotes;
    z.fetchQuotes = async (...a) => {
      calls += 1;
      return real(...a);
    };
    const { md, settle, clock } = single({ zerodha: z });
    await settle(md.ltp(["NSE:RELIANCE"], { maxAgeMs: 0 }));
    expect(calls).toBe(1);
    await clock.advance(500);
    const again = await settle(md.ltp(["NSE:RELIANCE"], { maxAgeMs: 0 }));
    expect(again.errors[0]).toMatchObject({ code: "UPSTREAM_ERROR", message: "upstream down" });
    expect(calls).toBe(1); // answered from the failure cache
    await clock.advance(3000);
    await settle(md.ltp(["NSE:RELIANCE"], { maxAgeMs: 0 }));
    expect(calls).toBe(2);
  });

  it("a symbol the broker does not know is remembered for 10 minutes", async () => {
    const { md, settle, clock, symbols } = single();
    let lookups = 0;
    const real = symbols.toBroker.bind(symbols);
    symbols.toBroker = async (...a) => {
      lookups += 1;
      return real(...a);
    };
    const first = await settle(md.ltp(["NSE:UNKNOWNCO"]));
    expect(first.errors[0].code).toBe("SYMBOL_NOT_FOUND");
    expect(lookups).toBe(1);
    await clock.advance(5 * 60_000);
    const second = await settle(md.ltp(["NSE:UNKNOWNCO"]));
    expect(second.errors[0].code).toBe("SYMBOL_NOT_FOUND");
    expect(lookups).toBe(1);
    await clock.advance(6 * 60_000);
    await settle(md.ltp(["NSE:UNKNOWNCO"]));
    expect(lookups).toBe(2);
  });

  it("a 429 is not cached: the next read tries again", async () => {
    const { md, settle, scheduler, zerodha } = single();
    scheduler.throttle("zerodha-main", "quote", 100);
    const first = await settle(md.ltp(["NSE:RELIANCE"], { maxAgeMs: 0 }));
    expect(first.errors[0].code).toBe("UPSTREAM_RATE_LIMITED");
    scheduler.reset();
    const second = await settle(md.ltp(["NSE:RELIANCE"], { maxAgeMs: 0 }));
    expect(second.items).toHaveLength(1);
    expect(quoteCalls(zerodha)).toHaveLength(1);
  });

  it("depth failures are remembered too", async () => {
    const z = failingAdapter("zerodha", "UPSTREAM_ERROR");
    let calls = 0;
    const real = z.fetchDepth;
    z.fetchDepth = async (...a) => {
      calls += 1;
      return real(...a);
    };
    const { md } = single({ zerodha: z });
    await expect(md.depth("NSE:RELIANCE")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    await expect(md.depth("NSE:RELIANCE")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(calls).toBe(1);
  });
});

describe("the original backup seam", () => {
  it("works with only deps.backupData: a bare facade is one delayed, unofficial backup source", async () => {
    const backup = fakeBackup();
    const base = buildMarket({ accounts: [] });
    const md = createMarketDataService({ ...base.deps, backupData: backup });
    const r = await base.settle(md.ltp(["NSE:RELIANCE"], { allowBackup: true }));
    expect(r.items[0]).toMatchObject({ symbol: "NSE:RELIANCE", ltp: 77.7 });
    expect(r.items[0].freshness).toMatchObject({ source: "backup", provider: "web-delayed", stale: false });
    expect(r.items[0].freshness).toMatchObject({ class: "delayed", delaySec: 900, official: false });
  });

  it("without allowBackup nothing changes: the read fails as before", async () => {
    const base = buildMarket({ accounts: [] });
    const md = createMarketDataService({ ...base.deps, backupData: fakeBackup() });
    const r = await base.settle(md.ltp(["NSE:RELIANCE"]));
    expect(r.items).toEqual([]);
    expect(r.errors[0].code).toBe("BROKER_UNAVAILABLE");
  });

  it("a facade with the management list() is routed by its rows: class, delay and official flag come from them", async () => {
    const rows = [
      { id: "vendor-eod", name: "Vendor end of day", kind: "free", tier: "byok", enabled: true, configured: true, needsKey: true, class: "eod", official: true, capabilities: ["quotes", "history"], limits: { perDay: 25 } },
      { id: "off-source", name: "Off", kind: "free", tier: "opt-in", enabled: false, class: "delayed", delaySec: 900, capabilities: ["quotes"], limits: { perMinute: 1 } },
    ];
    const backup = fakeBackup({ rows });
    const base = buildMarket({ accounts: [] });
    const md = createMarketDataService({ ...base.deps, backupData: backup });
    const r = await base.settle(md.ltp(["NSE:RELIANCE"], { allowBackup: true }));
    expect(r.items[0].freshness).toMatchObject({ source: "backup", provider: "vendor-eod", class: "eod", official: true, confidence: "medium", delaySec: null });
    expect(backup.calls[0][2].sourceId).toBe("vendor-eod");
  });

  it("labels an answer by the provider that really answered, not the one the router picked", async () => {
    const rows = [
      { id: "src-a", name: "A", kind: "free", tier: "opt-in", enabled: true, class: "delayed", delaySec: 900, official: false, capabilities: ["quotes"], limits: { perMinute: 1 } },
      { id: "src-b", name: "B", kind: "free", tier: "byok", enabled: true, configured: true, class: "eod", official: true, capabilities: ["quotes"], limits: { perDay: 1 } },
    ];
    const base = buildMarket({ accounts: [] });
    const answers = (provider) => ({
      ...fakeBackup({ rows }),
      async quotes(symbols) {
        return { items: symbols.map((symbol) => ({ symbol, fields: { ltp: 5 }, at: T0 - 60_000, provider })), errors: [] };
      },
    });
    const known = createMarketDataService({ ...base.deps, backupData: answers("src-b") });
    const r1 = await base.settle(known.ltp(["NSE:RELIANCE"], { allowBackup: true }));
    expect(r1.items[0].freshness).toMatchObject({ provider: "src-b", class: "eod", official: true });
    const unknown = createMarketDataService({ ...base.deps, backupData: answers("mystery") });
    const r2 = await base.settle(unknown.ltp(["NSE:INFY"], { allowBackup: true }));
    expect(r2.items[0].freshness).toMatchObject({ provider: "mystery", class: "delayed", official: false });
  });

  it("an injected router, health tracker and registry are used when provided", async () => {
    const seen = [];
    const router = { select: (req) => (seen.push(req), []), trace: () => ({}) };
    const base = buildMarket({});
    const md = createMarketDataService({ ...base.deps, sourceRouter: router });
    const r = await base.settle(md.ltp(["NSE:RELIANCE"]));
    expect(r.items).toEqual([]);
    expect(seen.length).toBeGreaterThan(0);
    expect(md.sourceRouter).toBe(router);
  });
});
