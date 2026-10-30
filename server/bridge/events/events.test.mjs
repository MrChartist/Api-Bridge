/**
 * Live events (stream S28): detectors with fixtures and edge cases, the engine's dedupe / cool-down, the routes,
 * the stream topic, a demo end to end and a throughput check (engine per-tick p95 under a 2,000 events/s load).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { resolveStreamConfig } from "../stream/config.mjs";
import { createFakeStreamHub } from "../stream/fake.mjs";
import { createClientSession } from "../stream/protocol.mjs";
import { KINDS, PRESETS, defaultParams } from "./catalogue.mjs";
import { circuitAt, createStockState, detectFuture, detectStock, pivots, volumeShareAt, MinuteRing } from "./detectors.mjs";
import { createEventsEngine, normaliseSelection, compileSelection } from "./engine.mjs";
import { contextFromCandles } from "./feed.mjs";
import { createChainState, detectChain, detectLeg, legOf } from "./optionDetectors.mjs";
import { createDemoMarket } from "./demoMarket.mjs";

const T0 = Date.parse("2026-10-30T10:00:00+05:30"); // minute 45 of the session
const all = () => compileSelection(normaliseSelection({}));
const t = (minute, ms = T0) => ({ ms, minute });
const kinds = (hits) => hits.map((h) => h.kind);

describe("catalogue", () => {
  it("every kind has a definition, a category and default params; presets name real kinds", () => {
    const ids = new Set(KINDS.map((k) => k.kind));
    for (const k of KINDS) {
      expect(k.def.length).toBeGreaterThan(20);
      expect(defaultParams(k.kind)).toBeTypeOf("object");
    }
    for (const p of PRESETS) for (const k of p.kinds) expect(ids.has(k)).toBe(true);
  });
  it("normaliseSelection clamps params and drops junk", () => {
    const s = normaliseSelection({ kinds: { vol_surge: { on: false, params: { multiple: 999 } }, nope: { on: true } }, cooldownSeconds: 1, watchlist: ["nse:reliance", "bad"] });
    expect(s.kinds.vol_surge).toEqual({ on: false, params: { multiple: 20, minMinutes: 10 } });
    expect(s.kinds.nope).toBeUndefined();
    expect(s.cooldownSeconds).toBe(10);
    expect(s.watchlist).toEqual(["NSE:RELIANCE"]);
  });
});

describe("stock detectors", () => {
  it("day high fires only after the first N minutes", () => {
    const s = createStockState({}, { prevClose: 100 });
    const sel = all();
    detectStock(s, { ltp: 100, high: 100, low: 99, close: 100 }, sel, t(2));
    expect(kinds(detectStock(s, { ltp: 101, high: 101, low: 99, close: 100 }, sel, t(5)))).not.toContain("day_high");
    expect(kinds(detectStock(s, { ltp: 102, high: 102, low: 99, close: 100 }, sel, t(20)))).toContain("day_high");
  });
  it("gap up at the open, then gap filled", () => {
    const s = createStockState({}, { prevClose: 100 });
    const sel = all();
    expect(kinds(detectStock(s, { ltp: 103, open: 103, high: 103, low: 103, close: 100 }, sel, t(0)))).toContain("gap_up");
    const h = detectStock(s, { ltp: 99.9, open: 103, high: 103, low: 99.9, close: 100 }, sel, t(30));
    expect(h.find((x) => x.kind === "gap_filled")).toMatchObject({ dir: -1 });
  });
  it("a gap is not announced late in the day (Bridge started after the open)", () => {
    const s = createStockState({}, { prevClose: 100 });
    expect(kinds(detectStock(s, { ltp: 104, open: 104, close: 100 }, all(), t(120)))).not.toContain("gap_up");
  });
  it("circuit bands match every tick rounding; only buyers and the unlock", () => {
    expect(circuitAt({ ltp: 172.75 }, 164.52, 0.05)).toMatchObject({ at: "upper", bandPct: 5 });
    expect(circuitAt({ ltp: 172.74 }, 164.52, 0.01)).toMatchObject({ at: "upper", bandPct: 5 });
    expect(circuitAt({ ltp: 156.29 }, 164.52, 0.01)).toMatchObject({ at: "lower", bandPct: 5 });
    expect(circuitAt({ ltp: 170 }, 164.52, 0.05).at).toBeNull();
    expect(circuitAt({ ltp: 50, upper: 50 }, 47.66, 0.05)).toMatchObject({ at: "upper", price: 50 });
    const s = createStockState({ tick: 0.05 }, { prevClose: 164.52 });
    const sel = all();
    detectStock(s, { ltp: 170, close: 164.52, bidQty: 10, askQty: 10 }, sel, t(30));
    const lock = detectStock(s, { ltp: 172.75, close: 164.52, bidQty: 90000, askQty: 0, bid: 172.75, ask: null }, sel, t(31));
    expect(lock.find((x) => x.kind === "only_buyers")?.text).toMatch(/upper circuit 5 %/);
    const un = detectStock(s, { ltp: 172.5, close: 164.52, bidQty: 100, askQty: 200 }, sel, t(40));
    expect(un.find((x) => x.kind === "circuit_unlocked")).toMatchObject({ variant: "upper", dir: -1 });
  });
  it("only sellers at the lower band with no bids", () => {
    const s = createStockState({}, { prevClose: 50.22 });
    const h = detectStock(s, { ltp: 47.71, close: 50.22, bidQty: 0, askQty: 5000, bid: null, ask: 47.71 }, all(), t(30));
    expect(kinds(h)).toContain("only_sellers");
  });
  it("volume above prev day and a surge against the intraday curve", () => {
    const s = createStockState({}, { prevClose: 100, prevVolume: 1000, avgVolume: 1000 });
    const sel = all();
    const h = detectStock(s, { ltp: 101, close: 100, volume: 1200 }, sel, t(60));
    expect(kinds(h)).toEqual(expect.arrayContaining(["vol_above_prev", "vol_surge"]));
    expect(h.find((x) => x.kind === "vol_above_prev").text).toMatch(/1\.2× prev-day volume/);
    expect(volumeShareAt(0)).toBe(0);
    expect(volumeShareAt(375)).toBe(1);
  });
  it("missing previous-day data (holiday, new listing): level kinds stay quiet, nothing throws", () => {
    const s = createStockState({}, {});
    const sel = all();
    detectStock(s, { ltp: 100 }, sel, t(30));
    const h = detectStock(s, { ltp: 120, volume: 1e9 }, sel, t(31));
    expect(kinds(h).filter((k) => ["prev_high_break", "vol_above_prev", "vol_surge", "pivot_cross", "high_52w", "move_pct"].includes(k))).toEqual([]);
  });
  it("% move levels, prev-day and 52-week breaks, pivots, VWAP and swings", () => {
    const ctx = { prevClose: 100, prevHigh: 101, prevLow: 98, high52: 104 };
    expect(pivots(ctx)).toMatchObject({ P: 99.67 });
    const s = createStockState({}, ctx);
    const sel = all();
    detectStock(s, { ltp: 100, close: 100, avgPrice: 100 }, sel, t(30));
    detectStock(s, { ltp: 99, close: 100, avgPrice: 100 }, sel, t(31));
    const h = detectStock(s, { ltp: 105, close: 100, avgPrice: 100 }, sel, t(32));
    expect(kinds(h)).toEqual(expect.arrayContaining(["move_pct", "prev_high_break", "high_52w", "pivot_cross", "vwap_cross", "swing_up"]));
  });
  it("futures OI build-up and surge", () => {
    const s = createStockState({}, {});
    const sel = all();
    detectFuture(s, { ltp: 100, close: 100, oi: 1_000_000 }, sel, t(30));
    const h = detectFuture(s, { ltp: 101, close: 100, oi: 1_050_000 }, sel, t(40));
    expect(h.find((x) => x.kind === "oi_buildup")).toMatchObject({ variant: "LB", dir: 1 });
    expect(kinds(h)).toContain("oi_surge");
  });
  it("MinuteRing reads N minutes ago", () => {
    const r = new MinuteRing(8);
    for (let m = 0; m < 20; m++) r.put(m, m * 10);
    expect(r.ago(19, 5)).toBe(140);
    expect(r.ago(19, 30)).toBeNull();
  });
  it("context from daily candles drops today's bar", () => {
    const c = Array.from({ length: 30 }, (_, i) => ({ time: `2026-09-${String(i + 1).padStart(2, "0")}`, open: 100, high: 101 + i, low: 99 - i, close: 100 + i, volume: 1000 }));
    c.push({ time: "2026-10-30", open: 1, high: 1, low: 1, close: 1, volume: 1 });
    expect(contextFromCandles(c, "2026-10-30")).toMatchObject({ prevClose: 129, prevHigh: 130, avgVolume: 1000, high52: 130 });
    expect(contextFromCandles([], "2026-10-30")).toBeNull();
  });
});

describe("option detectors", () => {
  it("strike OI surge against its own pace, premium spike, unusual volume, build-up", () => {
    const c = createChainState({ underlying: "NIFTY", expiry: "2026-11-03", lot: 65 });
    c.spot = 25000;
    const leg = legOf(c, 25000, "CE", "NFO:NIFTY-2026-11-03-25000-CE");
    const sel = all();
    let found = [];
    for (let m = 0; m < 12; m++) found.push(...detectLeg(c, leg, { ltp: 100, oi: 1_000_000 + m * 650, volume: m * 650 }, sel, t(30 + m)));
    const h = detectLeg(c, leg, { ltp: 140, oi: 1_000_000 + 12 * 650 + 65 * 900, volume: 2_000_000 }, sel, t(42));
    found = [...found, ...h];
    expect(kinds(found)).toEqual(expect.arrayContaining(["opt_oi_surge", "opt_premium_spike", "opt_unusual_volume", "opt_buildup"]));
    expect(h.find((x) => x.kind === "opt_oi_surge").dir).toBe(-1); // call writing reads bear
  });
  it("chain detectors: wall shift, PCR cross and max pain shift (throttled)", () => {
    const c = createChainState({ underlying: "NIFTY", expiry: "2026-11-03", lot: 1 });
    c.spot = 25000;
    const sel = all();
    const put = (k, r, oi) => detectLeg(c, legOf(c, k, r), { ltp: 10, oi }, sel, t(30));
    for (const k of [24900, 25000, 25100]) (put(k, "CE", k === 25100 ? 5000 : 1000), put(k, "PE", k === 24900 ? 800 : 500));
    expect(detectChain(c, sel, t(30, T0))).toEqual([]);
    put(25000, "CE", 9000);
    put(24900, "PE", 14000);
    expect(detectChain(c, sel, t(31, T0 + 100))).toEqual([]); // inside chainEveryMs
    const h = detectChain(c, sel, t(31, T0 + 2000));
    expect(kinds(h)).toEqual(expect.arrayContaining(["wall_shift", "pcr_cross"]));
  });
});

describe("engine", () => {
  it("dedupes repeats inside the cool-down, counts them, and flags the first of the day", () => {
    let now = T0;
    const bus = createEventBus();
    const seen = [];
    bus.on("market.event", (p) => seen.push(p.type));
    const e = createEventsEngine({ clock: { now: () => now }, bus });
    e.register({ symbol: "NSE:ABC", kind: "EQ", name: "Abc Ltd" });
    e.setContext("NSE:ABC", { prevClose: 100 });
    e.ingest({ symbol: "NSE:ABC", ltp: 100, high: 100, low: 100, close: 100 });
    for (let i = 1; i <= 5; i++) {
      now += 10_000;
      e.ingest({ symbol: "NSE:ABC", ltp: 100 + i, high: 100 + i, low: 100, close: 100 });
    }
    const highs = e.list({ kinds: ["day_high"] });
    expect(highs).toHaveLength(1);
    expect(highs[0]).toMatchObject({ count: 5, first: true, side: "bull", name: "Abc Ltd" });
    expect(seen).toContain("update");
    now += 400_000;
    e.ingest({ symbol: "NSE:ABC", ltp: 110, high: 110, low: 100, close: 100 });
    const again = e.list({ kinds: ["day_high"] });
    expect(again).toHaveLength(2);
    expect(again[0].first).toBe(false);
    expect(e.summary().bySide.bull).toBeGreaterThan(0);
    expect(e.symbolView("NSE:ABC").events.length).toBeGreaterThan(0);
  });
  it("a disabled kind does not fire", () => {
    const e = createEventsEngine({ clock: { now: () => T0 } });
    e.setSelection({ kinds: { day_high: { on: false } } });
    e.register({ symbol: "NSE:ABC", kind: "EQ" });
    e.ingest({ symbol: "NSE:ABC", ltp: 100, high: 100, low: 100, close: 100 });
    e.ingest({ symbol: "NSE:ABC", ltp: 101, high: 101, low: 100, close: 100 });
    expect(e.list({ kinds: ["day_high"] })).toEqual([]);
  });
});

describe("demo market and throughput", () => {
  it("replays a morning with a believable mix of stock and option events", () => {
    let now = T0 + 30 * 60_000;
    let dm;
    const e = createEventsEngine({ clock: { now: () => now }, sessionOf: (ms) => dm.sessionOf(ms) });
    dm = createDemoMarket({ engine: e, clock: { now: () => now }, startMs: now });
    dm.backfill(now, 30);
    const s = e.summary();
    for (const k of ["day_high", "day_low", "gap_up", "move_pct", "only_buyers", "opt_buildup", "opt_premium_spike"]) expect(s.byKind[k] ?? 0, k).toBeGreaterThan(0);
    expect(s.bySide.bull).toBeGreaterThan(0);
    expect(s.bySide.bear).toBeGreaterThan(0);
  });
  it("engine p95 per tick stays well under 1 ms at 2,000 events/s across 500+ symbols", () => {
    let now = T0;
    const bus = createEventBus();
    let n = 0;
    bus.on("market.event", () => (n += 1));
    let dm;
    const e = createEventsEngine({ clock: { now: () => now }, bus, sessionOf: (ms) => dm.sessionOf(ms) });
    e.setSelection({ cooldownSeconds: 10 });
    dm = createDemoMarket({ engine: e, clock: { now: () => now }, startMs: now, scale: 5 });
    const t0 = performance.now();
    let quotes = 0;
    for (let i = 0; i < 60; i++) {
      now += 1000;
      quotes += dm.step(now, { dtSec: 20 });
    }
    const wall = performance.now() - t0;
    const st = e.stats();
    expect(st.symbols).toBeGreaterThan(500);
    expect(st.perTickMs.p95).toBeLessThan(1);
    // Throughput: quotes processed per second of CPU (the engine, the simulator and the bus together).
    expect((quotes / wall) * 1000).toBeGreaterThan(2000);
    expect(n).toBeGreaterThan(100);
  });
});

describe("stream topic", () => {
  it("subscribe_events delivers market_event messages, filtered, and conflates updates per id", async () => {
    const bus = createEventBus();
    const hub = createFakeStreamHub({ bus, accountId: "a", broker: "dhan" });
    const sent = [];
    const transport = { kind: "ws", write: (m) => sent.push(structuredClone(m)), bufferedBytes: () => 0, close() {}, onDrain() {} };
    const s = createClientSession({ id: "ws_ev", kind: "ws", key: { id: "k1", scopes: ["read"], accounts: "*" }, hub, bus, transport, config: resolveStreamConfig({}), clock: { now: () => Date.now() }, logger: createNullLogger() });
    await s.handleOp({ op: "subscribe_events", asset: "stock" });
    bus.emit("market.event", { type: "new", event: { id: "e1", asset: "stock", kind: "day_high", side: "bull", count: 1 } });
    bus.emit("market.event", { type: "update", event: { id: "e1", asset: "stock", kind: "day_high", side: "bull", count: 2 } });
    bus.emit("market.event", { type: "new", event: { id: "e2", asset: "option", kind: "iv_spike", side: "neutral", count: 1 } });
    await new Promise((r) => setImmediate(r));
    const ev = sent.filter((m) => m.type === "market_event");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ action: "new", event: { id: "e1", count: 2 } });
    await s.handleOp({ op: "unsubscribe_events" });
    bus.emit("market.event", { type: "new", event: { id: "e3", asset: "stock", kind: "day_low", side: "bear", count: 1 } });
    await new Promise((r) => setImmediate(r));
    expect(sent.filter((m) => m.type === "market_event")).toHaveLength(1);
    s.close("test");
  });
});

describe("routes (demo Bridge end to end)", () => {
  it("lists, summarises, saves the selection and reads one symbol", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-events-"));
    const { config } = loadConfig({ raw: { dataDir, server: { port: 0 }, logging: { level: "silent" } }, env: {}, demo: true });
    const KEY = "mcb_e2eread0001_aaaaaaaaaaaaaaaaaaaa";
    const keyStore = { ...notImplementedService("keyStore"), authenticate: async (raw) => (raw === KEY ? { id: "e2eread0001", label: "r", scopes: ["read"], accounts: "*" } : null) };
    const app = await createApp({ config, overrides: { keyStore }, logger: createNullLogger() });
    const { port } = await app.listen();
    const get = async (path, init = {}) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...(init.headers ?? {}) } });
      return { status: r.status, body: await r.json() };
    };
    try {
      await app.start?.();
      const deadline = Date.now() + 20_000;
      let list;
      do {
        await new Promise((r) => setTimeout(r, 200));
        list = await get("/v1/events?limit=50");
      } while (list.body.data.length === 0 && Date.now() < deadline);
      expect(list.status).toBe(200);
      expect(list.body.data.length).toBeGreaterThan(0);
      expect((await get("/v1/events/catalogue")).body.data.kinds.length).toBe(KINDS.length);
      expect((await get("/v1/events/summary")).body.data.total).toBeGreaterThan(0);
      expect((await get("/v1/events?kind=nope")).status).toBe(400);
      const put = await get("/v1/events/selection", { method: "PUT", body: JSON.stringify({ kinds: { vwap_cross: { on: false } }, watchlist: ["NSE:TCS"] }) });
      expect(put.body.data.kinds.vwap_cross.on).toBe(false);
      expect((await get("/v1/events/selection")).body.data.watchlist).toEqual(["NSE:TCS"]);
      const sym = list.body.data[0].symbol;
      expect((await get(`/v1/events/symbols/${encodeURIComponent(sym)}`)).body.data.symbol).toBe(sym);
      expect((await get("/v1/events/status")).body.data.mode).toBe("demo");
    } finally {
      await app.close?.();
    }
  }, 40_000);
});
