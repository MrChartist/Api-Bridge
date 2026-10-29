/** Strategy builder maths (options.js, PRD 02): legs v2, payoffs with futures, stats, greeks, charges, margin, presets. */
import { describe, expect, it } from "vitest";
import * as O from "./options.js";
import { refCharges } from "./reference.js";

/** The reference charge table (reference.js fallback: the shipped figures). */
const RATES = refCharges(null);

const L = (right, strike, side, price, lots = 1, extra = {}) => ({ kind: "OPT", right, strike, side, price, lots, iv: 12, on: true, ...extra });
const FUT = (side, price, extra = {}) => ({ kind: "FUT", right: null, strike: null, side, price, lots: 1, on: true, basis0: 0, futYears: 0, ...extra });

const q = (ltp, extra = {}) => ({ symbol: "X", ltp, bid: ltp - 0.5, ask: ltp + 0.5, iv: 12, ...extra });
const STRIKES = Array.from({ length: 21 }, (_, i) => 25500 + i * 50);
const chain = {
  underlying: "NIFTY",
  expiry: "2026-11-03",
  underlyingLtp: 26010,
  atmStrike: 26000,
  lotSize: 75,
  rows: STRIKES.map((k) => ({ strike: k, ce: q(Math.max(5, 26010 - k) + 60, { symbol: `NFO:NIFTY-2026-11-03-${k}-CE` }), pe: q(Math.max(5, k - 26010) + 55, { symbol: `NFO:NIFTY-2026-11-03-${k}-PE` }) })),
};

describe("legs v2", () => {
  it("legUnits uses the leg's own lot size, else the fallback", () => {
    expect(O.legUnits({ lots: 2, lotSize: 30 }, 75)).toBe(60);
    expect(O.legUnits({ lots: 2 }, 75)).toBe(150);
    expect(O.legUnits({ lots: 1.9 }, 75)).toBe(75);
  });
  it("migrateLegs adds id, kind, expiry, lot size and on; drops junk; caps at 12", () => {
    const m = O.migrateLegs([{ right: "CE", strike: 26000, side: "SELL", lots: 2, entry: 110 }, { right: "XX", strike: 1, side: "BUY" }, null], "2026-11-03", { lotSize: 75 });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: "OPT", right: "CE", strike: 26000, side: "SELL", lots: 2, entry: 110, expiry: "2026-11-03", lotSize: 75, on: true });
    expect(m[0].id).toMatch(/^l/);
    const many = O.migrateLegs(Array.from({ length: 15 }, () => ({ right: "PE", strike: 26000, side: "BUY", lots: 1 })), "2026-11-03");
    expect(many).toHaveLength(12);
    expect(new Set(many.map((l) => l.id)).size).toBe(12);
    const fut = O.migrateLegs([{ kind: "FUT", side: "BUY", lots: 1, expiry: "2026-11-24", symbol: "NFO:NIFTY-2026-11-24-FUT", lotSize: 75 }], "2026-11-03");
    expect(fut[0]).toMatchObject({ kind: "FUT", right: null, strike: null, expiry: "2026-11-24" });
  });
  it("activeLegs drops switched-off legs from every figure", () => {
    const legs = [L("CE", 26000, "BUY", 100), L("CE", 26100, "SELL", 60, 1, { on: false })];
    expect(O.activeLegs(legs)).toHaveLength(1);
    expect(O.netPremium(legs, 75)).toBe(-7500);
    expect(O.strategyStats(legs, 75).maxProfit).toBeNull();
  });
});

describe("payoffs with futures", () => {
  it("a FUT leg is linear with its basis decaying to the option expiry", () => {
    const f = FUT("BUY", 26100, { basis0: 100, futYears: 20 / 365 });
    // Option expiry in 5 days: 15 of 20 days of basis left.
    expect(O.payoffAt([f], 26000, 75, { years: 5 / 365 })).toBeCloseTo((26000 + 75 - 26100) * 75, 6);
    expect(O.valueAt([f], 26000, 75, null, 0, { el: 0 })).toBeCloseTo(0, 6);
    expect(O.netPremium([f], 75)).toBe(0);
  });
  it("valueAt falls back to intrinsic once the target passes a leg's expiry", () => {
    const legs = [L("CE", 26000, "BUY", 110, 1, { years: 5 / 365 })];
    expect(O.valueAt(legs, 26200, 75, null, 0, { el: 6 / 365 })).toBeCloseTo((200 - 110) * 75, 6);
  });
  it("an IV shift raises a long straddle's value", () => {
    const legs = [L("CE", 26000, "BUY", 110, 1, { years: 10 / 365 }), L("PE", 26000, "BUY", 100, 1, { years: 10 / 365 })];
    const a = O.valueAt(legs, 26000, 75, null, 0, { el: 2 / 365 });
    const b = O.valueAt(legs, 26000, 75, null, 0, { el: 2 / 365, ivShift: 3 });
    expect(b).toBeGreaterThan(a);
  });
  it("valueAt is null when an option leg has no IV", () => {
    expect(O.valueAt([L("CE", 26000, "BUY", 110, 1, { iv: null, years: 0.02 })], 26000, 75, null, 0, { el: 0 })).toBeNull();
  });
});

