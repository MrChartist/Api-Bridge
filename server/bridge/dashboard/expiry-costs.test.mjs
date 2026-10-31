/**
 * Expiry and delivery maths (docs/spec/p1-06-stocks.md §6.2–6.7, §9.1). Reference values from the spec's worked
 * examples: RELIANCE monthly expiry Mon 23 Nov 2026 (shifted from Tue 24 Nov), lot 500, step 20, today Thu 19 Nov
 * (E-2), spot 1,452.30. Rates are the shipped charge table (unverified).
 */
import { describe, expect, it } from "vitest";
import { createCalendar } from "../reference/calendar.mjs";
import { SHIPPED_CHARGES, SHIPPED_DELIVERY_MARGIN, shippedHolidayRows } from "../reference/shipped.mjs";
import { deliveryMarginDates } from "../reference/calendar.mjs";
import { coveredBy, deliveryMarginOf, expiryDay, expiryDayNote, intrinsicOf, legExpiryCosts, moneynessOf, obligationOf, settleIndexCost, settleStockCost, settlementOf, squareOffCost } from "./expiry-costs.js";

const rates = { ...structuredClone(SHIPPED_CHARGES), brokerage: { kind: "flat", perOrder: 20 } };
const cal = createCalendar({ holidays: shippedHolidayRows() });
const EXPIRY = "2026-11-23";
const S = 1452.3;
const r2 = (x) => Math.round(x * 100) / 100;

describe("moneyness and the close-to-money band (§6.2)", () => {
  it.each([
    [1420, "CE", "ITM", 32.3],
    [1460, "CE", "CTM", 0],
    [1480, "CE", "OTM", 0],
    [1460, "PE", "ITM", 7.7],
    [1440, "PE", "CTM", 0],
  ])("%s %s → %s", (strike, right, moneyness, intrinsic) => {
    const m = moneynessOf({ strike, right, spot: S, step: 20 });
    expect(m.moneyness).toBe(moneyness);
    expect(r2(m.intrinsic)).toBe(intrinsic);
  });
  it("no step → no band", () => {
    expect(moneynessOf({ strike: 1460, right: "CE", spot: S, step: null }).moneyness).toBe("OTM");
    expect(moneynessOf({ strike: 1460, right: "XX", spot: S }).moneyness).toBeNull();
    expect(intrinsicOf(1420, "CE", null)).toBeNull();
  });
  it("settlement from kind", () => {
    expect([settlementOf("stock"), settlementOf("index"), settlementOf(null)]).toEqual(["physical", "cash", null]);
  });
});

describe("E-n days and the window (§6.3)", () => {
  it("the shifted 23 Nov expiry: E-4 17 Nov … E-1 20 Nov", () => {
    const items = deliveryMarginDates(EXPIRY, SHIPPED_DELIVERY_MARGIN.schedule, cal);
    expect(items.map((i) => [i.day, i.date, i.pct])).toEqual([
      ["E-4", "2026-11-17", 10],
      ["E-3", "2026-11-18", 25],
      ["E-2", "2026-11-19", 45],
      ["E-1", "2026-11-20", 70],
    ]);
  });
  it.each([
    ["2026-11-19", "E-2", true],
    ["2026-11-17", "E-4", true],
    ["2026-11-16", "E-5", false],
    ["2026-11-23", "E", true],
  ])("%s → %s in window %s", (asOf, day, inWindow) => {
    expect(expiryDay({ asOf, expiry: EXPIRY, cal, warnFrom: 4 })).toMatchObject({ day, inWindow });
  });
  it("after the expiry is out", () => {
    expect(expiryDay({ asOf: "2026-11-24", expiry: EXPIRY, cal })).toMatchObject({ day: null, inWindow: false, after: true });
  });
});

describe("delivery obligation (§6.4)", () => {
  it.each([
    [500, "CE", "receive-shares", -710000],
    [-500, "CE", "deliver-shares", 710000],
    [500, "PE", "deliver-shares", 710000],
    [-500, "PE", "receive-shares", -710000],
  ])("qty %s %s → %s", (qty, right, kind, cash) => {
    const ob = obligationOf({ strike: 1420, right, qty, underlying: "RELIANCE" });
    expect(ob).toMatchObject({ kind, shares: 500, cash });
  });
  it("text for the long call", () => {
    expect(obligationOf({ strike: 1420, right: "CE", qty: 500, underlying: "RELIANCE" }).text).toBe("Buy 500 RELIANCE at 1420");
  });
  it("covered true / false / null", () => {
    const short = obligationOf({ strike: 1460, right: "CE", qty: -500 });
    expect(coveredBy(short, 500)).toBe(true);
    expect(coveredBy(short, 499)).toBe(false);
    expect(coveredBy(short, null)).toBeNull();
    expect(coveredBy(obligationOf({ strike: 1420, right: "CE", qty: 500 }), 500)).toBeNull();
  });
});

describe("delivery margin (§6.5)", () => {
  const schedule = SHIPPED_DELIVERY_MARGIN.schedule;
  it("E-2 at 45 % × 20 % VaR+ELM → ₹65,353.50; E-1 → ₹1,01,661", () => {
    expect(r2(deliveryMarginOf({ day: "E-2", schedule, spot: S, qty: 500, varElmPct: 20 }).indicative)).toBe(65353.5);
    expect(r2(deliveryMarginOf({ day: "E-1", schedule, spot: S, qty: -500, varElmPct: 20 }).indicative)).toBe(101661);
  });
  it("no rupee figure without varElmPct, the percentage always", () => {
    expect(deliveryMarginOf({ day: "E-2", schedule, spot: S, qty: 500 })).toMatchObject({ pct: 45, indicative: null });
    expect(deliveryMarginOf({ day: "E", schedule, spot: S, qty: 500, varElmPct: 20 })).toMatchObject({ pct: null, indicative: null });
  });
});

