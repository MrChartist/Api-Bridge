/**
 * The unified and family book (stream S27, F2/F11; docs/spec/p1-12-guard-participants.md §7.13). Pure: shared by the
 * server (`book/bookService.mjs`) and the Positions page (All accounts / Family). No DOM, no fetch, no clock: prices,
 * times and positions come in as arguments.
 *
 *   Per leg: Greeks per unit from pricing.js (Black-76 on the forward F = spot·e^(r·Tcal), IV solved from the leg's
 *            mark); futures Δ = 1.
 *   Per underlying (per holder): Δ = Σ q·δ (units); Δ lots = Δ / lot; ₹Δ = Δ × spot; Γ = Σ q·γ; Θ = Σ q·θ (₹/day);
 *            Vega = Σ q·ν (₹/vol pt).
 *   Holder totals: P&L, Θ, Vega and ₹Δ summed across underlyings. Δ in units is NOT summed across underlyings.
 *   Family totals: sums of the family holders' totals; margins sum used / available per account.
 *
 * A holder is a pricing wall: its legs are priced only from its own sources (the server decides which and passes the
 * marks in). A holder with no usable source keeps broker-reported P&L and shows no Greeks, with the reason.
 */
import { greeks76, impliedVolB76 } from "./pricing.js";

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const round = (v, dp = 2) => (v === null ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const sumOf = (xs) => xs.reduce((s, x) => s + x, 0);
/** Σ over values that exist; null when none does. */
const sumKnown = (xs) => {
  const k = xs.map(num).filter((x) => x !== null);
  return k.length ? sumOf(k) : null;
};

/** Spread cap for a mid mark, % of mid (the strategy-P&L cap shared with guards and alerts, README C7). */
export const MAX_SPREAD_PCT = 15;

/** Notes the book shows (one place, so the page and the API say the same thing). */
export const BOOK_NOTES = Object.freeze({
  family: "Totals add separate accounts on this computer. Margin is not shared between accounts, and every exit goes to the leg's own account.",
  margin: "Sum of separate accounts; margin is not shared between accounts.",
  method: "Greeks per leg from that holder's own market data (Black-76 on the forward, IV from the leg's mark). ₹Δ = Δ (units) × spot, summed across underlyings, so it is not a hedge ratio.",
  outside: "Not in the family view. Guards and alert actions are not allowed on this holder's accounts.",
  disclaimer: "For information and personal use. Not investment advice.",
});

/** "No market-data account for {holder}; …" — the reason Greeks are missing for a holder. */
export const noDataReason = (label) => `No market-data account for ${label}; Greeks need spot and IV from that holder's own data.`;

/**
 * A leg's mark from a quote: mid when two-sided and the spread is at most `maxSpreadPct` of mid, else LTP.
 * @returns {{ mark: number|null, basis: "mid"|"ltp"|null }}
 */
export function markOf(q, { maxSpreadPct = MAX_SPREAD_PCT } = {}) {
  const bid = num(q?.bid);
  const ask = num(q?.ask);
  if (bid !== null && ask !== null && bid > 0 && ask >= bid) {
    const mid = (bid + ask) / 2;
    if (((ask - bid) / mid) * 100 <= maxSpreadPct) return { mark: round(mid, 4), basis: "mid" };
  }
  const ltp = num(q?.ltp);
  return ltp !== null && ltp > 0 ? { mark: ltp, basis: "ltp" } : { mark: null, basis: null };
}

/**
 * Price one leg (per-unit Greeks and IV). Futures: Δ 1, the rest 0. Options: IV from the mark on the forward; null
 * Greeks without spot, time or a solvable IV.
 * @param {{ kind: "OPT"|"FUT", right?: "CE"|"PE", strike?: number, mark: number|null }} leg
 * @param {{ spot: number|null, T: number|null, Tcal?: number|null, rate?: number, yearBasis?: number|null }} env
 * @returns {{ iv: number|null, greeks: { delta: number, gamma: number, theta: number, vega: number } | null }}
 */
export function priceLeg(leg, env) {
  if (leg.kind === "FUT") return { iv: null, greeks: { delta: 1, gamma: 0, theta: 0, vega: 0 } };
  const spot = num(env?.spot);
  const T = num(env?.T);
  const mark = num(leg.mark);
  const K = num(leg.strike);
  if (spot === null || spot <= 0 || T === null || mark === null || K === null || (leg.right !== "CE" && leg.right !== "PE")) return { iv: null, greeks: null };
  const r = num(env?.rate) ?? 0;
  const Tcal = num(env?.Tcal) ?? T;
  const F = spot * Math.exp(r * Tcal);
  if (!(T > 0)) {
    const g = greeks76(F, K, 0, 0, leg.right);
    return { iv: null, greeks: g };
  }
  const iv = impliedVolB76(mark, F, K, T, leg.right, Math.exp(-r * Tcal));
  if (iv === null) return { iv: null, greeks: null };
  const g = greeks76(F, K, T, iv, leg.right, { yearBasis: num(env?.yearBasis) });
  return { iv, greeks: g };
}

/**
 * P&L of an open leg: realised (broker) + q·(mark − avg) when marked, else the broker's figure.
 * @param {{ q: number, avg: number|null, mark: number|null, realised?: number|null, brokerPnl?: number|null }} leg
 */
export function legPnl(leg) {
  const q = num(leg.q) ?? 0;
  const mark = num(leg.mark);
  const avg = num(leg.avg);
  if (mark !== null && avg !== null) return (num(leg.realised) ?? 0) + q * (mark - avg);
  return num(leg.brokerPnl);
}

/**
 * Greeks of one underlying for one holder (§7.13). Legs carry per-unit `greeks` (or null when not priced).
 * @param {Array<{ q: number, greeks: object|null }>} legs @param {{ spot: number|null, lot: number|null }} u
 * @returns {{ delta: number, deltaLots: number|null, rupeeDelta: number|null, gamma: number, theta: number, vega: number, missing: number } | null}
 *   null when no leg could be priced
 */
export function underlyingGreeks(legs, { spot, lot }) {
  const priced = legs.filter((l) => l.greeks);
  if (!priced.length) return null;
  const s = (k) => sumOf(priced.map((l) => (num(l.q) ?? 0) * (num(l.greeks[k]) ?? 0)));
  const delta = s("delta");
  const L = num(lot);
  const S = num(spot);
  return {
    delta: round(delta, 4),
    deltaLots: L ? round(delta / L, 2) : null,
    rupeeDelta: S !== null ? round(delta * S, 2) : null,
    gamma: round(s("gamma"), 6),
    theta: round(s("theta"), 2),
    vega: round(s("vega"), 2),
    missing: legs.length - priced.length,
  };
}

/**
 * One holder's priced book: underlyings (legs + Greeks) and totals.
 * @param {{ holder: string, label: string, relationship: string|null, inFamily: boolean, priceSource: object,
 *   accounts: Array<{ account: string, pnl: number|null, margin: { used: number|null, available: number|null } | null }>,
 *   underlyings: Array<{ underlying: string, spot: number|null, lot: number|null, legs: object[] }> }} h
 */
export function priceHolder(h) {
  const underlyings = h.underlyings.map((u) => {
    const legs = u.legs.map((l) => ({ ...l, pnl: round(legPnl(l)) }));
    const greeks = h.priceSource?.kind === "none" ? null : underlyingGreeks(legs, u);
    return { underlying: u.underlying, spot: num(u.spot), lot: num(u.lot), greeks, legs };
  });
  const g = (k) => sumKnown(underlyings.map((u) => u.greeks?.[k]));
  // Account P&L from its own legs (+ legs closed today, realised only); an account that could not be read stays null.
  const allLegs = underlyings.flatMap((u) => u.legs);
  const accounts = h.accounts.map((a) => {
    if (a.error) return { ...a, pnl: null, realised: null, unrealised: null, positions: a.positions ?? 0 };
    const mine = allLegs.filter((l) => l.account === a.account);
    const closed = num(a.closedRealised) ?? 0;
    const realised = closed + sumOf(mine.map((l) => num(l.realised) ?? 0));
    const unrealised = sumOf(mine.map((l) => (l.pnl ?? 0) - (num(l.realised) ?? 0)));
    const { closedRealised: _c, ...rest } = a;
    return { ...rest, positions: mine.length, pnl: round(realised + unrealised), realised: round(realised), unrealised: round(unrealised) };
  });
  const totals = {
    pnl: round(sumKnown(accounts.map((a) => a.pnl))),
    theta: round(g("theta")),
    vega: round(g("vega")),
    rupeeDelta: round(g("rupeeDelta")),
    marginUsed: round(sumKnown(accounts.map((a) => a.margin?.used))),
    marginAvailable: round(sumKnown(accounts.map((a) => a.margin?.available))),
  };
  return { ...h, accounts, underlyings, totals };
}

/**
 * The response body for GET /v1/book (§4.3.1) from priced holders.
 * @param {Array<ReturnType<typeof priceHolder>>} holders  every visible holder, priced
 * @param {{ view: "holders"|"family", family: { name: string, relationships: string[] }, partial?: boolean, asOf: string }} o
 */
export function aggregate(holders, { view, family, partial = false, asOf }) {
  const famHolders = holders.filter((h) => h.inFamily);
  const outside = holders.filter((h) => !h.inFamily);
  let fam = null;
  if (view === "family") {
    const t = (k) => round(sumKnown(famHolders.map((h) => h.totals[k])));
    const accs = famHolders.flatMap((h) => h.accounts);
    fam = {
      name: family.name,
      relationships: [...family.relationships],
      holders: famHolders.map((h) => h.holder),
      totals: {
        pnl: t("pnl"),
        realised: round(sumKnown(accs.map((a) => a.realised))),
        unrealised: round(sumKnown(accs.map((a) => a.unrealised))),
        theta: t("theta"),
        vega: t("vega"),
        rupeeDelta: t("rupeeDelta"),
        marginUsed: t("marginUsed"),
        marginAvailable: t("marginAvailable"),
        accounts: accs.length,
        partial: Boolean(partial),
      },
      notes: [BOOK_NOTES.family],
    };
  }
  return {
    view,
    asOf,
    family: fam,
    holders: view === "family" ? famHolders : holders,
    outsideFamily: view === "family" ? outside.map((h) => ({ holder: h.holder, label: h.label, relationship: h.relationship, accounts: h.accounts.length, note: BOOK_NOTES.outside })) : [],
    partial: Boolean(partial),
    method: BOOK_NOTES.method,
    disclaimer: BOOK_NOTES.disclaimer,
  };
}

/**
 * Bulk selection on the All accounts / Family view: exits go to one account at a time. Selecting a leg of another
 * account clears the selection first.
 * @param {Array<{ account: string, symbol: string }>} selected  @param {{ account: string, symbol: string }} leg
 * @returns {{ selected: Array<{ account: string, symbol: string }>, cleared: boolean }}
 */
export function selectLeg(selected, leg) {
  const same = selected.filter((s) => s.account === leg.account);
  const cleared = same.length !== selected.length;
  const has = same.some((s) => s.symbol === leg.symbol);
  return { selected: has ? same.filter((s) => s.symbol !== leg.symbol) : [...same, { account: leg.account, symbol: leg.symbol }], cleared };
}