describe("strategyStats", () => {
  it("a naked short put has a finite max loss at S = 0", () => {
    const s = O.strategyStats([L("PE", 26000, "SELL", 100)], 75);
    expect(s.maxLoss).toBeCloseTo(-(26000 - 100) * 75, 6);
    expect(s.maxProfit).toBeCloseTo(100 * 75, 6);
  });
  it("a short call is unlimited, with a stress loss at +2σ", () => {
    const s = O.strategyStats([L("CE", 26000, "SELL", 100)], 75, { forward: 26000, ivPct: 12, years: 7 / 365 });
    expect(s.maxLoss).toBeNull();
    const up = 26000 * Math.exp(2 * 0.12 * Math.sqrt(7 / 365));
    expect(s.stress.price).toBeCloseTo(up, 6);
    expect(s.stress.value).toBeCloseTo(-(up - 26000 - 100) * 75, 4);
  });
  it("long future + long put: a finite floor and unlimited profit", () => {
    const s = O.strategyStats([FUT("BUY", 26000), L("PE", 25900, "BUY", 80)], 75);
    expect(s.maxProfit).toBeNull();
    expect(s.maxLoss).toBeCloseTo(-(100 + 80) * 75, 6);
  });
  it("a butterfly has exactly two breakevens", () => {
    const s = O.strategyStats([L("CE", 25900, "BUY", 180), L("CE", 26000, "SELL", 110, 2), L("CE", 26100, "BUY", 60)], 75);
    expect(s.breakevens).toHaveLength(2);
    expect(s.breakevens[0]).toBeCloseTo(25920, 6);
    expect(s.breakevens[1]).toBeCloseTo(26080, 6);
  });
  it("a breakeven exactly at a strike counts once", () => {
    // Short put 26000 @ 0 with a long put 25900 @ 0: payoff 0 at and above 26000 → one breakeven region start.
    const s = O.strategyStats([L("CE", 26000, "BUY", 100), L("PE", 26100, "BUY", 0, 1)], 75);
    const counts = new Map();
    for (const b of s.breakevens) counts.set(Math.round(b), (counts.get(Math.round(b)) ?? 0) + 1);
    for (const c of counts.values()) expect(c).toBe(1);
    const t = O.strategyStats([L("CE", 26000, "BUY", 0)], 75);
    expect(t.breakevens.filter((b) => Math.abs(b - 26000) < 1)).toHaveLength(1);
  });
  it("a box is locked", () => {
    const s = O.strategyStats([L("CE", 26000, "BUY", 110), L("CE", 26100, "SELL", 60), L("PE", 26100, "BUY", 150), L("PE", 26000, "SELL", 100)], 75);
    expect(s.maxProfit - s.maxLoss).toBeLessThan(1);
    expect(s.locked).toBeCloseTo(0, 6);
  });
  it("charges move a long straddle's breakevens outward", () => {
    const legs = [L("CE", 26000, "BUY", 110), L("PE", 26000, "BUY", 100)];
    const gross = O.strategyStats(legs, 75);
    const ch = { entry: O.charges(legs, RATES, { lotSize: 75 }).total, exit: (S) => O.exitCharges(legs, S, RATES, { lotSize: 75 }) };
    const net = O.strategyStats(legs, 75, { charges: ch });
    expect(net.breakevens[0]).toBeLessThan(gross.breakevens[0]);
    expect(net.breakevens[1]).toBeGreaterThan(gross.breakevens[1]);
  });
  it("long call PoP = 1 − N(d2) at the breakeven", () => {
    const T = 10 / 365;
    const s = O.strategyStats([L("CE", 26000, "BUY", 110)], 75, { forward: 26000, ivPct: 12, years: T });
    expect(s.pop).toBeCloseTo(O.probItm(26000, 26110, T, 12, "CE"), 6);
  });
  it("short strangle PoP is in (0, 1) and falls as the IV shift rises", () => {
    const legs = [L("CE", 26200, "SELL", 40), L("PE", 25800, "SELL", 40)];
    const T = 7 / 365;
    const a = O.strategyStats(legs, 75, { forward: 26000, ivPct: 12, years: T }).pop;
    const b = O.strategyStats(legs, 75, { forward: 26000, ivPct: 12, years: T, ivShift: 4 }).pop;
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
    expect(b).toBeLessThan(a);
  });
});

describe("strategyStats: charges and calendars", () => {
  it("iron condor max loss after charges ≈ gross max loss + entry/exit charges", () => {
    const legs = [L("PE", 25800, "BUY", 20), L("PE", 26000, "SELL", 45), L("CE", 26800, "SELL", 30), L("CE", 27000, "BUY", 15)];
    const opts = { forward: 26400, ivPct: 12, years: 6 / 365 };
    const gross = O.strategyStats(legs, 75, opts);
    const ch = O.strategyCharges(legs, RATES, { lotSize: 75, ...opts });
    const net = O.strategyStats(legs, 75, { ...opts, charges: ch });
    expect(net.maxLoss).toBeLessThan(gross.maxLoss);
    expect(gross.maxLoss - net.maxLoss).toBeLessThan(ch.entry + 200);
  });
  it("collar max loss is not inflated by exercise STT on the put at S = 0", () => {
    const legs = [FUT("BUY", 26400), L("PE", 26000, "BUY", 60), L("CE", 26800, "SELL", 50)];
    const opts = { forward: 26400, ivPct: 12, years: 6 / 365 };
    const gross = O.strategyStats(legs, 75, opts);
    const ch = O.strategyCharges(legs, RATES, { lotSize: 75, ...opts });
    const net = O.strategyStats(legs, 75, { ...opts, charges: ch });
    const sttAtZero = 26000 * 75 * RATES.opt.exerciseStt;
    expect(gross.maxLoss - net.maxLoss).toBeCloseTo(ch.entry + ch.exit(0), 0);
    expect(gross.maxLoss - net.maxLoss).toBeLessThan(ch.entry + ch.exit(26400) + sttAtZero / 2);
  });
  it("a calendar (legs with different expiries) samples the curved payoff", () => {
    const T1 = 5 / 365;
    const T2 = 33 / 365;
    const legs = [L("CE", 25000, "SELL", 120, 1, { iv: 14, years: T1 }), L("CE", 25000, "BUY", 300, 1, { iv: 14, years: T2 })];
    const s = O.strategyStats(legs, 75, { forward: 25000, ivPct: 14, years: T1 });
    expect(s.breakevens).toHaveLength(2);
    const f = O.strategyPayoff(legs, 75, { years: T1 });
    for (const b of s.breakevens) expect(Math.abs(f(b))).toBeLessThan(5);
    expect(s.breakevens[0]).toBeGreaterThan(24000);
    expect(s.breakevens[1]).toBeLessThan(26000);
    expect(s.breakevens[0]).toBeCloseTo(24488, -1);
    expect(s.breakevens[1]).toBeCloseTo(25536, -1);
    const sd = 0.14 * Math.sqrt(T1);
    const cdf = (x) => O.normCdf(Math.log(x / 25000) / sd + sd / 2);
    expect(s.pop).toBeCloseTo(cdf(s.breakevens[1]) - cdf(s.breakevens[0]), 6);
    expect(s.maxProfit).toBeCloseTo(Math.max(...Array.from({ length: 2001 }, (_, i) => f(23000 + i * 2))), -2);
  });
});

