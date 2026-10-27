/**
 * Scanner (stream S13): indicator maths, the condition language, and scan jobs sharing symbols over pooled accounts
 * at background priority, falling back to backup data, saved scans and their alerts.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeError } from "../core/errors.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { atr, ema, highest, rsi, sma, supertrend, vwap } from "./indicators.mjs";
import { columns, evaluate, languageReference, lastValue, lookbackOf, matchesLast, parseExpression } from "./expr.mjs";
import { createScanner } from "./scanService.mjs";

const closeTo = (a, b, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("indicators", () => {
  it("sma and ema", () => {
    const s = sma([1, 2, 3, 4, 5], 3);
    expect(s.slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(s.slice(2)).toEqual([2, 3, 4]);
    const e = ema([1, 2, 3, 4, 5], 3);
    expect(e[2]).toBe(2); // seeded with the SMA
    closeTo(e[3], 0.5 * 4 + 0.5 * 2);
    closeTo(e[4], 0.5 * 5 + 0.5 * 3);
  });

  it("rsi is 100 when only rising, 0 when only falling, 50 when flat", () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsi(up, 14).at(-1)).toBe(100);
    const down = Array.from({ length: 30 }, (_, i) => 100 - i);
    expect(rsi(down, 14).at(-1)).toBe(0);
    expect(rsi(new Array(30).fill(10), 14).at(-1)).toBe(50);
  });

  it("rsi matches Wilder's worked example within rounding", () => {
    // Wilder (1978) / StockCharts example closes
    const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64];
    const r = rsi(closes, 14);
    closeTo(r[14], 70.53, 0.1);
    closeTo(r[19], 57.92, 0.2);
  });

  it("atr, highest, supertrend and vwap", () => {
    const high = [10, 11, 12, 13, 14];
    const low = [9, 10, 11, 12, 13];
    const close = [9.5, 10.5, 11.5, 12.5, 13.5];
    // TR = 1, 1.5, 1.5, 1.5, 1.5; Wilder smoothing seeded with the first two
    expect(atr(high, low, close, 2).at(-1)).toBeCloseTo(1.46875, 9);
    expect(highest(high, 3).at(-1)).toBe(14);
    const st = supertrend(high, low, close, 2, 1);
    expect(st.at(-1)).toBeLessThan(close.at(-1)); // rising: the line sits below price
    const t0 = Date.UTC(2026, 9, 19, 3, 45) / 1000;
    const v = vwap([t0, t0 + 60, t0 + 86_400], [10, 12, 20], [10, 12, 20], [10, 12, 20], [100, 100, 50]);
    expect(v).toEqual([10, 11, 20]); // resets on the new day
  });
});

describe("condition language", () => {
  const bars = (closes, vol = 1000) => closes.map((c, i) => ({ time: 1_790_000_000 + i * 86_400, open: c, high: c + 1, low: c - 1, close: c, volume: vol }));

  it("parses and evaluates comparisons, arithmetic, offsets and booleans", () => {
    const cols = columns(bars([10, 11, 12, 13, 14]));
    expect(matchesLast(parseExpression("close > sma(3) and close[1] == 13"), cols)).toBe(true);
    expect(matchesLast(parseExpression("close > 2 * close[4] or not (close >= 14)"), cols)).toBe(false);
    expect(lastValue(parseExpression("change_pct"), cols)).toBeCloseTo(7.6923, 3);
    expect(lastValue(parseExpression("(high - low) / 2"), cols)).toBe(1);
    expect(matchesLast(parseExpression("close > highest(3)[1] && volume >= avg_volume(3)"), cols)).toBe(false);
  });

  it("crosses above / below look at the last two bars", () => {
    const cols = columns(bars([10, 10, 10, 9, 12]));
    expect(matchesLast(parseExpression("close crosses above sma(3)"), cols)).toBe(true);
    expect(matchesLast(parseExpression("close crosses below sma(3)"), cols)).toBe(false);
    const s = evaluate(parseExpression("close crosses below sma(3)"), cols);
    expect(s[3]).toBe(1);
  });

  it("NaN (not enough bars) is never a match", () => {
    const cols = columns(bars([1, 2, 3]));
    expect(matchesLast(parseExpression("sma(50) < 100"), cols)).toBe(false);
    expect(lastValue(parseExpression("rsi(14)"), cols)).toBeNull();
  });

  it("explains mistakes", () => {
    const err = (src) => {
      try {
        parseExpression(src);
      } catch (e) {
        expect(e).toBeInstanceOf(BridgeError);
        expect(e.code).toBe("VALIDATION_FAILED");
        return e.detail;
      }
      throw new Error(`no error for ${src}`);
    };
    expect(err("price > 10")).toMatch(/unknown name "price"/);
    expect(err("sma > 10")).toMatch(/sma is a function/);
    expect(err("sma() > 1")).toMatch(/needs a period/);
    expect(err("rsi(14) >")).toMatch(/ends too early/);
    expect(err("close crosses sma(5)")).toMatch(/crosses above/);
    expect(err("close[1.5] > 1")).toMatch(/whole number/);
    expect(err("process.exit()")).toMatch(/unexpected character|unknown/);
    expect(err("ema(9999)")).toMatch(/not a period/);
  });

  it("looks back far enough for warm-up and offsets", () => {
    expect(lookbackOf(parseExpression("close > sma(200)"))).toBeGreaterThanOrEqual(201);
    expect(lookbackOf(parseExpression("ema(20)[5] > 1"))).toBeGreaterThanOrEqual(66);
    expect(languageReference().functions.length).toBeGreaterThan(10);
  });

  it("counts offsets on plain fields and nested indicator sources", () => {
    expect(lookbackOf(parseExpression("close > close[60]"))).toBeGreaterThanOrEqual(61);
    expect(lookbackOf(parseExpression("sma(50, rsi(14)) > 50"))).toBeGreaterThanOrEqual(50 + 42);
    expect(lookbackOf(parseExpression("change_pct[3] > 1"))).toBeGreaterThanOrEqual(5);
    const closes = Array.from({ length: lookbackOf(parseExpression("sma(5, rsi(3)) > 0")) }, (_, i) => 100 + (i % 3));
    const cols = columns(closes.map((c, i) => ({ time: i * 86_400, open: c, high: c, low: c, close: c, volume: 1 })));
    expect(lastValue(parseExpression("sma(5, rsi(3))"), cols)).not.toBeNull();
  });
});

// ── scan jobs ──

const T = Date.UTC(2026, 9, 26, 6, 0);

/** Rising candles for symbols starting with "UP", falling otherwise. */
function candlesFor(symbol, n = 60) {
  const up = symbol.includes("UP");
  return Array.from({ length: n }, (_, i) => {
    const c = up ? 100 + i : 200 - i;
    return { time: 1_780_000_000 + i * 86_400, open: c, high: c + 1, low: c - 1, close: c, volume: 1000 };
  });
}

