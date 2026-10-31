import { describe, expect, it } from "vitest";
import { BridgeError } from "../core/errors.mjs";
import { createFakeMarketData } from "../market/fake.mjs";
import { concentrationOf, exposureOf, modelLeg, optionGreeks, riskRoutes, pnlHistogram, scenarioGrid, varOf } from "./risk.mjs";

const NOW = Date.parse("2026-10-30T10:00:00+05:30");
const ctxFor = (query = "", body, requireAccountAccess = () => {}) => ({ query: new URLSearchParams(query), body, requestId: "r1", principal: { kind: "local" }, requireAccountAccess });
const find = (routes, method, path) => routes.find((r) => r[0] === method && r[1] === path)[3];

// Independent Black-Scholes reference: erf by Taylor series (full double precision), not the repo's approximation.
function erf(x) {
  let sum = x;
  let term = x;
  for (let n = 1; n < 200; n++) {
    term *= (-x * x) / n;
    sum += term / (2 * n + 1);
  }
  return (2 / Math.sqrt(Math.PI)) * sum;
}
const N = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
function ref(S, K, T, r, v, type) {
  if (T <= 0) return type === "CE" ? Math.max(0, S - K) : Math.max(0, K - S);
  const d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / (v * Math.sqrt(T));
  const d2 = d1 - v * Math.sqrt(T);
  return type === "CE" ? S * N(d1) - K * Math.exp(-r * T) * N(d2) : K * Math.exp(-r * T) * N(-d2) - S * N(-d1);
}

function setup({ positions = [], funds, chains = [], prices = {} } = {}) {
  const md = createFakeMarketData({ prices });
  for (const [u, e, c] of chains) md.setChain(u, e, c);
  const seen = { access: [], orders: [] };
  const orders = {
    positions: async (ctx, account, o) => (seen.orders.push(["positions", account, o]), { items: positions, freshness: { source: "paper" } }),
    funds: async () => {
      if (funds instanceof Error) throw funds;
      return { funds };
    },
    holdings: async () => ({ items: [] }),
  };
  return { md, seen, routes: riskRoutes({ marketData: md, orders, now: () => NOW }), orders };
}
const deepNoNaN = (v) => {
  const bad = [];
  (function walk(x, p) {
    if (typeof x === "number" && !Number.isFinite(x)) bad.push(p);
    else if (x && typeof x === "object") for (const [k, y] of Object.entries(x)) walk(y, `${p}.${k}`);
  })(v, "$");
  return bad;
};

