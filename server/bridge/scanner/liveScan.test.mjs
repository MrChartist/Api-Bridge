/**
 * Live scans: the plain-word builder and its round trip through the Advanced text, the facts maths, every library
 * scan with realistic demo hits, saved-scan editing, scheduling at the close and "Scan hit" rows, and the API budget:
 * a 200-symbol scan through the REAL market-data service and scheduler, counting broker calls cold and warm.
 */
import { AsyncResource } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { COLUMNS, FACTS, OPERANDS, compileModel, describeModel, filterRows, matchOperand, resultsCsv, ruleWords, searchOperands, sortRows } from "../dashboard/scan-builder.js";
import { LIBRARY, libraryRequest } from "../dashboard/scan-library.js";
import { stubStreamHub } from "../market/__fixtures__/helpers.mjs";
import { createMarketDataService } from "../market/marketDataService.mjs";
import { createManualClock } from "../ratelimit/fake.mjs";
import { createScheduler } from "../ratelimit/scheduler.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { decompile } from "./decompile.mjs";
import { parseExpression, toText } from "./expr.mjs";
import { buildFacts, chainFacts, dailyFacts } from "./facts.mjs";
import { needsOf } from "./liveFacts.mjs";
import { createScannerRoutes } from "./routes.mjs";
import { SCANNER_CONSUMER, createScanner } from "./scanService.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const live = (src) => parseExpression(src, { fields: FACTS.map((f) => f.id) });

describe("plain-word builder", () => {
  it("compiles rules to the condition language and reads them back as words", () => {
    const model = {
      join: "and",
      rules: [
        { left: { id: "close" }, op: "gt", right: { id: "high_n", p: { n: 20 } } },
        { left: { id: "volume" }, op: "gt", right: { id: "avg_volume_n", p: { n: 20 } }, mult: 2 },
        { join: "or", rules: [{ left: { id: "pcr" }, op: "gte", right: { num: 1.5 } }, { left: { id: "nr7" }, op: "yes" }] },
      ],
    };
    const c = compileModel(model);
    expect(c.errors).toEqual([]);
    expect(c.text).toBe("close > highest(20)[1] and volume > 2 * avg_volume(20)[1] and (pcr >= 1.5 or nr7 == 1)");
    expect(ruleWords(model.rules[0])).toBe("Close is above 20-day high");
    expect(ruleWords(model.rules[1])).toBe("Volume is more than 2× 20-day average volume");
    expect(describeModel(model)).toBe("Close is above 20-day high and Volume is more than 2× 20-day average volume and (PCR (OI) is at least 1.5 or Yesterday was NR7)");
    // The text parses, with the facts as fields.
    expect(() => live(c.text)).not.toThrow();
  });

  it("validates parameters, numbers and multiples", () => {
    const bad = compileModel({ join: "and", rules: [{ left: { id: "high_n", p: { n: 1 } }, op: "lt", right: { num: "" } }, { left: { id: "volume" }, op: "gt", right: { id: "avg_volume_n", p: { n: 2.5 } }, mult: -1 }, { left: { id: "close" }, op: "?", right: { id: "open" } }] });
    expect(bad.errors.map((e) => e.path)).toEqual(["rules.0.left.n", "rules.0.right", "rules.1.right.n", "rules.1.mult", "rules.2.op"]);
    expect(bad.errors[0].message).toBe("Days: from 2 to 250.");
  });

  it("matches value templates and searches by words", () => {
    expect(matchOperand("highest(55)[1]")).toEqual({ id: "high_n", p: { n: 55 } });
    expect(matchOperand("-2.5")).toEqual({ num: -2.5 });
    expect(matchOperand("iv_rank")).toEqual({ id: "iv_rank" });
    expect(matchOperand("highest(20)")).toBeNull();
    expect(searchOperands("oi change").map((o) => o.id)).toContain("fut_oi_change_pct");
    expect(searchOperands("52").map((o) => o.id)).toEqual(expect.arrayContaining(["high_52w", "low_52w"]));
    expect(OPERANDS.length).toBeGreaterThan(40);
  });

  it("round-trips every library scan through the Advanced text, and says why when it cannot", () => {
    for (const s of LIBRARY) {
      const d = decompile(s.condition);
      expect(d.reason, s.id).toBeNull();
      expect(compileModel(d.model).text, s.id).toBe(s.condition);
    }
    const hand = decompile("close  >  2*avg_volume(20)[1] and ( pcr>=1.5 or iv_rank<20 )");
    expect(hand.model.rules[0]).toEqual({ left: { id: "close" }, op: "gt", right: { id: "avg_volume_n", p: { n: 20 } }, mult: 2 });
    expect(hand.text).toBe("close > 2 * avg_volume(20)[1] and (pcr >= 1.5 or iv_rank < 20)");
    expect(decompile("close / sma(50) > 1.02").reason).toMatch(/not a value the builder lists/);
    expect(decompile("not nr7 == 1").reason).toMatch(/not a comparison/);
    expect(() => decompile("close >")).toThrow(/ends too early/);
  });

  it("prints canonical text that parses back to the same tree", () => {
    for (const src of ["close > highest(20)[1]", "-(close - open) * 2 > atr(14)", "rsi(14) > 60 and (macd(12, 26) crosses above macd_signal(12, 26, 9) or not close < sma(50))"]) {
      const t = parseExpression(src);
      expect(parseExpression(toText(t))).toEqual(t);
    }
    expect(toText(parseExpression("rsi() > 50"))).toBe("rsi(14) > 50");
  });

  it("sorts, filters and exports result rows", () => {
    const rows = [
      { symbol: "NSE:A", isNew: true, facts: { ltp: 10, change_pct: 2, sector: "IT", fno: true, indices: ["NIFTY 50"] } },
      { symbol: "NSE:B", facts: { ltp: 20, change_pct: null, sector: "Banks", fno: false, indices: [] } },
      { symbol: "NSE:C", facts: { ltp: 5, change_pct: -1, sector: "IT", fno: true, indices: [] } },
    ];
    expect(sortRows(rows, "change_pct", -1).map((r) => r.symbol)).toEqual(["NSE:A", "NSE:C", "NSE:B"]);
    expect(sortRows(rows, "sector", 1).map((r) => r.symbol)).toEqual(["NSE:B", "NSE:A", "NSE:C"]);
    expect(filterRows(rows, { sector: "IT", index: "NIFTY 50" }).map((r) => r.symbol)).toEqual(["NSE:A"]);
    expect(filterRows(rows, { fnoOnly: true })).toHaveLength(2);
    const csv = resultsCsv(rows.slice(0, 1), COLUMNS.filter((c) => ["ltp", "change_pct", "sector"].includes(c.id)));
    expect(csv).toBe('symbol,new,ltp,change_pct,sector\n"NSE:A",1,10,2,"IT"');
  });
});

