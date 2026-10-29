/**
 * Demo mode: deterministic sample data through the real pipeline, every response labelled, no real broker reachable,
 * live trading forced off.
 */
import http from "node:http";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateAdapter } from "../../brokers/contract.mjs";
import { createBrokerRegistry } from "../../brokers/registry.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { black76, realisedVol, volTime } from "../dashboard/pricing.js";
import { DEMO_OPTION_UNDERLYINGS, DEMO_UNDERLYINGS, candles, createDemoAdapter, dailyCloses, demoChainAt, demoClockContext, demoInstruments, demoOptionOi, demoSplitSymbol, demoStrikeStep, demoUnderlying, expiriesFor, ivLevel, openInterestAt, optionPrice, parseToken, quoteOf, smileVol, spotAt } from "./demoAdapter.mjs";
import { DEMO_STOCK_LOT, demoDatasets } from "../reference/demoReference.mjs";
import { NIFTY50 } from "../scanner/universes.mjs";
import { demoCalendar } from "../reference/demoTables.mjs";
import { DEMO_HEADER, createDemoRegistry, labelDemoResult } from "./demoMode.mjs";

const T = Date.UTC(2026, 9, 19, 5, 0, 0); // Monday 10:30 IST

describe("demo adapter", () => {
  const a = createDemoAdapter({ now: () => T });

  it("is a strict contract adapter with no order methods", () => {
    expect(validateAdapter(a).errors).toEqual([]);
    for (const m of ["placeOrder", "modifyOrder", "cancelOrder"]) expect(a[m]).toBeUndefined();
  });

  it("gives the same prices for the same instant", async () => {
    expect(spotAt("NIFTY", T)).toBe(spotAt("NIFTY", T));
    const q1 = await a.fetchQuotes({}, [{ token: "DM-RELIANCE", exchange: "NSE" }]);
    const q2 = await createDemoAdapter({ now: () => T }).fetchQuotes({}, [{ token: "DM-RELIANCE", exchange: "NSE" }]);
    expect(q1).toEqual(q2);
    expect(spotAt("NIFTY", T + 60_000)).not.toBe(spotAt("NIFTY", T));
    expect(spotAt("NIFTY", T)).toBeGreaterThan(22_000);
    expect(spotAt("NIFTY", T)).toBeLessThan(29_000);
  });

  it("lists NIFTY, BANKNIFTY, SENSEX and stocks, all named (Demo)", () => {
    const rows = demoInstruments(T);
    for (const u of ["NIFTY", "BANKNIFTY", "SENSEX", "RELIANCE", "TCS"]) expect(rows.some((r) => r.underlying === u)).toBe(true);
    expect(rows.every((r) => r.name.includes("(Demo)"))).toBe(true);
    // Tue 20 Oct 2026 is in the shipped holiday list (Dussehra), so the demo expiry moves to Mon 19 Oct.
    expect(expiriesFor("NIFTY", T)[0]).toBe("2026-10-19");
    expect(expiriesFor("SENSEX", T)[0]).toBe("2026-10-22");
    expect(expiriesFor("BANKNIFTY", T)[0]).toBe("2026-10-27");
  });

  it("covers every NIFTY 50 stock, including symbols with - and &, so demo scans have a full universe", async () => {
    const listed = new Set(demoInstruments(T).map((r) => `${r.exchange}:${r.tradingSymbol}`));
    expect(NIFTY50.filter((s) => !listed.has(s))).toEqual([]);
    expect(parseToken("DM-BAJAJ-AUTO")).toEqual({ symbol: "BAJAJ-AUTO", kind: "spot" });
    expect(parseToken("DM-M&M")).toEqual({ symbol: "M&M", kind: "spot" });
    expect(parseToken("DM-NIFTY-2026-10-27-FUT")).toEqual({ symbol: "NIFTY", kind: "fut", expiry: "2026-10-27" });
    const q = await a.fetchQuotes({}, [{ token: "DM-BAJAJ-AUTO", exchange: "NSE" }, { token: "DM-M&M", exchange: "NSE" }]);
    expect(q.data.map((x) => x.ltp > 0)).toEqual([true, true]);
  });

  it("builds an option chain around the spot and candles in market hours", async () => {
    const chain = (await a.fetchOptionChain({}, "NIFTY", "2026-10-19")).data;
    expect(Object.keys(chain.oc)).toHaveLength(91); // ±45 strikes (p1-01 §8)
    expect(chain.last_price).toBe(spotAt("NIFTY", T));
    const bars = candles("DM-NIFTY", "15m", Date.UTC(2026, 9, 16, 3, 45), Date.UTC(2026, 9, 16, 10, 0));
    expect(bars).toHaveLength(25);
    for (const b of bars) expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
  });

  it("prices CE and PE on one vol per strike and tenor: parity holds, fronts are richer, puts are skewed", () => {
    const S = spotAt("NIFTY", T);
    for (const e of expiriesFor("NIFTY", T)) {
      const years = Math.max((Date.parse(`${e}T15:30:00+05:30`) - T) / (365 * 86_400_000), 10 / (365 * 24 * 60));
      for (const k of [-6, -2, 0, 3, 7].map((i) => Math.round(S / 50) * 50 + i * 50)) {
        const c = optionPrice("NIFTY", e, k, "CE", T);
        const p = optionPrice("NIFTY", e, k, "PE", T);
        if (c <= 0.05 || p <= 0.05) continue;
        // C − P = S − K·e^(−rT), up to the 0.05 tick on each leg.
        expect(Math.abs(c - p - (S - k * Math.exp(-0.065 * years)))).toBeLessThanOrEqual(0.1 + 1e-9);
      }
    }
    const u = { iv: 0.12, step: 50 };
    expect(smileVol(u, 25000, 25000, 7 / 365)).toBeGreaterThan(smileVol(u, 25000, 25000, 60 / 365));
    expect(smileVol(u, 25000, 0.95 * 25000, 30 / 365)).toBeGreaterThan(smileVol(u, 25000, 1.05 * 25000, 30 / 365));
  });

  it("prices options with Black-76 on the vol-time clock at the day's IV level (P1-3a)", () => {
    const u = DEMO_UNDERLYINGS.find((x) => x.symbol === "NIFTY");
    const S = spotAt("NIFTY", T);
    const e = expiriesFor("NIFTY", T)[1];
    const c = volTime(demoClockContext("NFO"), T, e);
    const k = Math.round(S / 50) * 50;
    const df = Math.exp(-0.065 * c.Tcal);
    const want = df * black76(S / df, k, c.T, 100 * smileVol(u, S, k, c.T, ivLevel("NIFTY", T)), "CE");
    expect(Math.abs(optionPrice("NIFTY", e, k, "CE", T) - want)).toBeLessThanOrEqual(0.025 + 1e-9);
    // After the settlement an option is worth its intrinsic value (never below one tick).
    const after = Date.parse(`${e}T15:31:00+05:30`);
    const S2 = spotAt("NIFTY", after);
    const kItm = Math.round(S2 / 50) * 50 - 200;
    expect(Math.abs(optionPrice("NIFTY", e, kItm, "CE", after) - (S2 - kItm))).toBeLessThanOrEqual(0.05);
    expect(optionPrice("NIFTY", e, kItm + 400, "CE", after)).toBe(0.05);
  });

  it("the IV level stays in 6–60 %, moves with the demo's own realised vol and sits above it on most days", () => {
    let above = 0;
    const levels = [];
    for (let i = 0; i < 120; i += 1) {
      const t = T - i * 86_400_000;
      const lv = ivLevel("NIFTY", t);
      levels.push(lv);
      expect(lv).toBeGreaterThanOrEqual(0.06);
      expect(lv).toBeLessThanOrEqual(0.6);
      if (lv * 100 > realisedVol(dailyCloses("NIFTY", t, 21), 20)) above += 1;
    }
    expect(above / 120).toBeGreaterThan(0.6);
    expect(Math.max(...levels) - Math.min(...levels)).toBeGreaterThan(0.02);
    expect(ivLevel("NIFTY", T)).toBe(ivLevel("NIFTY", T + 3_600_000)); // constant within an IST day
  });

  it("lists INDIA VIX (Demo), priced from NIFTY's 30-day IV on calendar time", async () => {
    expect(demoInstruments(T).find((r) => r.tradingSymbol === "INDIAVIX")).toMatchObject({ exchange: "NSE", instrumentType: "INDEX", name: "India VIX (Demo)" });
    const vix = spotAt("INDIAVIX", T);
    // NIFTY's 30-day calendar vol at the §6.6 target (30 calendar days ahead, rolled back to the previous trading day).
    const nifty = DEMO_UNDERLYINGS.find((x) => x.symbol === "NIFTY");
    const calVol = (t) => {
      let target = new Date(t + 30 * 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);
      const dc = demoCalendar();
      if (!dc.isTradingDay(target, "NFO")) target = dc.prevTradingDay(target, "NFO");
      const c = volTime(demoClockContext("NFO"), t, target);
      const S = spotAt("NIFTY", t);
      return 100 * smileVol(nifty, S, S, c.T, ivLevel("NIFTY", t)) * Math.sqrt(c.T / c.Tcal);
    };
    // 14 consecutive days at 11:00 IST: no weekday sawtooth when the target lands on a weekend or holiday.
    for (let i = 0; i < 14; i += 1) {
      const t = Date.UTC(2026, 9, 19 + i, 5, 30, 0);
      const ratio = spotAt("INDIAVIX", t) / calVol(t);
      expect(ratio, `day ${i}`).toBeGreaterThanOrEqual(1.0 - 1e-3);
      expect(ratio, `day ${i}`).toBeLessThanOrEqual(1.06 + 1e-3);
    }
    expect(Math.round(vix / 0.0025) * 0.0025).toBeCloseTo(vix, 9);
    const q = await a.fetchQuotes({}, [{ token: "DM-INDIAVIX", exchange: "NSE" }]);
    expect(q.data[0].ltp).toBe(vix);
    expect(q.data[0].bid).toBeLessThan(q.data[0].ask);
  });

  it("INDIA VIX candles keep the OHLC rule on its 0.0025 tick (5m and 1d)", () => {
    const bars = [...candles("DM-INDIAVIX", "5m", T - 2 * 86_400_000, T), ...candles("DM-INDIAVIX", "1d", T - 200 * 86_400_000, T)];
    expect(bars.length).toBeGreaterThan(100);
    for (const b of bars) {
      expect(b.high, `${b.time}`).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
      expect(b.low, `${b.time}`).toBeLessThanOrEqual(Math.min(b.open, b.close));
      expect(Math.round(b.high / 0.0025) * 0.0025).toBeCloseTo(b.high, 9);
      expect(Math.round(b.low / 0.0025) * 0.0025).toBeCloseTo(b.low, 9);
    }
  });

  it("demoChainAt builds a light OptionChain-shaped chain fast", () => {
    const e = expiriesFor("NIFTY", T)[0];
    const t0 = performance.now();
    const ch = demoChainAt("NIFTY", e, T, 30);
    const ms = performance.now() - t0;
    expect(ch).toMatchObject({ underlying: "NIFTY", expiry: e, underlyingLtp: spotAt("NIFTY", T), lotSize: 65 });
    expect(ch.rows).toHaveLength(61);
    const atm = ch.rows[30];
    expect(atm.ce.ltp).toBe(optionPrice("NIFTY", e, atm.strike, "CE", T));
    for (const r of ch.rows) for (const leg of [r.ce, r.pe]) expect(leg.bid).toBeLessThan(leg.ask);
    expect(ms).toBeLessThan(250);
    expect(demoChainAt("INDIAVIX", e, T)).toBeNull();
    // Stocks list ±20 strikes (P1-6).
    expect(demoChainAt("RELIANCE", expiriesFor("RELIANCE", T)[0], T, 30).rows).toHaveLength(41);
  });

  describe("stock options for all 50 demo stocks (P1-6 §4.1)", () => {
    const rows = demoInstruments(T);
    const stocks = Object.keys(DEMO_STOCK_LOT);

    it("every demo stock lists OPTSTK and FUTSTK on 3 monthly expiries with the demo lot", () => {
      expect(stocks).toHaveLength(50);
      for (const s of stocks) {
        const opts = rows.filter((r) => r.underlying === s && r.instrumentType === "OPTSTK" && !r.token.endsWith("-ADJ"));
        const futs = rows.filter((r) => r.underlying === s && r.instrumentType === "FUTSTK");
        const exps = [...new Set(opts.map((r) => r.expiry))];
        expect(exps).toEqual(expiriesFor(s, T));
        expect(exps).toHaveLength(3);
        expect(futs.map((r) => r.expiry)).toEqual(exps);
        for (const r of [...opts, ...futs]) expect(r.lotSize).toBe(DEMO_STOCK_LOT[s]);
        // ±20 strikes per expiry, CE and PE
        expect(opts.filter((r) => r.expiry === exps[0])).toHaveLength(82);
      }
      expect([DEMO_STOCK_LOT.RELIANCE, DEMO_STOCK_LOT.TATASTEEL, DEMO_STOCK_LOT.MARUTI]).toEqual([525, 4475, 50]);
      // Indices keep their own types
      expect(rows.some((r) => r.underlying === "NIFTY" && r.instrumentType === "OPTIDX")).toBe(true);
      expect(rows.some((r) => r.underlying === "NIFTY" && r.instrumentType === "OPTSTK")).toBe(false);
    });

    it("demo lots equal the demo reference lots", () => {
      const ref = demoDatasets(T);
      for (const s of stocks) expect(ref.lots.find((l) => l.underlying === s)?.lot).toBe(DEMO_STOCK_LOT[s]);
    });

    it("strike steps follow the table; TATASTEEL lists 167.5", () => {
      expect([90, 168, 300, 872, 1418, 3086, 7450, 15900].map(demoStrikeStep)).toEqual([1, 2.5, 5, 10, 20, 50, 100, 250]);
      for (const s of stocks) {
        const strikes = [...new Set(rows.filter((r) => r.underlying === s && r.instrumentType === "OPTSTK" && !r.token.endsWith("-ADJ")).map((r) => r.strike))].sort((a, b) => a - b);
        const step = demoUnderlying(s).step;
        for (let i = 1; i < strikes.length; i += 1) expect(Math.round((strikes[i] - strikes[i - 1]) * 100) / 100).toBe(step);
      }
      const tata = rows.filter((r) => r.underlying === "TATASTEEL" && r.instrumentType === "OPTSTK").map((r) => r.strike);
      expect(tata).toContain(167.5);
      expect(tata).toContain(165);
    });

    it("quotes for option tokens carry oi, bid, ask and sizes; OI is a multiple of the lot", async () => {
      const e = expiriesFor("TATASTEEL", T)[0];
      const opts = rows.filter((r) => r.underlying === "TATASTEEL" && r.expiry === e && r.instrumentType === "OPTSTK");
      const q = (await a.fetchQuotes({}, opts.map((r) => ({ token: r.token, exchange: "NFO" })))).data;
      expect(q).toHaveLength(opts.length);
      for (const x of q) {
        expect(x.oi % 4475).toBe(0);
        expect(x.oi).toBeGreaterThan(0);
        expect(x.bid).toBeLessThan(x.ask);
        expect(x.bidQty % 4475).toBe(0);
        expect(x.askQty % 4475).toBe(0);
      }
      const chain = (await a.fetchOptionChain({}, "TATASTEEL", e)).data;
      expect(Object.keys(chain.oc)).toHaveLength(41);
      expect(Object.keys(chain.oc).map(Number)).toContain(167.5);
    });

    it("near-the-money stock OI is about 1,000–2,500 lots and drifts through the session", () => {
      const e = expiriesFor("RELIANCE", T)[0];
      const S = spotAt("RELIANCE", T);
      const k = Math.round(S / 20) * 20;
      const token = `DM-RELIANCE-${e}-${k}-CE`;
      const lots = demoOptionOi(token, T) / 525;
      expect(lots).toBeGreaterThan(500);
      expect(lots).toBeLessThan(4000);
      const open = Date.UTC(2026, 9, 19, 3, 45);
      expect(demoOptionOi(token, open)).not.toBe(demoOptionOi(token, Date.UTC(2026, 9, 19, 10, 0)));
    });

    it("the split stock's nearest expiry lists 6 adjusted -ADJ contracts with lot × 5 and off-grid strikes", async () => {
      const split = demoSplitSymbol("2026-10-19");
      const adj = rows.filter((r) => r.token.endsWith("-ADJ"));
      expect(adj).toHaveLength(6);
      expect(new Set(adj.map((r) => r.underlying))).toEqual(new Set([split]));
      expect(new Set(adj.map((r) => r.expiry))).toEqual(new Set([expiriesFor(split, T)[0]]));
      for (const r of adj) {
        expect(r.lotSize).toBe(DEMO_STOCK_LOT[split] * 5);
        expect(Math.abs(r.strike / 20 - Math.round(r.strike / 20))).toBeGreaterThan(1e-6);
        expect(parseToken(r.token)).toMatchObject({ kind: "opt", adjusted: true, strike: r.strike });
      }
      const q = (await a.fetchQuotes({}, [{ token: adj[0].token, exchange: "NFO" }])).data[0];
      expect(q.oi % (DEMO_STOCK_LOT[split] * 5)).toBe(0);
      const chain = (await a.fetchOptionChain({}, split, adj[0].expiry)).data;
      expect(Object.keys(chain.oc)).toHaveLength(44);
    });
  });

  it("the demo registry holds only the demo broker", () => {
    const r = createDemoRegistry();
    expect(r.list()).toEqual(["demo"]);
    expect(() => r.get("zerodha")).toThrow(/Demo mode serves only/);
    expect(createBrokerRegistry().has("demo")).toBe(false);
  });

  it("labels { data, meta } bodies only", () => {
    expect(labelDemoResult({ data: 1, meta: { requestId: "r" } }).meta).toMatchObject({ demo: true, requestId: "r" });
    expect(labelDemoResult({ s: "ok" })).toEqual({ s: "ok" });
  });
});

