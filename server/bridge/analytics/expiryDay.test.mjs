import { describe, expect, it } from "vitest";
import { expiryDayRoutes, hoursToExpiry } from "./expiryDay.mjs";
import { createFakeMarketData } from "../market/fake.mjs";

const NOW = Date.parse("2026-10-27T09:30:00+05:30"); // 6 hours before the 15:30 cutoff
const leg = (strike, right, oi, ltp, gamma = 0.001) => ({ symbol: `NFO:NIFTY-2026-10-27-${strike}-${right}`, ltp, oi, oiChange: 0, volume: 1, gamma });
function setup() {
  const md = createFakeMarketData({ prices: { "NSE:NIFTY": 25100 } });
  md.setExpiries("NIFTY", ["2026-10-20", "2026-10-27", "2026-11-03"]);
  md.setChain("NIFTY", "2026-10-27", {
    underlyingLtp: 25100,
    lotSize: 75,
    rows: [
      { strike: 25000, ce: leg(25000, "CE", 300, 140), pe: leg(25000, "PE", 500, 30) },
      { strike: 25100, ce: leg(25100, "CE", 400, 60), pe: leg(25100, "PE", 400, 55) },
      { strike: 25200, ce: leg(25200, "CE", 900, 20), pe: leg(25200, "PE", 100, 120) },
    ],
  });
  md.setQuote("NFO:NIFTY-2026-10-27-25100-CE", { ltp: 60, open: 120 });
  md.setQuote("NFO:NIFTY-2026-10-27-25100-PE", { ltp: 55, open: 100 });
  const routes = expiryDayRoutes({ marketData: md, now: () => NOW });
  const h = Object.fromEntries(routes.map(([, p, , fn]) => [p.split("/").pop(), fn]));
  return { md, routes, h };
}
const ctx = (qs) => ({ query: new URLSearchParams(qs), requestId: "r1", requireAccountAccess() {}, principal: { kind: "local" } });

describe("expiryDayRoutes", () => {
  it("returns read-scope GET route tuples", () => {
    const { routes } = setup();
    expect(routes.map(([m, p, o]) => [m, p, o.scope])).toEqual([
      ["GET", "/v1/analytics/expiry-day", "read"],
      ["GET", "/v1/analytics/time-machine", "read"],
    ]);
  });

  it("computes hours to the 15:30 IST cutoff", () => {
    expect(hoursToExpiry("2026-10-27", NOW)).toBe(6);
    expect(hoursToExpiry("2026-10-27", Date.parse("2026-10-27T16:00:00+05:30"))).toBe(0);
  });

  it("builds the digest for the nearest expiry with flags", async () => {
    const { h } = setup();
    const { data, meta } = await h["expiry-day"](ctx("underlying=NIFTY&maxPainPct=0.1"));
    expect(data.expiry).toBe("2026-10-27");
    expect(data.timeToExpiry.hours).toBe(6);
    expect(data.timeToExpiry.isExpiryDay).toBe(true);
    expect(data.straddle).toMatchObject({ strike: 25100, price: 115, dayOpenPrice: 220, decayedPct: 47.73 });
    expect(data.maxPain.strike).toBe(25100);
    expect(data.oiWalls.resistance[0]).toEqual({ strike: 25200, value: 900 });
    expect(data.oiWalls.support[0]).toEqual({ strike: 25000, value: 500 });
    expect(["positive", "negative", "neutral"]).toContain(data.gamma.regime);
    expect(data.flags.map((f) => f.code)).not.toContain("STRADDLE_DECAYED");
    expect(meta.requestId).toBe("r1");
    const hi = await h["expiry-day"](ctx("underlying=NIFTY&decayPct=40"));
    expect(hi.data.flags.map((f) => f.code)).toContain("STRADDLE_DECAYED");
  });

  it("flags spot beyond max pain", async () => {
    const { md, h } = setup();
    md.setChain("NIFTY", "2026-10-27", {
      underlyingLtp: 25200,
      rows: [
        { strike: 25000, ce: leg(25000, "CE", 900, 200), pe: leg(25000, "PE", 100, 5) },
        { strike: 25200, ce: leg(25200, "CE", 100, 40), pe: leg(25200, "PE", 100, 40) },
      ],
    });
    const { data } = await h["expiry-day"](ctx("underlying=NIFTY&expiry=2026-10-27&maxPainPct=0.5"));
    expect(data.maxPain.spotDistance).toBe(data.spot - data.maxPain.strike);
    if (Math.abs(data.maxPain.spotDistancePct) >= 0.5) expect(data.flags.map((f) => f.code)).toContain("SPOT_BEYOND_MAX_PAIN");
    expect(data.straddle.decayedPct).toBeNull(); // no quotes for these legs, nothing invented
  });

  it("validates input", async () => {
    const { h } = setup();
    await expect(h["expiry-day"](ctx(""))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(h["expiry-day"](ctx("underlying=NIFTY&expiry=27-10"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(h["expiry-day"](ctx("underlying=NIFTY&decayPct=abc"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(h["time-machine"](ctx("symbol=NSE:NIFTY&interval=5m"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("replays candles with ATM strikes and states limitations", async () => {
    const { md, h } = setup();
    const t0 = Math.floor(Date.parse("2026-10-27T09:15:00+05:30") / 1000);
    md.setCandles("NSE:NIFTY", "5m", [
      { time: t0, open: 25000, high: 25040, low: 24990, close: 25030, volume: 10 },
      { time: t0 + 300, open: 25030, high: 25100, low: 25020, close: 25080, volume: 12 },
    ]);
    const { data } = await h["time-machine"](ctx(`symbol=NSE:NIFTY&interval=5m&from=${t0}`));
    expect(data.count).toBe(2);
    expect(data.bars.map((b) => b.atmStrike)).toEqual([25050, 25100]);
    expect(data.bars[1].atmShift).toBe(50);
    expect(data.bars[1].moveFromStart).toBe(80);
    expect(data.limitations.join(" ")).toMatch(/not stored/);
    expect(data.bars[0]).not.toHaveProperty("cePrice");
    expect(md.calls.some(([n]) => n === "optionChain")).toBe(false);
  });
});