describe("facts", () => {
  const day = (i, o, h, l, c, v = 1000) => ({ time: 1_790_000_000 + i * 86_400, open: o, high: h, low: l, close: c, volume: v });

  it("NR7, inside day, 52-week and 20-day levels from completed bars", () => {
    const bars = Array.from({ length: 30 }, (_, i) => day(i, 100, 104 + (i % 3), 96 - (i % 2), 100 + (i % 5)));
    bars.push(day(30, 100, 103, 98, 101)); // range 5, inside the day before (104..96) and the narrowest of 7
    const f = dailyFacts(bars);
    expect(f.nr7).toBe(1);
    expect(f.inside_day).toBe(1);
    expect(f.high_52w).toBe(106);
    expect(f.prev_high).toBe(103);
    expect(f.avg_volume_20).toBe(1000);
    bars.push(day(31, 100, 110, 90, 105));
    expect(dailyFacts(bars).nr7).toBe(0);
  });

  it("chain facts: PCR, ATM IV, skew, max pain, straddle against the expected move, OI change and volume / OI", () => {
    const leg = (ltp, iv, oi, oiChange = 0, volume = 0) => ({ ltp, iv, oi, oiChange, volume });
    const rows = [900, 950, 1000, 1050, 1100].map((k) => ({ strike: k, ce: leg(Math.max(5, 1000 - k + 30), 20 - (k - 1000) / 100, 1000 + (k > 1000 ? 4000 : 0)), pe: leg(Math.max(5, k - 1000 + 30), 20 + (1000 - k) / 50, 2000 + (k < 1000 ? 3000 : 0), k === 950 ? 2500 : 0, k === 1000 ? 6000 : 100) }));
    const now = Date.parse("2026-10-20T10:00:00+05:30");
    const c = chainFacts({ expiry: "2026-10-27", underlyingLtp: 1000, rows }, 1000, now);
    expect(c.atm).toBe(1000);
    expect(c.pcr).toBeCloseTo(16000 / 13000, 3);
    expect(c.atm_iv).toBe(20);
    expect(c.put_skew).toBe(1); // 950 put: 21 vs 20
    expect(c.call_skew).toBe(-0.5);
    expect(c.straddle).toBe(60);
    expect(c.top_oi_chg_strike).toBe(950);
    expect(c.top_oi_chg_pct).toBeCloseTo((2500 / 2500) * 100, 5);
    expect(c.max_vol_oi).toBe(3); // 6000 / 2000 at 1000 PE
    expect(c.dte).toBeCloseTo(7.23, 1);
    expect(c.straddle_vs_move).toBeGreaterThan(0.8);
  });

  it("futures, MWPL and live numbers", () => {
    const now = Date.parse("2026-10-20T12:00:00+05:30");
    const f = buildFacts({ quote: { ltp: 105, open: 103, high: 106, low: 102, close: 100, volume: 5000 }, daily: { avg_volume_20: 4000, prev_high: 104 }, fut: { near: { ltp: 106, close: 101, oi: 1100 }, next: { oi: 900 }, prevOi: 1000, expiry: "2026-10-27" }, mwpl: { mwplPct: 88, inBan: false }, meta: { fno: true } }, now);
    expect(f.change_pct).toBe(5);
    expect(f.gap_pct).toBe(3);
    expect(f.fut_oi_change_pct).toBe(10);
    expect(f.basis).toBe(1);
    expect(f.rollover_pct).toBe(45);
    expect(f.basis_ann_pct).toBeGreaterThan(40);
    expect(f.upper_circuit).toBe(110);
    expect(f.to_upper_circuit_pct).toBeCloseTo(4.76, 2);
    expect(f.vol_pace).toBeGreaterThan(1.25); // 5000 by noon against 4000 a full day
    expect(f.in_ban).toBe(0);
    expect(f.iv_rank).toBeNull(); // no chain
  });

  it("reads only the data parts a condition needs", () => {
    expect([...needsOf([live("gap_pct > 2")])]).toEqual([]);
    expect([...needsOf([live("close > highest(20)[1]")])]).toEqual(["daily"]);
    expect([...needsOf([live("fut_oi_change_pct > 3 and iv_rank > 80")])].sort()).toEqual(["chain", "futures", "futuresPrevOi", "ivHistory"]);
    expect([...needsOf([live("mwpl_pct >= 80")])]).toEqual(["mwpl"]);
  });
});

