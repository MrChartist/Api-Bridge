// The option chain's insight cards, the pure half: which cell the pointer is on (from its classes), the card's content
// for that cell (a title, the reading in plain words, a small picture's numbers and the fact rows: formula inputs and
// result), and where the card goes so it stays on screen. No DOM: chain-insight.js draws it. Numbers are printed by
// format.js only; the maths is options.js, the same as the chain's own columns.
//
// Fact rows: chain-facts.js (cellFacts) is the columns' own source when it exists; factsFor() here is the fallback with
// the same shape, [{ label, value, note?, tone? }], so the switch is one line in chain-insight.js.
import { DASH, formatCompact, formatFixed, formatInt, formatPercent, formatRupee, formatSigned, formatSignedPercent, formatSignedRupee, isFigure } from "./format.js";
import * as O from "./options.js";
import { cellHelp } from "./chain-help.js";
import * as M from "./chain-metrics.js";
import { FACT_KEYS, cellFacts } from "./chain-facts.js";

const num = (v) => (isFigure(v) ? Number(v) : null);
const g = (v, dp = 2) => (isFigure(v) ? formatFixed(v, dp) : DASH);
const sg = (v, dp = 2) => (isFigure(v) ? formatSigned(v, dp) : DASH);
const pc = (v, dp = 1) => (isFigure(v) ? formatPercent(v, dp) : DASH);
const spc = (v, dp = 1) => (isFigure(v) ? formatSignedPercent(v, dp) : DASH);
const rs = (v) => (isFigure(v) ? formatRupee(v, 2) : DASH);
const srs = (v) => (isFigure(v) ? formatSignedRupee(v, 2) : DASH);
const cmp = (v, signed = false) => (isFigure(v) ? formatCompact(v, { signed }) : DASH);
/** "up" / "down" from a sign; null at zero or without a figure. */
export const toneOf = (v) => (num(v) === null || v === 0 ? null : v > 0 ? "up" : "down");
const RIGHT = { ce: "CE", pe: "PE" };
export const SIDE_NAME = Object.freeze({ ce: "Call", pe: "Put" });

/**
 * Which cell a chain table cell is, from its classes (desk.js cellCls: "num c-oi s-ce", "num c-syn mid-col", the
 * strike's "strike-col"). Null for anything else (the spot row, the foot).
 * @param {string} className
 * @returns {{ key: string, part: "ce"|"pe"|"mid"|"strike" } | null}
 */
export function readCell(className) {
  const c = ` ${String(className ?? "")} `;
  if (c.includes(" strike-col ")) return { key: "strike", part: "strike" };
  const m = /\sc-([A-Za-z0-9]+)\s/.exec(c);
  // The straddle table's cells (sdPrice, sdOi …: a call and its put added together) have no card of their own.
  if (!m || /^sd[A-Z]/.test(m[1])) return null;
  const part = c.includes(" s-ce ") ? "ce" : c.includes(" s-pe ") ? "pe" : c.includes(" mid-col ") ? "mid" : null;
  return part ? { key: m[1], part } : null;
}

/**
 * Where the card goes: below the cell, else above it, else whichever side has more room; then slid along so it stays
 * `margin` px inside the viewport. Left-aligned to the cell (right-aligned for a cell in the right half of the view).
 * @param {{ left: number, top: number, right: number, bottom: number }} a the cell's rect (viewport px)
 * @param {{ w: number, h: number }} card
 * @param {{ w: number, h: number }} view
 * @returns {{ left: number, top: number, place: "below"|"above" }}
 */
export function placeCard(a, card, view, { gap = 6, margin = 8 } = {}) {
  const roomBelow = view.h - a.bottom - gap - margin;
  const roomAbove = a.top - gap - margin;
  const place = card.h <= roomBelow ? "below" : card.h <= roomAbove ? "above" : roomBelow >= roomAbove ? "below" : "above";
  let top = place === "below" ? a.bottom + gap : a.top - gap - card.h;
  top = Math.max(margin, Math.min(top, view.h - margin - card.h));
  const mid = (a.left + a.right) / 2;
  let left = mid > view.w / 2 ? a.right - card.w : a.left;
  left = Math.max(margin, Math.min(left, view.w - margin - card.w));
  return { left: Math.round(left), top: Math.round(top), place };
}

/** Black-76 price of the leg at its own IV (undiscounted, on the forward); null without IV or time. */
export function theorPrice(x, strike, side, iv) {
  if (!x || num(iv) === null || !(iv > 0) || !(x.years > 0) || num(x.F) === null) return null;
  return O.black76(x.F, strike, x.years, iv, RIGHT[side]);
}

/**
 * The build-up reading a cell shows (desk.js bu / bu5 / bu15): chain-metrics.js dayBuildup over the day (or the OI
 * window the chain reads), windowBuildup against the 5 / 15 min snapshot. { state, code?, dPx?, dOi?, pxPct?, oiPct?, isNew? }.
 */
