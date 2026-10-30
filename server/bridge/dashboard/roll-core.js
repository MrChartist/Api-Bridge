// roll-core.js: roll a leg or a whole group to a later expiry (BRD F8). Pure: no DOM, no fetch, no clock. Positions
// draws the sheet (positions.js openRoll) and sends the result as one basket through the order sheet
// (strategy-place.js), so every normal check, the paper default and the live opt-ins apply.
//
// Three ways to pick the new strike, per leg:
//  - "same":     the same strike (the nearest listed one when it is not listed in the new expiry);
//  - "delta":    the strike in the new expiry whose delta is nearest the leg's delta now (same call or put);
//  - "distance": the same distance in points from the forward: new strike ≈ F(new) + (strike − F(now)), which keeps
//                a short strangle's wings as far out as they are today once the carry between expiries is allowed for.
// Each roll closes the held leg at the touch (buy back a short at the ask, sell a long at the bid) and opens the new one
// on the same side at the touch. The net is what the roll collects (+) or pays (−) before charges.
import { b76Delta } from "./pricing.js";
import { charges as chargeLines, curveRoots, payoffAt } from "./options.js";
import { scenarioMarginLegs } from "./whatif-core.js";
import { portfolioMargin } from "./span-margin.js";

export const ROLL_MODES = Object.freeze([
  ["same", "Same strikes"],
  ["delta", "Same delta"],
  ["distance", "Same distance"],
]);

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const nearest = (list, target) => (list.length ? list.reduce((b, k) => (Math.abs(k - target) < Math.abs(b - target) ? k : b), list[0]) : null);

/** The touch for a side: a buy pays the ask, a sell gets the bid; the LTP (then a fallback) when a side is missing. */
export function touch(quote, side, fallback = null) {
  const b = num(quote?.bid);
  const a = num(quote?.ask);
  const l = num(quote?.ltp);
  if (side === "BUY") return a > 0 ? a : l > 0 ? l : num(fallback);
  return b > 0 ? b : l > 0 ? l : num(fallback);
}

/** The delta of a chain quote: the chain's own, else Black-76 from its IV. */
function quoteDelta(q, F, strike, years, right) {
  const d = num(q?.delta);
  if (d !== null) return d;
  const iv = num(q?.iv);
  return iv !== null && F > 0 && years > 0 ? b76Delta(F, strike, years, iv, right) : null;
}

/**
 * The new strike for one held option leg.
 * @param {{ strike: number, right: "CE"|"PE", F?: number, iv?: number, T?: number, greeks?: { delta?: number } }} leg
 * @param {"same"|"delta"|"distance"} mode
 * @param {{ rows: object[], Fnow?: number, Fnext?: number, years?: number }} next  the new expiry's chain rows
 */
export function rollStrike(leg, mode, { rows = [], Fnow = null, Fnext = null, years = null } = {}) {
  const side = leg.right === "PE" ? "pe" : "ce";
  const listed = rows.filter((r) => r?.[side]).map((r) => r.strike);
  if (!listed.length) return null;
  if (mode === "delta") {
    const d0 = num(leg.greeks?.delta) ?? (num(leg.F) && num(leg.iv) && num(leg.T) > 0 ? b76Delta(leg.F, leg.strike, leg.T, leg.iv, leg.right) : null);
    if (d0 !== null) {
      let best = null;
      for (const r of rows) {
        const d = quoteDelta(r[side], num(Fnext), r.strike, num(years), leg.right);
        if (d === null) continue;
        if (!best || Math.abs(d - d0) < best.gap) best = { k: r.strike, gap: Math.abs(d - d0) };
      }
      if (best) return best.k;
    }
    return nearest(listed, leg.strike);
  }
  if (mode === "distance" && num(Fnow) > 0 && num(Fnext) > 0) return nearest(listed, num(Fnext) + (leg.strike - num(Fnow)));
  return nearest(listed, leg.strike);
}