describe("scenario maths against hand-computed Black-Scholes", () => {
  // Expiry exactly 365 days ahead of now, so T = 1 year and the textbook C(100,100,1y,5%,20%) = 10.4506 applies.
  const EXP = "2027-10-30";
  const T_NOW = Date.parse(`${EXP}T15:30:00+05:30`) - 365 * 86_400_000;
  const mk = () => riskRoutes({ marketData: createFakeMarketData(), orders: {}, now: () => T_NOW });
  const CE = `NFO:NIFTY-${EXP}-100-CE`;
  const body = (extra = {}) => ({ ratePct: 5, positions: [{ symbol: CE, netQty: 1, spot: 100, price: 10.4506, ivPct: 20 }], ...extra });

  it("textbook anchor: reference implementation gives 10.4506", () => {
    expect(ref(100, 100, 1, 0.05, 0.2, "CE")).toBeCloseTo(10.4506, 3);
    expect(ref(100, 100, 1, 0.05, 0.2, "PE")).toBeCloseTo(5.5735, 3);
  });

  it("spot, IV and time cells match the reference reprice", async () => {
    const r = await find(mk(), "POST", "/v1/analytics/risk/scenario")(ctxFor("", body({ spotShocksPct: [-10, 0, 10], ivShocksPts: [0, 5], daysForward: [0, 30] })));
    const base = ref(100, 100, 1, 0.05, 0.2, "CE");
    expect(r.data.cells).toHaveLength(12);
    const cell = (s, v, d) => r.data.cells.find((c) => c.spotPct === s && c.ivPts === v && c.days === d);
    expect(cell(0, 0, 0).pnl).toBe(0);
    expect(cell(10, 0, 0).pnl).toBeCloseTo(ref(110, 100, 1, 0.05, 0.2, "CE") - base, 2);
    expect(cell(-10, 0, 0).pnl).toBeCloseTo(ref(90, 100, 1, 0.05, 0.2, "CE") - base, 2);
    expect(cell(0, 5, 0).pnl).toBeCloseTo(ref(100, 100, 1, 0.05, 0.25, "CE") - base, 2);
    expect(cell(0, 0, 30).pnl).toBeCloseTo(ref(100, 100, 1 - 30 / 365, 0.05, 0.2, "CE") - base, 2);
    expect(cell(10, 5, 30).pnl).toBeCloseTo(ref(110, 100, 1 - 30 / 365, 0.05, 0.25, "CE") - base, 2);
    // base price and Greeks from the same model
    expect(r.data.legs[0].modelPrice).toBeCloseTo(10.4506, 3);
    expect(r.data.legs[0].delta).toBeCloseTo(N((Math.log(1) + (0.05 + 0.02) * 1) / 0.2), 2);
    expect(deepNoNaN(r)).toEqual([]);
  });

  it("short qty flips the sign and the put matches the reference", async () => {
    const put = `NFO:NIFTY-${EXP}-100-PE`;
    const r = await find(mk(), "POST", "/v1/analytics/risk/scenario")(ctxFor("", { ratePct: 5, spotShocksPct: [5], ivShocksPts: [0], daysForward: [0], positions: [{ symbol: put, netQty: -3, spot: 100, price: 5.5735, ivPct: 20 }] }));
    const exp = -3 * (ref(105, 100, 1, 0.05, 0.2, "PE") - ref(100, 100, 1, 0.05, 0.2, "PE"));
    expect(r.data.cells[0].pnl).toBeCloseTo(exp, 2);
    expect(r.data.cells[0].pnl).toBeGreaterThan(0);
  });

  it("options past expiry in a cell become intrinsic", async () => {
    const r = await find(mk(), "POST", "/v1/analytics/risk/scenario")(ctxFor("", body({ spotShocksPct: [10], ivShocksPts: [0], daysForward: [365] })));
    expect(r.data.cells[0].pnl).toBeCloseTo(10 - ref(100, 100, 1, 0.05, 0.2, "CE"), 2);
  });

  it("Taylor error is small for small shocks and grows with size; reported per cell", async () => {
    const r = await find(mk(), "POST", "/v1/analytics/risk/scenario")(ctxFor("", body({ spotShocksPct: [-10, -0.5, 0, 0.5, 10], ivShocksPts: [0], daysForward: [0] })));
    const c = (s) => r.data.cells.find((x) => x.spotPct === s);
    expect(Math.abs(c(0.5).taylorError)).toBeLessThan(0.01);
    expect(Math.abs(c(10).taylorError)).toBeGreaterThan(Math.abs(c(0.5).taylorError));
    expect(c(10).taylorError).toBeCloseTo(c(10).taylorPnl - c(10).pnl, 1);
    expect(r.data.summary.taylor.maxAbsErrorCell).toBeTruthy();
    expect(r.data.base.taylorPnl).toBe(0);
    // analytic Greeks vs the closed form
    const g = optionGreeks({ spot: 100, strike: 100, right: "CE", iv: 0.2, T: 1, rate: 0.05 });
    expect(g.delta).toBeCloseTo(0.6368, 3);
    expect(g.gamma).toBeCloseTo(0.018762, 4);
    expect(g.vega).toBeCloseTo(0.37524, 3);
    expect(g.theta).toBeCloseTo(-6.414 / 365, 3);
  });

  it("per underlying split sums to the book", async () => {
    const r = await find(mk(), "POST", "/v1/analytics/risk/scenario")(
      ctxFor("", { ratePct: 5, spotShocksPct: [-5], ivShocksPts: [0], daysForward: [0], positions: [{ symbol: CE, netQty: 2, spot: 100, price: 10.4506, ivPct: 20 }, { symbol: "NFO:RELIANCE-2027-10-30-FUT", netQty: -10, price: 1400 }] }),
    );
    const c = r.data.cells[0];
    expect(Object.keys(c.byUnderlying).sort()).toEqual(["NIFTY", "RELIANCE"]);
    expect(c.byUnderlying.RELIANCE).toBeCloseTo(-10 * (1400 * 0.95 - 1400), 2);
    expect(c.pnl).toBeCloseTo(c.byUnderlying.NIFTY + c.byUnderlying.RELIANCE, 1);
    expect(r.data.byUnderlying.map((u) => u.underlying).sort()).toEqual(["NIFTY", "RELIANCE"]);
  });
});