describe("expected value and greeks", () => {
  it("a long call bought at its Black-76 price has EV ≈ 0", () => {
    const T = 20 / 365;
    const c = O.black76(26000, 26100, T, 14, "CE");
    const ev = O.expectedValue([L("CE", 26100, "BUY", c)], 1, { forward: 26000, ivPct: 14, years: T });
    expect(Math.abs(ev)).toBeLessThan(0.005 * c);
  });
  it("black76Greeks match finite differences; Δc − Δp = 1", () => {
    const F = 26000;
    const K = 26150;
    const T = 15 / 365;
    const iv = 13;
    for (const right of ["CE", "PE"]) {
      const g = O.black76Greeks(F, K, T, iv, right);
      const p = (f, t = T, v = iv) => O.black76(f, K, t, v, right);
      const h = 0.5;
      expect(g.delta).toBeCloseTo((p(F + h) - p(F - h)) / (2 * h), 4);
      expect(g.gamma / ((p(F + 5) - 2 * p(F) + p(F - 5)) / 25)).toBeCloseTo(1, 2);
      expect(g.vega / ((p(F, T, iv + 0.01) - p(F, T, iv - 0.01)) / 0.02)).toBeCloseTo(1, 3);
      const dt = 1e-5;
      // Theta is per trading-day unit of the (default, weighted) clock: 1 / 268.95 of a year.
      expect(g.theta / (-(p(F, T + dt) - p(F, T - dt)) / (2 * dt) / 268.95)).toBeCloseTo(1, 3);
    }
    expect(O.black76Greeks(F, K, T, iv, "CE").delta - O.black76Greeks(F, K, T, iv, "PE").delta).toBeCloseTo(1, 10);
    expect(O.black76Greeks(F, K, 0, iv, "PE")).toEqual({ delta: -1, gamma: 0, theta: 0, vega: 0 });
  });
  it("netGreeksModel: short straddle is short gamma and vega, long theta; FUT Δ = 1 per unit", () => {
    const legs = [L("CE", 26000, "SELL", 110, 1, { years: 7 / 365 }), L("PE", 26000, "SELL", 100, 1, { years: 7 / 365 })];
    const g = O.netGreeksModel(legs, 26000, { lotSize: 75 });
    expect(Math.abs(g.delta)).toBeLessThan(5);
    expect(g.gamma).toBeLessThan(0);
    expect(g.vega).toBeLessThan(0);
    expect(g.theta).toBeGreaterThan(0);
    expect(O.netGreeksModel([FUT("SELL", 26000)], 26000, { lotSize: 75 }).delta).toBe(-75);
  });
  it("model delta agrees with the chain's delta on demo-like inputs", () => {
    const T = 7 / 365;
    const d = O.black76Greeks(26000, 26100, T, 12, "CE").delta;
    const c = { lotSize: 75, rows: [{ strike: 26100, ce: { delta: d + 0.004 } }] };
    const chainD = O.netGreeks([L("CE", 26100, "BUY", 50)], c).delta;
    const modelD = O.netGreeksModel([L("CE", 26100, "BUY", 50, 1, { years: T })], 26000, { lotSize: 75 }).delta;
    expect(Math.abs(chainD - modelD) / 75).toBeLessThan(0.01);
  });
});

describe("charges", () => {
  it("a 1-lot NSE option sell, by hand", () => {
    const c = O.charges([L("CE", 26000, "SELL", 100, 1, { symbol: "NFO:NIFTY-2026-11-03-26000-CE" })], RATES, { lotSize: 75 });
    const t = 7500;
    expect(c.brokerage).toBe(20);
    expect(c.stt).toBeCloseTo(t * 0.0015, 9);
    expect(c.txn).toBeCloseTo(t * 0.0003503, 9);
    expect(c.sebi).toBeCloseTo(t * 1e-6, 9);
    expect(c.stamp).toBe(0);
    expect(c.gst).toBeCloseTo(0.18 * (20 + t * 0.0003503 + t * 1e-6), 9);
    expect(c.total).toBeCloseTo(20 + t * 0.0015 + t * 0.0003503 + t * 1e-6 + 0.18 * (20 + t * 0.0003503 + t * 1e-6), 9);
  });
  it("a BSE buy pays stamp and the BSE rate, no STT", () => {
    const c = O.charges([L("PE", 80000, "BUY", 200, 1, { symbol: "BFO:SENSEX-2026-11-06-80000-PE", lotSize: 20 })], RATES);
    expect(c.stt).toBe(0);
    expect(c.stamp).toBeCloseTo(4000 * 0.00003, 9);
    expect(c.txn).toBeCloseTo(4000 * 0.000325, 9);
  });
  it("exercise STT on a long ITM option at expiry", () => {
    expect(O.exitCharges([L("CE", 26000, "BUY", 50)], 26200, RATES, { lotSize: 75 })).toBeCloseTo(200 * 75 * 0.0015, 9);
    expect(O.exitCharges([L("CE", 26000, "SELL", 50)], 26200, RATES, { lotSize: 75 })).toBe(0);
  });
});

describe("margin estimate", () => {
  it("iron condor = |max loss|", () => {
    const legs = [L("PE", 25700, "BUY", 20), L("PE", 25800, "SELL", 35), L("CE", 26200, "SELL", 35), L("CE", 26300, "BUY", 20)];
    const m = O.marginEstimate(legs, 75, { forward: 26000, years: 5 / 365 });
    expect(m.defined).toBe(true);
    expect(m.required).toBeCloseTo(-O.strategyStats(legs, 75).maxLoss, 6);
  });
  it("short strangle = price-scan loss + 2% exposure; ELM only on expiry day", () => {
    const legs = [L("CE", 26200, "SELL", 40), L("PE", 25800, "SELL", 40)];
    const m = O.marginEstimate(legs, 75, { forward: 26000, years: 5 / 365 });
    const scan = -(O.payoffAt(legs, 26000 * 0.91, 75));
    expect(m.defined).toBe(false);
    expect(m.scanLoss).toBeCloseTo(Math.max(scan, -O.payoffAt(legs, 26000 * 1.09, 75)), 6);
    expect(m.required).toBeCloseTo(m.scanLoss + 0.02 * 2 * 75 * 26000, 6);
    const e = O.marginEstimate(legs, 75, { forward: 26000, years: 0.001, expiryToday: true });
    expect(e.elm).toBeCloseTo(0.02 * 2 * 75 * 26000, 6);
  });
  it("a naked short put is not defined risk: its margin is a scan, below a strangle that contains it", () => {
    const put = [L("PE", 24800, "SELL", 40)];
    const strangle = [L("PE", 24800, "SELL", 40), L("CE", 25200, "SELL", 40)];
    const mp = O.marginEstimate(put, 75, { forward: 25000, years: 5 / 365 });
    const ms = O.marginEstimate(strangle, 75, { forward: 25000, years: 5 / 365 });
    expect(mp.defined).toBe(false);
    expect(mp.required).toBeLessThan(0.2 * 24800 * 75);
    expect(mp.required).toBeLessThanOrEqual(ms.required);
    const bullPut = [L("PE", 24800, "SELL", 40), L("PE", 24700, "BUY", 25)];
    expect(O.marginEstimate(bullPut, 75, { forward: 25000, years: 5 / 365 }).defined).toBe(true);
  });
  it("ratios: ROM, reward/risk and implied rate", () => {
    const r = O.strategyRatios({ maxProfit: 3000, maxLoss: -12000, margin: 40000, locked: 500, net: -100000, years: 0.1 });
    expect(r.rom).toBeCloseTo(0.075, 9);
    expect(r.rr).toBeCloseTo(0.25, 9);
    expect(r.implied).toBeCloseTo(0.05, 9);
    expect(O.strategyRatios({ maxProfit: null, maxLoss: -1 }).rr).toBeNull();
  });
});