function demoScanner(extra = {}) {
  const bus = createEventBus({ logger: createNullLogger() });
  const scanner = createScanner({ config: { demo: true }, marketData: {}, accounts: {}, scheduler: {}, bus, clock: { now: () => Date.now() }, paths: {}, ...extra });
  return { scanner, bus };
}
async function run(scanner, req, who) {
  const j = await scanner.start(req, who);
  await scanner.waitFor(j, 20_000);
  return scanner.view(j);
}

describe("demo: every library scan", () => {
  it("has realistic hits, zero broker calls, and a run time", async () => {
    const { scanner } = demoScanner();
    for (const s of LIBRARY) {
      const v = await run(scanner, libraryRequest(s.id));
      expect(v.status, s.id).toBe("completed");
      expect(v.results.length, `${s.id} hits`).toBeGreaterThan(0);
      expect(v.results.length, `${s.id} not everything`).toBeLessThan(80);
      expect(v.stats.brokerCalls).toBe(0);
      expect(v.stats.symbols).toBeGreaterThan(180);
      expect(v.results[0].facts.sector === null || typeof v.results[0].facts.sector === "string").toBe(true);
    }
  }, 60_000);

  it("marks new symbols since the last run of the same scan", async () => {
    let t = Date.parse("2026-10-21T10:00:00+05:30");
    const { scanner } = demoScanner({ clock: { now: () => t } });
    const req = libraryRequest("pdh-breakout-volume");
    const a = await run(scanner, req);
    expect(a.firstRun).toBe(true);
    expect(a.results.every((r) => r.isNew === false)).toBe(true);
    t += 5 * 3_600_000; // later in the day more stories are on
    const b = await run(scanner, req);
    expect(b.firstRun).toBe(false);
    const before = new Set(a.results.map((r) => r.symbol));
    for (const r of b.results) expect(r.isNew).toBe(!before.has(r.symbol));
  });

  it("counts matches while editing", async () => {
    const { scanner } = demoScanner();
    const c = await scanner.count({ universe: "FNO", interval: "live", condition: "gap_pct > 2" });
    expect(c.total).toBeGreaterThan(180);
    expect(c.matched).toBeGreaterThan(0);
    expect(c.sample.length).toBe(Math.min(8, c.matched));
    await expect(scanner.count({ universe: "NIFTY50", condition: "close > 1" })).rejects.toThrow(/live scans/);
  });
});