/**
 * The roll of held legs to `toExpiry`: per leg { leg, lots, units, close: { side, price }, open: { side, strike, right,
 * expiry, symbol, quote, price } }. Futures and legs without a listed strike are left out (reported in `skipped`).
 * @param {object[]} legs  priced held legs: { symbol, kind, strike, right, expiry, q, lot, mark, quote, F, iv, T, greeks }
 * @param {{ mode: string, toExpiry: string, rows: object[], Fnow?: number, Fnext?: number, years?: number, prefix?: string,
 *   underlying: string }} ctx
 */
export function rollPlan(legs, ctx) {
  const rolls = [];
  const skipped = [];
  for (const l of legs ?? []) {
    if (!l || !num(l.q)) continue;
    if (l.kind !== "OPT") {
      skipped.push({ leg: l, why: "futures roll on the Option Chain or Strategy Builder" });
      continue;
    }
    const k = rollStrike(l, ctx.mode, ctx);
    if (k === null) {
      skipped.push({ leg: l, why: "no listed strike" });
      continue;
    }
    const row = ctx.rows.find((r) => r.strike === k);
    const q = row?.[l.right === "PE" ? "pe" : "ce"] ?? null;
    const units = Math.abs(l.q);
    const lot = num(l.lot) || 1;
    const closeSide = l.q > 0 ? "SELL" : "BUY";
    const openSide = l.q > 0 ? "BUY" : "SELL";
    rolls.push({
      leg: l,
      lots: Math.max(1, Math.round(units / lot)),
      units,
      lot,
      close: { side: closeSide, price: touch(l.quote, closeSide, l.mark) },
      open: {
        side: openSide,
        strike: k,
        right: l.right,
        expiry: ctx.toExpiry,
        symbol: q?.symbol ?? `${ctx.prefix ?? "NFO"}:${ctx.underlying}-${ctx.toExpiry}-${k}-${l.right}`,
        quote: q,
        price: touch(q, openSide),
        iv: num(q?.iv),
      },
    });
  }
  return { rolls, skipped };
}

const proceeds = (side, price, units) => (num(price) === null ? null : (side === "SELL" ? 1 : -1) * price * units);

/**
 * The money of a roll: { net (collected + / paid −, before charges), closeNet, openNet, charges, netAfter, missing }.
 * `rates` is the reference charges table (options.js charges()).
 */
export function rollMoney(plan, rates) {
  let closeNet = 0;
  let openNet = 0;
  let missing = 0;
  const legsForCharges = [];
  for (const r of plan.rolls) {
    const c = proceeds(r.close.side, r.close.price, r.units);
    const o = proceeds(r.open.side, r.open.price, r.units);
    if (c === null || o === null) missing += 1;
    closeNet += c ?? 0;
    openNet += o ?? 0;
    legsForCharges.push({ kind: "OPT", side: r.close.side, lots: r.lots, lotSize: r.lot, units: r.units, price: r.close.price, expiry: r.leg.expiry, strike: r.leg.strike, right: r.leg.right, symbol: r.leg.symbol });
    legsForCharges.push({ kind: "OPT", side: r.open.side, lots: r.lots, lotSize: r.lot, units: r.units, price: r.open.price, expiry: r.open.expiry, strike: r.open.strike, right: r.open.right, symbol: r.open.symbol });
  }
  const ch = legsForCharges.length ? chargeLines(legsForCharges, rates).total : 0;
  const net = closeNet + openNet;
  return { net, closeNet, openNet, charges: ch, netAfter: net - ch, missing };
}

/**
 * Breakevens at the new expiry of the rolled legs, counting what the closed legs locked in (their P&L from the average
 * price to the close price) and the charges: where opened payoff + locked − charges = 0. Sampled over ±25 % of `spot`.
 */