describe("presets", () => {
  const fut = { symbol: "NFO:NIFTY-2026-11-24-FUT", expiry: "2026-11-24", lotSize: 75 };
  it("35 presets in 5 groups (7, 7, 11, 4, 6); five calendars", () => {
    expect(O.PRESETS).toHaveLength(35);
    const n = (g) => O.PRESETS.filter((p) => p.group === g).length;
    expect([n("bull"), n("bear"), n("neutral"), n("vol"), n("hedge")]).toEqual([7, 7, 11, 4, 6]);
    expect(O.PRESETS.filter((p) => p.multi).map((p) => p.id)).toEqual(["call-calendar", "put-calendar", "call-diagonal", "double-calendar", "double-diagonal"]);
  });
  it("every preset builds listed strikes, the right sides and ratios", () => {
    const listed = new Set(STRIKES);
    for (const p of O.PRESETS) {
      const legs = O.presetLegs(p.id, chain, { move: 150, forward: 26010, fut, back: "2026-11-10" });
      expect(legs.length, p.id).toBeGreaterThan(0);
      if (p.multi) expect(new Set(legs.map((l) => l.expiry))).toEqual(new Set(["2026-11-03", "2026-11-10"]));
      for (const l of legs) {
        if (l.kind === "FUT") expect(l.symbol).toBe(fut.symbol);
        else expect(listed.has(l.strike), `${p.id} ${l.strike}`).toBe(true);
        expect(["BUY", "SELL"]).toContain(l.side);
      }
      expect(legs.some((l) => l.kind === "FUT")).toBe(p.needsFut);
    }
    expect(O.presetLegs("call-ratio-back", chain, { move: 150 }).map((l) => `${l.side}${l.lots}${l.right}`)).toEqual(["SELL1CE", "BUY2CE"]);
    expect(O.presetLegs("long-call-fly", chain, { move: 150 }).map((l) => l.lots)).toEqual([1, 2, 1]);
    expect(O.presetLegs("collar", chain, { move: 150 })).toEqual([]);
    expect(O.presetLegs("call-calendar", chain, { move: 150 })).toEqual([]);
    expect(O.presetLegs("call-calendar", chain, { move: 150, back: "2026-11-10" }).map((l) => `${l.side} ${l.strike} ${l.expiry}`)).toEqual(["SELL 26000 2026-11-03", "BUY 26000 2026-11-10"]);
    const box = O.presetLegs("box", chain, { move: 150, forward: 26010 });
    expect(box.map((l) => `${l.side} ${l.right} ${l.strike}`)).toEqual(["BUY CE 26000", "SELL CE 26150", "BUY PE 26150", "SELL PE 26000"]);
  });
  it("strikes beyond the rows are clamped", () => {
    const legs = O.presetLegs("iron-condor", chain, { move: 5000 });
    expect(Math.min(...legs.map((l) => l.strike))).toBe(25500);
    expect(Math.max(...legs.map((l) => l.strike))).toBe(26500);
  });
  it("presetGlyph: ≤ 8 points inside the 32 × 16 box", () => {
    for (const p of O.PRESETS) {
      const legs = O.presetLegs(p.id, chain, { move: 150, fut, back: "2026-11-10" }).map((l) => ({ ...l, price: 50 }));
      const g = O.presetGlyph(legs, 75);
      expect(g.points.length).toBeLessThanOrEqual(8);
      for (const [x, y] of g.points) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(32);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(16);
      }
    }
  });
  it("legsMatch compares contracts, sides and lots", () => {
    const a = O.presetLegs("short-strangle", chain, { move: 150 });
    expect(O.legsMatch(O.migrateLegs(a, "2026-11-03"), a)).toBe(true);
    expect(O.legsMatch([{ ...a[0], lots: 2 }, a[1]], a)).toBe(false);
  });
});