describe("demo realism for the recorder (p1-01 §8)", () => {
  const a = createDemoAdapter({ now: () => T });
  const at = (h, m) => Date.UTC(2026, 9, 19, h - 5, m - 30); // IST h:m on Mon 19 Oct 2026

  it("OI changes through the day, is always a whole number of lots, and is the same at the same instant", () => {
    const e = expiriesFor("NIFTY", T)[1];
    const k = Math.round(spotAt("NIFTY", T) / 50) * 50;
    let changed = 0;
    for (const strike of [k - 200, k - 50, k, k + 100, k + 300]) {
      for (const right of ["CE", "PE"]) {
        const ten = openInterestAt("NIFTY", strike, right, e, at(10, 0));
        const two = openInterestAt("NIFTY", strike, right, e, at(14, 0));
        expect(ten % 65, `${strike}${right}`).toBe(0);
        expect(two % 65).toBe(0);
        expect(openInterestAt("NIFTY", strike, right, e, at(10, 0))).toBe(ten);
        if (ten !== two) changed += 1;
      }
    }
    expect(changed).toBeGreaterThanOrEqual(8);
  });

  it("previous_oi is the same function at the previous close; bid and ask sizes are whole lots", async () => {
    const e = expiriesFor("NIFTY", T)[0];
    const chain = (await a.fetchOptionChain({}, "NIFTY", e)).data;
    const [key, row] = Object.entries(chain.oc)[45];
    const strike = Number(key);
    const prevClose = Date.UTC(2026, 9, 16, 10, 0); // Fri 16 Oct 15:30 IST
    expect(row.ce.previous_oi).toBe(openInterestAt("NIFTY", strike, "CE", e, prevClose));
    expect(row.ce.oi_chg).toBe(row.ce.oi - row.ce.previous_oi);
    expect(row.ce.top_bid_quantity % 65).toBe(0);
    expect(row.ce.top_ask_quantity).toBeGreaterThan(0);
    const q = quoteOf(`DM-NIFTY-${e}-${strike}-PE`, "NFO", T);
    expect(q.bidQty % 65).toBe(0);
    expect(q.askQty % 65).toBe(0);
    expect(quoteOf("DM-NIFTY", "NSE", T)).toMatchObject({ bidQty: null, askQty: null });
  });

  it("lists FINNIFTY, MIDCPNIFTY and the stock-option underlyings with the reference lots; BANKEX stays absent", () => {
    const rows = demoInstruments(T);
    const lotOf = (u, type) => rows.find((r) => r.underlying === u && r.instrumentType === type)?.lotSize;
    expect(lotOf("FINNIFTY", "OPTIDX")).toBe(60);
    expect(lotOf("MIDCPNIFTY", "OPTIDX")).toBe(120);
    for (const [u, lot] of [["RELIANCE", 525], ["HDFCBANK", 750], ["ICICIBANK", 550], ["INFY", 500], ["SBIN", 850]]) {
      expect(lotOf(u, "OPTSTK"), u).toBe(lot);
      expect(lotOf(u, "FUTSTK"), u).toBe(lot);
    }
    expect(rows.some((r) => r.underlying === "BANKEX")).toBe(false);
    // P1-6 lists options on every demo stock (it supersedes P1-1's five), indices first.
    expect(rows.some((r) => r.underlying === "TCS" && r.instrumentType === "OPTSTK")).toBe(true);
    expect(DEMO_OPTION_UNDERLYINGS.slice(0, 5)).toEqual(["NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY"]);
    expect(DEMO_OPTION_UNDERLYINGS).toHaveLength(5 + 50);
    expect(rows.filter((r) => r.strike !== null).every((r) => r.strike > 0)).toBe(true);
  });
});

