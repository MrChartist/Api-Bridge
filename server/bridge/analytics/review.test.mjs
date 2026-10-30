/** Regression tests for bugs found in the S15 analytics review. Each one failed before its fix. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeMarketData } from "../market/fake.mjs";
import { alertRuleRoutes, createAlertRules } from "./alertRules.mjs";
import { expiryDayRoutes } from "./expiryDay.mjs";
import { futuresChainRoutes } from "./futuresChain.mjs";
import { maxPain, strategyPayoff } from "./math.mjs";
import { buildLotSplit } from "./positions.mjs";
import { createAnalyticsRoutes } from "./routes.mjs";
import { strategyRoutes } from "./strategies.mjs";

const L = (type, side, strike, price) => ({ type, side, strike, price, lots: 1, lotSize: 1 });
const ctxOf = (query = "", body) => ({ query: new URLSearchParams(query), body, requestId: "r1", principal: { kind: "local" }, requireAccountAccess() {} });

describe("strategyPayoff", () => {
  it("a short put loses a finite amount at spot zero, not 'unbounded'", () => {
    const r = strategyPayoff([L("PE", "sell", 100, 5)], { from: 80, to: 130, step: 1 });
    expect(r.unboundedLoss).toBe(false);
    expect(r.maxLoss).toBe(-95);
    expect(r.lossAtZero).toBe(true);
    expect(r.maxProfit).toBe(5);
  });
  it("still sees unbounded risk when the requested range ends below the strike", () => {
    const r = strategyPayoff([L("CE", "sell", 100, 5)], { from: 10, to: 40, step: 1 });
    expect(r.unboundedLoss).toBe(true);
    expect(r.maxLoss).toBeNull();
  });
  it("max profit and loss do not depend on the plotted range", () => {
    const r = strategyPayoff([L("CE", "buy", 100, 6), L("CE", "sell", 110, 2)], { from: 101, to: 109, step: 1 });
    expect(r.maxProfit).toBe(6);
    expect(r.maxLoss).toBe(-4);
  });
  it("finds the break-even exactly even when a grid step straddles a strike", () => {
    const r = strategyPayoff([L("CE", "buy", 100, 6), L("CE", "sell", 110, 2)], { from: 80, to: 130, step: 7 });
    expect(r.breakevens).toEqual([104]);
  });
  it("finds a break-even that lands on the last plotted point", () => {
    const r = strategyPayoff([L("CE", "buy", 100, 5)], { from: 90, to: 105, step: 1 });
    expect(r.breakevens).toEqual([105]);
  });
  it("refuses a curve with an absurd number of points or an empty range", () => {
    const legs = [L("CE", "buy", 100, 5)];
    expect(() => strategyPayoff(legs, { from: 0, to: 1_000_000, step: 0.001 })).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => strategyPayoff(legs, { from: 120, to: 100 })).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});

describe("maxPain", () => {
  it("is null when no strike carries any open interest", () => {
    expect(maxPain([{ strike: 100, ce: { oi: 0 }, pe: { oi: 0 } }, { strike: 200, ce: { oi: null }, pe: {} }])).toBeNull();
  });
});

describe("analytics routes input limits", () => {
  const md = createFakeMarketData({ prices: { "NSE:NIFTY": 25000 } });
  const routes = createAnalyticsRoutes({ marketData: md });
  it("rejects a payoff request that would build millions of points", async () => {
    await expect(routes.payoff(ctxOf("", { legs: [{ type: "CE", side: "buy", strike: 100, price: 1 }], from: 0, to: 1e9, step: 0.01 }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("rejects numbers that would overflow to Infinity and leak null", async () => {
    await expect(routes.payoff(ctxOf("", { legs: [{ type: "CE", side: "buy", strike: 1e300, price: 1 }] }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(routes.positionSize(ctxOf("", { capital: 1e308, riskPct: 100, entry: 1, stop: 0.5 }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(routes.greeks(ctxOf("spot=25000&strike=25000&type=CE&days=10&iv=15&rate=1e9"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("greeks: a premium below intrinsic value is not given a made-up 0.1 % IV", async () => {
    await expect(routes.greeks(ctxOf("spot=25000&strike=24000&type=CE&days=10&price=100"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("lot-split", () => {
  it("rejects an oversized plan without building millions of slices first", () => {
    const t0 = performance.now();
    expect(() => buildLotSplit({ symbol: "NFO:NIFTY-2026-11-24-FUT", quantity: 5_000_000, lotSize: 1, iceberg: { sliceLots: 1, delayMs: 0 } })).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe("expiry handling in IST", () => {
  const expiries = ["2026-10-27", "2026-11-03", "2026-11-10"];
  const mk = (nowIso) => {
    const md = createFakeMarketData({ prices: { "NSE:NIFTY": 25000 } });
    md.setExpiries("NIFTY", expiries);
    const now = Date.parse(nowIso);
    return { md, deps: { marketData: md, clock: { now: () => now } } };
  };
  it("surface skips an expiry whose 15:30 IST cutoff has passed", async () => {
    const { deps } = mk("2026-10-27T11:00:00Z"); // 16:30 IST on expiry day
    const r = await createAnalyticsRoutes(deps).surface(ctxOf("underlying=NIFTY&expiries=2"));
    expect(r.data.expiries.map((e) => e.expiry)).toEqual(["2026-11-03", "2026-11-10"]);
  });
  it("surface uses the IST calendar day, not the UTC one", async () => {
    const { deps } = mk("2026-10-27T19:00:00Z"); // 00:30 IST on 28 Oct, UTC date is still 27 Oct
    const r = await createAnalyticsRoutes(deps).surface(ctxOf("underlying=NIFTY&expiries=1"));
    expect(r.data.expiries.map((e) => e.expiry)).toEqual(["2026-11-03"]);
  });
  it("futures chain skips an expired expiry", async () => {
    const { md, deps } = mk("2026-10-27T11:00:00Z");
    md.setQuote("NFO:NIFTY-2026-11-03-FUT", { ltp: 25100 });
    const h = Object.fromEntries(futuresChainRoutes(deps).map(([, p, , fn]) => [p, fn]));
    const r = await h["/v1/analytics/futures"](ctxOf("underlying=NIFTY&expiries=1"));
    expect(r.data.futures.map((f) => f.expiry)).toEqual(["2026-11-03"]);
  });
  it("expiry-day defaults to the next expiry once today's cutoff has passed", async () => {
    const { deps } = mk("2026-10-27T11:00:00Z");
    const h = Object.fromEntries(expiryDayRoutes(deps).map(([, p, , fn]) => [p.split("/").pop(), fn]));
    const r = await h["expiry-day"](ctxOf("underlying=NIFTY"));
    expect(r.data.expiry).toBe("2026-11-03");
    expect(r.data.asOf.startsWith("2026-10-27T16:30")).toBe(true); // the injected clock, not the wall clock
  });
  it("strategies read time from the injected clock", async () => {
    const { deps } = mk("2026-10-26T10:00:00Z"); // exactly one day before the 27 Oct cutoff
    const build = strategyRoutes(deps).find(([, p]) => p.endsWith("/build"))[3];
    const r = await build(ctxOf("underlying=NIFTY&expiry=2026-10-27&template=bull_call_spread"));
    expect(r.data.daysToExpiry).toBe(1);
  });
  it("basis-history accepts 60m, the interval the market data layer knows, and rejects 1h", async () => {
    const { deps } = mk("2026-10-27T05:00:00Z");
    const h = Object.fromEntries(futuresChainRoutes(deps).map(([, p, , fn]) => [p, fn]));
    await expect(h["/v1/analytics/basis-history"](ctxOf("underlying=NIFTY&expiry=2026-11-03&interval=1h"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(h["/v1/analytics/basis-history"](ctxOf("underlying=NIFTY&expiry=2026-11-03&interval=60m"))).resolves.toBeTruthy();
  });
});

describe("time-machine strike arithmetic", () => {
  it("does not leak floating point noise into atmStrike", async () => {
    const md = createFakeMarketData({ prices: { "NSE:NIFTY": 25000 } });
    const t0 = Math.floor(Date.parse("2026-10-27T09:15:00+05:30") / 1000);
    md.setCandles("NSE:NIFTY", "5m", [{ time: t0, open: 50, high: 51, low: 49, close: 50.0346, volume: 1 }]);
    const h = expiryDayRoutes({ marketData: md }).find(([, p]) => p.endsWith("time-machine"))[3];
    const r = await h(ctxOf(`symbol=NSE:NIFTY&interval=5m&from=${t0}&step=0.05`));
    expect(r.data.bars[0].atmStrike).toBe(50.05);
  });
});

describe("alert rules", () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const body = { name: "n", underlying: "NIFTY", metric: "spot_cross", value: 25000, op: "above" };
  const clock = { now: () => Date.parse("2026-10-30T05:00:00Z") };

  it("a caller with no key cannot see or delete rules saved by the local owner", async () => {
    const marketData = createFakeMarketData({ prices: { "NSE:NIFTY": 24900 } });
    const deps = { marketData, clock };
    const h = Object.fromEntries(alertRuleRoutes(deps).map(([m, p, , fn]) => [`${m} ${p}`, fn]));
    const local = { requestId: "q", params: {}, query: new URLSearchParams(), principal: { kind: "local" } };
    const made = await h["POST /v1/analytics/alert-rules"]({ ...local, body });
    const id = JSON.parse(made.body).data.id;
    const anon = { requestId: "q", params: { ruleId: id }, query: new URLSearchParams(), principal: { kind: "webhook", id: "w" }, scopes: new Set(["read"]) };
    expect((await h["GET /v1/analytics/alert-rules"](anon)).data).toEqual([]);
    await expect(h["DELETE /v1/analytics/alert-rules/:ruleId"](anon)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("save reports a disk failure as a BridgeError and does not keep a rule it could not store", () => {
    const dir = mkdtempSync(join(tmpdir(), "alert-rules-"));
    dirs.push(dir);
    const notADir = join(dir, "file");
    writeFileSync(notADir, "x");
    const svc = createAlertRules({ marketData: createFakeMarketData(), clock, paths: { dataDir: notADir } });
    expect(() => svc.save(body)).toThrowError(expect.objectContaining({ code: "INTERNAL" }));
    expect(svc.list()).toEqual([]);
  });
});