describe("building and placing", () => {
  it("shiftLegs moves every option leg one strike; nothing moves at an edge", () => {
    const legs = [L("CE", 26000, "SELL", 1, 1, { entry: 10 }), L("PE", 25950, "SELL", 1), FUT("BUY", 1)];
    const up = O.shiftLegs(legs, [25950, 26000, 26050], 1);
    expect(up.map((l) => l.strike)).toEqual([26050, 26000, null]);
    expect(up[0].entry).toBeUndefined();
    expect(O.shiftLegs(up, [25950, 26000, 26050], 1)).toBe(up);
    expect(O.stepStrike([1, 2, 3], 3, 1)).toBeNull();
    expect(O.stepStrike([1, 2, 3], 2, -1)).toBe(1);
  });
  it("placementPlan: hedges first (furthest first), shorts last (nearest last); exit buys back shorts first", () => {
    const legs = [L("CE", 26200, "SELL", 1), L("PE", 25700, "BUY", 1), L("PE", 25800, "SELL", 1), L("CE", 26400, "BUY", 1), FUT("SELL", 1), FUT("BUY", 1)];
    const plan = O.placementPlan(legs, "entry", { spot: 26000 });
    expect(plan.map((p) => `${p.side} ${p.leg.kind === "FUT" ? "FUT" : p.leg.strike} ${p.phase}`)).toEqual(["BUY 26400 hedge", "BUY 25700 hedge", "BUY FUT hedge", "SELL FUT hedge", "SELL 26200 short", "SELL 25800 short"]);
    const exit = O.placementPlan(legs.slice(0, 4), "exit", { spot: 26000 });
    expect(exit.map((p) => `${p.side} ${p.leg.strike}`)).toEqual(["BUY 26200", "BUY 25800", "SELL 25700", "SELL 26400"]);
  });
  it("retryIndex never picks a row whose order is still working", () => {
    expect(O.retryIndex([{ status: "filled" }, { status: "open" }, { status: "rejected" }, { status: "skipped" }])).toBe(2);
    expect(O.retryIndex([{ status: "filled" }, { status: "partial" }, { status: "timeout" }, { status: "unknown" }])).toBe(-1);
    expect(O.retryIndex([{ status: "cancelled" }])).toBe(0);
  });
  it("scenarioLevels in % and σ", () => {
    const pct = O.scenarioLevels("pct", { spot: 26000 });
    expect(pct).toHaveLength(9);
    expect(pct[0].price).toBeCloseTo(25220, 6);
    const sig = O.scenarioLevels("sigma", { spot: 26000, forward: 26050, ivPct: 12, years: 7 / 365 });
    expect(sig.map((r) => r.k)).toEqual([-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2]);
    expect(sig[8].price).toBeCloseTo(26050 * Math.exp(2 * 0.12 * Math.sqrt(7 / 365)), 6);
    expect(O.scenarioLevels("sigma", { spot: 26000 })).toEqual([]);
  });
  it("sigmaBand and sigmaZ agree", () => {
    const b = O.sigmaBand(26000, 12, 0.02, 1);
    expect(O.sigmaZ(b.hi, 26000, 12, 0.02)).toBeCloseTo(1, 9);
    expect(O.sigmaZ(b.lo, 26000, 12, 0.02)).toBeCloseTo(-1, 9);
  });
  it("payoffModel: shape, stable x-range, target hidden at expiry", () => {
    const legs = [L("CE", 26200, "SELL", 40, 1, { years: 7 / 365 }), L("PE", 25800, "SELL", 40, 1, { years: 7 / 365 })];
    const m = O.payoffModel(legs, { lotSize: 75, spot: 26000, forward: 26020, years: 7 / 365, el: 1 / 365, ivPct: 12 });
    expect(m.xs.length).toBe(m.expiry.length);
    expect(m.target).toHaveLength(m.xs.length);
    expect(m.breakevens).toHaveLength(2);
    expect(m.band1[0]).toBeLessThan(m.band1[1]);
    expect(m.yMin).toBeLessThan(0);
    expect(m.lo).toBeLessThan(25800);
    const again = O.payoffModel(legs, { lotSize: 75, spot: 26000, forward: 26020, years: 7 / 365, el: 3 / 365, ivPct: 12 });
    expect([again.lo, again.hi]).toEqual([m.lo, m.hi]);
    const atExp = O.payoffModel(legs, { lotSize: 75, spot: 26000, forward: 26020, years: 7 / 365, el: 7 / 365, ivPct: 12 });
    expect(atExp.target).toBeNull();
    expect(O.payoffModel([], { lotSize: 75, spot: 26000 })).toBeNull();
  });
  it("basisPrice: touch, mid, LTP and the LTP fallback", () => {
    const qt = { bid: 99.9, ask: 100.3, ltp: 100 };
    expect(O.basisPrice(qt, "BUY").price).toBe(100.3);
    expect(O.basisPrice(qt, "SELL").price).toBe(99.9);
    expect(O.basisPrice(qt, "BUY", "mid").price).toBeCloseTo(100.1, 9);
    expect(O.basisPrice({ bid: 0, ask: 0, ltp: 12 }, "BUY")).toEqual({ price: 12, fallback: true });
    expect(O.basisPrice({ bid: 0, ask: 0, ltp: null }, "BUY")).toEqual({ price: null, fallback: false });
  });
});

describe("strategyWarnings", () => {
  const base = { strikes: [25800, 26000, 26200], spot: 26000, lotSize: 75 };
  const codes = (c) => O.strategyWarnings({ ...base, ...c }).map((w) => w.code);
  it("blocks: no price, outside the strikes, no contract", () => {
    const w = O.strategyWarnings({ ...base, legs: [L("CE", 26000, "BUY", null, 1, { symbol: "S" }), L("CE", 26400, "BUY", 5, 1, { symbol: "S" }), L("PE", 25800, "BUY", 5)] });
    expect(w.map((x) => x.code)).toEqual(["NO_PRICE", "NOT_IN_CHAIN", "NO_SYMBOL"]);
    expect(w[0]).toMatchObject({ severity: "block", text: "26000 CE has no price" });
  });
  it("shortfall: the hedged estimate warns; the account's own figure and live block", () => {
    const legs = [L("CE", 26000, "BUY", 5, 1, { symbol: "S" })];
    expect(O.strategyWarnings({ ...base, legs, margin: { required: 50000, free: 40000 } })[0]).toMatchObject({ code: "SHORTFALL", severity: "warn", text: "Short of margin by ₹10000" });
    expect(O.strategyWarnings({ ...base, legs, margin: { required: 50000, free: 40000 }, live: true })[0].severity).toBe("block");
    const acct = O.strategyWarnings({ ...base, legs, margin: { required: 50000, free: 40000, source: "account" } })[0];
    expect(acct).toMatchObject({ code: "SHORTFALL", severity: "block" });
  });
  it("naked, expiry-day shorts, breakeven beyond 1σ", () => {
    const short = [L("CE", 26000, "SELL", 50, 1, { symbol: "S" })];
    const st = O.strategyStats(short, 75, { forward: 26000, ivPct: 12, years: 3 / 365 });
    expect(codes({ legs: short, stats: st, expiryToday: true })).toEqual(["NAKED", "EXPIRY_DAY_SHORT"]);
    const long = [L("CE", 26200, "BUY", 50, 1, { symbol: "S" })];
    const s2 = O.strategyStats(long, 75);
    expect(codes({ legs: long, stats: s2, band1: { lo: 25900, hi: 26100 } })).toContain("BE_OUTSIDE_1S");
  });
  it("exercise-STT trap, wide spread, freeze slices, hedge expiring first, legs cap", () => {
    expect(codes({ legs: [L("CE", 25800, "BUY", 199.9, 1, { symbol: "S" })] })).toContain("STT_TRAP");
    expect(codes({ legs: [L("CE", 26000, "BUY", 5, 1, { symbol: "S", spreadPct: 7.1 })] })).toContain("WIDE_SPREAD");
    const fz = O.strategyWarnings({ ...base, legs: [L("PE", 26000, "SELL", 5, 30, { symbol: "S", freezeQty: 1800 })] }).find((w) => w.code === "FREEZE");
    expect(fz.text).toBe("26000 PE goes in 2 slices (freeze 1800)");
    const h = O.strategyWarnings({ ...base, legs: [L("PE", 26000, "BUY", 5, 1, { symbol: "S", expiry: "2026-11-03" }), FUT("BUY", 26000, { symbol: "F", expiry: "2026-11-24" })] }).find((w) => w.code === "HEDGE_EXPIRES_FIRST");
    expect(h.text).toBe("The hedge expires before the future (3 Nov vs 24 Nov)");
    expect(codes({ legs: [], legCount: 12 })).toEqual(["LEGS_CAP"]);
  });
});