describe("demo recorder (p1-01 §8, e2e step 5)", () => {
  let app;
  let base;
  let key;
  let dir;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "mcb-demo-rec-"));
    const { config } = loadConfig({ raw: { dataDir: dir, server: { port: 0 }, logging: { level: "silent" } }, env: {}, demo: true });
    app = await createApp({ config, logger: createNullLogger() });
    const { port } = await app.listen();
    base = `http://127.0.0.1:${port}`;
    ({ key } = await app.deps.keyStore.create({ label: "t", scopes: ["admin", "paper"], accounts: "*" }));
  });
  afterAll(async () => {
    await app?.close();
  });
  const get = async (path) => {
    const r = await fetch(base + path, { headers: { Authorization: `Bearer ${key}` } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  it("records into its own folder: 1 chain by stream, the rest by REST, BANKEX refused, five stocks every 5 minutes", async () => {
    const st = (await get("/v1/options/recorder")).body.data;
    expect(st).toMatchObject({ demo: true, account: { id: "demo", broker: "demo" }, session: { alwaysOpen: true } });
    expect(st.plan.capacity.stream).toMatchObject({ cap: 300, feedLimit: 500 });
    expect(st.plan.chains.filter((c) => c.source === "stream").map((c) => c.underlying)).toEqual(["NIFTY"]);
    expect(st.plan.chains.filter((c) => c.kind === "index" && c.source === "rest")).toHaveLength(14);
    expect(st.plan.chains.filter((c) => c.kind === "stock").map((c) => [c.underlying, c.everyMinutes, c.source])).toEqual(["RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "SBIN"].map((u) => [u, 5, "rest"]));
    expect(st.plan.refused).toEqual([expect.objectContaining({ underlying: "BANKEX", reason: "not-offered" })]);
    expect(existsSync(join(dir, "recorder-demo"))).toBe(true);
    expect(existsSync(join(dir, "recorder"))).toBe(false);
  });

  it("within seconds the nearest NIFTY expiry has back-filled minutes since the day start, and daily rows for previous weekdays", async () => {
    const e = (await get("/v1/expiries?underlying=NIFTY")).body.data.expiries[0];
    let page = null;
    for (let i = 0; i < 100; i++) {
      page = (await get(`/v1/options/snapshots?underlying=NIFTY&expiry=${e}&from=${new Date(Date.now() + 19_800_000).toISOString().slice(0, 10)}&fields=oi,ltp&limit=500`)).body.data;
      if (page.snapshots.length > 3) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(page.snapshots.length).toBeGreaterThan(3);
    expect(new Set(page.snapshots.map((s) => s.quality))).toEqual(expect.objectContaining({}));
    expect(page.snapshots.some((s) => s.quality === "demo-backfill")).toBe(true);
    expect(page.snapshots.every((s) => s.quality === "demo-backfill" || s.quality === "demo")).toBe(true);
    await app.deps.recorder.backfillDone();
    const daily = (await get("/v1/options/daily?underlying=NIFTY")).body.data.rows;
    expect(new Set(daily.map((r) => r.date)).size).toBeGreaterThanOrEqual(2);
  }, 30_000);
});

describe("demo mode config", () => {
  it("replaces accounts, forces live trading off and keeps real brokers out", () => {
    const { config, warnings } = loadConfig({
      raw: { dataDir: "/tmp/x", safety: { liveTrading: true }, accounts: [{ id: "dhan-main", broker: "dhan", live: { enabled: true } }] },
      env: {},
      demo: true,
      knownBrokers: createBrokerRegistry().list(),
    });
    expect(config.demo).toBe(true);
    expect(config.safety.liveTrading).toBe(false);
    expect(config.accounts.map((a) => [a.id, a.broker, a.holder])).toEqual([
      ["demo", "demo", "demo"],
      ["demo-paper", "paper", "demo"],
      ["demo-paper-spouse", "paper", "demo-spouse"],
      ["demo-paper-other", "paper", "demo-other"],
    ]);
    expect(warnings.join(" ")).toMatch(/DEMO MODE/);
  });

  it("MCB_DEMO=1 and \"demo\": true turn it on; a demo account outside demo mode is refused", () => {
    expect(loadConfig({ raw: {}, env: { MCB_DEMO: "1" } }).config.demo).toBe(true);
    expect(loadConfig({ raw: { demo: true }, env: {} }).config.demo).toBe(true);
    expect(() => loadConfig({ raw: { accounts: [{ id: "x1", broker: "demo" }] }, env: {}, knownBrokers: createBrokerRegistry().list() })).toThrow(/unknown broker demo/);
  });
});

describe("demo mode end to end", () => {
  let app;
  let base;
  let key;
  let dir;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "mcb-demo-"));
    const { config } = loadConfig({ raw: { dataDir: dir, server: { port: 0 }, logging: { level: "silent" } }, env: {}, demo: true });
    app = await createApp({ config, logger: createNullLogger() });
    const { port } = await app.listen();
    base = `http://127.0.0.1:${port}`;
    ({ key } = await app.deps.keyStore.create({ label: "t", scopes: ["admin", "paper"], accounts: "*" }));
  });
  afterAll(async () => {
    await app?.close();
  });
  const get = async (path) => {
    const r = await fetch(base + path, { headers: { Authorization: `Bearer ${key}` } });
    return { status: r.status, demo: r.headers.get(DEMO_HEADER), body: await r.json().catch(() => null) };
  };

  it("serves labelled quotes, chains and history from the demo account", async () => {
    const h = await get("/v1/health");
    expect(h).toMatchObject({ status: 200, demo: "demo", body: { demo: true } });
    const q = await get("/v1/quotes?symbols=NSE:NIFTY,BSE:SENSEX,NSE:RELIANCE");
    expect(q.status).toBe(200);
    expect(q.demo).toBe("demo");
    expect(q.body.meta).toMatchObject({ demo: true });
    expect(q.body.data.map((x) => x.freshness.broker)).toEqual(["demo", "demo", "demo"]);
    const e = await get("/v1/expiries?underlying=NIFTY");
    const c = await get(`/v1/optionchain?underlying=NIFTY&expiry=${e.body.data.expiries[0]}&strikes=3&greeks=true`);
    expect(c.status).toBe(200);
    expect(c.body.data.rows).toHaveLength(7);
    expect(c.body.data.rows[3].ce.delta).toBeGreaterThan(0);
    const hist = await get("/v1/history?symbol=NSE:NIFTY&interval=1d&countback=5");
    expect(hist.body.data.candles).toHaveLength(5);
    const cell = await fetch(`${base}/xl/ltp?symbol=NSE:NIFTY`, { headers: { Authorization: `Bearer ${key}` } });
    expect(cell.headers.get(DEMO_HEADER)).toBe("demo");
  });

  it("places paper orders and refuses live ones; writes no secrets file or master key", async () => {
    const order = (mode) =>
      fetch(`${base}/v1/orders`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json", "Idempotency-Key": `demo-test-${mode}-0001` },
        body: JSON.stringify({ account: "demo-paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "MARKET", mode }),
      });
    const paper = await order("paper");
    expect(paper.status).toBe(201);
    expect((await paper.json()).data.mode).toBe("paper");
    const live = await order("live");
    expect(live.status).toBeGreaterThanOrEqual(400);
    expect(existsSync(join(dir, "secrets.enc"))).toBe(false);
    expect(existsSync(join(dir, "master.key"))).toBe(false);
  });

  it("errors are labelled too", async () => {
    const r = await get("/v1/quotes");
    expect(r.status).toBe(400);
    expect(r.demo).toBe("demo");
  });

  it("an unknown account points at the demo account ids", async () => {
    const r = await get("/v1/positions?account=paper");
    expect(r.body.code).toBe("ACCOUNT_NOT_FOUND");
    expect(r.body.detail).toContain('"demo-paper"');
    expect(r.body.detail).toContain('"demo-paper-spouse"');
  });
});

describe("public demo dashboard (server.remoteDashboard)", () => {
  const get = (port, path, host) =>
    new Promise((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port, path, headers: { host, "x-forwarded-for": "203.0.113.9" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      r.on("error", reject);
      r.end();
    });
  const boot = async (remoteDashboard) => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-pubdemo-"));
    const { config } = loadConfig({ raw: { dataDir: dir, demo: true, server: { port: 0, allowedHosts: ["demo.example.com"], remoteDashboard }, logging: { level: "silent" } }, env: {} });
    const app = await createApp({ config, logger: createNullLogger() });
    const { port } = await app.listen();
    return { app, port };
  };

  it("serves the dashboard through a proxy only when switched on; key routes stay this-computer-only", async () => {
    const off = await boot(false);
    try {
      expect(await get(off.port, "/dashboard", "demo.example.com")).toBe(403);
    } finally {
      await off.app.close();
    }
    const on = await boot(true);
    try {
      expect(await get(on.port, "/dashboard", "demo.example.com")).toBe(200);
      expect(await get(on.port, "/dashboard/app.js", "demo.example.com")).toBe(200);
      expect(await get(on.port, "/v1/accounts", "demo.example.com")).toBe(401);
      expect(await get(on.port, "/dashboard", "evil.example.net")).toBe(403);
    } finally {
      await on.app.close();
    }
  });
});
