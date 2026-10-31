/**
 * Stock option chains built from batched quotes (stream S19, docs/spec/p1-06-stocks.md §2.6 step 5, §6.10, §6.11).
 * PURE: the quotes are fetched by the sweep; this file only shapes them.
 *
 *  - strikeWindow: ±n listed strikes around ATM (the strike nearest spot, the lower one on a tie); strikes are never
 *    invented, only the master's listed ones are used.
 *  - chainFromQuotes: the OpenAPI OptionChain from master legs + quotes through market/chain.mjs rowsFromQuotes (the
 *    same Greeks seam as /v1/optionchain), plus ΔOI with its basis per leg.
 *  - oiChangeOf: ΔOI basis order: broker (the chain endpoint's own change) → recorder (the last OI recorded on the
 *    previous trading day) → day-baseline (the first OI seen today) → null.
 */
import { atmStrike, rowsFromQuotes, settlementOfKind } from "../market/chain.mjs";

/** Listed strikes within ±n steps (by position) of the ATM strike, ascending. */
export function strikeWindow(strikes, spot, n) {
  const xs = [...new Set(strikes)].sort((a, b) => a - b);
  const atm = atmStrike(xs, spot);
  if (atm === null) return xs;
  const i = xs.indexOf(atm);
  return xs.slice(Math.max(0, i - n), i + n + 1);
}

/**
 * ΔOI of one contract and where it came from (§6.11).
 * @param {{ oi: number|null, brokerChange?: number|null, recorderPrev?: number|null, dayBase?: [string, number]|null }} p
 * @returns {{ oiChange: number|null, oiChangeBasis: "broker"|"recorder"|"day-baseline"|null, since?: string }}
 */
export function oiChangeOf({ oi, brokerChange = null, recorderPrev = null, dayBase = null }) {
  if (Number.isFinite(brokerChange)) return { oiChange: brokerChange, oiChangeBasis: "broker" };
  if (!Number.isFinite(oi)) return { oiChange: null, oiChangeBasis: null };
  if (Number.isFinite(recorderPrev)) return { oiChange: oi - recorderPrev, oiChangeBasis: "recorder" };
  if (Array.isArray(dayBase) && Number.isFinite(dayBase[1])) return { oiChange: oi - dayBase[1], oiChangeBasis: "day-baseline", since: dayBase[0] };
  return { oiChange: null, oiChangeBasis: null };
}

/**
 * One chain from quotes.
 * @param {{ legs: Array<{ canonical: string, strike: number, right: "CE"|"PE" }>, quotes: Map<string, object>,
 *   spot: number|null, expiry: string, underlying: string, lotSize: number|null, tickSize?: number|null,
 *   strikeStep?: number|null, kind?: "stock"|"index", nowMs: number, rate: number, greeks?: boolean,
 *   recorderPrev?: Map<string, number>, dayBase?: Record<string, [string, number]>, freshness?: object }} p
 */
export function chainFromQuotes(p) {
  const built = rowsFromQuotes(p.legs, p.quotes, { spot: p.spot, expiry: p.expiry, greeks: p.greeks !== false, nowMs: p.nowMs, rate: p.rate });
  let earliest = null;
  const rows = built.rows.map((r) => {
    const out = { strike: r.strike, ce: null, pe: null };
    for (const side of ["ce", "pe"]) {
      const leg = r[side];
      if (!leg) continue;
      const d = oiChangeOf({ oi: leg.oi, recorderPrev: p.recorderPrev?.get(leg.symbol) ?? null, dayBase: p.dayBase?.[leg.symbol] ?? null });
      if (d.since && (earliest === null || d.since < earliest)) earliest = d.since;
      out[side] = { ...leg, oiChange: d.oiChange, oiChangeBasis: d.oiChangeBasis, ...(d.since ? { oiChangeSince: d.since } : {}) };
    }
    return out;
  });
  return {
    underlying: p.underlying,
    expiry: p.expiry,
    underlyingKind: p.kind ?? "stock",
    settlement: settlementOfKind(p.kind ?? "stock"),
    underlyingLtp: built.underlyingLtp,
    atmStrike: built.atmStrike,
    lotSize: p.lotSize ?? null,
    tickSize: p.tickSize ?? null,
    strikeStep: p.strikeStep ?? null,
    rows,
    ...(earliest ? { oiChangeSince: earliest } : {}),
    ...(p.freshness ? { freshness: p.freshness } : {}),
  };
}

/** Mark broker-chain legs with their ΔOI basis (the chain method: the broker's own change when it sent one). */
export function withBrokerBasis(chain, { recorderPrev = null, dayBase = null } = {}) {
  const rows = chain.rows.map((r) => {
    const out = { ...r };
    for (const side of ["ce", "pe"]) {
      const leg = r[side];
      if (!leg) continue;
      const d = oiChangeOf({ oi: leg.oi, brokerChange: Number.isFinite(leg.oiChange) ? leg.oiChange : null, recorderPrev: recorderPrev?.get(leg.symbol) ?? null, dayBase: dayBase?.[leg.symbol] ?? null });
      out[side] = { ...leg, oiChange: d.oiChange, oiChangeBasis: d.oiChangeBasis, ...(d.since ? { oiChangeSince: d.since } : {}) };
    }
    return out;
  });
  return { ...chain, rows };
}
