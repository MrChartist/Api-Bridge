/**
 * Option chain cell facts: for any chain column, the inputs of its formula and the result, in plain words, so a hover
 * card or the in-app help can show how a figure was made. Pure: no DOM, no fetch, no clock; the figures come from
 * chain-metrics.js and options.js, the formatting from format.js.
 *
 *   cellFacts(key, q, row, side, ctx) → [{ label, value, note }]
 *
 * `q` = the leg (row.ce / row.pe), `side` = "ce" | "pe", `ctx` = the chain's draw context (desk.js context(): spot,
 * F (forward), years (vol-time), tcal (calendar years), df, sm.atmIv, lot, buWin, winQ, bu5, bu15; a plain object
 * with the same fields works). A fact whose input is missing reads "–" with a note saying so; nothing is invented.
 */

import * as M from "./chain-metrics.js";
import * as O from "./options.js";
import { DASH, formatCompact, formatFixed, formatInt, formatPercent, formatSigned, formatSignedPercent } from "./format.js";

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const fig = (v, dp = 2) => (num(v) === null ? DASH : formatFixed(v, dp));
const sgn = (v, dp = 2) => (num(v) === null ? DASH : formatSigned(v, dp));
const pct = (v, dp = 2) => (num(v) === null ? DASH : formatPercent(v, dp));
const spct = (v, dp = 2) => (num(v) === null ? DASH : formatSignedPercent(v, dp));
const cnt = (v) => (num(v) === null ? DASH : formatCompact(v));
const scnt = (v) => (num(v) === null ? DASH : formatCompact(v, { signed: true }));
const f = (label, value, note = "") => ({ label, value, note });
const R = (side) => (side === "ce" ? "CE" : "PE");
const fwd = (ctx) => num(ctx?.F ?? ctx?.forward);
const atm = (ctx) => num(ctx?.sm?.atmIv ?? ctx?.atmIv);

/** Why a leg has no IV (and so no Greeks), from the Bridge's `ivReason`, or where its IV came from. */
export function ivSourceText(q) {
  const why = {
    SETTLING: "expiry-day settlement window and the price is within 2 ticks of intrinsic",
    NOQUOTE: "no usable price to solve from",
    TICK: "the price is one tick or less",
    INTRINSIC: "the price is at or below discounted intrinsic value, so no volatility fits",
    RANGE: "the solved IV falls outside 1-300 %",
    SETTLED: "the contract has expired",
    NOFORWARD: "the chain has no forward to price on",
  }[q?.ivReason];
  if (why) return `no IV for this leg: ${why}`;
  if (num(q?.iv) > 0) return q?.greeksSource === "computed" ? "IV solved from this leg's price (Black-76 on the forward)" : q?.greeksSource === "broker" ? "IV as the data source sent it" : "IV from the chain";
  return "no IV for this leg: the data source sent none and none could be solved";
}

/** The facts behind a build-up reading (day or minute window). */
function buildupFacts(rd, winLabel, floors) {
  if (!rd || rd.state !== "ok") return [f("Reading", DASH, M.BUILDUP_STATE_TEXT[rd?.state] ?? "Nothing to compare with")];
  return [
    f("Reading", M.BUILDUP_LABELS[rd.code], rd.code === "NT" ? "One move is inside its floor" : rd.isNew ? "New strike: the premium alone decides" : "From the signs of the two moves"),
    f("Premium change", `${sgn(rd.dPx)} (${spct(rd.pxPct)})`, `Over ${winLabel}; floor ${formatPercent(floors.pxFloor, 1)}`),
    f("OI change", `${scnt(rd.dOi)} (${rd.isNew ? "new" : spct(rd.oiPct, 1)})`, `Over ${winLabel}; floor ${formatPercent(floors.oiFloor, 1)}`),
    f("Rule", "Premium up and OI up: Long build-up · down and up: Short build-up · up and down: Short covering · down and down: Long unwinding", "Both moves must reach their floors, else Neutral"),
  ];
}

const greekFacts = (key, q, value, dp, unit) => {
  const s = M.greekState(key, value);
  return [
    f(key[0].toUpperCase() + key.slice(1), s === "value" ? fig(value, dp) : DASH, s === "zero" ? "Exactly zero" : s === "unavailable" ? `Greek unavailable: ${ivSourceText(q)}` : unit),
    f("IV used", num(q?.iv) > 0 ? formatFixed(q.iv, 2) : DASH, ivSourceText(q)),
    f("Model", "Black-76 on the chain's forward", "The same model and clock for every leg"),
  ];
};