describe("saved scans: edit, duplicate, schedule at the close, scan hits", () => {
  it("renames, changes, duplicates; runs once after the close; new matches become Scan hit rows and alerts", async () => {
    let t = Date.parse("2026-10-21T14:00:00+05:30"); // Wednesday
    const hits = [];
    const alerts = [];
    const dir = mkdtempSync(join(tmpdir(), "scan-saved-"));
    const { scanner, bus } = demoScanner({ clock: { now: () => t }, paths: { dataDir: dir }, events: () => ({ scanHit: (h) => hits.push(h) }) });
    bus.on("scan.alert", (p) => alerts.push(p));
    const s = await scanner.save({ name: "Gaps", request: libraryRequest("gap-up"), atClose: true, notify: false, libraryId: "gap-up", builder: LIBRARY[0].model });
    await expect(scanner.save({ name: "gaps", request: libraryRequest("gap-up") })).rejects.toThrow(/exists already/);
    const renamed = await scanner.updateSaved(s.id, { name: "Gap ups" });
    expect(renamed.name).toBe("Gap ups");
    const copy = scanner.duplicateSaved(s.id);
    expect(copy.name).toBe("Gap ups (copy)");
    expect(copy.lastRun).toBeNull();
    scanner.removeSaved(copy.id);

    await scanner.tick(); // 14:00: not yet
    expect(scanner.list()).toHaveLength(0);
    t = Date.parse("2026-10-21T15:35:00+05:30");
    await scanner.tick();
    expect(scanner.list()).toHaveLength(1);
    await scanner.waitFor(scanner.list()[0], 10_000);
    await scanner.tick(); // once a day
    expect(scanner.list()).toHaveLength(1);
    const first = scanner.saved().find((x) => x.id === s.id);
    expect(first.lastRun.matched.length).toBeGreaterThan(0);
    expect(hits).toHaveLength(0); // the first run sets the baseline

    // A changed condition starts a new baseline.
    await scanner.updateSaved(s.id, { request: { ...libraryRequest("gap-up"), condition: "gap_pct > 0.2" } });
    expect(scanner.saved().find((x) => x.id === s.id).lastRun).toBeNull();

    // Later in the demo day more breakouts switch on: the next run alerts (notify off) and writes Scan hit rows.
    const b = await scanner.save({ name: "Breakouts", request: libraryRequest("pdh-breakout-volume"), libraryId: "pdh-breakout-volume" });
    await scanner.waitFor(await scanner.runSaved(b.id), 10_000);
    await scanner.updateSaved(b.id, { notify: false });
    t = Date.parse("2026-10-21T20:00:00+05:30"); // the demo session has reached its close
    await scanner.waitFor(await scanner.runSaved(b.id), 10_000);
    const alert = alerts.find((a) => a.savedId === b.id);
    expect(alert.notify).toBe(false);
    expect(alert.newMatches.length).toBeGreaterThan(0);
    expect(hits.length).toBe(alert.newMatches.length);
    expect(hits[0]).toMatchObject({ name: "Breakouts", savedId: b.id, side: "up" });
    expect(typeof hits[0].ltp).toBe("number");
  });
});