describe("scenario inputs", () => {
  const h = (routes) => find(routes, "POST", "/v1/analytics/risk/scenario");
  it("needs exactly one of account or positions, bounds the grid, rejects junk", async () => {
    const { routes } = setup();
    await expect(h(routes)(ctxFor("", {}))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(h(routes)(ctxFor("", { account: "paper", positions: [{ symbol: "NSE:RELIANCE", netQty: 1, price: 1 }] }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const many = Array.from({ length: 11 }, (_, i) => i - 5);
    await expect(h(routes)(ctxFor("", { positions: [{ symbol: "NSE:RELIANCE", netQty: 1, price: 1 }], spotShocksPct: many, ivShocksPts: many, daysForward: [0, 1, 2, 3] }))).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringMatching(/cells/) });
    await expect(h(routes)(ctxFor("", { positions: [{ symbol: "NSE:RELIANCE", netQty: 1, price: 1 }], spotShocksPct: [-100] }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(h(routes)(ctxFor("", { positions: [{ symbol: "NSE:RELIANCE", netQty: 0, price: 1 }] }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(h(routes)(ctxFor("", { account: "paper", extra: 1 }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("maxCells lowers the cap", async () => {
    const { routes } = setup();
    await expect(h(routes)(ctxFor("", { positions: [{ symbol: "NSE:RELIANCE", netQty: 1, price: 1 }], maxCells: 4 }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("account path checks access first and uses the chain", async () => {
    const CE = "NFO:NIFTY-2026-11-24-25000-CE";
    const leg = { symbol: CE, ltp: 200, bid: 200, ask: 200, oi: 1, oiChange: 0, volume: 1, iv: 15, greeksSource: "broker" };
    const { routes, seen } = setup({
      positions: [{ symbol: CE, product: "NRML", netQty: -130, avgPrice: 200, ltp: 200 }, { symbol: "NFO:NIFTY-2026-11-24-FUT", product: "NRML", netQty: 65, ltp: 25010 }],
      chains: [["NIFTY", "2026-11-24", { underlyingLtp: 25000, lotSize: 65, rows: [{ strike: 25000, ce: leg, pe: null }] }]],
    });
    const guard = [];
    const r = await h(routes)(ctxFor("", { account: "paper", mode: "paper", spotShocksPct: [-5, 0, 5], ivShocksPts: [0], daysForward: [0] }, (a) => guard.push(a)));
    expect(guard).toEqual(["paper"]);
    expect(seen.orders[0]).toEqual(["positions", "paper", { mode: "paper" }]);
    expect(r.data.legs).toHaveLength(2);
    expect(r.data.cells.find((c) => c.spotPct === 0).pnl).toBe(0);
    expect(r.data.net.delta).not.toBeNull();
    expect(deepNoNaN(r)).toEqual([]);
    // access denied is passed through untouched
    await expect(h(routes)(ctxFor("", { account: "other" }, () => { throw new BridgeError("ACCOUNT_FORBIDDEN", "no"); }))).rejects.toMatchObject({ code: "ACCOUNT_FORBIDDEN" });
  });
  it("raw errors never leak", async () => {
    const orders = { positions: async () => { throw new TypeError("secret detail"); } };
    const routes = riskRoutes({ marketData: createFakeMarketData(), orders, now: () => NOW });
    const err = await h(routes)(ctxFor("", { account: "paper" })).catch((e) => e);
    expect(err).toBeInstanceOf(BridgeError);
    expect(err.code).toBe("INTERNAL");
    expect(String(err.message)).not.toMatch(/secret/);
  });
  it("a leg with no price or IV is skipped, not NaN", async () => {
    const { routes } = setup();
    const r = await h(routes)(ctxFor("", { positions: [{ symbol: "NFO:NIFTY-2026-11-24-25000-CE", netQty: 1, spot: 25000 }, { symbol: "junk", netQty: 1 }, { symbol: "NFO:NIFTY-2025-01-01-25000-CE", netQty: 1, spot: 1, price: 1 }] }));
    expect(r.data.skipped.map((s) => s.reason).sort()).toEqual(["expired", "no usable IV or price", "symbol is not a Bridge symbol"]);
    expect(r.data.cells.every((c) => c.pnl === 0)).toBe(true);
    expect(deepNoNaN(r)).toEqual([]);
  });
});

const FUT = "NFO:NIFTY-2026-11-24-FUT";
const BOOK = [
  { symbol: "NSE:RELIANCE", product: "CNC", netQty: 100, ltp: 1000 },
  { symbol: FUT, product: "NRML", netQty: -65, ltp: 25000 },
];

describe("exposure and concentration", () => {
  it("gross, net, long, short and per-underlying delta exposure", async () => {
    const { routes } = setup({ positions: BOOK, funds: { availableCash: 500000, usedMargin: 100000, totalBalance: 600000 } });
    const r = await find(routes, "GET", "/v1/analytics/risk/exposure")(ctxFor("account=paper"));
    expect(r.data.longNotional).toBe(100000);
    expect(r.data.shortNotional).toBe(1625000);
    expect(r.data.grossNotional).toBe(1725000);
    expect(r.data.netNotional).toBe(-1525000);
    expect(r.data.deltaAdjusted.net).toBe(-1525000);
    expect(r.data.byUnderlying.map((u) => [u.underlying, u.deltaExposure])).toEqual([["NIFTY", -1625000], ["RELIANCE", 100000]]);
    expect(r.data.funds.usedMargin).toBe(100000);
    expect(r.data.marginUtilisationPct).toBeCloseTo(16.67, 2);
    expect(r.data.grossLeverage).toBeCloseTo(2.88, 2);
  });
  it("funds missing gives null and a note, nothing invented", async () => {
    const { routes } = setup({ positions: BOOK, funds: new BridgeError("CAPABILITY_UNSUPPORTED", "x") });
    const r = await find(routes, "GET", "/v1/analytics/risk/exposure")(ctxFor("account=paper"));
    expect(r.data.funds).toBeNull();
    expect(r.data.fundsNote).toMatch(/not available/);
    expect(r.data.marginUtilisationPct).toBeNull();
    await expect(find(routes, "GET", "/v1/analytics/risk/exposure")(ctxFor(""))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("weights, sector share and HHI by hand", async () => {
    const { routes } = setup({ positions: BOOK });
    const r = await find(routes, "GET", "/v1/analytics/risk/concentration")(ctxFor("account=paper&top=1"));
    const w = 1625000 / 1725000;
    expect(r.data.topPositions).toHaveLength(1);
    expect(r.data.topPositions[0].weight).toBeCloseTo(w, 4);
    expect(r.data.hhi).toBeCloseTo(w * w + (1 - w) * (1 - w), 4);
    expect(r.data.bySector.map((s) => s.sector)).toEqual(["Index", "Energy"]);
    expect(r.data.effectiveUnderlyings).toBeCloseTo(1 / (w * w + (1 - w) ** 2), 1);
  });
  it("empty book is null, not NaN", () => {
    const c = concentrationOf([], 5);
    expect(c.hhi).toBeNull();
    expect(deepNoNaN(exposureOf([]))).toEqual([]);
    expect(exposureOf([]).grossNotional).toBe(0);
  });
});

// 101 closes -> 100 returns: 5 days of -2 % and 95 days of +0.1 %.
function candlesWith(returns, start = 1000) {
  let c = start;
  const out = [{ time: 1_700_000_000, open: c, high: c, low: c, close: c, volume: 1 }];
  returns.forEach((r, i) => {
    c *= 1 + r;
    out.push({ time: 1_700_000_000 + (i + 1) * 86_400, open: c, high: c, low: c, close: c, volume: 1 });
  });
  return out;
}
const RET = [...Array(5).fill(-0.02), ...Array(95).fill(0.001)];

describe("VaR", () => {
  it("historical simulation matches the hand-computed quantile and expected shortfall", async () => {
    const { routes, md } = setup({ positions: [BOOK[0]] });
    md.setCandles("NSE:RELIANCE", "1d", candlesWith(RET));
    const r = await find(routes, "GET", "/v1/analytics/risk/var")(ctxFor("account=paper&days=250&confidence=95"));
    // exposure 100,000; sorted P&L: five of -2,000 then +100. p = 0.05, index 99 x 0.05 = 4.95 -> -2,000 + 2,100 x 0.95 = -5.
    expect(r.data.method).toBe("historical-simulation");
    expect(r.data.observations).toBe(100);
    expect(r.data.var).toBeCloseTo(5, 0);
    expect(r.data.expectedShortfall).toBeCloseTo(2000, 0);
    expect(r.data.label).toMatch(/Estimate/);
    expect(r.data.deltaNormal.var).toBeGreaterThan(0);
    const r99 = await find(routes, "GET", "/v1/analytics/risk/var")(ctxFor("account=paper&confidence=99"));
    // index 0.99 x 0.99 = 98.01 of the sorted tail is irrelevant; p = 0.01 -> index 0.99 -> -2,000 (both lowest equal).
    expect(r99.data.var).toBeCloseTo(2000, 0);
    expect(r99.data.expectedShortfall).toBeCloseTo(2000, 0);
    await expect(find(routes, "GET", "/v1/analytics/risk/var")(ctxFor("account=paper&confidence=90"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("falls back to delta-normal on thin history and says so", async () => {
    const { routes, md } = setup({ positions: [BOOK[0]] });
    md.setCandles("NSE:RELIANCE", "1d", candlesWith(RET.slice(0, 25)));
    const r = await find(routes, "GET", "/v1/analytics/risk/var")(ctxFor("account=paper"));
    expect(r.data.method).toBe("delta-normal");
    expect(r.data.note).toMatch(/Fell back/);
    const sumsq = RET.slice(0, 25).reduce((t, x) => t + x * x, 0) / 25;
    expect(r.data.var).toBeCloseTo(1.6448536 * 100000 * Math.sqrt(sumsq), 0);
    expect(r.data.expectedShortfall).toBeGreaterThan(r.data.var);
  });
  it("no history at all gives null with a reason and a per-underlying error", async () => {
    const { routes } = setup({ positions: [BOOK[0]] });
    const r = await find(routes, "GET", "/v1/analytics/risk/var")(ctxFor("account=paper"));
    expect(r.data.var).toBeNull();
    expect(r.data.reason).toBeTruthy();
    expect(r.errors[0].underlying).toBe("RELIANCE");
  });
  it("varOf is finite for an option book (full reprice)", () => {
    const leg = { symbol: "NFO:NIFTY-2026-11-24-25000-CE", exchange: "NFO", underlying: "NIFTY", kind: "OPT", right: "CE", strike: 25000, dte: 25, qty: -65, spot: 25000, price: 300, iv: 0.15 };
    const v = varOf([modelLeg(leg, 0.065)], { NIFTY: candlesWith(RET, 25000) }, { confidence: 95 });
    expect(v.var).toBeGreaterThan(0);
    expect(v.expectedShortfall).toBeGreaterThanOrEqual(v.var);
    expect(deepNoNaN(v)).toEqual([]);
  });
});

describe("what-if", () => {
  it("before vs after, plan only, margin not invented", async () => {
    const { routes, md, orders } = setup({ positions: [BOOK[0]], funds: { availableCash: 1, usedMargin: 1, totalBalance: 2 }, prices: { "NFO:NIFTY-2026-11-24-FUT": 25000 } });
    md.setCandles("NSE:RELIANCE", "1d", candlesWith(RET));
    md.setCandles("NSE:NIFTY", "1d", candlesWith(RET, 25000));
    const placed = [];
    orders.place = () => placed.push(1);
    const r = await find(routes, "POST", "/v1/analytics/risk/whatif")(ctxFor("", { account: "paper", add: [{ symbol: FUT, side: "sell", quantity: 65 }] }));
    expect(placed).toEqual([]);
    expect(r.data.planOnly).toBe(true);
    expect(r.data.before.exposure.grossNotional).toBe(100000);
    expect(r.data.after.exposure.grossNotional).toBe(1725000);
    expect(r.data.after.exposure.netNotional).toBe(-1525000);
    expect(r.data.change.grossNotional).toBe(1625000);
    expect(r.data.before.concentration.hhi).toBe(1);
    expect(r.data.after.concentration.hhi).toBeLessThan(1);
    expect(r.data.after.var.var).toBeGreaterThanOrEqual(0);
    expect(r.data.margin.requiredForAdd).toBeNull();
    expect(r.data.added[0].netQty).toBe(-65);
    expect(deepNoNaN(r)).toEqual([]);
  });
  it("adding the opposite quantity nets the position out", async () => {
    const { routes, md } = setup({ positions: [BOOK[0]] });
    md.setCandles("NSE:RELIANCE", "1d", candlesWith(RET));
    const r = await find(routes, "POST", "/v1/analytics/risk/whatif")(ctxFor("", { account: "paper", add: [{ symbol: "NSE:RELIANCE", side: "SELL", quantity: 100, price: 1000 }] }));
    expect(r.data.after.exposure.grossNotional).toBe(0);
    await expect(find(routes, "POST", "/v1/analytics/risk/whatif")(ctxFor("", { account: "paper", add: [] }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(find(routes, "POST", "/v1/analytics/risk/whatif")(ctxFor("", { add: [{ symbol: "NSE:RELIANCE", side: "BUY", quantity: 1 }] }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("tca", () => {
  const trades = [
    { tradeId: "T1", orderId: "o1", symbol: "NSE:RELIANCE", side: "BUY", qty: 10, price: 100.5, charges: 0.5, tradedAt: "2026-10-30T10:00:01+05:30" },
    { tradeId: "T2", orderId: "o2", symbol: "NSE:RELIANCE", side: "SELL", qty: 10, price: 99.8, charges: 0.5, tradedAt: "2026-10-30T10:00:03+05:30" },
    { tradeId: "T3", orderId: "o3", symbol: "NSE:TCS", side: "BUY", qty: 5, price: 3000, charges: 1, tradedAt: "2026-10-30T10:00:00+05:30" },
  ];
  const orders = [
    { orderId: "o1", orderType: "LIMIT", price: 100, placedAt: "2026-10-30T10:00:00+05:30" },
    { orderId: "o2", orderType: "LIMIT", price: 100, placedAt: "2026-10-30T10:00:01+05:30" },
    { orderId: "o3", orderType: "MARKET", price: null, placedAt: "2026-10-30T09:59:59+05:30" },
  ];
  it("slippage vs limit, fees and latency; lists what the store lacks", async () => {
    const calls = [];
    const deps = { marketData: {}, orders: { trades: async (c, o) => (calls.push(["trades", o]), { items: trades, nextCursor: null }), list: async (c, o) => (calls.push(["list", o]), { items: orders }) } };
    const r = await find(riskRoutes(deps), "GET", "/v1/analytics/risk/tca")(ctxFor("account=paper"));
    expect(calls.every(([, o]) => o.mode === "paper" && o.accountId === "paper")).toBe(true);
    const f = Object.fromEntries(r.data.fills.map((x) => [x.tradeId, x]));
    expect(f.T1.slippageBps).toBeCloseTo(50, 3);
    expect(f.T2.slippageBps).toBeCloseTo(20, 3);
    expect(f.T3.slippageBps).toBeNull();
    expect(f.T3.referencePrice).toBeNull();
    expect(f.T1.latencyMs).toBe(1000);
    expect(f.T2.latencyMs).toBe(2000);
    expect(f.T3.latencyMs).toBe(1000);
    expect(r.data.totals.charges).toBe(2);
    expect(r.data.slippage.measuredFills).toBe(2);
    expect(r.data.slippage.avgBps).toBeCloseTo(35, 3);
    expect(r.data.latencyMs.median).toBe(1000);
    expect(r.data.unavailable.join(" ")).toMatch(/arrivalPrice/);
    expect(deepNoNaN(r)).toEqual([]);
  });
  it("no fills is empty, not NaN", async () => {
    const deps = { marketData: {}, orders: { trades: async () => ({ items: [] }), list: async () => ({ items: [] }) } };
    const r = await find(riskRoutes(deps), "GET", "/v1/analytics/risk/tca")(ctxFor("account=paper"));
    expect(r.data.fillCount).toBe(0);
    expect(r.data.slippage.avgBps).toBeNull();
    expect(deepNoNaN(r)).toEqual([]);
  });
});

describe("route table and grid core", () => {
  it("lists the six read routes", () => {
    expect(riskRoutes({}).map((r) => r.slice(0, 3))).toEqual([
      ["POST", "/v1/analytics/risk/scenario", { scope: "read" }],
      ["GET", "/v1/analytics/risk/exposure", { scope: "read" }],
      ["GET", "/v1/analytics/risk/concentration", { scope: "read" }],
      ["GET", "/v1/analytics/risk/var", { scope: "read" }],
      ["POST", "/v1/analytics/risk/whatif", { scope: "read" }],
      ["GET", "/v1/analytics/risk/tca", { scope: "read" }],
    ]);
  });
  it("scenarioGrid of a futures leg is linear", () => {
    const m = modelLeg({ symbol: FUT, exchange: "NFO", underlying: "NIFTY", kind: "FUT", qty: 65, spot: 25000, price: 25000 }, 0.065);
    const g = scenarioGrid([m], { spotShocksPct: [-2, 2], ivShocksPts: [0], daysForward: [0], rate: 0.065 });
    expect(g.cells.map((c) => c.pnl)).toEqual([-32500, 32500]);
    expect(g.cells.every((c) => c.taylorError === 0)).toBe(true);
  });
});

describe("pnlHistogram", () => {
  it("buckets the simulated day P&Ls from the worst to the best, every day counted once", () => {
    const h = pnlHistogram([-100, -50, 0, 0, 50, 100], 4);
    expect(h).toHaveLength(4);
    expect(h[0]).toEqual({ from: -100, to: -50, count: 1 });
    expect(h.at(-1)).toEqual({ from: 50, to: 100, count: 2 });
    expect(h.reduce((t, b) => t + b.count, 0)).toBe(6);
    expect(pnlHistogram([5, 5])).toEqual([{ from: 5, to: 5, count: 2 }]);
    expect(pnlHistogram([])).toEqual([]);
  });
});
