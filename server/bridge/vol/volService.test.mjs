/**
 * VolService scheduler and capture (docs/spec/p1-03-pricing-vol.md §2.4, §2.7, §2.8, §9.2), with a fake clock, a temp
 * data directory, market/fake.mjs and a fake reference service:
 *  - the capture fires at close − 5 on a trading day, not on a fixture holiday or a weekend (acceptance criterion 3);
 *  - it stops at close − 0.5 min and marks the row partial; the close + 5 retry re-captures only failed or partial
 *    underlyings; a late capture runs when the Bridge starts between close + 5 and + 30; missed rows after + 30 and for
 *    trading days the Bridge was off;
 *  - chain reads are background priority inside the background share and pinned to vol.account; with a recorder
 *    snapshot there are zero chain calls; no headroom → partial without a call;
 *  - the snapshot reuses its cache inside the TTL and is served stale when the chain fails;
 *  - vol.captured payloads and S9 predictions.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { assertService } from "../core/contracts.mjs";
import { TOPICS, createEventBus } from "../core/eventBus.mjs";
import { createLogger } from "../core/logger.mjs";
import { createManualClock } from "../ratelimit/fake.mjs";
import { createScheduler } from "../ratelimit/scheduler.mjs";
import { demoChainAt, expiriesFor } from "../demo/demoAdapter.mjs";
import { createFakeMarketData } from "../market/fake.mjs";
import { createVolService } from "./volService.mjs";

const flushed = async (x) => {
  await x.svc.store.flush();
  return x.svc.store;
};
const IST = (s) => Date.parse(`${s}+05:30`);
const istDate = (t) => new Date(t + 330 * 60_000).toISOString().slice(0, 10);
const HOLIDAY = "2026-11-24";

function fakeReference({ holidays = [HOLIDAY] } = {}) {
  const isTradingDay = (d) => {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    return wd !== 0 && wd !== 6 && !holidays.includes(d);
  };
  return {
    session: (exchange, t) => ({ date: istDate(t), open: "09:15", close: "15:30", tradingDay: isTradingDay(istDate(t)), source: "test" }),
    calendar: () => ({ isTradingDay, holidays: holidays.map((date) => ({ date, exchanges: ["NSE", "BSE"], label: "Fixture", verified: false })) }),
    rate: () => ({ value: 0.065, quality: "default", source: "test" }),
  };
}

/** A Bridge-like setup: fake market data with demo-priced chains for every listed expiry at `chainAt`. */
function setup({ start = IST("2026-10-29T15:20:00"), underlyings = ["NIFTY"], chainAt = null, vol = {}, recorder = null, scheduler = null, holidays } = {}) {
  let t = start;
  const clock = { now: () => t };
  const md = createFakeMarketData({ clock, prices: { "NSE:NIFTY": 25120, "NSE:BANKNIFTY": 56400, "NSE:INDIAVIX": 13.4 }, accountId: "acc-1", broker: "dhan" });
  const priceAt = chainAt ?? IST(`${istDate(start)}T15:25:00`);
  for (const u of underlyings) {
    const exps = expiriesFor(u, priceAt, 6);
    md.setExpiries(u, exps);
    for (const e of exps) md.setChain(u, e, demoChainAt(u, e, priceAt, 30));
  }
  const bars = Array.from({ length: 70 }, (_, i) => ({ time: 1_780_000_000 + i * 86_400, open: 25000 + i, high: 25100 + i, low: 24900 + i, close: 25000 + (i % 2 ? 80 : -80) + i, volume: 0 }));
  md.setCandles("NSE:NIFTY", "1d", bars);
  md.setCandles("NSE:BANKNIFTY", "1d", bars);
  const events = [];
  const bus = { emit: (topic, payload) => events.push([topic, payload]) };
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-vol-svc-"));
  const deps = { config: { dataDir, vol: { underlyings, ...vol } }, clock, bus, marketData: md, reference: fakeReference({ holidays }), symbols: null, scheduler, recorder };
  const svc = createVolService(deps);
  return {
    svc,
    md,
    events,
    dataDir,
    deps,
    at: (s) => {
      t = typeof s === "number" ? s : IST(s);
      return t;
    },
    advance: (ms) => (t += ms),
    chainCalls: () => md.calls.filter((c) => c[0] === "optionChain"),
  };
}