describe("routes", () => {
  const ctx = (o = {}) => ({ requestId: "r1", principal: { kind: "local" }, query: new URLSearchParams(o.query ?? ""), params: o.params ?? {}, body: o.body ?? {} });

  it("library, compile both ways, count, saved results as text and CSV, and a scan from the query string", async () => {
    const { scanner } = demoScanner();
    const r = createScannerRoutes(scanner);
    const lib = await r.library(ctx());
    expect(lib.data.scans.length).toBe(LIBRARY.length);
    expect(lib.data.columns.map((c) => c.id)).toContain("iv_rank");
    const c1 = await r.compile(ctx({ body: { builder: LIBRARY.find((x) => x.id === "high-20-volume").model } }));
    expect(c1.data.condition).toBe("close > highest(20)[1] and volume > 2 * avg_volume(20)[1]");
    expect(c1.data.needs).toEqual(["daily"]);
    expect(c1.meta.roundTrip).toBe(true);
    const c2 = await r.compile(ctx({ body: { condition: "iv_rank >= 80" } }));
    expect(c2.data.model.rules[0]).toEqual({ left: { id: "iv_rank" }, op: "gte", right: { num: 80 } });
    await expect(r.compile(ctx({ body: { builder: { join: "and", rules: [] } } }))).rejects.toThrow(/at least one rule/);
    const n = await r.count(ctx({ body: { universe: "FNO", interval: "live", condition: "mwpl_pct >= 80" } }));
    expect(n.data.matched).toBeGreaterThan(0);

    const saved = await scanner.save({ name: "Ban watch", request: libraryRequest("near-ban") });
    await scanner.waitFor(await scanner.runSaved(saved.id), 10_000);
    const txt = await r.savedResults(ctx({ params: { savedId: saved.id }, query: "format=text" }));
    expect(txt.status).toBe(200);
    expect(String(txt.body)).toMatch(/^[A-Z0-9&-]+(,[A-Z0-9&-]+)*$/);
    const csv = await r.savedResults(ctx({ params: { savedId: saved.id }, query: "format=csv" }));
    expect(String(csv.body).split(/\r?\n/)[0]).toBe("symbol,new,ltp,change_pct,vol_pace,fut_oi_change_pct,atm_iv,iv_rank,pcr,basis_pct,mwpl_pct,sector,close,change_pct,volume".replace(",change_pct,volume", ",volume"));
    await expect(r.savedResults(ctx({ params: { savedId: saved.id }, query: "format=xml" }))).rejects.toThrow(/json, csv or text/);

    const q = await r.scanFromQuery(ctx({ query: "condition=gap_pct%20%3E%202&format=json&sort=gap_pct" }));
    expect(q.data.status).toBe("completed");
    expect(q.data.results.length).toBeGreaterThan(0);
    const patched = await r.updateSaved(ctx({ params: { savedId: saved.id }, body: { everyMinutes: 15, notify: false } }));
    expect(patched.data).toMatchObject({ everyMinutes: 15, notify: false });
    const dup = await r.duplicateSaved(ctx({ params: { savedId: saved.id } }));
    expect(dup.status).toBe(201);
  });
});

// ── API budget: 200 symbols through the real market-data service and scheduler ──

const T_SCAN = Date.UTC(2026, 9, 20, 5, 0, 0); // Tuesday 10:30 IST
const N = 200;
const tickers = Array.from({ length: N }, (_, i) => `STK${String(i + 1).padStart(3, "0")}`);