describe("settings and saves", () => {
  it("strategyConfig: defaults, validation, unknown keys dropped", () => {
    expect(O.strategyConfig(null)).toEqual({ ...O.STRATEGY_DEFAULTS, metrics: [...O.STRATEGY_DEFAULTS.metrics] });
    const c = O.strategyConfig({ group: "vol", basis: "mid", net: false, metrics: ["ev", "nope", "ev", "rom"], scenario: "sigma", product: "INTRADAY", hedgeWait: 30, junk: 1 });
    expect(c).toEqual({ ...O.STRATEGY_DEFAULTS, group: "vol", basis: "mid", net: false, metrics: ["ev", "rom"], scenario: "sigma", product: "INTRADAY", hedgeWait: 30, moreOpen: false });
    expect(O.strategyConfig({ curves: 3, dist: false, table: "grid", yMode: "pct", scenario: "strikes" })).toMatchObject({ curves: 3, dist: false, table: "grid", yMode: "pct", scenario: "strikes" });
    expect(O.strategyConfig({ curves: 7, table: "x", yMode: "x" })).toMatchObject({ curves: 2, table: "spot", yMode: "rupee" });
    expect(O.strategyConfig({ metrics: [], hedgeWait: 7, basis: "x" })).toMatchObject({ metrics: [...O.STRATEGY_DEFAULTS.metrics], hedgeWait: 15, basis: "touch" });
  });
  it("normaliseSaved: rejects bad enums, NaN and > 12 legs; caps strings; regenerates clashing ids", () => {
    const good = { id: "a", name: `  ${"x".repeat(80)}  `, underlying: "nifty", expiry: "2026-11-03", legs: [{ right: "CE", strike: 26000, side: "SELL", lots: 1, entry: 110, ivAtSave: 12 }], notes: "n".repeat(900), savedAt: "2026-10-28T08:35:00.000Z", extra: "drop" };
    const r = O.normaliseSaved({ v: 1, items: [good, { ...good }, { ...good, legs: [{ right: "XE", strike: 1, side: "SELL", lots: 1 }] }, { ...good, legs: [{ right: "CE", strike: Number.NaN, side: "SELL", lots: 1 }] }, { ...good, legs: Array.from({ length: 13 }, () => good.legs[0]) }] });
    expect(r.items).toHaveLength(2);
    expect(r.skipped).toBe(3);
    expect(r.items[0].name).toHaveLength(60);
    expect(r.items[0].notes).toHaveLength(500);
    expect(r.items[0].underlying).toBe("NIFTY");
    expect(r.items[0].extra).toBeUndefined();
    expect(r.items[0].legs[0]).toMatchObject({ entry: 110, ivAtSave: 12, kind: "OPT" });
    expect(r.items[1].id).not.toBe(r.items[0].id);
  });
  it("expiryCloseMs is 15:30 IST", () => {
    expect(new Date(O.expiryCloseMs("2026-11-03")).toISOString()).toBe("2026-11-03T10:00:00.000Z");
    expect(O.expiryCloseMs("bad")).toBeNull();
  });
});

describe("round 2: chart model, probabilities, table rows", () => {
  const T = 7 / 365;
  const condor = [L("PE", 25700, "BUY", 15, 1, { years: T }), L("PE", 25850, "SELL", 30, 1, { years: T }), L("CE", 26150, "SELL", 30, 1, { years: T }), L("CE", 26300, "BUY", 15, 1, { years: T })];
  it("payoffModel: curves list, extremes, density, profit intervals, ±2σ inside the range", () => {
    const m = O.payoffModel(condor, { lotSize: 75, spot: 26000, forward: 26000, years: T, el: 2 / 365, ivPct: 12, curves: 3 });
    expect(m.curves.map((c) => c.id)).toEqual(["expiry", "target", "mid"]);
    expect(m.mid).toHaveLength(m.xs.length);
    expect(m.maxProfitAt).toBeGreaterThanOrEqual(25850);
    expect(m.maxProfitAt).toBeLessThan(26150);
    expect(m.maxLossAt < 25700 || m.maxLossAt > 26300).toBe(true);
    expect(Math.max(...m.density)).toBeCloseTo(1, 9);
    expect(m.profitIntervals).toHaveLength(1);
    const [a, b] = m.profitIntervals[0];
    expect(a).toBeCloseTo(m.breakevens[0], -1);
    expect(b).toBeCloseTo(m.breakevens[1], -1);
    expect(m.lo).toBeLessThanOrEqual(m.band2[0]);
    expect(m.hi).toBeGreaterThanOrEqual(m.band2[1]);
    const one = O.payoffModel(condor, { lotSize: 75, spot: 26000, forward: 26000, years: T, el: 2 / 365, ivPct: 12, curves: 1 });
    expect(one.target).toBeNull();
    expect(one.horizon).toBe(T);
  });
  it("payoffModel: a far tail is clamped to 4× the other side, with what was cut", () => {
    const naked = [L("CE", 26000, "SELL", 40, 1, { years: T })];
    const m = O.payoffModel(naked, { lotSize: 75, spot: 26000, forward: 26000, years: T, ivPct: 12, range: { lo: 25000, hi: 29000 } });
    expect(m.clip).toMatchObject({ side: "low" });
    expect(m.clip.value).toBeLessThan(-4 * 40 * 75);
    expect(m.yMin).toBeGreaterThan(m.clip.value);
  });
  it("calendar: approx stats and a POP from the sampled curve", () => {
    const legs = [L("CE", 26000, "SELL", 120, 1, { iv: 14, years: 5 / 365 }), L("CE", 26000, "BUY", 300, 1, { iv: 14, years: 33 / 365 })];
    const s = O.strategyStats(legs, 75, { forward: 26000, ivPct: 14, years: 5 / 365 });
    expect(s.approx).toBe(true);
    const f = O.strategyPayoff(legs, 75, { years: 5 / 365 });
    expect(O.probProfit(f, { forward: 26000, ivPct: 14, years: 5 / 365 })).toBeCloseTo(s.pop, 6);
    expect(O.strategyStats(condor, 75, { forward: 26000, ivPct: 12, years: T }).approx).toBe(false);
  });
  it("lognormalPdf integrates to 1; probAbove + probBelow = 1; touch ≈ 2 × beyond", () => {
    let area = 0;
    for (let S = 20000; S <= 32000; S += 5) area += O.lognormalPdf(S, 26000, 0.14, 30 / 365) * 5;
    expect(area).toBeCloseTo(1, 3);
    expect(O.probAbove(26500, 26000, T, 12) + O.probBelow(26500, 26000, T, 12)).toBeCloseTo(1, 12);
    expect(O.probTouch(26500, 26000, T, 12)).toBeCloseTo(2 * O.probAbove(26500, 26000, T, 12), 12);
    expect(O.probTouch(25500, 26000, T, 12)).toBeCloseTo(2 * O.probBelow(25500, 26000, T, 12), 12);
    expect(O.probTouch(26000.0001, 26000, T, 12)).toBeLessThanOrEqual(1);
  });
  it("intervalsWhere and probMaxProfit", () => {
    const xs = [0, 1, 2, 3, 4, 5];
    expect(O.intervalsWhere(xs, [-1, -1, 1, 1, -1, -1], (v) => v > 0)).toEqual([[1.5, 3.5]]);
    expect(O.intervalsWhere(xs, [1, 1, -1, -1, 1, 1], (v) => v > 0)).toEqual([[0, 1.5], [3.5, Infinity]]);
    const m = O.payoffModel(condor, { lotSize: 75, spot: 26000, forward: 26000, years: T, ivPct: 12 });
    const pm = O.probMaxProfit(m.xs, m.expiry, 26000, T, 12);
    expect(pm).toBeCloseTo(O.probBelow(26150, 26000, T, 12) - O.probBelow(25850, 26000, T, 12), 2);
    expect(pm).toBeLessThan(m.stats.pop);
  });
  it("spotLevels: 13 strikes around spot, the spot row and breakevens inside", () => {
    const rows = O.spotLevels({ strikes: STRIKES, spot: 26010, n: 6, breakevens: [25777, 30000] });
    expect(rows.filter((r) => r.kind === "strike")).toHaveLength(13);
    expect(rows.find((r) => r.kind === "spot").price).toBe(26010);
    expect(rows.filter((r) => r.kind === "be").map((r) => r.price)).toEqual([25777]);
    expect(rows.map((r) => r.price)).toEqual([...rows.map((r) => r.price)].sort((a, b) => a - b));
    const edge = O.spotLevels({ strikes: STRIKES, spot: 25510, n: 6 });
    expect(edge[0].price).toBe(25500);
    expect(edge.filter((r) => r.kind !== "spot")).toHaveLength(13);
  });
  it("gridDates: now, daily, the expiry last; evenly spaced past 8 columns", () => {
    const now = Date.UTC(2026, 9, 29, 4);
    const exp = now + 3.5 * 86400000;
    const d = O.gridDates(now, exp);
    expect(d[0]).toBe(now);
    expect(d[d.length - 1]).toBe(exp);
    expect(d).toHaveLength(5);
    const long = O.gridDates(now, now + 30 * 86400000);
    expect(long).toHaveLength(8);
    expect(long[long.length - 1]).toBe(now + 30 * 86400000);
  });
});