function fakes({ candidates = ["acc-a", "acc-b"], perSecond = { "acc-a": 3, "acc-b": 1 }, failFor = new Set(), backupEnabled = false } = {}) {
  const calls = [];
  const backupCalls = [];
  const accounts = {
    marketDataCandidates: ({ capability, allowedAccounts }) => {
      calls.push(["candidates", capability, allowedAccounts]);
      return allowedAccounts ? candidates.filter((c) => allowedAccounts.includes(c)) : candidates;
    },
    get: (id) => ({ id, broker: id.replace("acc-", "b") }),
  };
  const scheduler = { policyFor: (broker) => ({ limits: { history: { perSecond: perSecond[`acc-${broker.slice(1)}`] ?? 1 } } }) };
  const marketData = {
    async history(p, opts) {
      calls.push(["history", p.symbol, opts.accountId ?? null, opts.priority, Boolean(opts.allowBackup)]);
      await new Promise((r) => setTimeout(r, 1));
      if (failFor.has(p.symbol)) throw new BridgeError("UPSTREAM_ERROR", "broker failed");
      return { symbol: p.symbol, candles: candlesFor(p.symbol, p.countback), freshness: { source: "broker", accountId: opts.accountId ?? candidates[0] } };
    },
  };
  const backupData = {
    status: () => ({ enabled: backupEnabled }),
    async history({ symbol }) {
      backupCalls.push(symbol);
      return { symbol, candles: candlesFor(symbol), provider: "yahoo", partial: false };
    },
  };
  return { accounts, scheduler, marketData, backupData, calls, backupCalls };
}

