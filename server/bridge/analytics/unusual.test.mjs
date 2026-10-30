import { describe, expect, it } from "vitest";
import { aggressorProxy, scanChain, scoreOf, unusualRoutes } from "./unusual.mjs";
import { createFakeMarketData } from "../market/fake.mjs";

const leg = (symbol, o = {}) => ({ symbol, ltp: 100, bid: 99, ask: 101, oi: 1000, oiChange: 0, volume: 100, iv: 15, ...o });
const chainOf = (rows, extra = {}) => ({ underlyingLtp: 25000, lotSize: 75, rows, ...extra });
const ctx = (query) => ({ query: new URLSearchParams(query), requestId: "r1", principal: { kind: "local" }, requireAccountAccess() {} });
const S = (k, r) => `NFO:NIFTY-2026-12-31-${k}-${r}`;

const rows = [
  { strike: 25000, ce: leg(S(25000, "CE"), { iv: 15 }), pe: leg(S(25000, "PE"), { iv: 15 }) },
  // OTM call: 4 % OTM, heavy volume, high IV, OI growth, ltp at ask
  { strike: 26000, ce: leg(S(26000, "CE"), { ltp: 20.3, bid: 19, ask: 20.5, volume: 8000, oi: 2000, oiChange: 1000, iv: 24 }), pe: leg(S(26000, "PE"), { volume: 0 }) },
  { strike: 24000, ce: null, pe: leg(S(24000, "PE"), { ltp: 5, bid: 4.5, ask: 6, volume: 10, oi: 0 }) },
];

describe("pure functions", () => {
  it("aggressor proxy", () => {
    expect(aggressorProxy({ ltp: 20.3, bid: 19, ask: 20.5 }).side).toBe("buyer-aggressive");
    expect(aggressorProxy({ ltp: 19.1, bid: 19, ask: 20.5 }).side).toBe("seller-aggressive");
    expect(aggressorProxy({ ltp: 19.75, bid: 19, ask: 20.5 }).side).toBe("neutral");
    expect(aggressorProxy({ ltp: 5, bid: null, ask: 6 })).toEqual({ position: null, side: null, proxy: true });
  });
  it("scoreOf is bounded and monotone", () => {
    expect(scoreOf({})).toBe(0);
    expect(scoreOf({ volOi: 99, premiumInr: 1e12, otmPct: 50, ivVsAtm: 3, oiChangePct: 500 })).toBe(100);
    expect(scoreOf({ volOi: 1.5 })).toBe(15);
  });
  it("scanChain computes metrics and flags", () => {
    const items = scanChain({ underlying: "NIFTY", expiry: "2026-12-31", ...chainOf(rows, { atmStrike: 25000 }) });
    expect(items.map((c) => `${c.strike}${c.side}`)).toEqual(["25000call", "25000put", "26000call", "24000put"]);
    const c = items.find((x) => x.strike === 26000);
    expect(c.volOi).toBe(4);
    expect(c.premiumInr).toBe(8000 * 20.3 * 75);
    expect(c.otmPct).toBe(4);
    expect(c.ivVsAtm).toBe(1.6);
    expect(c.oiChangePct).toBe(100);
    expect(c.aggressor.side).toBe("buyer-aggressive");
    expect(c.flags).toEqual(["VOLUME_SPIKE", "BIG_PREMIUM", "OTM_LOTTERY", "IV_ANOMALY", "OI_BUILDUP"]);
    expect(c.score).toBeGreaterThan(70);
    expect(items[0].flags).toEqual([]);
    const zeroOi = items.find((x) => x.strike === 24000);
    expect(zeroOi.volOi).toBeNull();
    expect(zeroOi.otmPct).toBe(4);
  });
  it("premium is null without a lot size", () => {
    const items = scanChain({ ...chainOf(rows), lotSize: null });
    expect(items.every((c) => c.premiumInr === null)).toBe(true);
  });
});

describe("route", () => {
  function setup() {
    const md = createFakeMarketData({ prices: { "NSE:NIFTY": 25000, "NSE:BANKNIFTY": 52000 }, clock: { now: () => Date.parse("2026-12-01T05:00:00Z") } });
    md.setExpiries("NIFTY", ["2026-11-24", "2026-12-31"]);
    md.setChain("NIFTY", "2026-12-31", chainOf(rows));
    md.setExpiries("BANKNIFTY", []);
    const [[method, path, opts, handler]] = unusualRoutes({ marketData: md, now: () => Date.parse("2026-12-01T05:00:00Z") });
    return { md, method, path, opts, handler };
  }
  it("shape and default nearest expiry", async () => {
    const { method, path, opts, handler } = setup();
    expect([method, path, opts]).toEqual(["GET", "/v1/analytics/unusual", { scope: "read" }]);
    const r = await handler(ctx("underlyings=nifty,BANKNIFTY"));
    expect(r.data.underlyings[0]).toMatchObject({ underlying: "NIFTY", expiry: "2026-12-31", contracts: 4 });
    expect(r.data.contracts[0].strike).toBe(26000);
    expect(r.data.method.score).toContain("score =");
    expect(r.errors).toEqual([expect.objectContaining({ underlying: "BANKNIFTY", code: "SYMBOL_NOT_FOUND" })]);
    expect(r.meta.requestId).toBe("r1");
  });
  it("filters, sort and limit", async () => {
    const { handler } = setup();
    const e = "expiry=2026-12-31";
    expect((await handler(ctx(`underlyings=NIFTY&${e}&side=put`))).data.contracts.every((c) => c.side === "put")).toBe(true);
    expect((await handler(ctx(`underlyings=NIFTY&${e}&minVolOi=2`))).data.contracts.map((c) => c.strike)).toEqual([26000]);
    expect((await handler(ctx(`underlyings=NIFTY&${e}&minPremium=1000000`))).data.count).toBe(1);
    const byPrem = await handler(ctx(`underlyings=NIFTY&${e}&sort=premium&limit=2`));
    expect(byPrem.data.contracts).toHaveLength(2);
    expect(byPrem.data.count).toBe(4);
    expect(byPrem.data.contracts[0].premiumInr).toBeGreaterThanOrEqual(byPrem.data.contracts[1].premiumInr);
  });
  it("validates input", async () => {
    const { handler } = setup();
    for (const q of ["", "underlyings=A,B,C,D,E,F,G,H,I,J,K", "underlyings=NIFTY&side=x", "underlyings=NIFTY&sort=x", "underlyings=NIFTY&expiry=tomorrow", "underlyings=NIFTY&limit=0", "underlyings=NIFTY&minPremium=-1", "underlyings=NIFTY&limit=2.5"]) {
      await expect(handler(ctx(q))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });
});
