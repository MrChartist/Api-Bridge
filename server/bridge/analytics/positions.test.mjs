import { describe, expect, it } from "vitest";
import { positionRoutes, buildLotSplit, planSlices, aggregatePositionGreeks } from "./positions.mjs";
import { createFakeMarketData } from "../market/fake.mjs";

const ctxFor = (query = "", body, requireAccountAccess = () => {}) => ({ query: new URLSearchParams(query), body, requestId: "r1", principal: { kind: "local" }, requireAccountAccess });
const find = (routes, method, path) => routes.find((r) => r[0] === method && r[1] === path)[3];

const leg = (symbol, ltp, g) => ({ symbol, ltp, bid: ltp, ask: ltp, oi: 1, oiChange: 0, volume: 1, iv: 15, greeksSource: "broker", ...g });
const EXP = "2026-11-24";
const CE = `NFO:NIFTY-${EXP}-25000-CE`;
const PE = `NFO:NIFTY-${EXP}-25000-PE`;

function setup(items) {
  const md = createFakeMarketData();
  md.setChain("NIFTY", EXP, {
    underlyingLtp: 25000,
    lotSize: 65,
    rows: [{ strike: 25000, ce: leg(CE, 200, { delta: 0.5, gamma: 0.001, theta: -5, vega: 12 }), pe: leg(PE, 190, { delta: -0.5, gamma: 0.001, theta: -4, vega: 12 }) }],
  });
  const seen = [];
  const orders = { positions: async (ctx, account, o) => (seen.push([account, o]), { items, freshness: { source: "broker" } }) };
  return { routes: positionRoutes({ marketData: md, orders }), md, seen };
}