describe("the 15:25 capture (acceptance criterion 3)", () => {
  it("fires at close − 5 on a trading day, writes S2 rows, the summary, predictions and vol.captured", async () => {
    const x = setup({ vol: { account: "acc-1" } });
    x.at("2026-10-29T15:24:00");
    expect(await x.svc.tick()).toEqual([]);
    expect(x.chainCalls()).toHaveLength(0);
    x.at("2026-10-29T15:25:00");
    const ran = await x.svc.tick();
    expect(ran).toEqual([{ underlying: "NIFTY", status: "ok", rows: 4 }]);
    // Background priority, inside the background share, pinned to the configured data account.
    for (const [, params, opts] of x.chainCalls()) {
      expect(params).toMatchObject({ underlying: "NIFTY", greeks: false, strikes: 40 });
      expect(opts).toMatchObject({ priority: "background", backgroundShare: 0.5, accountId: "acc-1", maxAgeMs: 30_000 });
    }
    const st = x.svc.store;
    const rows = st.expiryIndex("NIFTY");
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.date === "2026-10-29" && r.quality === "live")).toBe(true);
    const full = (await flushed(x)).readExpiryRows("NIFTY");
    expect(full[0]).toMatchObject({ trigger: "scheduled", source: "broker", broker: "dhan", accountId: "acc-1", late: false });
    const sum = st.summaryOn("NIFTY", "2026-10-29");
    expect(sum).toMatchObject({ quality: "live", missed: false, partial: false, vix: { value: 13.4, close: null } });
    expect(sum.cm30.method).toBe("interpolated");
    expect(sum.hv.cc20).toBeGreaterThan(0);
    // A second tick in the window does not capture again.
    expect(await x.svc.tick()).toEqual([]);
    expect(x.events).toEqual([["vol.captured", expect.objectContaining({ underlying: "NIFTY", date: "2026-10-29", quality: "live", partial: false, missed: false, trigger: "scheduled", ivr252: null })]]);
    expect(x.events[0][1].cm30Iv).toBeGreaterThan(5);
    const preds = await x.svc.predictions({ from: "2026-10-29", to: "2026-10-29" });
    expect(new Set(preds.items.map((p) => p.metric))).toEqual(new Set(["band1", "band2", "eam", "pItmBand"]));
    expect(preds.items).toHaveLength(16);
    // The close + 5 job fills the closing VIX and spot on the 15:25 row.
    x.at("2026-10-29T15:35:00");
    await x.svc.tick();
    expect(st.summaryOn("NIFTY", "2026-10-29")).toMatchObject({ spotClose: 25120, vix: { close: 13.4 } });
    await x.svc.stop();
  });

  it("does not fire on a fixture holiday or a weekend", async () => {
    for (const day of [HOLIDAY, "2026-10-31"]) {
      const x = setup({ start: IST(`${day}T15:25:00`) });
      expect(await x.svc.tick()).toEqual([]);
      expect(x.chainCalls()).toHaveLength(0);
      x.at(`${day}T16:10:00`);
      expect(await x.svc.tick()).toEqual([]);
      expect(x.svc.store.summaries("NIFTY")).toEqual([]);
    }
  });

  it("stops at close − 0.5 min (partial); the close + 5 retry re-captures only failed or partial underlyings", async () => {
    const x = setup({ underlyings: ["NIFTY", "BANKNIFTY"] });
    x.at("2026-10-29T15:29:20");
    // Every chain read takes 8 s of the fake clock: NIFTY gets two of its four expiries before 15:29:30.
    const real = x.md.optionChain;
    x.md.optionChain = async (p, o) => {
      x.advance(8000);
      return real(p, o);
    };
    const first = await x.svc.tick();
    expect(first.map((r) => [r.underlying, r.status])).toEqual([
      ["NIFTY", "partial"],
      ["BANKNIFTY", "failed"],
    ]);
    expect(x.svc.store.summaryOn("NIFTY", "2026-10-29").partial).toBe(true);
    expect(x.svc.store.summaryOn("BANKNIFTY", "2026-10-29")).toBeNull();
    x.md.optionChain = real;
    x.at("2026-10-29T15:35:00");
    const retry = await x.svc.tick();
    expect(retry.map((r) => [r.underlying, r.status])).toEqual([
      ["NIFTY", "ok"],
      ["BANKNIFTY", "ok"],
    ]);
    const rows = (await flushed(x)).readExpiryRows("NIFTY", { from: "2026-10-29" });
    expect(rows.every((r) => r.trigger === "retry")).toBe(true);
    expect(x.svc.store.summaryOn("NIFTY", "2026-10-29").partial).toBe(false);
    // Once retried, later ticks leave them alone.
    const calls = x.chainCalls().length;
    x.at("2026-10-29T15:40:00");
    expect(await x.svc.tick()).toEqual([]);
    expect(x.chainCalls()).toHaveLength(calls);
  });

  it("a failed capture and a failed retry end as a missed row (CHAIN_FAILED) after close + 30", async () => {
    const x = setup();
    x.md.optionChain = async () => {
      throw Object.assign(new Error("upstream"), { code: "UPSTREAM_ERROR" });
    };
    x.at("2026-10-29T15:25:00");
    expect((await x.svc.tick())[0]).toMatchObject({ underlying: "NIFTY", status: "failed", reason: "CHAIN_FAILED" });
    x.at("2026-10-29T15:35:00");
    expect((await x.svc.tick())[0]).toMatchObject({ status: "failed" });
    x.at("2026-10-29T16:00:00");
    expect(await x.svc.tick()).toEqual([{ underlying: "NIFTY", status: "missed", reason: "CHAIN_FAILED" }]);
    expect(x.svc.store.summaryOn("NIFTY", "2026-10-29")).toMatchObject({ missed: true, reason: "CHAIN_FAILED", quality: null });
    expect(x.events.at(-1)).toEqual(["vol.captured", expect.objectContaining({ underlying: "NIFTY", missed: true, trigger: "missed" })]);
  });

  it("a Bridge started between close + 5 and + 30 takes a late capture; after + 30 the day is missed (BRIDGE_OFF)", async () => {
    const late = setup({ start: IST("2026-10-29T15:40:00") });
    await late.svc.start();
    await late.svc.stop();
    expect(late.svc.store.summaryOn("NIFTY", "2026-10-29")).toMatchObject({ late: true, quality: "live" });
    expect((await flushed(late)).readExpiryRows("NIFTY")[0]).toMatchObject({ trigger: "late", late: true });
    const off = setup({ start: IST("2026-10-29T16:05:00") });
    await off.svc.start();
    await off.svc.stop();
    expect(off.svc.store.summaryOn("NIFTY", "2026-10-29")).toMatchObject({ missed: true, reason: "BRIDGE_OFF" });
    expect(off.chainCalls()).toHaveLength(0);
  });

  it("writes missed rows at start for trading days the Bridge was off since the last row", async () => {
    const x = setup({ start: IST("2026-10-26T15:25:00") });
    await x.svc.tick(); // Mon 26 Oct captured
    await x.svc.stop();
    // Restart on Thu 29 Oct at 10:00 with the same data directory: Tue 27 and Wed 28 were missed.
    const y = createVolService({ ...x.deps, clock: { now: () => IST("2026-10-29T10:00:00") } });
    await y.start();
    await y.stop();
    expect(y.store.summaries("NIFTY").map((r) => [r.date, r.missed ? r.reason : r.quality])).toEqual([
      ["2026-10-26", "live"],
      ["2026-10-27", "BRIDGE_OFF"],
      ["2026-10-28", "BRIDGE_OFF"],
    ]);
    const hist = await y.history({ underlying: "NIFTY", from: "2026-10-20", to: "2026-10-29" });
    expect(hist.gaps).toEqual([
      { date: "2026-10-27", reason: "BRIDGE_OFF" },
      { date: "2026-10-28", reason: "BRIDGE_OFF" },
    ]);
  });
});