/** Fact builders per column key: (q, row, side, ctx) → facts. */
const FACTS = {
  ltp: (q) => [f("Last traded price", fig(q?.ltp), "The premium of the most recent trade, in rupees"), f("Change", `${sgn(M.ltpChange(q))} (${spct(M.ltpChangePct(q))})`, "Against the previous close")],
  ltpChg: (q) => [f("LTP", fig(q?.ltp)), f("Previous close", fig(M.quotePrice(q?.close))), f("LTP change", sgn(M.ltpChange(q)), "LTP − previous close; a dash without a close")],
  prevClose: (q) => [f("Previous close", fig(M.quotePrice(q?.close)), "The option's own close in the last session, the baseline of every change"), f("LTP", fig(q?.ltp))],
  avgPx: (q) => [f("Average price", fig(M.quotePrice(q?.avgPrice)), "Average price of today's trades, as the data source sends it"), f("LTP − average", sgn(num(q?.ltp) !== null && M.quotePrice(q?.avgPrice) !== null ? q.ltp - q.avgPrice : null))],
  high: (q) => [f("Day high (source)", fig(M.quotePrice(q?.high))), f("LTP", fig(q?.ltp)), f("Today's high", fig(M.dayHigh(q)), "max(day high, LTP)"), f("Place in the range", M.rangePosition(q) === null ? DASH : formatPercent(M.rangePosition(q) * 100, 0), "0 % at the low, 100 % at the high")],
  low: (q) => [f("Day low (source)", fig(M.quotePrice(q?.low))), f("LTP", fig(q?.ltp)), f("Today's low", fig(M.dayLow(q)), "min(day low, LTP)"), f("Place in the range", M.rangePosition(q) === null ? DASH : formatPercent(M.rangePosition(q) * 100, 0), "0 % at the low, 100 % at the high")],
  vol: (q) => [f("Volume today", cnt(q?.volume), "Contracts traded so far today"), f("Previous session", cnt(q?.prevVolume), num(q?.prevVolume) === null ? "The data source does not send it" : ""), f("Change", scnt(M.volumeChange(q?.volume, q?.prevVolume)), "Today so far − the whole previous session")],
  prevVol: (q) => [f("Previous volume", cnt(q?.prevVolume), num(q?.prevVolume) === null ? "The data source does not send it" : "Contracts traded in the last session")],
  volOi: (q) => [f("Volume", cnt(q?.volume)), f("Open interest", cnt(q?.oi)), f("Volume ÷ OI", fig(M.volumeOiRatio(q)), "Contracts traded for every contract still open")],
  bidPx: (q) => [f("Bid", fig(M.quotePrice(q?.bid)), "The highest price bid for the contract right now"), f("Bid quantity", cnt(M.quoteQty(q?.bidQty)))],
  askPx: (q) => [f("Ask", fig(M.quotePrice(q?.ask)), "The lowest price offered for the contract right now"), f("Ask quantity", cnt(M.quoteQty(q?.askQty)))],
  bidQty: (q, row, side, ctx) => [f("Bid quantity", cnt(M.quoteQty(q?.bidQty)), "Contracts waiting at the top bid"), f("In lots", M.quoteQty(q?.bidQty) === null || !(num(ctx?.lot) > 0) ? DASH : formatFixed(q.bidQty / ctx.lot, 1))],
  askQty: (q, row, side, ctx) => [f("Ask quantity", cnt(M.quoteQty(q?.askQty)), "Contracts waiting at the top ask"), f("In lots", M.quoteQty(q?.askQty) === null || !(num(ctx?.lot) > 0) ? DASH : formatFixed(q.askQty / ctx.lot, 1))],
  spreadAbs: (q, row, side, ctx) => {
    const sp = M.spreadAbs(q);
    return [f("Bid", fig(M.quotePrice(q?.bid))), f("Ask", fig(M.quotePrice(q?.ask))), f("Spread", fig(sp), "Ask − bid; the whole ask with no bid"), f("As % of mid", pct(O.spreadPct(q))), f("Per lot", sp === null || !(num(ctx?.lot) > 0) ? DASH : `₹${formatFixed(sp * ctx.lot, 2)}`, "Spread × lot size: the cost of crossing once")];
  },
  spread: (q) => [f("Spread % of mid", pct(O.spreadPct(q)), "(ask − bid) ÷ mid × 100"), f("Mid", fig(O.mid(q)))],
  bidPct: (q, row, side, ctx) => [f("Bid", fig(M.quotePrice(q?.bid))), f("Spot", fig(ctx?.spot)), f("Bid % of spot", pct(M.pctOfSpot(q?.bid, ctx?.spot)), "bid ÷ spot × 100")],
  askPct: (q, row, side, ctx) => [f("Ask", fig(M.quotePrice(q?.ask))), f("Spot", fig(ctx?.spot)), f("Ask % of spot", pct(M.pctOfSpot(q?.ask, ctx?.spot)), "ask ÷ spot × 100")],
  bidPctAnn: (q, row, side, ctx) => [f("Bid % of spot", pct(M.pctOfSpot(q?.bid, ctx?.spot))), f("Days to expiry", M.annualDays(ctx?.tcal) === null ? DASH : formatInt(M.annualDays(ctx?.tcal)), "Whole calendar days, at least 1"), f("Annualised", pct(M.annualisedPct(M.pctOfSpot(q?.bid, ctx?.spot), ctx?.tcal), 1), "Bid % × 365 ÷ days; simple, not compounded")],
  askPctAnn: (q, row, side, ctx) => [f("Ask % of spot", pct(M.pctOfSpot(q?.ask, ctx?.spot))), f("Days to expiry", M.annualDays(ctx?.tcal) === null ? DASH : formatInt(M.annualDays(ctx?.tcal)), "Whole calendar days, at least 1"), f("Annualised", pct(M.annualisedPct(M.pctOfSpot(q?.ask, ctx?.spot), ctx?.tcal), 1), "Ask % × 365 ÷ days; simple, not compounded")],
  oi: (q) => [f("Open interest", cnt(q?.oi), "Contracts still open at this strike"), f("Previous close", cnt(M.prevOi(q)), "OI − change"), f("Change", scnt(q?.oiChange)), f("Change %", M.prevOi(q) === 0 ? "New" : spct(M.oiChangePctOf(q), 1), "Change ÷ previous close's OI")],
  chg: (q) => [f("OI change", scnt(q?.oiChange), "Contracts added (+) or closed (−)"), f("Change %", M.prevOi(q) === 0 ? "New" : spct(M.oiChangePctOf(q), 1), "Change ÷ previous close's OI")],
  bu: (q, row, side, ctx) => {
    const win = ctx?.buWin ?? "day";
    const leg = typeof ctx?.winQ === "function" ? ctx.winQ(q, row, side) : q;
    return buildupFacts(M.dayBuildup(leg, win), ctx?.winLabel ? `the last ${ctx.winLabel}` : "the day", M.BUILDUP_WINDOWS[win] ?? M.BUILDUP_WINDOWS.day);
  },
  bu5: (q, row, side, ctx) => buildupFacts(M.windowBuildup(q, ctx?.bu5, row?.strike, side), "5 minutes", M.BUILDUP_WINDOWS[5]),
  bu15: (q, row, side, ctx) => buildupFacts(M.windowBuildup(q, ctx?.bu15, row?.strike, side), "15 minutes", M.BUILDUP_WINDOWS[15]),
  iv: (q, row, side, ctx) => [f("IV", num(q?.iv) > 0 ? formatFixed(q.iv, 2) : DASH, ivSourceText(q)), f("ATM IV", atm(ctx) === null ? DASH : formatFixed(atm(ctx), 2)), f("Source's own IV", num(q?.brokerIv) > 0 ? formatFixed(q.brokerIv, 2) : DASH, "When the data source sent one and the Bridge solved its own")],
  delta: (q) => greekFacts("delta", q, q?.delta, 2, "Premium change for a 1-point move in the underlying"),
  gamma: (q) => greekFacts("gamma", q, q?.gamma, 4, "Change in Delta for a 1-point move"),
  theta: (q) => greekFacts("theta", q, q?.theta, 2, "Rupees per unit lost in one trading day from time alone"),
  vega: (q) => greekFacts("vega", q, q?.vega, 2, "Rupees per unit for a 1-point change in IV"),
  rho: (q, row, side, ctx) => {
    const v = M.rho76(fwd(ctx), row?.strike, ctx?.years, q?.iv, R(side), ctx?.tcal, ctx?.df);
    return [...greekFacts("rho", q, v, 3, "Rupees per unit for a 1 percentage-point rise in the rate, the forward held fixed"), f("Formula", "−(calendar years to expiry) × price ÷ 100", `Calendar years ${num(ctx?.tcal) === null ? DASH : formatFixed(ctx.tcal, 4)}`)];
  },
  theo: (q, row, side, ctx) => {
    const t = M.theoPrice(fwd(ctx), row?.strike, ctx?.years, atm(ctx), R(side), ctx?.df);
    return [f("Forward", fig(fwd(ctx))), f("ATM IV", atm(ctx) === null ? DASH : formatFixed(atm(ctx), 2), "One volatility for every strike, not this leg's own"), f("Theoretical price", t === null ? DASH : fig(t), t === null ? "No ATM IV or forward: never priced on a guessed volatility" : "Black-76, discounted"), f("Mid − theoretical", sgn(t === null || O.mid(q) === null ? null : O.mid(q) - t), "What the IV smile adds (+) or takes away (−)")];
  },
  intrinsic: (q, row, side, ctx) => [f("Spot", fig(ctx?.spot)), f("Strike", fig(row?.strike, 0)), f("Intrinsic value", fig(M.intrinsicValue(row?.strike, R(side), ctx?.spot)), side === "ce" ? "max(0, spot − strike)" : "max(0, strike − spot)")],
  ext: (q, row, side, ctx) => [f("Premium (mid)", fig(O.mid(q))), f("Forward", fig(fwd(ctx))), f("Time value", fig(O.extrinsic(row?.strike, R(side), O.mid(q), fwd(ctx))), "Premium − intrinsic on the forward; below zero flags a parity break or a stale quote")],
  be: (q, row, side) => [f("Premium (mid)", fig(O.mid(q))), f("Breakeven", fig(O.breakeven(row?.strike, R(side), O.mid(q))), side === "ce" ? "strike + premium" : "strike − premium")],
  bePct: (q, row, side, ctx) => [f("Breakeven", fig(O.breakeven(row?.strike, R(side), O.mid(q))), side === "ce" ? "strike + premium (mid)" : "strike − premium (mid)"), f("Spot", fig(ctx?.spot)), f("Breakeven %", spct(M.breakevenPct(row?.strike, R(side), O.mid(q), ctx?.spot)), "(breakeven − spot) ÷ spot × 100")],
  dist: (q, row, side, ctx) => {
    const d = O.distance(row?.strike, R(side), ctx?.spot);
    return [f("Points from spot", d ? formatSigned(d.pts, 0) : DASH, "Out of the money positive"), f("Percent of spot", d ? spct(d.pct) : DASH), f("In σ to expiry", sgn(M.sigmaDist(row?.strike, R(side), fwd(ctx), atm(ctx), ctx?.years)), "At ATM IV")];
  },
  pitm: (q, row, side, ctx) => {
    const p = O.probItm(fwd(ctx), row?.strike, ctx?.years, q?.iv, R(side));
    return [f("P(ITM)", p === null ? DASH : formatPercent(p * 100, 1), "N(d2) on the forward at the leg's IV: the model's chance of finishing in the money"), f("IV used", num(q?.iv) > 0 ? formatFixed(q.iv, 2) : DASH, ivSourceText(q))];
  },
  potm: (q, row, side, ctx) => {
    const p = O.probItm(fwd(ctx), row?.strike, ctx?.years, q?.iv, R(side));
    return [f("P(OTM)", p === null ? DASH : formatPercent((1 - p) * 100, 1), "1 − P(ITM)"), f("IV used", num(q?.iv) > 0 ? formatFixed(q.iv, 2) : DASH, ivSourceText(q))];
  },
  pop: (q, row, side, ctx) => {
    const p = O.chanceOfProfit(fwd(ctx), row?.strike, ctx?.years, num(q?.iv) ?? atm(ctx), R(side), O.mid(q));
    return [f("Breakeven", fig(O.breakeven(row?.strike, R(side), O.mid(q)))), f("Chance of profit, long", p === null ? DASH : formatPercent(p * 100, 1), "P(price at expiry beyond the breakeven), log-normal at the leg's IV")];
  },
  pops: (q, row, side, ctx) => {
    const p = O.chanceOfProfit(fwd(ctx), row?.strike, ctx?.years, num(q?.iv) ?? atm(ctx), R(side), O.mid(q));
    return [f("Breakeven", fig(O.breakeven(row?.strike, R(side), O.mid(q)))), f("Chance of profit, short", p === null ? DASH : formatPercent((1 - p) * 100, 1), "1 − the long side's chance")];
  },
  liq: (q) => [f("Spread % of mid", pct(O.spreadPct(q))), f("Volume", cnt(q?.volume)), f("Score", "1 to 5", "55 % from the spread, 45 % from the volume rank on this side")],
  prem: (q, row, side, ctx) => [f("Volume", cnt(q?.volume)), f("Lot", num(ctx?.lot) === null ? DASH : formatInt(ctx.lot)), f("LTP", fig(q?.ltp)), f("Premium traded", num(q?.volume) === null || num(q?.ltp) === null || num(ctx?.lot) === null ? DASH : `₹${formatCompact(q.volume * ctx.lot * q.ltp)}`, "volume × lot × LTP")],
  premLot: (q, row, side, ctx) => [f("Premium (mid)", fig(O.mid(q))), f("Per lot", O.mid(q) === null || num(ctx?.lot) === null ? DASH : `₹${formatFixed(O.mid(q) * ctx.lot, 2)}`, "mid × lot size")],
  thetaLot: (q, row, side, ctx) => [f("Theta", fig(q?.theta)), f("Per lot", num(q?.theta) === null || num(ctx?.lot) === null ? DASH : `₹${formatFixed(q.theta * ctx.lot, 2)}`, "theta × lot size: one trading day's decay on one lot")],
  ivx: (q, row, side, ctx) => [f("IV", num(q?.iv) > 0 ? formatFixed(q.iv, 2) : DASH), f("ATM IV", atm(ctx) === null ? DASH : formatFixed(atm(ctx), 2)), f("IV − ATM IV", num(q?.iv) > 0 && atm(ctx) !== null ? formatSigned(q.iv - atm(ctx), 2) : DASH, "Vol points over (+) or under (−) the at-the-money volatility")],
  hedge: (q, row, side, ctx) => [f("Delta", fig(q?.delta)), f("Position delta", num(ctx?.netDelta) === null ? DASH : formatFixed(ctx.netDelta, 0), "Units; one long futures lot when there is no position"), f("Lots to offset", num(O.hedgeLots(ctx?.netDelta, q?.delta, ctx?.lot)) === null ? DASH : formatInt(O.hedgeLots(ctx?.netDelta, q?.delta, ctx?.lot)))],
  costPct: (q, row, side, ctx) => [f("Premium (mid)", fig(O.mid(q))), f("Spot", fig(ctx?.spot)), f("Cost % of spot", O.mid(q) === null || !(num(ctx?.spot) > 0) ? DASH : formatPercent((O.mid(q) / ctx.spot) * 100, 2), "mid ÷ spot × 100")],
  relDist: (q, row, side, ctx) => [f("Strike", fig(row?.strike, 0)), f("Spot", fig(ctx?.spot)), f("Relative distance", spct(M.relativeDistance(row?.strike, ctx?.spot)), "(strike − spot) ÷ spot × 100, negative below spot"), f("In σ to expiry", sgn(M.sigmaDist(row?.strike, R(side), fwd(ctx), atm(ctx), ctx?.years)), "ln(K ÷ F) for a call, ln(F ÷ K) for a put, over ATM IV × √time")],
};

/** Every column key cellFacts knows (the rest get a one-line fact from the column's own figure). */
export const FACT_KEYS = Object.freeze(Object.keys(FACTS));

/**
 * The facts behind one cell: [{ label, value, note }]. Unknown keys (per-strike columns and the rest) return the
 * leg's LTP and IV as context, so a card never comes back empty.
 */
export function cellFacts(key, q, row, side, ctx = {}) {
  const fn = FACTS[key];
  if (fn) return fn(q ?? null, row ?? null, side, ctx ?? {});
  return [f("LTP", fig(q?.ltp)), f("IV", num(q?.iv) > 0 ? formatFixed(q.iv, 2) : DASH, ivSourceText(q))];
}