function makeScanner(f, extra = {}) {
  const bus = createEventBus();
  const events = [];
  for (const t of ["scan.progress", "scan.completed", "scan.alert"]) bus.on(t, (e) => events.push([t, e]));
  const scanner = createScanner({
    config: { scanner: extra.scanner ?? {} },
    ...f,
    bus,
    clock: { now: () => extra.now?.() ?? T },
    paths: { dataDir: extra.dataDir ?? mkdtempSync(join(tmpdir(), "mcb-scan-")) },
  });
  return { scanner, events, bus };
}

const done = (scanner, job) => scanner.waitFor(job, 5000);

describe("scan jobs", () => {
  it("shares symbols over pooled accounts, pinned, at background priority", async () => {
    const f = fakes();
    const { scanner, events } = makeScanner(f);
    const symbols = Array.from({ length: 20 }, (_, i) => `NSE:${i % 2 ? "UP" : "DN"}${i}`);
    const job = await done(scanner, await scanner.start({ symbols, condition: "close > sma(20)", columns: ["rsi(14)"], sort: { by: "close" } }));
    expect(job.status).toBe("completed");
    const v = scanner.view(job);
    expect(v.progress).toMatchObject({ total: 20, done: 20, matched: 10, errors: 0 });
    expect(v.results.every((r) => r.symbol.includes("UP"))).toBe(true);
    expect(v.results[0].values).toHaveProperty("rsi(14)");
    expect(v.results[0].values["rsi(14)"]).toBe(100);
    // sorted by close, highest first
    expect(v.results.map((r) => r.sortValue)).toEqual([...v.results.map((r) => r.sortValue)].sort((a, b) => b - a));
    const hist = f.calls.filter((c) => c[0] === "history");
    expect(new Set(hist.map((c) => c[3]))).toEqual(new Set(["background"]));
    expect([...new Set(hist.map((c) => c[2]))].sort()).toEqual(["acc-a", "acc-b"]);
    // pool widths follow each account's history budget: a 3/s account runs 3 workers, a 1/s account 1
    expect(v.plan.pools.map((p) => [p.accountId, p.concurrency])).toEqual([
      ["acc-a", 3],
      ["acc-b", 1],
    ]);
    expect(v.usage["acc-a"] + v.usage["acc-b"]).toBe(20);
    expect(events.some(([t, e]) => t === "scan.completed" && e.jobId === job.id)).toBe(true);
  });

  it("keeps to the key's accounts", async () => {
    const f = fakes();
    const { scanner } = makeScanner(f);
    const job = await done(scanner, await scanner.start({ symbols: ["NSE:UP1", "NSE:UP2"], condition: "close > 0" }, { allowedAccounts: ["acc-b"] }));
    expect(scanner.view(job).plan.pools.map((p) => p.accountId)).toEqual(["acc-b"]);
    const hist = f.calls.filter((c) => c[0] === "history");
    // a single account is not pinned: the read stays unpinned so it can fall back to backup data
    expect(hist.every((c) => c[2] === null && c[4] === true)).toBe(true);
  });

  it("falls back to backup candles for a symbol a pinned account cannot serve", async () => {
    const f = fakes({ failFor: new Set(["NSE:UP3"]), backupEnabled: true });
    const { scanner } = makeScanner(f);
    const job = await done(scanner, await scanner.start({ symbols: ["NSE:UP1", "NSE:UP3"], condition: "close > 0" }));
    const v = scanner.view(job);
    expect(v.progress.errors).toBe(0);
    expect(v.results.find((r) => r.symbol === "NSE:UP3")).toMatchObject({ source: "backup", provider: "yahoo", accountId: null });
    expect(f.backupCalls).toEqual(["NSE:UP3"]);
  });

  it("source backup never touches a broker; no source at all is a clear error", async () => {
    const f = fakes({ backupEnabled: true });
    const { scanner } = makeScanner(f);
    const job = await done(scanner, await scanner.start({ symbols: ["NSE:UP1"], condition: "close > 0", source: "backup" }));
    expect(scanner.view(job).results).toHaveLength(1);
    expect(f.calls.filter((c) => c[0] === "history")).toHaveLength(0);
    const none = makeScanner(fakes({ candidates: [] })).scanner;
    await expect(none.start({ symbols: ["NSE:UP1"], condition: "close > 0" })).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE" });
  });

  it("records per-symbol errors and invalid symbols without failing the scan", async () => {
    const f = fakes({ failFor: new Set(["NSE:DN2"]) });
    const { scanner } = makeScanner(f);
    const job = await done(scanner, await scanner.start({ symbols: ["NSE:UP1", "NSE:DN2", "??"], condition: "close > 0" }));
    const v = scanner.view(job);
    expect(v.status).toBe("completed");
    expect(v.errors.map((e) => [e.symbol, e.code])).toEqual([
      ["??", "VALIDATION_FAILED"],
      ["NSE:DN2", "UPSTREAM_ERROR"],
    ]);
  });

  it("validates requests and universes up front", async () => {
    const { scanner } = makeScanner(fakes(), { scanner: { maxSymbols: 2, universes: { MINE: ["NSE:UP1"] } } });
    await expect(scanner.start({ condition: "close > 0" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(scanner.start({ universe: "NOPE", condition: "close > 0" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(scanner.start({ symbols: ["NSE:A1", "NSE:A2", "NSE:A3"], condition: "close > 0" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(scanner.start({ symbols: ["NSE:A1"], condition: "close >" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await scanner.universe("mine")).toEqual(["NSE:UP1"]);
    expect((await scanner.universe("NIFTY50")).length).toBe(50);
    const p = await scanner.plan({ universe: "MINE", condition: "rsi(14) > 50" });
    expect(p).toMatchObject({ symbols: 1, backupFallback: false });
    expect(p.lookbackBars).toBeGreaterThanOrEqual(42);
  });

  it("cancelling a queued scan wakes anyone waiting on it", async () => {
    const f = fakes();
    const { scanner } = makeScanner(f, { scanner: { maxRunning: 1, perAccountConcurrency: 1 } });
    const first = await scanner.start({ symbols: Array.from({ length: 100 }, (_, i) => `NSE:UP${i}`), condition: "close > 0" });
    const queued = await scanner.start({ symbols: ["NSE:UP1"], condition: "close > 0" });
    expect(queued.status).toBe("queued");
    const t0 = Date.now();
    const waiting = scanner.waitFor(queued, 10_000);
    scanner.cancel(queued);
    await waiting;
    expect(Date.now() - t0).toBeLessThan(1000);
    scanner.cancel(first);
    await done(scanner, first);
  });

  it("saved-scan alerts compare all matches, not just the top N kept by limit", async () => {
    const f = fakes({ candidates: ["acc-a"] });
    const { scanner, events } = makeScanner(f);
    const s = await scanner.save({ name: "Top", request: { symbols: ["NSE:UP1", "NSE:UP2", "NSE:UP3"], condition: "close > 0", limit: 1, sort: { by: "close" } } });
    await done(scanner, await scanner.runSaved(s.id));
    expect(scanner.saved()[0].lastRun.matched).toHaveLength(3);
    await done(scanner, await scanner.runSaved(s.id));
    expect(events.filter(([tp]) => tp === "scan.alert")).toHaveLength(0);
  });

  it("a revoked key's scheduled scans stop running", async () => {
    let t = Date.UTC(2026, 9, 26, 5, 0);
    const f = fakes({ candidates: ["acc-a"] });
    const { scanner, bus } = makeScanner(f, { now: () => t });
    await scanner.save({ name: "x", request: { symbols: ["NSE:UP1"], condition: "close > 0" }, everyMinutes: 5 }, { keyId: "key_gone" });
    bus.emit("key.revoked", { keyId: "key_gone" });
    await scanner.tick();
    expect(scanner.list()).toHaveLength(0);
    expect(scanner.saved()[0].disabledReason).toBe("key revoked");
  });

  it("cancels a running scan", async () => {
    const f = fakes();
    const { scanner } = makeScanner(f, { scanner: { perAccountConcurrency: 1 } });
    const symbols = Array.from({ length: 200 }, (_, i) => `NSE:UP${i}`);
    const job = await scanner.start({ symbols, condition: "close > 0" });
    await new Promise((r) => setTimeout(r, 5));
    scanner.cancel(job);
    await done(scanner, job);
    expect(job.status).toBe("cancelled");
    expect(job.progress.done).toBeLessThan(200);
  });

  it("saved scans persist, run on schedule in market hours and alert on new matches", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-scan-"));
    let t = Date.UTC(2026, 9, 26, 5, 0); // Monday 10:30 IST
    const f = fakes({ candidates: ["acc-a"] });
    const { scanner, events } = makeScanner(f, { dataDir, now: () => t });
    const s = await scanner.save({ name: "Risers", request: { symbols: ["NSE:UP1"], condition: "close > 0" }, everyMinutes: 5 });
    await scanner.tick();
    const first = scanner.list()[0];
    await done(scanner, first);
    expect(scanner.saved()[0].lastRun.matched).toEqual(["NSE:UP1"]);
    expect(events.some(([tp]) => tp === "scan.alert")).toBe(false); // the first run sets the baseline

    // not due yet
    t += 60_000;
    await scanner.tick();
    expect(scanner.list()).toHaveLength(1);

    // saved scans survive a restart
    const reloaded = makeScanner(f, { dataDir, now: () => t }).scanner;
    expect(reloaded.saved()[0].id).toBe(s.id);

    t += 5 * 60_000;
    const raw = scanner.saved()[0];
    expect(raw.everyMinutes).toBe(5);
    // closed market: nothing runs
    t = Date.UTC(2026, 9, 25, 5, 0); // Sunday
    await scanner.tick();
    expect(scanner.list()).toHaveLength(1);

    const job2 = await scanner.runSaved(s.id);
    await done(scanner, job2);
    expect(scanner.view(job2).newMatches).toEqual([]);
    scanner.removeSaved(s.id);
    expect(scanner.saved()).toEqual([]);
  });

  it("emits scan.alert with the symbols a saved scan newly matches", async () => {
    const failFor = new Set(["NSE:DN1"]);
    const f = fakes({ candidates: ["acc-a"], failFor });
    const { scanner, events } = makeScanner(f);
    const s = await scanner.save({ name: "Movers", request: { symbols: ["NSE:UP1", "NSE:DN1"], condition: "close > 0" } });
    const j1 = await scanner.runSaved(s.id);
    await done(scanner, j1);
    expect(scanner.saved()[0].lastRun.matched).toEqual(["NSE:UP1"]);
    failFor.clear();
    const j2 = await scanner.runSaved(s.id);
    await done(scanner, j2);
    expect(scanner.view(j2).newMatches).toEqual(["NSE:DN1"]);
    const alerts = events.filter(([tp]) => tp === "scan.alert").map(([, e]) => e);
    expect(alerts).toEqual([expect.objectContaining({ savedId: s.id, name: "Movers", jobId: j2.id, newMatches: ["NSE:DN1"] })]);
  });
});
