// Expiry and physical delivery maths. PURE: no imports, no DOM, no fetch, no clock. Used by the order service in
// server/bridge/orders (the dashboard pages do not load it).
//
// Every rate comes from the charge table passed in (reference.charges(): opt, physical, margin, sebiPerCrore, gst,
// brokerage); this file holds none. Money is in rupees, unrounded (format.js rounds for display). The physical
// settlement rates and the delivery-margin schedule are unverified; callers show that.
//
// Leg: { strike, right: "CE"|"PE", qty (signed units: + long, − short), exchange?: "NFO"|"BFO", bid?, ask? }.

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const num = (v) => (finite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** Which cash exchange's rates apply to a derivative exchange (BFO legs settle on BSE). */
export const cashExchangeOf = (exchange) => (exchange === "BFO" || exchange === "BSE" ? "BSE" : "NSE");

/** "physical" for stock derivatives, "cash" for index derivatives (kind from the master, never from the name). */
export const settlementOf = (kind) => (kind === "stock" ? "physical" : kind === "index" ? "cash" : null);

/** Intrinsic value of a leg at spot S. */
export function intrinsicOf(strike, right, spot) {
  const K = num(strike);
  const S = num(spot);
  if (K === null || S === null) return null;
  return right === "CE" ? Math.max(0, S - K) : Math.max(0, K - S);
}

/**
 * Moneyness. ITM: CE with S > K or PE with S < K. CTM (our display band, not an exchange definition): not ITM
 * and |K − S| ≤ ctmStrikes × step. OTM otherwise. With no step the band is empty.
 * @returns {{ moneyness: "ITM"|"CTM"|"OTM"|null, intrinsic: number|null, distance: number|null }}
 */
export function moneynessOf({ strike, right, spot, step = null, ctmStrikes = 1 }) {
  const K = num(strike);
  const S = num(spot);
  if (K === null || S === null || (right !== "CE" && right !== "PE")) return { moneyness: null, intrinsic: null, distance: null };
  const intrinsic = intrinsicOf(K, right, S);
  const distance = Math.abs(K - S);
  if (intrinsic > 0) return { moneyness: "ITM", intrinsic, distance };
  const s = num(step);
  const band = s !== null && s > 0 ? (num(ctmStrikes) ?? 0) * s : -1;
  return { moneyness: distance <= band ? "CTM" : "OTM", intrinsic, distance };
}

/**
 * E-n day and the warning window. `cal.tradingDaysBetween(a, b)` counts trading days after a up to b.
 * @returns {{ day: string|null, n: number|null, inWindow: boolean, after: boolean }}
 */
export function expiryDay({ asOf, expiry, cal, warnFrom = 4 }) {
  if (!asOf || !expiry || typeof cal?.tradingDaysBetween !== "function") return { day: null, n: null, inWindow: false, after: false };
  if (asOf > expiry) return { day: null, n: null, inWindow: false, after: true };
  const n = cal.tradingDaysBetween(asOf, expiry);
  return { day: n === 0 ? "E" : `E-${n}`, n, inWindow: n <= warnFrom, after: false };
}

/**
 * Delivery obligation if a stock option leg settles ITM.
 * @returns {{ kind: "receive-shares"|"deliver-shares", shares: number, cash: number, value: number, buyer: boolean, text: string } | null}
 */
export function obligationOf({ strike, right, qty, underlying = "" }) {
  const K = num(strike);
  const q = num(qty);
  if (K === null || q === null || q === 0 || (right !== "CE" && right !== "PE")) return null;
  const shares = Math.abs(q);
  const value = K * shares;
  // Long call and short put take delivery (buy shares at K); short call and long put give delivery.
  const buyer = (right === "CE" && q > 0) || (right === "PE" && q < 0);
  const name = underlying ? `${underlying} ` : "";
  return buyer
    ? { kind: "receive-shares", shares, cash: -value, value, buyer, text: `Buy ${shares} ${name}at ${K}` }
    : { kind: "deliver-shares", shares, cash: value, value, buyer, text: `Deliver ${shares} ${name}shares at ${K}` };
}

/**
 * Whether a delivering leg is covered by holdings: true / false, or null when holdings are unknown or the leg takes
 * delivery (nothing to deliver).
 */
export function coveredBy(obligation, heldShares) {
  if (!obligation || obligation.buyer) return null;
  const h = num(heldShares);
  if (h === null) return null;
  return h >= obligation.shares;
}

/**
 * Delivery margin: the schedule percentage for `day`, and an indicative rupee figure only when the caller
 * supplies `varElmPct` (VaR + ELM rate in percent, from their broker). Never a default VaR.
 * @param {{ day: string|null, schedule: Array<{ day: string, pct: number, date?: string }>, spot: number, qty: number, varElmPct?: number|null }} p
 */
export function deliveryMarginOf({ day, schedule, spot, qty, varElmPct = null }) {
  const row = (schedule ?? []).find((r) => r.day === day) ?? null;
  const pct = row ? num(row.pct) : null;
  const v = num(varElmPct);
  const S = num(spot);
  const q = num(qty);
  const indicative = pct !== null && v !== null && S !== null && q !== null ? (pct / 100) * (v / 100) * S * Math.abs(q) : null;
  return { pct, indicative, basis: indicative === null ? null : { pct, varElmPct: v, spot: S, qty: Math.abs(q) } };
}

/**
 * Charges if a stock option leg settles by delivery: delivery STT, stamp (share buyer), cash-segment txn,
 * SEBI and GST on (txn + SEBI), all on V = K × |q|. The broker's own physical-delivery charge is excluded (unknown).
 */
export function settleStockCost({ strike, right, qty, exchange = "NFO" }, rates) {
  const ob = obligationOf({ strike, right, qty });
  const ph = rates?.physical;
  if (!ob || !ph) return null;
  const V = ob.value;
  const exch = cashExchangeOf(exchange);
  const sttDelivery = (num(ph.sttDelivery) ?? 0) * V;
  const stamp = ob.buyer ? (num(ph.stampBuy) ?? 0) * V : 0;
  const txn = (num(ph.txn?.[exch]) ?? num(ph.txn?.NSE) ?? 0) * V;
  const sebi = (V * (num(rates.sebiPerCrore) ?? 0)) / 1e7;
  const gst = (num(rates.gst) ?? 0) * (txn + sebi);
  const lines = [
    { key: "sttDelivery", value: sttDelivery },
    { key: "stamp", value: stamp },
    { key: "txn", value: txn },
    { key: "sebi", value: sebi },
    { key: "gst", value: gst },
  ];
  return { total: sttDelivery + stamp + txn + sebi + gst, value: V, lines, excluded: ["Broker's physical-delivery charge"] };
}

/**
 * Charges if a long ITM index option settles in cash: exercise STT on intrinsic × units, plus the profile's
 * exercise brokerage (one order) and GST on it. Short legs pay none here.
 * @param {{ intrinsic: number, qty: number }} leg
 * @param {object} rates  charge table
 * @param {{ perOrder?: number, exerciseBrokerage?: boolean }} [profile]  default: rates.brokerage.perOrder, charged
 */
export function settleIndexCost({ intrinsic, qty }, rates, profile = {}) {
  const I = num(intrinsic);
  const q = num(qty);
  if (I === null || q === null) return null;
  if (!(I > 0) || q <= 0) return { total: 0, lines: [], excluded: [] };
  const stt = (num(rates?.opt?.exerciseStt) ?? 0) * I * q;
  const per = num(profile.perOrder) ?? num(rates?.brokerage?.perOrder) ?? 0;
  const brokerage = profile.exerciseBrokerage === false ? 0 : per;
  const gst = (num(rates?.gst) ?? 0) * brokerage;
  return {
    total: stt + brokerage + gst,
    lines: [
      { key: "exerciseStt", value: stt },
      { key: "brokerage", value: brokerage },
      { key: "gst", value: gst },
    ],
    excluded: [],
  };
}

/**
 * Charges to square off an option leg now: the reverse order at the bid (long) or ask (short), with a flat
 * brokerage per order. Same formula as options.js orderCharges for options.
 * @param {{ qty: number, bid?: number|null, ask?: number|null, exchange?: string }} leg
 */
export function squareOffCost({ qty, bid = null, ask = null, exchange = "NFO" }, rates, profile = {}) {
  const q = num(qty);
  if (q === null || q === 0) return null;
  const side = q > 0 ? "SELL" : "BUY";
  const price = num(side === "SELL" ? bid : ask);
  if (price === null || price < 0) return { price: null, side, total: null, premium: null, lines: [] };
  const units = Math.abs(q);
  const premium = price * units;
  const exch = cashExchangeOf(exchange);
  const o = rates?.opt ?? {};
  const brokerage = premium > 0 ? num(profile.perOrder) ?? num(rates?.brokerage?.perOrder) ?? 0 : 0;
  const stt = side === "SELL" ? premium * (num(o.sttSell) ?? 0) : 0;
  const txn = premium * (num(o.txn?.[exch]) ?? num(o.txn?.NSE) ?? 0);
  const sebi = (premium * (num(rates?.sebiPerCrore) ?? 0)) / 1e7;
  const ipft = (premium * (num(rates?.ipftPerCrore) ?? 0)) / 1e7;
  const stamp = side === "BUY" ? premium * (num(o.stampBuy) ?? 0) : 0;
  const gst = (brokerage + txn + sebi + ipft) * (num(rates?.gst) ?? 0);
  const lines = [
    { key: "brokerage", value: brokerage },
    { key: "stt", value: stt },
    { key: "txn", value: txn },
    { key: "sebi", value: sebi },
    { key: "ipft", value: ipft },
    { key: "stamp", value: stamp },
    { key: "gst", value: gst },
  ].filter((l) => l.key !== "ipft" || l.value !== 0);
  return { price, side, premium, total: brokerage + stt + txn + sebi + ipft + stamp + gst, lines };
}

/**
 * One leg's expiry view: moneyness, obligation (stock), delivery margin (stock), settle vs square-off charges.
 * @param {object} leg  { symbol?, strike, right, qty, exchange?, bid?, ask? }
 * @param {{ kind: "index"|"stock", underlying?: string, spot: number|null, step?: number|null, day?: string|null,
 *   schedule?: object[], varElmPct?: number|null, heldShares?: number|null, ctmStrikes?: number, rates: object, profile?: object }} c
 */
export function legExpiryCosts(leg, c) {
  const m = moneynessOf({ strike: leg.strike, right: leg.right, spot: c.spot, step: c.step, ctmStrikes: c.ctmStrikes ?? 1 });
  const out = { symbol: leg.symbol ?? null, qty: leg.qty, strike: leg.strike, right: leg.right, moneyness: m.moneyness, intrinsic: m.intrinsic, obligation: null, deliveryMargin: null, settle: null, squareOff: squareOffCost(leg, c.rates, c.profile), covered: null, difference: null };
  if (c.kind === "stock") {
    const relevant = m.moneyness === "ITM" || m.moneyness === "CTM";
    if (relevant) {
      out.obligation = obligationOf({ strike: leg.strike, right: leg.right, qty: leg.qty, underlying: c.underlying ?? "" });
      out.deliveryMargin = deliveryMarginOf({ day: c.day ?? null, schedule: c.schedule, spot: c.spot, qty: leg.qty, varElmPct: c.varElmPct });
      out.settle = settleStockCost(leg, c.rates);
      out.covered = coveredBy(out.obligation, c.heldShares);
    } else {
      out.settle = { total: 0, value: 0, lines: [], excluded: [] };
    }
  } else {
    out.settle = settleIndexCost({ intrinsic: m.intrinsic ?? 0, qty: leg.qty }, c.rates, c.profile);
  }
  if (out.settle && finite(out.settle.total) && out.squareOff && finite(out.squareOff.total)) out.difference = out.settle.total - out.squareOff.total;
  return out;
}

/** The disclaimer every expiry-costs result and the positions panel carry. */
export const EXPIRY_COSTS_NOTE = "Calculated from the rate table and your inputs. Not tax or investment advice; your broker's contract note decides.";

/**
 * The "Expiry today" chip title, rendered from the rate table. `pct` formats a decimal rate as percent
 * text; it is passed in so this file stays free of number formatting.
 * @param {{ kind: "index"|"stock", rates: object, pct: (v: number) => string }} p
 */
export function expiryDayNote({ kind, rates, pct }) {
  if (kind === "stock") return "Physically settled today: ITM long calls and short puts take delivery of shares, ITM long puts and short calls give delivery.";
  const elm = num(rates?.margin?.expiryDayElmIndexShort);
  const ex = num(rates?.opt?.exerciseStt);
  const sell = num(rates?.opt?.sttSell);
  const parts = [];
  if (elm !== null) parts.push(`Short index options carry an extra ${pct(elm)} ELM today (rate from the charges table).`);
  if (ex !== null && sell !== null) parts.push(`Long ITM options left to settle pay exercise STT of ${pct(ex)} of intrinsic; squaring off pays ${pct(sell)} of the premium instead.`);
  return parts.join(" ");
}