describe("lot-split", () => {
  it("splits NIFTY under the freeze limit and never touches orders", async () => {
    const orders = new Proxy({}, { get: () => () => { throw new Error("orders must not be used"); } });
    const h = find(positionRoutes({ orders, marketData: {} }), "POST", "/v1/analytics/lot-split");
    const r = await h(ctxFor("", { symbol: "NFO:NIFTY-2026-11-24-FUT", quantity: 65 * 60, lotSize: 65 }));
    expect(r.data.planOnly).toBe(true);
    expect(r.data.freezeQty).toBe(1800);
    expect(r.data.maxLotsPerOrder).toBe(27);
    expect(r.data.children.map((c) => c.lots)).toEqual([27, 27, 6]);
    expect(r.data.children.every((c) => c.quantity <= 1800 && c.quantity % 65 === 0)).toBe(true);
    expect(r.data.children.reduce((t, c) => t + c.quantity, 0)).toBe(3900);
    expect(r.data.warnings[0]).toMatch(/unverified/);
  });
  it("builds an iceberg schedule with smaller slices", () => {
    const d = buildLotSplit({ symbol: "NFO:BANKNIFTY-2026-11-24-FUT", quantity: 300, lotSize: 30, iceberg: { sliceLots: 4, delayMs: 250 } });
    expect(d.iceberg.schedule.map((s) => [s.lots, s.sendAfterMs])).toEqual([[4, 0], [4, 250], [2, 500]]);
    expect(d.iceberg.totalDurationMs).toBe(500);
  });
  it("a single slice needs no split", () => {
    expect(buildLotSplit({ symbol: "NFO:NIFTY-2026-11-24-FUT", quantity: 130, lotSize: 65 }).needsSplit).toBe(false);
  });
  it("lower request freezeQty wins; higher cannot raise the table", () => {
    expect(buildLotSplit({ symbol: "NFO:NIFTY-2026-11-24-FUT", quantity: 650, lotSize: 65, freezeQty: 650 }).freezeQty).toBe(650);
    expect(buildLotSplit({ symbol: "NFO:NIFTY-2026-11-24-FUT", quantity: 650, lotSize: 65, freezeQty: 99999 }).freezeQty).toBe(1800);
  });
  it("needs freezeQty for contracts without a table entry", () => {
    expect(() => buildLotSplit({ symbol: "NFO:RELIANCE-2026-11-24-FUT", quantity: 1000, lotSize: 500 })).toThrow(/freezeQty/);
    expect(buildLotSplit({ symbol: "NFO:RELIANCE-2026-11-24-FUT", quantity: 1000, lotSize: 500, freezeQty: 500 }).orderCount).toBe(2);
  });
  it("rejects bad input", async () => {
    const h = find(positionRoutes({}), "POST", "/v1/analytics/lot-split");
    await expect(h(ctxFor("", { symbol: "NFO:NIFTY-2026-11-24-FUT", quantity: 100, lotSize: 65 }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(h(ctxFor("", { symbol: "nonsense", quantity: 65, lotSize: 65 }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(h(ctxFor("", { symbol: "NFO:NIFTY-2026-11-24-FUT", quantity: 65, lotSize: 65, extra: 1 }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(() => planSlices({ quantity: 4000, lotSize: 2000, freezeQty: 1800 })).toThrow(/larger than the freeze/);
    expect(() => buildLotSplit({ symbol: "NFO:NIFTY-2026-11-24-FUT", quantity: 65 * 600, lotSize: 65, freezeQty: 65 })).toThrow(/limit/);
  });
  it("exposes the expected route table", () => {
    const rs = positionRoutes({});
    expect(rs.map((r) => r.slice(0, 3))).toEqual([
      ["POST", "/v1/analytics/lot-split", { scope: "read" }],
      ["GET", "/v1/analytics/position-greeks", { scope: "read" }],
    ]);
  });
});

describe("position-greeks", () => {
  it("nets a short call and a long put per unit, with exposure and rollup", async () => {
    const { routes, seen } = setup([
      { symbol: CE, product: "INTRADAY", netQty: -130, avgPrice: 200, ltp: 200, pnl: 0 },
      { symbol: PE, product: "INTRADAY", netQty: 65, avgPrice: 190, ltp: 190, pnl: 0 },
      { symbol: "NFO:NIFTY-2026-11-24-FUT", product: "INTRADAY", netQty: 65 },
      { symbol: PE.replace("25000", "24000"), product: "INTRADAY", netQty: 0 },
    ]);
    const r = await find(routes, "GET", "/v1/analytics/position-greeks")(ctxFor("account=paper&mode=paper"));
    expect(seen).toEqual([["paper", { mode: "paper" }]]);
    const [ce, pe] = r.data.positions;
    expect(ce.delta).toBe(-65);
    expect(ce.deltaExposure).toBe(-1_625_000);
    expect(ce.theta).toBe(650);
    expect(pe.delta).toBe(-32.5);
    expect(r.data.net.delta).toBe(-97.5);
    expect(r.data.net.vega).toBe(-130 * 12 + 65 * 12);
    expect(r.data.byUnderlying).toHaveLength(1);
    expect(r.data.byUnderlying[0]).toMatchObject({ underlying: "NIFTY", positions: 2, delta: -97.5 });
    expect(r.data.skipped).toEqual([{ symbol: "NFO:NIFTY-2026-11-24-FUT", reason: "not an option" }]);
    expect(r.meta.accountId).toBe("paper");
  });
  it("computes Greeks from LTP when the chain has none", () => {
    const chain = { underlyingLtp: 25000, rows: [{ strike: 25000, ce: leg(CE, 300, { delta: null, gamma: null, theta: null, vega: null, greeksSource: null }), pe: null }] };
    const r = aggregatePositionGreeks([{ symbol: CE, netQty: 65 }], new Map([[`NIFTY|${EXP}`, chain]]));
    expect(r.positions[0].greeksSource).toBe("computed");
    expect(r.positions[0].delta).toBeGreaterThan(0);
  });
  it("flags positions whose leg or chain is missing and reports chain errors", async () => {
    const { routes } = setup([{ symbol: `NFO:NIFTY-${EXP}-26000-CE`, netQty: 65 }, { symbol: "NFO:SENSEX-2026-11-26-80000-CE", netQty: 20 }]);
    const r = await find(routes, "GET", "/v1/analytics/position-greeks")(ctxFor("account=paper"));
    expect(r.data.positions.every((p) => p.greeksAvailable === false)).toBe(true);
    expect(r.errors).toHaveLength(1);
    expect(r.data.net.delta).toBe(0);
  });
  it("validates account and enforces account access", async () => {
    const { routes } = setup([]);
    const h = find(routes, "GET", "/v1/analytics/position-greeks");
    await expect(h(ctxFor(""))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(h(ctxFor("account=Bad_Id"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(h(ctxFor("account=paper&mode=x"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const deny = () => { throw Object.assign(new Error("no"), { code: "FORBIDDEN" }); };
    await expect(h(ctxFor("account=paper", undefined, deny))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