export function buildupReading(key, q, row, side, x) {
  if (key === "bu5" || key === "bu15") return M.windowBuildup(q, x?.[key], row?.strike, side);
  return M.dayBuildup(x?.winQ ? x.winQ(q, row, side) : q, x?.buWin ?? "day");
}

/** The build-up's two moves over the cell's window: premium and open interest, then and now. */
export function buildupMoves(q, x) {
  const w = x?.winQ ? x.winQ(q) : q;
  const ltp = num(q?.ltp);
  const dp = num(w?.change);
  const oi = num(q?.oi);
  const doi = num(w?.oiChange);
  const p0 = ltp !== null && dp !== null ? ltp - dp : null;
  const o0 = oi !== null && doi !== null ? oi - doi : null;
  return {
    tag: O.buildup(w),
    price: { from: p0, to: ltp, chg: dp, pct: p0 ? (dp / p0) * 100 : null },
    oi: { from: o0, to: oi, chg: doi, pct: o0 ? (doi / o0) * 100 : null },
  };
}

const BU_MEANING = Object.freeze({
  LB: "Premium up and open interest up: new long positions are being opened.",
  SB: "Premium down and open interest up: new short positions are being written.",
  SC: "Premium up and open interest down: short positions are being closed.",
  LU: "Premium down and open interest down: long positions are being closed.",
});
const BU_TONE = Object.freeze({ LB: "up", SC: "up", SB: "down", LU: "down" });

/** "Day · since the previous close" or "1h · since the stored snapshot". */
const basis = (x) => (x?.windowed && x?.winLabel ? `${x.winLabel} · against the snapshot from ${x.winLabel} ago` : "Day · against the previous close");

/**
 * The fact rows for one cell: formula inputs, then the result. Same shape as chain-facts.js cellFacts.
 * @returns {Array<{ label: string, value: string, note?: string, tone?: "up"|"down"|null }>}
 */