describe("round 2: sizing, drafts, adjustments", () => {
  it("legsGcd / sizeLegs keep the ratios; flipSides mirrors and clears entries", () => {
    const legs = [{ lots: 2 }, { lots: 4 }, { lots: 2 }];
    expect(O.legsGcd(legs)).toBe(2);
    expect(O.sizeLegs(legs, 3).map((l) => l.lots)).toEqual([3, 6, 3]);
    expect(O.sizeLegs(legs, 0).map((l) => l.lots)).toEqual([1, 2, 1]);
    expect(O.sizeLegs([{ lots: 1 }, { lots: 2 }], 99999, { maxLots: 100 }).map((l) => l.lots)).toEqual([50, 100]);
    expect(O.legsGcd([])).toBe(1);
    const f = O.flipSides([{ side: "BUY", entry: 5, entryTag: "avg" }, { side: "SELL" }]);
    expect(f.map((l) => l.side)).toEqual(["SELL", "BUY"]);
    expect(f[0].entry).toBeUndefined();
  });
  it("migrateBaskets: per-expiry drafts move to the underlying; held drafts replace, others merge", () => {
    const b = O.migrateBaskets({
      NIFTY: [{ right: "CE", strike: 26000, side: "SELL", lots: 1, expiry: "2026-11-03" }],
      "NIFTY|2026-11-03": [{ right: "CE", strike: 26000, side: "SELL", lots: 2 }, { right: "PE", strike: 25800, side: "SELL", lots: 1 }],
      "BANKNIFTY|2026-11-24": [{ right: "PE", strike: 52000, side: "BUY", lots: 1 }],
    });
    expect(Object.keys(b).sort()).toEqual(["BANKNIFTY", "NIFTY"]);
    expect(b.NIFTY.map((l) => `${l.right}${l.lots}${l.expiry}`)).toEqual(["CE3" + "2026-11-03", "PE12026-11-03"]);
    expect(b.BANKNIFTY[0].expiry).toBe("2026-11-24");
    const held = O.migrateBaskets({ NIFTY: [{ right: "CE", strike: 1, side: "BUY", lots: 1 }], "NIFTY|2026-11-10": [{ right: "PE", strike: 26000, side: "SELL", lots: 1, entry: 50, entryTag: "avg" }] });
    expect(held.NIFTY).toHaveLength(1);
    expect(held.NIFTY[0]).toMatchObject({ strike: 26000, expiry: "2026-11-10" });
    expect(O.migrateBaskets(null)).toEqual({});
  });
  it("backExpiry and nextExpiry", () => {
    const ex = ["2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24"];
    expect(O.backExpiry(ex, "2026-11-03")).toBe("2026-11-10");
    expect(O.backExpiry(ex, "2026-11-03", 10)).toBe("2026-11-17");
    expect(O.backExpiry(ex, "2026-11-24")).toBeNull();
    expect(O.backExpiry(["2026-11-03", "2026-11-05"], "2026-11-03")).toBe("2026-11-05");
    expect(O.nextExpiry(ex, "2026-11-10")).toBe("2026-11-17");
    expect(O.nextExpiry(ex, "2026-11-24")).toBeNull();
  });
  it("rollStrike: out = away from spot, in = towards it", () => {
    expect(O.rollStrike(STRIKES, { strike: 26200, right: "CE" }, 26000, "out")).toBe(26250);
    expect(O.rollStrike(STRIKES, { strike: 26200, right: "CE" }, 26000, "in")).toBe(26150);
    expect(O.rollStrike(STRIKES, { strike: 25800, right: "PE" }, 26000, "out")).toBe(25750);
    expect(O.rollStrike(STRIKES, { strike: 26500, right: "CE" }, 26000, "out")).toBeNull();
    expect(O.rollStrike(STRIKES, { strike: 26000, right: "PE" }, 26000, "out")).toBe(25950);
  });
  it("wingStrike: the nearest wing at ≤ 25% of the short's premium, at least 2 steps out", () => {
    const px = (k) => Math.max(1, 120 - (k - 26000) * 0.6);
    expect(O.wingStrike(STRIKES, { strike: 26000, right: "CE", side: "SELL" }, px)).toBe(26150);
    expect(O.wingStrike(STRIKES, { strike: 26000, right: "CE", side: "SELL" }, () => 100)).toBe(26500);
    expect(O.wingStrike(STRIKES, { strike: 26000, right: "PE", side: "SELL" }, (k) => (k <= 25800 ? 5 : 80))).toBe(25800);
    expect(O.wingStrike(STRIKES, { strike: 26000, right: "CE", side: "BUY" }, px)).toBeNull();
  });
  it("neutraliseDelta: futures lots, else ATM options", () => {
    expect(O.neutraliseDelta({ deltaUnits: 160, lot: 75, fut: { lotSize: 75 } })).toMatchObject({ kind: "FUT", side: "SELL", lots: 2, after: 10 });
    expect(O.neutraliseDelta({ deltaUnits: 20, lot: 75, fut: { lotSize: 75 } })).toBeNull();
    const o = O.neutraliseDelta({ deltaUnits: -80, lot: 75, atm: { strike: 26000, ceDelta: 0.52, peDelta: -0.48 } });
    expect(o).toMatchObject({ kind: "OPT", side: "BUY", right: "CE", strike: 26000, lots: 2 });
    expect(Math.abs(o.after)).toBeLessThan(80);
  });
  it("convertStructure: strangle → condor, straddle → fly, naked → spread", () => {
    const strangle = [{ kind: "OPT", right: "PE", strike: 25800, side: "SELL", lots: 1, expiry: "2026-11-03" }, { kind: "OPT", right: "CE", strike: 26200, side: "SELL", lots: 1, expiry: "2026-11-03" }];
    const c = O.convertStructure(strangle, STRIKES);
    expect(c.name).toBe("Iron condor");
    expect(c.legs.map((l) => `${l.side[0]}${l.right}${l.strike}`)).toEqual(["BPE25700", "SPE25800", "SCE26200", "BCE26300"]);
    const fly = O.convertStructure([{ ...strangle[0], strike: 26000 }, { ...strangle[1], strike: 26000 }], STRIKES, { w: 4 });
    expect(fly.name).toBe("Iron fly");
    expect(O.convertStructure([strangle[1]], STRIKES).name).toBe("Bear call spread");
    expect(O.convertStructure([{ ...strangle[0], side: "BUY" }], STRIKES)).toBeNull();
  });
  it("strategyName: structures with strikes, calendars by expiry", () => {
    const ic = [L("PE", 25800, "BUY", 1), L("PE", 26000, "SELL", 1), L("CE", 26850, "SELL", 1), L("CE", 27050, "BUY", 1)];
    expect(O.strategyName(ic)).toBe("Iron condor 25800/26000/26850/27050");
    expect(O.strategyName([L("CE", 26000, "SELL", 1, 1, { expiry: "2026-11-03" }), L("CE", 26000, "BUY", 1, 1, { expiry: "2026-11-10" })])).toBe("Long calendar (call) 26000");
    expect(O.strategyName([L("CE", 26200, "SELL", 1, 1, { expiry: "2026-11-03" }), L("CE", 26000, "BUY", 1, 1, { expiry: "2026-11-10" })])).toBe("Diagonal (call) 26000/26200");
    expect(O.strategyName([L("CE", 26000, "BUY", 1), L("CE", 26100, "SELL", 1, 2), L("CE", 26200, "BUY", 1)])).toBe("Long call butterfly 26000/26100/26200");
    expect(O.strategyName([])).toBe("New strategy");
    expect(O.strategyName([L("CE", 26000, "BUY", 1), L("PE", 25000, "BUY", 1, 3), L("CE", 27000, "SELL", 1)])).toBe("Custom 3-leg");
  });
  it("calendar warnings: front expiring today, back IV below front", () => {
    const legs = [L("CE", 26000, "SELL", 50, 1, { symbol: "S", expiry: "2026-11-03", iv: 16 }), L("CE", 26000, "BUY", 90, 1, { symbol: "S", expiry: "2026-11-10", iv: 13 })];
    const w = O.strategyWarnings({ legs, today: "2026-11-03" }).map((x) => x.code);
    expect(w).toEqual(["CAL_EXPIRY_DAY", "BACK_IV_LOWER"]);
    expect(O.strategyWarnings({ legs: [legs[0]], today: "2026-11-03" }).map((x) => x.code)).toEqual([]);
    expect(O.strategyWarnings({ legs, chainAgeMs: 20000 })[0]).toMatchObject({ code: "STALE", severity: "block", text: "Prices are 20 s old" });
  });
});

