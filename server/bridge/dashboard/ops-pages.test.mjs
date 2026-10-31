/** Ops pages (Safety, Algo, Futures, Flow): the pure helpers behind each view's hero reading and highlights. */
import { describe, expect, it } from "vitest";
import { limitTone, limitUse, limitsHeadline } from "./readiness.js";
import { basisCls, biggestFlow, carryItems, cumulativeFlows, flowItems, steepestCarry, syntheticGaps, syntheticItems } from "./analyticsMore.js";
import { contractLabel, tideFlowSeries, unusualLead } from "./analyticsFlow.js";
import { distanceTone } from "./trigger-core.js";
import { DASH, formatInt } from "./format.js";

const acct = (id, { orders = 0, paper = 0, pnl = 0, paperPnl = 0, maxOrders = 100, maxLoss = 10_000 } = {}) => ({
  accountId: id,
  ordersToday: orders,
  paperOrdersToday: paper,
  realisedPnlToday: pnl,
  paperRealisedPnlToday: paperPnl,
  limits: { dailyMaxOrders: maxOrders, dailyMaxLoss: maxLoss },
});

describe("Safety headroom (readiness.js)", () => {
  it("tones a used/max pair: clear, near from 80 %, at the cap, none without a cap", () => {
    expect(limitTone(10, 100)).toBe("ok");
    expect(limitTone(80, 100)).toBe("near");
    expect(limitTone(100, 100)).toBe("breach");
    expect(limitTone(120, 100)).toBe("breach");
    expect(limitTone(5, null)).toBe("none");
    expect(limitTone(null, 100)).toBe("none");
  });

  it("adds paper and live orders; only a loss uses the loss limit", () => {
    const u = limitUse(acct("a", { orders: 30, paper: 55, pnl: -6000, paperPnl: -2500 }));
    expect(u.orders).toMatchObject({ used: 85, max: 100, tone: "near" });
    expect(u.loss).toMatchObject({ used: 8500, max: 10_000, tone: "near" });
    expect(u.pnl).toBe(-8500);
    expect(limitUse(acct("b", { pnl: 4000 })).loss).toMatchObject({ used: 0, frac: 0, tone: "ok" });
  });

  it("keeps a missing figure missing, never an invented 0", () => {
    const u = limitUse({ accountId: "x", limits: { dailyMaxOrders: 100, dailyMaxLoss: 1000 } });
    expect(u.orders.used).toBeNull();
    expect(u.loss.used).toBeNull();
    expect(u.orders.tone).toBe("none");
  });

  it("headlines the account nearest a cap, by name", () => {
    const names = new Map([["p", "Paper account"], ["q", "Spouse"]]);
    expect(limitsHeadline([acct("p", { paper: 4 }), acct("q", { paper: 9 })], names)).toEqual({ tone: "ok", text: "Every account is well inside its limits. Most used: Spouse, 9% of its daily orders." });
    expect(limitsHeadline([acct("p", { paper: 4 }), acct("q", { paperPnl: -9000 })], names)).toEqual({ tone: "near", text: "Spouse has used 90% of its daily loss limit." });
    expect(limitsHeadline([acct("p", { paper: 100 }), acct("q", { paperPnl: -9000 })], names).tone).toBe("breach");
    expect(limitsHeadline([acct("p")], names).text).toBe("Every account is well inside its limits. Nothing used yet today.");
    expect(limitsHeadline([], names).tone).toBe("none");
  });
});