export function factsFor(key, q, row, side, x) {
  const K = row?.strike ?? null;
  const right = RIGHT[side];
  const P = q ? O.mid(q) : null;
  const lot = num(x?.lot) ?? 1;
  const F = num(x?.F);
  const spot = num(x?.spot);
  const iv = num(q?.iv);
  const atmIv = num(x?.sm?.atmIv);
  switch (key) {
    case "ltp": {
      const ch = num(q?.change);
      const prev = num(q?.ltp) !== null && ch !== null ? q.ltp - ch : num(q?.close);
      const th = theorPrice(x, K, side, iv);
      return [
        { label: "Last trade", value: g(q?.ltp) },
        { label: "Previous close", value: g(prev) },
        { label: "Change", value: sg(ch), tone: toneOf(ch) },
        { label: "Change %", value: spc(O.changePct(q), 2), tone: toneOf(ch) },
        { label: "Mid", value: g(P), note: "(bid + ask) ÷ 2" },
        { label: "Model price", value: g(th), note: "Black-76 at this leg's IV" },
        { label: "LTP − model", value: th === null || num(q?.ltp) === null ? DASH : sg(q.ltp - th), tone: th === null ? null : toneOf(q.ltp - th) },
      ];
    }
    case "bid":
    case "ask":
    case "spread":
    case "costPct": {
      const b = num(q?.bid);
      const a = num(q?.ask);
      const sp = O.spreadPct(q);
      const out = [
        { label: "Bid", value: g(b), tone: b === null ? null : "down" },
        { label: "Ask", value: g(a), tone: a === null ? null : "up" },
        { label: "Mid", value: g(P) },
        { label: "Spread", value: b !== null && a !== null ? g(a - b) : DASH, note: "ask − bid" },
        { label: "Spread % of mid", value: pc(sp, 2) },
      ];
      if (isFigure(q?.bidQty) || isFigure(q?.askQty)) out.push({ label: "Size bid / ask", value: `${cmp(q?.bidQty)} / ${cmp(q?.askQty)}` });
      out.push({ label: "Mid % of spot", value: P !== null && spot ? pc((P / spot) * 100, 3) : DASH }, { label: "Round trip per lot", value: b !== null && a !== null ? rs((a - b) * lot) : DASH, note: "spread × lot" });
      return out;
    }
    case "liq": {
      const rank = x?.ranks?.[side]?.get(K) ?? null;
      const sp = O.spreadPct(q);
      return [
        { label: "Spread % of mid", value: pc(sp, 2) },
        { label: "Spread score", value: sp === null ? "1 of 5" : `${sp <= 1 ? 5 : sp <= 2.5 ? 4 : sp <= 5 ? 3 : sp <= 10 ? 2 : 1} of 5`, note: "55% of the score" },
        { label: "Volume rank", value: rank === null ? DASH : `Above ${formatInt(rank * 100)}% of this side`, note: "45% of the score" },
        { label: "Liquidity", value: `${formatInt(O.liquidityScore(q, rank))} of 5` },
      ];
    }
    case "prem":
      return [
        { label: "Volume", value: cmp(q?.volume) },
        { label: "Lot size", value: formatInt(lot) },
        { label: "LTP", value: g(q?.ltp) },
        { label: "Premium traded", value: isFigure(q?.volume) && isFigure(q?.ltp) ? `₹${formatCompact(q.volume * lot * q.ltp)}` : DASH },
      ];
    case "oi":
    case "chg": {
      const oi = num(q?.oi);
      const ch = num(q?.oiChange);
      const prev = oi !== null && ch !== null ? oi - ch : null;
      const maxOi = num(x?.sm?.maxOi);
      const rank = x?.topOi?.[side]?.get(K) ?? null;
      const out = [
        { label: "Open interest", value: cmp(oi), note: `${formatInt(oi)} contracts` },
        { label: "At the baseline", value: cmp(prev) },
        { label: "Change", value: cmp(ch, true), tone: toneOf(ch) },
        { label: "Change %", value: prev > 0 ? spc((ch / prev) * 100, 1) : DASH, tone: toneOf(ch), note: "change ÷ baseline" },
        { label: "Share of largest OI", value: oi !== null && maxOi ? pc((oi / maxOi) * 100, 0) : DASH },
      ];
      if (rank) out.push({ label: "OI rank on this side", value: formatInt(rank), note: rank === 1 ? "the OI wall" : "top three" });
      if (lot > 1 && oi !== null) out.push({ label: "In lots", value: cmp(oi / lot) });
      return out;
    }
    case "vol": {
      const v = num(q?.volume);
      const oi = num(q?.oi);
      const maxVol = num(x?.maxVol);
      return [
        { label: "Volume today", value: cmp(v), note: `${formatInt(v)} contracts` },
        { label: "Open interest", value: cmp(oi) },
        { label: "Volume ÷ OI", value: v !== null && oi ? formatFixed(v / oi, 2) : DASH },
        { label: "Share of largest volume", value: v !== null && maxVol ? pc((v / maxVol) * 100, 0) : DASH },
        { label: "Unusual for its OI", value: x?.hot?.has?.(q?.symbol) ? "Yes" : "No" },
      ];
    }
    case "bu": {
      const m = buildupMoves(q, x);
      return [
        { label: "Premium then → now", value: `${g(m.price.from)} → ${g(m.price.to)}` },
        { label: "Premium change", value: spc(m.price.pct, 2), tone: toneOf(m.price.chg) },
        { label: "OI then → now", value: `${cmp(m.oi.from)} → ${cmp(m.oi.to)}` },
        { label: "OI change", value: spc(m.oi.pct, 1), tone: toneOf(m.oi.chg) },
        { label: "Reading", value: m.tag ? `${m.tag} · ${O.BUILDUP_NAMES[m.tag]}` : "No pattern" },
      ];
    }
    case "pcrK": {
      const p = O.strikePcr(row);
      return [
        { label: "Put OI", value: cmp(row?.pe?.oi) },
        { label: "Call OI", value: cmp(row?.ce?.oi) },
        { label: "Put ÷ call", value: g(p) },
      ];
    }
    case "iv":
    case "ivx":
    case "ivskew": {
      const s = key === "ivskew" ? "pe" : side;
      const leg = key === "ivskew" ? row?.pe : q;
      const other = s === "ce" ? row?.pe : row?.ce;
      const liv = num(leg?.iv);
      const oiv = num(other?.iv);
      const move = liv !== null && F !== null && x?.years > 0 ? F * (liv / 100) * Math.sqrt(x.years) : null;
      return [
        { label: key === "ivskew" ? "Put IV" : "This leg's IV", value: g(liv, 2) },
        { label: key === "ivskew" ? "Call IV" : `${SIDE_NAME[s === "ce" ? "pe" : "ce"]} IV, same strike`, value: g(oiv, 2) },
        { label: "ATM IV", value: g(atmIv, 2) },
        { label: "IV − ATM", value: liv !== null && atmIv !== null ? sg(liv - atmIv, 2) : DASH, tone: liv !== null && atmIv !== null ? toneOf(liv - atmIv) : null },
        { label: "1σ move to expiry", value: move === null ? DASH : `±${formatFixed(move, 0)} pts`, note: "F × IV × √T" },
        { label: "Source", value: ivSourceText(leg) },
      ];
    }
    case "delta":
    case "gamma":
    case "theta":
    case "vega":
    case "thetaLot": {
      const d = num(q?.delta);
      const gm = num(q?.gamma);
      const th = num(q?.theta);
      const vg = num(q?.vega);
      return [
        { label: "Delta", value: g(d, 4) },
        { label: "Gamma", value: g(gm, 6) },
        { label: "Theta", value: g(th, 2), tone: toneOf(th) },
        { label: "Vega", value: g(vg, 2), tone: toneOf(vg) },
        { label: "IV used", value: g(iv, 2) },
        { label: "Forward", value: g(F, 2) },
        { label: "Lot size", value: formatInt(lot) },
        { label: "Greeks from", value: q?.greeksSource === "broker" ? "Broker feed" : q?.greeksSource === "computed" ? "Bridge (Black-76)" : DASH },
      ];
    }
    case "hedge": {
      const d = num(q?.delta);
      const n = O.hedgeLots(x?.netDelta, d, lot);
      return [
        { label: x?.hedgeOwn ? "Position delta" : "One futures lot", value: g(x?.netDelta, 1), note: "in units of the underlying" },
        { label: "Leg delta", value: g(d, 4) },
        { label: "Delta per lot", value: d === null ? DASH : g(d * lot, 1) },
        { label: "Lots to offset", value: n === null ? DASH : formatInt(n) },
      ];
    }
    case "ext": {
      const intr = F !== null && K !== null ? Math.max(0, right === "CE" ? F - K : K - F) : null;
      const tv = O.extrinsic(K, right, P, F);
      return [
        { label: "Premium (mid)", value: g(P) },
        { label: "Forward", value: g(F) },
        { label: "Strike", value: formatInt(K) },
        { label: "Intrinsic", value: g(intr), note: right === "CE" ? "max(0, F − K)" : "max(0, K − F)" },
        { label: "Time value", value: g(tv), tone: tv !== null && tv < -0.05 ? "down" : null },
        { label: "Share of premium", value: tv !== null && P ? pc((tv / P) * 100, 0) : DASH },
      ];
    }
    case "be": {
      const be = O.breakeven(K, right, P);
      const mv = be !== null && spot ? be - spot : null;
      return [
        { label: "Strike", value: formatInt(K) },
        { label: "Premium (mid)", value: g(P) },
        { label: "Breakeven", value: g(be), note: right === "CE" ? "strike + premium" : "strike − premium" },
        { label: "Spot", value: g(spot) },
        { label: "Move needed", value: mv === null ? DASH : `${sg(mv, 1)} pts · ${spc((mv / spot) * 100, 2)}`, tone: toneOf(mv) },
      ];
    }
    case "dist": {
      const d = O.distance(K, right, spot);
      const sd = O.sigmaDistance(K, right, F, atmIv, x?.years);
      return [
        { label: "Strike", value: formatInt(K) },
        { label: "Spot", value: g(spot) },
        { label: "Distance", value: d ? `${sg(d.pts, 1)} pts · ${spc(d.pct, 2)}` : DASH, note: "positive = out of the money" },
        { label: "ATM IV", value: g(atmIv, 2) },
        { label: "In σ to expiry", value: sd === null ? DASH : `${sg(sd, 2)}σ` },
      ];
    }
    case "pitm":
    case "potm":
    case "pop":
    case "pops": {
      const p = O.probItm(F, K, x?.years, iv, right);
      const be = O.breakeven(K, right, P);
      const pop = O.chanceOfProfit(F, K, x?.years, iv ?? atmIv, right, P);
      return [
        { label: "Forward", value: g(F) },
        { label: "Strike", value: formatInt(K) },
        { label: "IV used", value: g(iv ?? (key.startsWith("pop") ? atmIv : null), 2) },
        { label: "P(ITM)", value: p === null ? DASH : pc(p * 100, 1) },
        { label: "P(OTM)", value: p === null ? DASH : pc((1 - p) * 100, 1) },
        { label: "Breakeven", value: g(be) },
        { label: "Chance of profit, long", value: pop === null ? DASH : pc(pop * 100, 1) },
        { label: "Chance of profit, short", value: pop === null ? DASH : pc((1 - pop) * 100, 1) },
      ];
    }
    case "premLot":
      return [
        { label: "Premium (mid)", value: g(P) },
        { label: "Lot size", value: formatInt(lot) },
        { label: "Per lot", value: P === null ? DASH : rs(P * lot) },
      ];
    case "strad": {
      const c = O.mid(row?.ce);
      const p = O.mid(row?.pe);
      const s = O.strikeStraddle(row);
      return [
        { label: "Call mid", value: g(c) },
        { label: "Put mid", value: g(p) },
        { label: "Straddle", value: g(s) },
        { label: "% of spot", value: s !== null && spot ? pc((s / spot) * 100, 2) : DASH },
        { label: "Per lot", value: s === null ? DASH : rs(s * lot) },
      ];
    }
    case "syn":
    case "dev":
    case "edge": {
      const s = x?.syn?.get?.(K) ?? null;
      const e = x?.edge?.get?.(K) ?? null;
      const ref = num(x?.ref);
      const dev = s && num(s.mid) !== null && ref !== null ? s.mid - ref : null;
      return [
        { label: "Call mid", value: g(O.mid(row?.ce)) },
        { label: "Put mid", value: g(O.mid(row?.pe)) },
        { label: "Synthetic", value: g(s?.mid), note: "K + (C − P) × e^(rT)" },
        { label: x?.refKind === "fut" ? "Same-expiry future" : "Chain forward", value: g(ref) },
        { label: "Deviation", value: sg(dev), tone: toneOf(dev) },
        { label: "Per lot", value: dev === null ? DASH : srs(dev * lot), tone: toneOf(dev) },
        { label: "Edge at the touch", value: e ? `${sg(e.edge)} · ${e.kind}` : DASH, tone: e ? toneOf(e.edge) : null },
      ];
    }
    case "strike": {
      const atm = O.atmRow(x?.c)?.strike ?? null;
      const d = O.distance(K, "CE", spot);
      return [
        { label: "Spot", value: g(spot) },
        { label: "Forward", value: g(F) },
        { label: "ATM strike", value: atm === null ? DASH : formatInt(atm) },
        { label: "Strike − spot", value: d ? `${sg(d.pts, 1)} pts · ${spc(d.pct, 2)}` : DASH },
        { label: "Call is", value: moneyness(K, "CE", F) },
        { label: "Put is", value: moneyness(K, "PE", F) },
        { label: "Straddle", value: g(O.strikeStraddle(row)) },
        { label: "Strike PCR", value: g(O.strikePcr(row)) },
      ];
    }
    default:
      // The columns added later (chain-facts.js has a formula row for each of them).
      return FACT_KEYS.includes(key) ? cellFacts(key, q, row, side, x) : [];
  }
}