describe("settle vs square off (§6.6, §6.7)", () => {
  it("stock: +500 × 1420 CE settles for ₹842.22", () => {
    const s = settleStockCost({ strike: 1420, right: "CE", qty: 500 }, rates);
    expect(r2(s.total)).toBe(842.22);
    expect(Object.fromEntries(s.lines.map((l) => [l.key, r2(l.value)]))).toEqual({ sttDelivery: 710, stamp: 106.5, txn: 21.09, sebi: 0.71, gst: 3.92 });
    expect(s.excluded).toEqual(["Broker's physical-delivery charge"]);
  });
  it("stock: squaring off at bid 33.80 costs ₹55.96", () => {
    const q = squareOffCost({ qty: 500, bid: 33.8, ask: 34.2 }, rates);
    expect(q).toMatchObject({ side: "SELL", price: 33.8 });
    expect(r2(q.premium)).toBe(16900);
    expect(r2(q.total)).toBe(55.96);
  });
  it("index: NIFTY 25000 CE +65 at spot 25,080 settles for ₹31.40; square off at 79.50 costs ₹33.49", () => {
    expect(r2(settleIndexCost({ intrinsic: intrinsicOf(25000, "CE", 25080), qty: 65 }, rates).total)).toBe(31.4);
    expect(r2(squareOffCost({ qty: 65, bid: 79.5, ask: 80 }, rates).total)).toBe(33.49);
  });
  it("short and OTM legs pay no settle charge (index); a seller of shares pays no stamp (stock)", () => {
    expect(settleIndexCost({ intrinsic: 80, qty: -65 }, rates).total).toBe(0);
    expect(settleIndexCost({ intrinsic: 0, qty: 65 }, rates).total).toBe(0);
    const short = settleStockCost({ strike: 1460, right: "CE", qty: -500 }, rates);
    expect(short.lines.find((l) => l.key === "stamp").value).toBe(0);
  });
  it("BSE txn row for a BFO stock leg", () => {
    const nse = settleStockCost({ strike: 1420, right: "CE", qty: 500, exchange: "NFO" }, rates);
    const bse = settleStockCost({ strike: 1420, right: "CE", qty: 500, exchange: "BFO" }, rates);
    expect(r2(bse.lines.find((l) => l.key === "txn").value)).toBe(r2(710000 * rates.physical.txn.BSE));
    expect(bse.total).toBeGreaterThan(nse.total);
  });
  it("a doctored table (every rate × 10) moves every figure", () => {
    const x10 = structuredClone(rates);
    x10.physical.sttDelivery *= 10;
    x10.physical.stampBuy *= 10;
    x10.physical.txn.NSE *= 10;
    x10.sebiPerCrore *= 10;
    x10.opt.exerciseStt *= 10;
    const a = settleStockCost({ strike: 1420, right: "CE", qty: 500 }, rates);
    const b = settleStockCost({ strike: 1420, right: "CE", qty: 500 }, x10);
    for (const k of ["sttDelivery", "stamp", "txn", "sebi", "gst"]) expect(r2(b.lines.find((l) => l.key === k).value)).toBe(r2(10 * a.lines.find((l) => l.key === k).value));
    expect(settleIndexCost({ intrinsic: 80, qty: 65 }, x10).lines[0].value).toBeCloseTo(78, 6);
  });
});

describe("legExpiryCosts", () => {
  const base = { kind: "stock", underlying: "RELIANCE", spot: S, step: 20, day: "E-2", schedule: SHIPPED_DELIVERY_MARGIN.schedule, varElmPct: 20, rates };
  it("ITM stock leg: obligation, margin, settle, square off, difference", () => {
    const l = legExpiryCosts({ symbol: "NFO:RELIANCE-2026-11-23-1420-CE", strike: 1420, right: "CE", qty: 500, bid: 33.8, ask: 34.2 }, base);
    expect(l.moneyness).toBe("ITM");
    expect(l.obligation).toMatchObject({ kind: "receive-shares", cash: -710000 });
    expect(r2(l.deliveryMargin.indicative)).toBe(65353.5);
    expect(r2(l.settle.total)).toBe(842.22);
    expect(r2(l.squareOff.total)).toBe(55.96);
    expect(r2(l.difference)).toBe(786.26);
  });
  it("OTM stock leg beyond the band costs 0 to settle and has no obligation", () => {
    const l = legExpiryCosts({ strike: 1480, right: "CE", qty: 500, bid: 4, ask: 4.2 }, base);
    expect(l).toMatchObject({ moneyness: "OTM", obligation: null, deliveryMargin: null });
    expect(l.settle.total).toBe(0);
  });
  it("index legs have no obligation", () => {
    const l = legExpiryCosts({ strike: 25000, right: "CE", qty: 65, bid: 79.5, ask: 80 }, { kind: "index", spot: 25080, step: 50, rates });
    expect(l.obligation).toBeNull();
    expect(r2(l.settle.total)).toBe(31.4);
  });
});

describe("expiryDayNote", () => {
  const pct = (v) => `${Math.round(v * 10000) / 100} %`;
  it("index note renders the table's figures; stock note names delivery", () => {
    expect(expiryDayNote({ kind: "index", rates, pct })).toContain("extra 2 % ELM");
    const x = structuredClone(rates);
    x.margin.expiryDayElmIndexShort = 0.03;
    expect(expiryDayNote({ kind: "index", rates: x, pct })).toContain("extra 3 % ELM");
    expect(expiryDayNote({ kind: "stock", rates, pct })).toMatch(/delivery/);
  });
});