export function rollBreakevens(plan, { spot, charges = 0 } = {}) {
  const S = num(spot);
  if (!(S > 0) || !plan.rolls.length || plan.rolls.some((r) => num(r.open.price) === null)) return [];
  const locked = plan.rolls.reduce((a, r) => a + (num(r.close.price) !== null && num(r.leg.avg) !== null ? r.leg.q * (r.close.price - r.leg.avg) : 0), 0);
  const legs = plan.rolls.map((r) => ({ kind: "OPT", side: r.open.side, lots: r.lots, lotSize: r.lot, strike: r.open.strike, right: r.open.right, price: r.open.price }));
  const f = (x) => payoffAt(legs, x, 1) + locked - (num(charges) ?? 0);
  const xs = [];
  for (let i = 0; i <= 400; i++) xs.push(S * 0.75 + (S * 0.5 * i) / 400);
  for (const r of plan.rolls) if (r.open.strike > xs[0] && r.open.strike < xs[xs.length - 1]) xs.push(r.open.strike);
  xs.sort((a, b) => a - b);
  return curveRoots(f, xs).map((x) => Math.round(x * 10) / 10);
}

/**
 * Margin of the underlying's book before and after the roll (span-margin.js, the paper model): { before, after,
 * change }. `book` is every priced held leg of the underlying (the rolled ones included).
 */
export function rollMargin(book, plan, { underlying, nowMs, Fnow, Fnext = null, atmIv = null }) {
  const F = num(Fnow);
  if (!(F > 0)) return null;
  const rolled = new Set(plan.rolls.map((r) => r.leg.symbol));
  const opened = plan.rolls.map((r) => ({ kind: "OPT", strike: r.open.strike, right: r.open.right, expiry: r.open.expiry, q: (r.open.side === "SELL" ? -1 : 1) * r.units, avg: r.open.price, mark: r.open.price, F: num(Fnext) ?? F, iv: r.open.iv, T: 0, t0: nowMs, priced: num(r.open.price) !== null, inc: true }));
  const ctx = { nowMs, forwards: { [underlying]: F }, ivs: num(atmIv) !== null ? { [underlying]: num(atmIv) } : {} };
  const ml = (ls) => scenarioMarginLegs(ls, underlying, {});
  // Opened legs carry their own price and IV straight in (T 0 would value them at intrinsic in scenarioMarginLegs).
  const openML = opened.filter((l) => l.priced).map((l) => ({ underlying, kind: "OPT", right: l.right, strike: l.strike, expiry: l.expiry, qty: l.q, cost: l.mark, mark: l.mark, iv: l.iv }));
  const before = portfolioMargin(ml(book), ctx).required;
  const after = portfolioMargin([...ml(book.filter((l) => !rolled.has(l.symbol))), ...openML], ctx).required;
  return { before, after, change: after - before };
}

/**
 * The basket to send: per roll, the closing order and the opening order, as order-sheet items. The sheet puts buys
 * first (buy back shorts and buy the new longs before any sell), which keeps margin covered at every step (BRD F9).
 */
export function rollItems(plan, { product = "MARGIN", label = (x) => x } = {}) {
  const out = [];
  for (const r of plan.rolls) {
    out.push({ side: r.close.side, symbol: r.leg.symbol, label: label({ strike: r.leg.strike, right: r.leg.right, expiry: r.leg.expiry, close: true }), lots: r.lots, lotSize: r.lot, price: r.close.price, product: r.leg.product ?? product, quote: () => r.leg.quote ?? null, freezeQty: r.leg.freeze ?? null, leg: r.leg });
    out.push({ side: r.open.side, symbol: r.open.symbol, label: label({ strike: r.open.strike, right: r.open.right, expiry: r.open.expiry, close: false }), lots: r.lots, lotSize: r.lot, price: r.open.price, product: r.leg.product ?? product, quote: () => r.open.quote ?? null, freezeQty: r.leg.freeze ?? null, leg: null });
  }
  return out;
}