function liveSetup() {
  const clock = createManualClock(T_SCAN);
  // Real timers carry the async context (who caused a call) into their callbacks; make the manual clock do the same.
  const setT = clock.setTimeout.bind(clock);
  clock.setTimeout = (fn, ms) => setT(AsyncResource.bind(fn), ms);
  const bus = createEventBus({ logger: createNullLogger() });
  const calls = { quotes: [], history: [] };
  const specs = [
    ...tickers.map((t) => ({ symbol: `NSE:${t}`, lotSize: 1, tickSize: 0.05 })),
    ...tickers.flatMap((t) => ["2026-10-27", "2026-11-24"].map((e) => ({ symbol: `NFO:${t}-${e}-FUT`, lotSize: 500, tickSize: 0.05 }))),
  ].map((s, i) => ({ ...s, refs: { zerodha: { token: `Z${i + 1}`, tradingSymbol: s.symbol } } }));
  const base = (token) => 100 + (Number(String(token).slice(1)) % 400);
  const adapter = {
    id: "zerodha",
    credentialFields: ["apiKey", "accessToken"],
    capabilities: { auth: { kind: "apiKeyToken" }, ltp: true, quotes: true, historical: { intervals: ["1d"] } },
    async testConnection() {
      return { status: "success" };
    },
    async fetchQuotes(creds, refs) {
      calls.quotes.push({ at: clock.now(), n: refs.length });
      return { status: "success", data: refs.map((r) => ({ token: r.token, exchange: r.exchange, ltp: base(r.token) * 1.02, open: base(r.token), high: base(r.token) * 1.03, low: base(r.token) * 0.99, close: base(r.token), volume: 50_000, oi: 10_000 })) };
    },
    async fetchHistorical(creds, req) {
      calls.history.push({ at: clock.now(), token: req.instrument.token });
      const p = base(req.instrument.token);
      const out = [];
      const end = Math.floor(Date.UTC(2026, 9, 19, 3, 45) / 1000);
      for (let i = 0; i < 270; i += 1) out.push({ time: end - (269 - i) * 86_400, open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 40_000, oi: 9_000 });
      return { status: "success", data: out };
    },
  };
  const accounts = createFakeAccountManager({ accounts: [{ id: "zerodha-main", broker: "zerodha", adapter, creds: { apiKey: "k", accessToken: "t" } }], bus });
  const scheduler = createScheduler({ config: {}, logger: createNullLogger(), bus, clock, accounts });
  const symbols = createFakeSymbolService({ instruments: specs, today: "2026-10-20" });
  const md = createMarketDataService({ config: { market: {} }, logger: createNullLogger(), bus, clock, paths: {}, brokers: {}, accounts, scheduler, symbols, streamHub: stubStreamHub() });
  const scanner = createScanner({ config: {}, marketData: md, accounts, scheduler, symbols, bus, clock, paths: {} });
  return { clock, scanner, scheduler, calls };
}

async function runOnClock(env, req) {
  const start = env.clock.now();
  const j = await env.scanner.start(req);
  for (let i = 0; i < 2000 && ["queued", "running"].includes(j.status); i += 1) await env.clock.advance(250);
  const v = env.scanner.view(j);
  return { ...v, clockMs: env.clock.now() - start };
}

describe("API budget: a 200-symbol live scan", () => {
  const universe = tickers.map((t) => `NSE:${t}`);

  it("cold: one daily read per symbol (paced by the background gate) and one batched quote read; warm: no broker call", async () => {
    const env = liveSetup();
    const req = { symbols: universe, interval: "live", condition: "close > prev_high and vol_pace > 0", sort: { by: "change_pct" } };
    const cold = await runOnClock(env, req);
    expect(cold.status).toBe("completed");
    expect(env.calls.history).toHaveLength(N);
    expect(env.calls.quotes).toHaveLength(1); // 200 symbols, Zerodha takes 500 per call
    expect(cold.stats.brokerCalls).toBe(N + 1);
    expect(cold.stats.dailyFetched).toBe(N);
    expect(cold.results).toHaveLength(N);
    expect(env.scheduler.consumerCalls(SCANNER_CONSUMER).calls).toBe(N + 1);
    // History never above the broker's 3/s, and background work keeps half of every window free.
    const perSec = new Map();
    for (const c of env.calls.history) perSec.set(Math.floor(c.at / 1000), (perSec.get(Math.floor(c.at / 1000)) ?? 0) + 1);
    expect(Math.max(...perSec.values())).toBeLessThanOrEqual(2);
    console.info(`cold 200-symbol scan: ${Math.round(cold.clockMs / 1000)} s on the broker clock, ${cold.stats.brokerCalls} broker calls`);

    const warm = await runOnClock(env, req);
    expect(env.calls.history).toHaveLength(N); // daily bars are cached for the day
    expect(warm.stats.brokerCalls).toBe(0); // quotes still within 15 s
    expect(warm.stats.dailyCached).toBe(N);
    await env.clock.advance(20_000);
    const later = await runOnClock(env, req);
    expect(later.stats.brokerCalls).toBe(1); // one batched quote read
    console.info(`warm 200-symbol scan: ${warm.clockMs} ms, ${warm.stats.brokerCalls} broker calls; 20 s later ${later.stats.brokerCalls}`);
  }, 120_000);

  it("an F&O scan adds the futures to the same batched quote reads, and their previous OI once a day", async () => {
    const env = liveSetup();
    const req = { symbols: universe, interval: "live", condition: "fut_oi_change_pct > 5 and rollover_pct > 0" };
    const v = await runOnClock(env, req);
    expect(v.status).toBe("completed");
    expect(env.calls.quotes).toHaveLength(3); // 600 symbols in chunks of 200
    expect(env.calls.history).toHaveLength(N); // one previous-day OI read per near future
    expect(v.results.length).toBe(N); // OI 10000 against 9000 yesterday
    expect(v.results[0].facts.fut_oi_change_pct).toBeCloseTo(11.11, 2);
    const again = await runOnClock(env, req);
    expect(again.stats.brokerCalls).toBe(0);
  }, 120_000);

  it("a price-only scan never reads daily bars or futures", async () => {
    const env = liveSetup();
    const v = await runOnClock(env, { symbols: universe, interval: "live", condition: "gap_pct > 1" });
    expect(env.calls.history).toHaveLength(0);
    expect(env.calls.quotes).toHaveLength(1);
    expect(v.stats.brokerCalls).toBe(1);
    expect(v.results).toHaveLength(0); // the stub opens at the previous close: no gap
  });
});