const moneyness = (K, right, F) => {
  if (num(K) === null || num(F) === null) return DASH;
  const d = right === "CE" ? F - K : K - F;
  return Math.abs(d) < 1e-9 ? "At the money" : d > 0 ? "In the money" : "Out of the money";
};
/** Where a leg's IV came from: the broker's feed, or solved by the Bridge from the price. */
export const ivSource = (leg) => (num(leg?.iv) === null ? null : leg?.greeksSource === "broker" ? "feed" : leg?.greeksSource === "computed" ? "solved" : null);
const ivSourceText = (leg) => ({ feed: "Broker feed", solved: "Solved from the price" })[ivSource(leg)] ?? DASH;

/**
 * The card for one cell: { title, sub, headline, tone, visual, facts, how }. `facts` comes from cellFacts when the
 * columns' module supplies them, else factsFor. `label` names a column the help index does not know yet.
 */
export function cardModel(key, q, row, side, x, { facts = null, label = null } = {}) {
  const help = cellHelp(key);
  const K = row?.strike ?? null;
  const lot = num(x?.lot) ?? 1;
  const leg = side === "ce" || side === "pe" ? SIDE_NAME[side] : null;
  const name = help?.label ?? label ?? key;
  const title = key === "strike" ? `${formatInt(K)} strike` : leg ? `${formatInt(K)} ${leg} · ${name}` : `${formatInt(K)} · ${name}`;
  const out = { key, title, sub: help?.name && help.name !== name ? help.name : "", headline: "", tone: null, visual: null, facts: facts ?? factsFor(key, q, row, side, x), how: help?.how ?? "" };
  const P = q ? O.mid(q) : null;
  const iv = num(q?.iv);
  const atmIv = num(x?.sm?.atmIv);
  const no = (text) => Object.assign(out, { headline: text });
  switch (key) {
    case "ltp": {
      const ltp = num(q?.ltp);
      const ch = num(q?.change);
      if (ltp === null) return no("No trade in this contract yet today.");
      out.tone = toneOf(ch);
      out.headline = ch === null ? `Last traded at ${g(ltp)}.` : `Last traded at ${g(ltp)}, ${ch > 0 ? "up" : ch < 0 ? "down" : "unchanged"}${ch ? ` ${g(Math.abs(ch))} (${pc(Math.abs(O.changePct(q) ?? 0), 2)})` : ""} on the previous close.`;
      const th = theorPrice(x, K, side, iv);
      if (th !== null) out.visual = { kind: "gap", ltp, theor: th, gap: ltp - th };
      return out;
    }
    case "bid":
    case "ask":
    case "spread":
    case "costPct":
    case "liq":
    case "prem": {
      const b = num(q?.bid);
      const a = num(q?.ask);
      const sp = O.spreadPct(q);
      const spot = num(x?.spot);
      if (b !== null && a !== null && b > 0 && a >= b) out.visual = { kind: "quote", bid: b, ask: a, mid: (a + b) / 2, spread: a - b, spreadPct: sp, bidPct: spot ? (b / spot) * 100 : null, askPct: spot ? (a / spot) * 100 : null };
      if (key === "bid") out.headline = b === null || b <= 0 ? "Nobody is bidding right now." : `The highest bid is ${g(b)}: ${rs(b * lot)} for one lot of ${formatInt(lot)}.`;
      else if (key === "ask") out.headline = a === null || a <= 0 ? "Nobody is offering right now." : `The lowest ask is ${g(a)}: ${rs(a * lot)} for one lot of ${formatInt(lot)}.`;
      else if (key === "spread") out.headline = sp === null ? "No two-sided quote, so no spread." : `The ask is ${g(a - b)} above the bid: ${pc(sp, 1)} of the mid. A round trip at the touch gives up about that much.`;
      else if (key === "costPct") out.headline = P === null || !spot ? "No premium or no spot." : `The premium is ${pc((P / spot) * 100, 2)} of spot.`;
      else if (key === "liq") out.headline = `Liquidity ${formatInt(O.liquidityScore(q, x?.ranks?.[side]?.get(K) ?? null))} of 5, from the spread and the volume rank on this side.`;
      else out.headline = isFigure(q?.volume) && isFigure(q?.ltp) ? `About ₹${formatCompact(q.volume * lot * q.ltp)} of premium changed hands today.` : "No volume or no last price.";
      if (key === "bid") out.tone = b > 0 ? "down" : null;
      if (key === "ask") out.tone = a > 0 ? "up" : null;
      return out;
    }
    case "oi":
    case "chg": {
      const oi = num(q?.oi);
      const ch = num(q?.oiChange);
      if (oi === null) return no("The feed sent no open interest for this contract.");
      const prev = ch !== null ? oi - ch : null;
      out.sub = basis(x);
      out.tone = toneOf(ch);
      out.headline =
        ch === null
          ? `${cmp(oi)} contracts open. No baseline to compare with.`
          : ch === 0
            ? `${cmp(oi)} contracts open, unchanged on the baseline.`
            : `${cmp(oi)} contracts open: ${cmp(Math.abs(ch))} ${ch > 0 ? "added" : "cut"}${prev > 0 ? ` (${pc(Math.abs((ch / prev) * 100), 1)})` : ""} since the baseline.`;
      if (prev !== null) out.visual = { kind: "oi", prev, now: oi, chg: ch };
      return out;
    }
    case "vol": {
      const v = num(q?.volume);
      const oi = num(q?.oi);
      if (v === null || v === 0) return no("No trade in this contract today.");
      out.headline = `${cmp(v)} contracts traded today${oi ? `, ${formatFixed(v / oi, 2)} times the open interest` : ""}.${x?.hot?.has?.(q?.symbol) ? " That ratio is well above the rest of the chain." : ""}`;
      return out;
    }
    case "bu":
    case "bu5":
    case "bu15": {
      // The reading the cell shows (chain-metrics.js classifyBuildup over the cell's window, floors included).
      const rd = buildupReading(key, q, row, side, x);
      const win = key === "bu" ? (x?.buWin ?? "day") : key.slice(2);
      const w = M.BUILDUP_WINDOWS[win] ?? M.BUILDUP_WINDOWS.day;
      out.sub = key === "bu" ? basis(x) : `${w.label} · against the snapshot this page recorded ${w.label} ago`;
      if (rd.state !== "ok") return no(`${M.BUILDUP_STATE_TEXT[rd.state] ?? "Not measurable"}.`);
      const ltp = num(q?.ltp);
      const oi = num(q?.oi);
      const price = { from: ltp === null ? null : ltp - rd.dPx, to: ltp, chg: rd.dPx, pct: rd.pxPct };
      const oiMove = { from: oi === null ? null : oi - rd.dOi, to: oi, chg: rd.dOi, pct: rd.oiPct };
      const max = num(key === "bu" ? (x?.maxChg?.[side] ?? x?.sm?.maxOiChange) : x?.[key]?.max?.[side]);
      const strength = max ? Math.min(1, Math.abs(rd.dOi) / max) : null;
      const tag = rd.code === "NT" ? null : rd.code;
      out.visual = { kind: "buildup", tag, price, oi: oiMove, strength };
      if (!tag) return no(`Neutral: a move stayed inside its floor (OI ${formatPercent(w.oiFloor, 0)}, premium ${formatPercent(w.pxFloor, 1)} over ${w.label}), so neither side is named.`);
      out.tone = BU_TONE[tag];
      out.headline = `${M.BUILDUP_LABELS[tag]}. ${BU_MEANING[tag]}${rd.isNew ? " A new strike (no OI at the baseline): the premium alone names it." : ""}`;
      return out;
    }
    case "rho": {
      out.headline = iv === null ? "No IV for this leg, so no Rho." : "How much the premium moves for a 1 percentage-point rise in the interest rate, the forward held fixed.";
      return out;
    }
    case "theo": {
      out.headline = atmIv === null ? "No ATM IV on the chain, so no theoretical price." : `Priced at the chain's ATM IV of ${pc(atmIv, 1)} for every strike: the gap to the mid is what the smile adds or takes away.`;
      return out;
    }
    case "intrinsic": {
      const spot = num(x?.spot);
      const v = M.intrinsicValue(K, RIGHT[side], spot);
      out.headline = v === null ? "No spot price." : v > 0 ? `${g(v)} of the premium is already in the money against spot.` : "Out of the money against spot: no intrinsic value.";
      return out;
    }
    case "ltpChg":
    case "prevClose":
    case "avgPx":
    case "high":
    case "low":
    case "prevVol":
    case "volOi":
    case "bidPx":
    case "askPx":
    case "bidQty":
    case "askQty":
    case "spreadAbs":
    case "bePct":
    case "relDist":
    case "bidPct":
    case "askPct":
    case "bidPctAnn":
    case "askPctAnn": {
      out.headline = help?.shows ?? "";
      if (key === "ltpChg") out.tone = toneOf(M.ltpChange(q));
      if (key === "bidPx" || key === "bidQty" || key === "bidPct" || key === "bidPctAnn") out.tone = "down";
      if (key === "askPx" || key === "askQty" || key === "askPct" || key === "askPctAnn") out.tone = "up";
      return out;
    }
    case "iv":
    case "ivx":
    case "ivskew": {
      const s = key === "ivskew" ? "pe" : side;
      const l = key === "ivskew" ? row?.pe : q;
      const o = s === "ce" ? row?.pe : row?.ce;
      const liv = num(l?.iv);
      const oiv = num(o?.iv);
      if (liv === null || liv <= 0) return no("No usable IV for this leg: no price, or a price the model cannot solve. A dash is not zero volatility.");
      const vsAtm = atmIv !== null ? liv - atmIv : null;
      const vsOther = oiv !== null && oiv > 0 ? liv - oiv : null;
      out.visual = { kind: "iv", source: ivSource(l), vsAtm, vsOther, other: SIDE_NAME[s === "ce" ? "pe" : "ce"], atmIv };
      out.headline =
        key === "ivskew"
          ? vsOther === null
            ? "The call at this strike has no IV to compare with."
            : `The put's IV is ${formatFixed(Math.abs(vsOther), 1)} vol points ${vsOther >= 0 ? "above" : "below"} the call's.`
          : `The premium implies ${formatFixed(liv, 2)}% volatility a year${vsAtm === null ? "." : `, ${formatFixed(Math.abs(vsAtm), 1)} points ${vsAtm >= 0 ? "above" : "below"} ATM.`}`;
      return out;
    }
    case "delta":
    case "gamma":
    case "theta":
    case "vega":
    case "thetaLot": {
      const d = num(q?.delta);
      const gm = num(q?.gamma);
      const th = num(q?.theta);
      const vg = num(q?.vega);
      if (d === null && gm === null && th === null && vg === null) return no("No IV for this leg, so no Greeks.");
      const focus = key === "thetaLot" ? "theta" : key;
      const clamp = (v) => Math.max(-1, Math.min(1, v));
      out.visual = {
        kind: "greeks",
        focus,
        rows: [
          { id: "delta", label: "1 point in the index", unit: d, lot: d === null ? null : d * lot },
          { id: "theta", label: "1 day", unit: th, lot: th === null ? null : th * lot },
          { id: "vega", label: "1 vol point", unit: vg, lot: vg === null ? null : vg * lot },
        ],
        gamma: gm !== null && d !== null ? { now: d, up: clamp(d + gm * 10), down: clamp(d - gm * 10) } : null,
      };
      if (focus === "delta") out.headline = d === null ? "No delta for this leg." : `The premium moves about ${formatFixed(Math.abs(d * 10), 2)} for 10 points in the index, the ${d >= 0 ? "same" : "opposite"} way (${rs(Math.abs(d * 10 * lot))} a lot).`;
      else if (focus === "gamma") out.headline = gm === null || d === null ? "No gamma for this leg." : `Delta moves from ${formatFixed(d, 3)} to ${formatFixed(clamp(d + gm * 10), 3)} after 10 points up, and to ${formatFixed(clamp(d - gm * 10), 3)} after 10 points down.`;
      else if (focus === "theta") out.headline = th === null ? "No theta for this leg." : `A day takes about ${formatFixed(Math.abs(th), 2)} off the premium (${rs(Math.abs(th * lot))} a lot)${P ? `, ${pc(Math.abs(th / P) * 100, 1)} of it` : ""}. A rate at this instant, not tomorrow's change.`;
      else out.headline = vg === null ? "No vega for this leg." : `One vol point of IV moves the premium about ${formatFixed(Math.abs(vg), 2)} (${rs(Math.abs(vg * lot))} a lot), the effect if IV moves.`;
      out.tone = focus === "theta" ? toneOf(th) : focus === "vega" ? toneOf(vg) : focus === "delta" ? toneOf(d) : toneOf(gm);
      return out;
    }
    case "ext": {
      const tv = O.extrinsic(K, RIGHT[side], P, num(x?.F));
      if (tv === null) return no("No premium or no forward.");
      out.headline = tv < -0.05 ? `The premium is ${g(Math.abs(tv))} under intrinsic on the forward: a parity break or a stale quote.` : `${g(tv)} of the ${g(P)} premium is time value; the rest, ${g(P - tv)}, is intrinsic.`;
      out.tone = tv < -0.05 ? "down" : null;
      return out;
    }
    case "be": {
      const be = O.breakeven(K, RIGHT[side], P);
      const spot = num(x?.spot);
      if (be === null) return no("No premium, so no breakeven.");
      const mv = spot ? ((be - spot) / spot) * 100 : null;
      out.headline = `A long position at ${g(P)} gets its premium back at ${g(be)} at expiry${mv === null ? "." : `, ${pc(Math.abs(mv), 2)} ${mv >= 0 ? "above" : "below"} spot.`}`;
      out.tone = toneOf(mv);
      return out;
    }
    case "dist": {
      const d = O.distance(K, RIGHT[side], num(x?.spot));
      if (!d) return no("No spot to measure from.");
      out.headline = `The strike is ${g(Math.abs(d.pts), 1)} points (${pc(Math.abs(d.pct), 2)}) ${d.pts > 0 ? "out of" : d.pts < 0 ? "in" : "at"} the money for this ${leg?.toLowerCase() ?? "leg"}.`;
      return out;
    }
    case "pitm":
    case "potm":
    case "pop":
    case "pops": {
      const F = num(x?.F);
      const p = key.startsWith("pop") ? O.chanceOfProfit(F, K, x?.years, iv ?? atmIv, RIGHT[side], P) : O.probItm(F, K, x?.years, iv, RIGHT[side]);
      if (p === null) return no("No IV, so the model has no reading.");
      const v = key === "potm" || key === "pops" ? 1 - p : p;
      const what = { pitm: "finishes in the money", potm: "expires out of the money", pop: "a long position ends in profit", pops: "a short position keeps a profit" }[key];
      out.headline = `The model gives ${pc(v * 100, 0)} that ${what} at expiry. A log-normal estimate at this IV, not a forecast.`;
      return out;
    }
    case "premLot":
      out.headline = P === null ? "No premium." : `One lot of ${formatInt(lot)} costs ${rs(P * lot)} at the mid.`;
      return out;
    case "hedge": {
      const n = O.hedgeLots(x?.netDelta, num(q?.delta), lot);
      out.headline = n === null ? "This leg's delta does not offset the position's." : `${formatInt(n)} lot${n === 1 ? "" : "s"} of this ${leg?.toLowerCase() ?? "leg"} would offset ${x?.hedgeOwn ? "your position's delta on this expiry" : "one long futures lot"}.`;
      return out;
    }
    case "strad": {
      const s = O.strikeStraddle(row);
      const spot = num(x?.spot);
      out.headline = s === null ? "One leg has no price." : `The call and put together cost ${g(s)}${spot ? `, ${pc((s / spot) * 100, 2)} of spot` : ""}: the move both premiums price in to expiry.`;
      return out;
    }
    case "pcrK": {
      const p = O.strikePcr(row);
      out.headline = p === null ? "No call open interest to compare with." : `${formatFixed(p, 2)} puts open for every call at this strike.`;
      return out;
    }
    case "syn":
    case "dev":
    case "edge": {
      const s = x?.syn?.get?.(K) ?? null;
      const ref = num(x?.ref);
      if (!s || num(s.mid) === null) return no("One of the two legs has no price.");
      const dev = ref !== null ? s.mid - ref : null;
      out.tone = toneOf(dev);
      out.headline = `The call and put imply a future at ${g(s.mid)}${dev === null ? "." : `, ${g(Math.abs(dev))} ${dev >= 0 ? "above" : "below"} the ${x?.refKind === "fut" ? "same-expiry future" : "chain forward"}.`}`;
      return out;
    }
    case "strike": {
      const atm = O.atmRow(x?.c)?.strike ?? null;
      out.headline = atm === K ? "The ATM strike: the listed strike nearest the forward." : `${formatInt(Math.abs((K ?? 0) - (atm ?? 0)))} points ${K > atm ? "above" : "below"} the ATM strike ${formatInt(atm)}.`;
      return out;
    }
    default:
      return out;
  }
}