describe("round 2: suggestions by view", () => {
  const view = { spot: 26010, forward: 26010, ivPct: 12, years: 7 / 365, lot: 75, risk: "defined" };
  it("inferView: ±0.25 of the move", () => {
    expect(O.inferView(26200, 26000, 400)).toBe("bull");
    expect(O.inferView(25800, 26000, 400)).toBe("bear");
    expect(O.inferView(26050, 26000, 400)).toBe("neutral");
  });
  it("candidates: listed strikes, de-duplicated, capped", () => {
    const c = O.suggestCandidates(chain, { target: 26300, spot: 26010, forward: 26010, move: 150 });
    expect(c.length).toBeGreaterThan(5);
    expect(c.length).toBeLessThanOrEqual(400);
    expect(new Set(c.map((x) => x.id)).has("bull-call")).toBe(true);
    expect(c.every((x) => x.legs.every((l) => STRIKES.includes(l.strike)))).toBe(true);
    const sigs = c.map((x) => JSON.stringify(x.legs));
    expect(new Set(sigs).size).toBe(sigs.length);
    expect(O.suggestCandidates(chain, { target: 26300, spot: 26010, forward: 26010, move: 150, cap: 7 })).toHaveLength(7);
  });
  it("suggestStrategies: money-makers at the target, ranked by return on capital, defined risk only", () => {
    const top = O.suggestStrategies(chain, { ...view, target: 26300, move: 150 });
    expect(top.length).toBeGreaterThan(0);
    expect(top.length).toBeLessThanOrEqual(6);
    for (const t of top) {
      expect(t.pnlT).toBeGreaterThan(0);
      expect(t.maxLoss).not.toBeNull();
      expect(t.capital).toBeGreaterThan(0);
    }
    for (let i = 1; i < top.length; i += 1) expect(top[i - 1].score).toBeGreaterThanOrEqual(top[i].score);
    const capped = O.suggestStrategies(chain, { ...view, target: 26300, move: 150, maxCapital: 1 });
    expect(capped).toEqual([]);
    const bear = O.suggestStrategies(chain, { ...view, target: 25700, move: 150 });
    expect(bear.every((t) => O.PRESETS.find((p) => p.id === t.id).group === "bear")).toBe(true);
  });
});