describe("Futures (analyticsMore.js)", () => {
  const list = [
    { expiry: "2026-11-24", basis: 100, annualisedPct: 6.5 },
    { expiry: "2026-12-29", basis: 260, annualisedPct: -7.1 },
    { expiry: "2027-01-26", basis: 390, annualisedPct: null },
  ];
  it("finds the steepest carry by size, either sign", () => {
    expect(steepestCarry(list).expiry).toBe("2026-12-29");
    expect(steepestCarry([])).toBeNull();
  });
  it("colours carry bars by direction and marks the steepest", () => {
    const items = carryItems(list);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.bars[0].cls)).toEqual(["up", "dn"]);
    expect(items[1]).toMatchObject({ band: "hot", tag: "Steepest" });
    expect(items[0].tag).toBeNull();
  });
  it("measures synthetic gaps from the median and finds the strike most out of line", () => {
    const strikes = [
      { strike: 24900, arbitrageGap: -89.4, synthetic: 1 },
      { strike: 25000, arbitrageGap: -89.45, synthetic: 1 },
      { strike: 25100, arbitrageGap: -89.4, synthetic: 1 },
      { strike: 25200, arbitrageGap: -86.0, synthetic: 1 },
      { strike: 25300, arbitrageGap: null, synthetic: 1 },
    ];
    const g = syntheticGaps(strikes);
    expect(g.median).toBe(-89.4);
    expect(g.outlier).toMatchObject({ strike: 25200, dev: 3.4 });
    const items = syntheticItems(strikes, 25000);
    const byLabel = Object.fromEntries(items.map((i) => [i.label, i]));
    expect(byLabel[formatInt(25200)]).toMatchObject({ band: "hot", tag: "Out of line" });
    expect(byLabel[formatInt(25000)].bars[0].cls).toBe("dn");
    expect(byLabel[formatInt(24900)].bars[0].cls).toBe("up");
    expect(syntheticGaps([]).median).toBeNull();
    expect(syntheticGaps([{ strike: 1, arbitrageGap: 2 }]).outlier).toBeNull();
  });
  it("colours a signed series by its latest value", () => {
    expect(basisCls(12)).toBe("up");
    expect(basisCls(-0.5)).toBe("dn");
    expect(basisCls(null)).toBe("up");
  });
});

describe("FII and DII flows (analyticsMore.js)", () => {
  const days = [
    { date: "2026-10-30", fii: { net: 3598 }, dii: { net: -817 } },
    { date: "2026-10-29", fii: { net: 1200 }, dii: { net: -4100 } },
  ];
  it("finds the biggest single-session flow, either side and sign", () => {
    expect(biggestFlow(days)).toEqual({ who: "DII", date: "2026-10-29", net: -4100 });
    expect(biggestFlow([])).toBeNull();
  });
  it("colours bars green for net buying and red for net selling, DII lighter, the biggest marked", () => {
    const items = flowItems(days);
    expect(items[0].bars.map((b) => b.cls)).toEqual(["up", "dn lite"]);
    expect(items[1]).toMatchObject({ band: "hot", tag: "Biggest: DII" });
    expect(items[0].tag).toBeNull();
  });
  it("colours each cumulative line by where its total ends", () => {
    const [fii, dii] = cumulativeFlows(days);
    expect(fii.cls).toBe("up");
    expect(dii.cls).toBe("dn");
  });
});

describe("Flow: unusual activity and tide (analyticsFlow.js)", () => {
  it("leads with the top contract, the biggest premium and the call / put split", () => {
    const rows = [
      { underlying: "NIFTY", strike: 25500, side: "call", premiumInr: 2e7 },
      { underlying: "BANKNIFTY", strike: 51000, side: "put", premiumInr: 6e7 },
      { underlying: "NIFTY", strike: 25000, side: "put", premiumInr: null },
    ];
    const l = unusualLead(rows);
    expect(contractLabel(l.top)).toBe(`NIFTY ${formatInt(25500)} CE`);
    expect(contractLabel(l.biggest)).toBe(`BANKNIFTY ${formatInt(51000)} PE`);
    expect(l.callShare).toBeCloseTo(0.25);
    expect(unusualLead([]).callShare).toBeNull();
    expect(contractLabel(null)).toBe(DASH);
  });
  it("draws call premium green and put premium red", () => {
    const [c, p] = tideFlowSeries([{ ts: 0, callPremium: 1e7, putPremium: 2e7 }]);
    expect(c.cls).toBe("up");
    expect(p.cls).toBe("dn");
  });
});

describe("Triggers (trigger-core.js)", () => {
  it("tones how close a leg is to firing", () => {
    expect(distanceTone(0.3)).toBe("close");
    expect(distanceTone(1.2)).toBe("near");
    expect(distanceTone(4)).toBe("");
    expect(distanceTone(null)).toBe("");
  });
});