describe("chain sources and budget", () => {
  it("reads the recorder's snapshot instead of the broker when one is fresh (zero chain calls)", async () => {
    const t = IST("2026-10-29T15:25:00");
    const recorder = {
      status: () => ({ account: { id: "rec-acc" } }),
      async latest({ underlying, expiry }) {
        const c = demoChainAt(underlying, expiry, t, 20);
        const pick = (side, key) => c.rows.map((r) => r[side]?.[key] ?? null);
        const side = (s) => ({ ltp: pick(s, "ltp"), bid: pick(s, "bid"), ask: pick(s, "ask"), oi: pick(s, "oi"), vol: pick(s, "volume") });
        return { u: underlying, x: expiry, ts: t - 20_000, spot: c.underlyingLtp, atm: c.atmStrike, broker: "dhan", accountId: "rec-acc", k: c.rows.map((r) => r.strike), ce: side("ce"), pe: side("pe") };
      },
    };
    const x = setup({ start: t, recorder });
    const ran = await x.svc.tick();
    expect(ran[0]).toMatchObject({ status: "ok", rows: 4 });
    expect(x.chainCalls()).toHaveLength(0);
    expect((await flushed(x)).readExpiryRows("NIFTY")[0]).toMatchObject({ source: "recorder" });
    // The expiry list is read pinned to the recorder's data account.
    expect(x.md.calls.find((c) => c[0] === "expiries")[2]).toMatchObject({ accountId: "rec-acc", priority: "background" });
  });

  it("without background headroom before close − 0.5 min the row is partial and no chain is read", async () => {
    const scheduler = { headroom: () => ({ remaining: 2, limit: 20, resetMs: 60_000 }) };
    const x = setup({ start: IST("2026-10-29T15:29:00"), scheduler, vol: { account: "acc-1" } });
    const ran = await x.svc.tick();
    expect(ran[0]).toMatchObject({ underlying: "NIFTY", status: "failed" });
    expect(x.chainCalls()).toHaveLength(0);
  });

  it("the snapshot reuses its cache inside the TTL and is served stale when the chain fails", async () => {
    const x = setup({ start: IST("2026-10-29T11:00:00"), chainAt: IST("2026-10-29T11:00:00") });
    const a = await x.svc.snapshot({ underlying: "NIFTY" });
    expect(a).toMatchObject({ underlying: "NIFTY", available: true, stale: false, clock: { mode: "weighted" } });
    expect(a.rows.length).toBeGreaterThanOrEqual(2);
    expect(a.rows.every((r) => r.quality === "live-snapshot" && !("accountId" in r))).toBe(true);
    expect(a.cm30.iv).toBeGreaterThan(5);
    const calls = x.chainCalls().length;
    for (const [, , o] of x.chainCalls()) expect(o).toMatchObject({ priority: "background", maxAgeMs: 60_000 });
    x.advance(30_000);
    await x.svc.snapshot({ underlying: "NIFTY" });
    expect(x.chainCalls()).toHaveLength(calls);
    x.advance(40_000);
    x.md.optionChain = async () => {
      throw Object.assign(new Error("down"), { code: "UPSTREAM_ERROR" });
    };
    const stale = await x.svc.snapshot({ underlying: "NIFTY" });
    expect(stale).toMatchObject({ available: true, stale: true, asOf: a.asOf });
    expect(await x.svc.snapshot({ underlying: "RELIANCE" })).toEqual({ underlying: "RELIANCE", available: false, reason: "NOT_TRACKED" });
  });

  it("satisfies the contract; manual capture skips an existing row unless replace; logPredictions validates", async () => {
    const x = setup({ start: IST("2026-10-29T15:25:00") });
    assertService("vol", x.svc);
    await x.svc.tick();
    const again = await x.svc.capture({ underlyings: ["nifty"] });
    expect(again).toMatchObject({ underlyings: ["NIFTY"], skipped: ["NIFTY"] });
    const rep = await x.svc.capture({ underlyings: ["NIFTY"], replace: true });
    expect(rep.results[0]).toMatchObject({ status: "ok" });
    expect((await flushed(x)).readExpiryRows("NIFTY")[0].trigger).toBe("manual");
    await expect(x.svc.capture({ underlyings: ["RELIANCE"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const { ids } = await x.svc.logPredictions([{ metric: "pop", underlying: "NIFTY", expiry: "2026-11-03", prediction: { p: 0.6 }, modelVersion: "builder-v1" }]);
    expect(ids).toHaveLength(1);
    await expect(x.svc.logPredictions([{ metric: "bad metric", underlying: "NIFTY" }])).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await x.svc.predictions({ from: "2026-10-29", to: "2026-10-29", metric: "pop" })).items[0]).toMatchObject({ modelVersion: "builder-v1", outcome: null });
  });
});

describe("review round: closing values, budget gate, snapshot, capacity, late quotes, stop, clock input", () => {
  it("a 10:00 manual capture stores no closing values and does not stand in for the close − 5 capture", async () => {
    const x = setup({ start: IST("2026-10-29T10:00:00") });
    const r = await x.svc.capture({ underlyings: ["NIFTY"] });
    expect(r.results[0]).toMatchObject({ status: "ok" });
    const morning = x.svc.store.summaryOn("NIFTY", "2026-10-29");
    expect(morning).toMatchObject({ trigger: "manual", spotClose: null, vix: { close: null } });
    x.at("2026-10-29T15:25:00");
    expect((await x.svc.tick())[0]).toMatchObject({ underlying: "NIFTY", status: "ok" });
    const sum = x.svc.store.summaryOn("NIFTY", "2026-10-29");
    expect(sum).toMatchObject({ trigger: "scheduled", spotClose: null, vix: { close: null } });
    expect((await flushed(x)).readExpiryRows("NIFTY", { from: "2026-10-29" }).every((row) => row.trigger === "scheduled")).toBe(true);
    // The close fills the closing values.
    x.at("2026-10-29T15:35:00");
    await x.svc.tick();
    expect(x.svc.store.summaryOn("NIFTY", "2026-10-29")).toMatchObject({ spotClose: 25120, vix: { close: 13.4 } });
    // A manual capture after the close takes closing values at once.
    const y = setup({ start: IST("2026-10-29T15:45:00") });
    await y.svc.capture({ underlyings: ["NIFTY"] });
    expect(y.svc.store.summaryOn("NIFTY", "2026-10-29")).toMatchObject({ spotClose: 25120, vix: { close: 13.4 } });
  });

  it("every background call passes the gate and carries backgroundShare; the account is chosen before the first call", async () => {
    const asked = [];
    const scheduler = { headroom: (acc, cls) => (asked.push([acc, cls]), { remaining: 100, limit: 100, resetMs: 0 }) };
    const x = setup({ start: IST("2026-10-29T15:25:00"), scheduler });
    x.deps.accounts = { marketDataCandidates: ({ capability }) => (capability === "optionChain" ? ["acc-9"] : []), get: () => ({ broker: "dhan" }) };
    const svc = createVolService(x.deps);
    expect((await svc.tick())[0]).toMatchObject({ status: "ok" });
    for (const [name, , opts] of x.md.calls.filter((c) => ["expiries", "optionChain", "history"].includes(c[0]))) expect(opts, name).toMatchObject({ priority: "background", backgroundShare: 0.5 });
    for (const [, , opts] of x.md.calls.filter((c) => c[0] === "quotes")) expect(opts).toMatchObject({ priority: "background", backgroundShare: 0.5, accountId: "acc-9" });
    expect(x.md.calls.find((c) => c[0] === "expiries")[2]).toMatchObject({ accountId: "acc-9" });
    expect(new Set(asked.map((a) => a[1]))).toEqual(new Set(["chain", "quote", "history"]));
    expect(asked.every(([acc]) => acc === "acc-9")).toBe(true);
    expect(svc.status().account.selectedBy).toBe("first-with-optionChain");
    // A gate that throws fails closed: no broker call at all.
    const y = setup({ start: IST("2026-10-29T15:25:00"), vol: { account: "acc-1" }, scheduler: { headroom: () => { throw new Error("broken"); } } });
    expect((await y.svc.tick())[0]).toMatchObject({ status: "failed" });
    expect(y.md.calls).toEqual([]);
  });

  it("with no headroom the snapshot answers at once from the last one, marked stale, with no chain call; concurrent reads share one build", async () => {
    let room = true;
    const scheduler = { headroom: () => (room ? { remaining: 100, limit: 100, resetMs: 0 } : { remaining: 0, limit: 100, resetMs: 60_000 }) };
    const x = setup({ start: IST("2026-10-29T11:00:00"), chainAt: IST("2026-10-29T11:00:00"), scheduler, vol: { account: "acc-1" } });
    const [a, b] = await Promise.all([x.svc.snapshot({ underlying: "NIFTY" }), x.svc.snapshot({ underlying: "NIFTY" })]);
    expect(a).toMatchObject({ available: true, stale: false });
    expect(b.asOf).toBe(a.asOf);
    const built = x.chainCalls().length;
    expect(x.md.calls.filter((c) => c[0] === "expiries")).toHaveLength(1);
    room = false;
    x.advance(70_000);
    const started = Date.now();
    const stale = await x.svc.snapshot({ underlying: "NIFTY" });
    expect(Date.now() - started).toBeLessThan(200);
    expect(stale).toMatchObject({ available: true, stale: true, asOf: a.asOf });
    expect(x.chainCalls()).toHaveLength(built);
    // Nothing cached yet: no chain, still at once.
    const y = setup({ start: IST("2026-10-29T11:00:00"), scheduler: { headroom: () => ({ remaining: 0, limit: 100, resetMs: 60_000 }) }, vol: { account: "acc-1" } });
    expect(await y.svc.snapshot({ underlying: "NIFTY" })).toEqual({ underlying: "NIFTY", available: false, reason: "NO_CHAIN" });
    expect(y.md.calls).toEqual([]);
  });

  it("stocks beyond the 15:25 window's capacity are refused at start with the reason in status", async () => {
    const stocks = Array.from({ length: 32 }, (_, i) => `STK${i + 1}`);
    // 20 chain calls a minute; background keeps at most half: 10 a minute × 4.5 min = 45 calls; 6 indices × 4 = 24.
    const scheduler = { headroom: () => ({ remaining: 20, limit: 20, resetMs: 0 }), headroomWindows: () => ({ windows: [{ window: "1m", limit: 20, remaining: 20, resetMs: 0 }], backoffMs: 0 }) };
    const x = setup({ start: IST("2026-10-29T10:00:00"), scheduler, vol: { account: "acc-1", underlyings: ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"], stocks } });
    x.deps.accounts = { get: () => ({ broker: "dhan" }), marketDataCandidates: () => [] };
    const svc = createVolService(x.deps);
    await svc.start();
    await svc.stop();
    const st = svc.status();
    expect(st.capacity).toMatchObject({ chainCallsPerMin: 10, maxStocksThatFit: 10, fits: false });
    expect(st.capacity.refused.message).toBe("Your Dhan account can capture 10 stocks in the 15:25 window; 32 are configured");
    expect(st.capacity.refused.stocks).toEqual(stocks.slice(10));
    expect(st.underlyings.find((u) => u.underlying === "STK11")).toMatchObject({ available: false, reason: "BEYOND_CAPACITY" });
    expect(st.underlyings.find((u) => u.underlying === "STK10").available).toBe(true);
  });

  it("a late capture from one-sided quotes after the close is refused, and the day ends missed", async () => {
    const x = setup({ start: IST("2026-10-29T15:40:00") });
    const priceAt = IST("2026-10-29T15:25:00");
    for (const e of expiriesFor("NIFTY", priceAt, 6)) {
      const c = demoChainAt("NIFTY", e, priceAt, 30);
      const zero = (leg) => (leg ? { ...leg, bid: 0, ask: 0 } : leg);
      x.md.setChain("NIFTY", e, { ...c, rows: c.rows.map((r) => ({ ...r, ce: zero(r.ce), pe: zero(r.pe) })) });
    }
    expect((await x.svc.tick())[0]).toMatchObject({ underlying: "NIFTY", status: "failed", reason: "CHAIN_FAILED" });
    expect(x.svc.store.summaryOn("NIFTY", "2026-10-29")).toBeNull();
    x.at("2026-10-29T16:00:00");
    expect(await x.svc.tick()).toEqual([{ underlying: "NIFTY", status: "missed", reason: "CHAIN_FAILED" }]);
  });

  it("each expiry row is priced at the instant its chain was read", async () => {
    const x = setup({ start: IST("2026-10-29T15:25:00") });
    const real = x.md.optionChain;
    x.md.optionChain = async (p, o) => {
      x.advance(60_000);
      return real(p, o);
    };
    await x.svc.tick();
    const rows = (await flushed(x)).readExpiryRows("NIFTY");
    expect(new Set(rows.map((r) => r.capturedAt)).size).toBe(rows.length);
    const { volTime } = await import("../dashboard/pricing.js");
    const { pricingContext } = await import("./context.mjs");
    for (const r of rows) {
      const at = Date.parse(r.capturedAt);
      const ctx = pricingContext({ config: x.deps.config, reference: x.deps.reference, exchange: "NFO", kind: "index", now: at });
      expect(r.clock.T).toBeCloseTo(volTime(ctx, at, r.expiry).T, 8);
    }
  });

  it("stop() ends a capture waiting for budget and waits for it before the last flush", async () => {
    const scheduler = { headroom: () => ({ remaining: 0, limit: 100, resetMs: 4000 }) };
    const x = setup({ start: IST("2026-10-29T11:00:00"), scheduler, vol: { account: "acc-1" } });
    const run = x.svc.capture({ underlyings: ["NIFTY"] });
    await new Promise((r) => setTimeout(r, 20));
    const started = Date.now();
    await x.svc.stop();
    expect(Date.now() - started).toBeLessThan(500);
    expect((await run).results[0]).toMatchObject({ status: "failed" });
    expect(x.md.calls).toEqual([]);
    expect(await x.svc.tick()).toEqual([]);
  });

  it("the clock's `at` must be an ISO-8601 instant with an offset", async () => {
    const x = setup();
    for (const at of ["Oct 29 2026", "2026", "2026-10-29", "2026-10-29T10:00:00"]) await expect(x.svc.clock({ underlying: "NIFTY", at })).rejects.toMatchObject({ code: "VALIDATION_FAILED", errors: [{ path: "at" }] });
    expect((await x.svc.clock({ underlying: "NIFTY", at: "2026-10-29T10:00:00+05:30", expiries: ["2026-11-03"] })).expiries[0].T).toBeCloseTo(0.0147289, 6);
  });
});

describe("a user chain read during a capture is not delayed by more than 200 ms (real scheduler)", () => {
  const v = (spec) => ({ ...spec, verified: true, source: "https://example.test/limits" });
  const TBROKER = { tbroker: { brokerId: "tbroker", limits: { chain: v({ perSecond: 4, perMinute: 120 }), quote: v({ perSecond: 1 }), history: v({ perSecond: 5 }), other: v({ perSecond: 20 }) }, groups: {}, maxQuoteBatch: 1000, feed: {}, pooling: "unknown" } };

  async function run(broker, policies, every) {
    const clock = createManualClock(IST("2026-10-29T15:24:59"));
    const logger = createLogger({ level: "silent" });
    const bus = createEventBus({ logger, topics: TOPICS });
    const accounts = createFakeAccountManager({ accounts: [{ id: "d-1", broker }], bus });
    const scheduler = createScheduler({ config: { ratelimit: {} }, logger, bus, clock, accounts }, policies ? { policies } : {});
    const priceAt = IST("2026-10-29T15:25:00");
    const exps = expiriesFor("NIFTY", priceAt, 6);
    const fresh = () => ({ asOf: new Date(clock.now()).toISOString(), source: "broker", accountId: "d-1", broker });
    const sched = (cls, o, fn) => scheduler.schedule({ accountId: o.accountId ?? "d-1", endpointClass: cls, priority: o.priority ?? "interactive", backgroundShare: o.backgroundShare }, fn);
    const capCalls = [];
    // The marketData seam: each call scheduled the way marketDataService schedules its broker call.
    const marketData = {
      expiries: (u, o) => sched("other", o, async () => ({ expiries: exps, freshness: fresh() })),
      optionChain: (p, o) => sched("chain", o, async () => (capCalls.push(clock.now()), { ...demoChainAt(p.underlying, p.expiry, priceAt, 30), freshness: fresh() })),
      quotes: (list, o) => sched("quote", o, async () => ({ items: list.map((symbol) => ({ symbol, ltp: symbol.includes("VIX") ? 13.4 : 25120, freshness: fresh() })) })),
      history: (p, o) => sched("history", o, async () => ({ candles: [], freshness: fresh() })),
    };
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-vol-prio-"));
    const svc = createVolService({ config: { dataDir, vol: { underlyings: ["NIFTY", "BANKNIFTY"], account: "d-1" } }, clock, marketData, reference: fakeReference(), symbols: null, scheduler, recorder: null, accounts });
    await clock.advance(1000);
    const capture = svc.tick();
    let done = false;
    capture.then(() => (done = true));
    const delays = [];
    const users = [];
    // Users ask for a chain every `every` ms for 20 s while the capture runs (and after it ends).
    for (let i = 0; i < 800; i++) {
      if (i % Math.round(every / 25) === 0) {
        const asked = clock.now();
        users.push(sched("chain", { priority: "interactive" }, async () => delays.push(clock.now() - asked)));
      }
      await clock.advance(25);
    }
    for (let i = 0; i < 12_000 && !done; i++) await clock.advance(25);
    const results = await capture;
    for (let i = 0; i < 40; i++) await clock.advance(25);
    await Promise.allSettled(users);
    await svc.stop();
    scheduler.stop();
    return { results, delays, capCalls, status: svc.status() };
  }

  it("Dhan policy: users go first; the 1/s chain window leaves background work nothing, so the capture reads no chain", async () => {
    const r = await run("dhan", null, 3500);
    expect(r.delays.length).toBeGreaterThan(3);
    expect(Math.max(...r.delays)).toBeLessThanOrEqual(200);
    expect(r.capCalls).toHaveLength(0);
    expect(r.results.every((x) => x.status === "failed")).toBe(true);
    expect(r.status.capacity).toMatchObject({ chainCallsPerMin: 0, fits: false });
  }, 60_000);

  it("a 4/s, 120/min chain policy: the capture completes and users are still never delayed > 200 ms", async () => {
    const r = await run("tbroker", TBROKER, 700);
    expect(r.results.map((x) => x.status)).toEqual(["ok", "ok"]);
    expect(r.capCalls.length).toBeGreaterThanOrEqual(8);
    expect(r.delays.length).toBeGreaterThan(3);
    expect(Math.max(...r.delays)).toBeLessThanOrEqual(200);
  }, 60_000);
});