describe("Option Screener quick scans", () => {
  it("each picks a real screen and a real column of it, with the screen's own direction values", async () => {
    const S = await import("../dashboard/screens.js");
    const { OPTION_QUICK_SCANS, quickScanPatch, activeQuickScan, LIBRARY_BY_ID } = await import("../dashboard/scan-library.js");
    const dir = S.FILTERS.direction.options;
    let cfg = S.screenerConfig({}, { list: S.SCAN_UNDERLYINGS });
    for (const q of OPTION_QUICK_SCANS) {
      const preset = S.presetById(q.preset);
      expect(preset.id, q.id).toBe(q.preset);
      expect(preset.columns.some((c) => c.id === q.sort.by), `${q.id} sorts by ${q.sort.by}`).toBe(true);
      expect(LIBRARY_BY_ID.has(q.library)).toBe(true);
      cfg = S.screenerConfig({ ...cfg, ...quickScanPatch(cfg, q.id, dir) }, { list: S.SCAN_UNDERLYINGS });
      expect(cfg.preset).toBe(q.preset);
      expect(cfg.sort[q.preset]).toEqual(q.sort);
      expect(activeQuickScan(cfg, dir)).toBe(q.id);
    }
    const over = S.screenerConfig({ ...cfg, ...quickScanPatch(cfg, "q-over-atm", dir) }, { list: S.SCAN_UNDERLYINGS });
    expect(over.filters.ivout.direction).toBe(dir[1][0]);
    const under = S.screenerConfig({ ...over, ...quickScanPatch(over, "q-under-atm", dir) }, { list: S.SCAN_UNDERLYINGS });
    expect(under.filters.ivout.direction).toBe(dir[2][0]);
    expect(activeQuickScan({ ...under, sort: { ...under.sort, ivout: { by: "iv", dir: "desc" } } }, dir)).toBeNull();
    expect(quickScanPatch(cfg, "nope")).toBeNull();
  });
});

describe("Live events: Scan hit rows", () => {
  it("a scan hit is one row labelled with the scan's name, folded within the cooldown, off when the kind is off", async () => {
    const { createEventsEngine } = await import("../events/engine.mjs");
    const t = Date.parse("2026-10-21T11:00:00+05:30");
    const e = createEventsEngine({ clock: { now: () => t } });
    const rec = e.external({ symbol: "NSE:SBIN", kind: "scan_hit", variant: "saved_1", label: "Breakouts", dir: 1, ltp: 812.4, changePct: 1.2 });
    expect(rec).toMatchObject({ kind: "scan_hit", label: "Breakouts", side: "bull", symbol: "NSE:SBIN", ltp: 812.4, category: "custom" });
    expect(e.external({ symbol: "NSE:SBIN", kind: "scan_hit", variant: "saved_1", label: "Breakouts", dir: 1 })).toBeNull(); // folded
    expect(e.list({ kinds: ["scan_hit"] })[0].count).toBe(2);
    expect(e.external({ symbol: "NSE:SBIN", kind: "nope", label: "x" })).toBeNull();
    const sel = e.selection();
    e.setSelection({ ...sel, kinds: { ...sel.kinds, scan_hit: { on: false, params: {} } } });
    expect(e.external({ symbol: "NSE:TCS", kind: "scan_hit", variant: "saved_2", label: "Other" })).toBeNull();
  });
});
