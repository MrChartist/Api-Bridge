/**
 * Option-chain helpers — stream S5. Pure functions that turn a broker's chain (contract OptionChainResult, Dhan-shaped
 * legs) or a list of option quotes into the OpenAPI OptionChain rows, pick the ATM strike, trim to N strikes each side
 * and fill in computed IV and Greeks (server/lib/blackScholes.mjs) where the broker sent none.
 *
 * Computed Greeks use: the leg's LTP, the underlying LTP from the same read, the strike, calendar days to 15:30 IST on
 * the expiry day (at least 0.25 days), and the configured risk-free rate (default 6.5 %). No dividend yield. IV is in
 * percent; theta per calendar day; vega per one vol point. Every leg says where its Greeks came from (greeksSource).
 * That is the legacy model (`ivModel=legacy-bs-spot`, still the default until 2027-05-01).
 *
 * `ivModel=b76-forward` (docs/spec/p1-03-pricing-vol.md §3.9) prices every leg through dashboard/pricing.js, the same
 * code the dashboard runs: Black-76 on the 5-strike parity forward, mid prices, the vol-time clock for σ√T and calendar
 * time for interest. Theta is per trading-day unit. The broker's own IV, if it sent one, is kept as `brokerIv`.
 */
import { computeIVAndGreeks, daysBetween } from "../../lib/blackScholes.mjs";
import { formatSymbol } from "../core/symbolFormat.mjs";
import { greeks76, legIv, parityForward, volTime } from "../dashboard/pricing.js";
import { GREEK_KEYS, chainLegFields, legLacksGreeks, stripGreeks } from "./normalise.mjs";

/** BSE index underlyings trade on BFO; everything else defaults to NFO. */
const BFO_UNDERLYINGS = new Set(["SENSEX", "BANKEX", "SENSEX50"]);

/** Default derivatives exchange for an underlying when no instrument data says otherwise. */
export function defaultOptionExchange(underlying) {
  return BFO_UNDERLYINGS.has(String(underlying).toUpperCase()) ? "BFO" : "NFO";
}

/** Canonical leg symbol. */
export function legSymbol(exchange, underlying, expiry, strike, right) {
  return formatSymbol({ exchange, underlying, expiry, strike, right, kind: "OPT" });
}

/**
 * Strike step (docs/spec/p1-06-stocks.md §6.1): the most common positive gap between consecutive distinct listed
 * strikes of one expiry; the smaller gap wins a tie; null with fewer than 3 strikes. Inferred, so callers label it.
 * [1360, 1380, 1400, 1410, 1420, 1440, 1460] → 20 (the off-grid 1410 is typical after a corporate action).
 * @param {number[]} strikes
 */
export function strikeStepOf(strikes) {
  const xs = [...new Set((strikes ?? []).filter((k) => typeof k === "number" && Number.isFinite(k) && k > 0))].sort((a, b) => a - b);
  if (xs.length < 3) return null;
  const counts = new Map();
  for (let i = 1; i < xs.length; i += 1) {
    const gap = Math.round((xs[i] - xs[i - 1]) * 10_000) / 10_000;
    if (gap > 0) counts.set(gap, (counts.get(gap) ?? 0) + 1);
  }
  let best = null;
  for (const [gap, n] of counts) if (best === null || n > best[1] || (n === best[1] && gap < best[0])) best = [gap, n];
  return best ? best[0] : null;
}

/** "physical" for stock derivatives, "cash" for index derivatives, null when the kind is unknown. */
export const settlementOfKind = (kind) => (kind === "stock" ? "physical" : kind === "index" ? "cash" : null);

/** The strike nearest to spot (lower strike on a tie), or null. */
export function atmStrike(strikes, spot) {
  if (!(spot > 0) || !strikes.length) return null;
  let best = strikes[0];
  for (const k of strikes) if (Math.abs(k - spot) < Math.abs(best - spot)) best = k;
  return best;
}

/** Keep `n` strikes on each side of ATM (rows sorted ascending). */
export function trimStrikes(rows, atm, n) {
  if (!n || atm === null) return rows;
  const i = rows.findIndex((r) => r.strike === atm);
  if (i < 0) return rows;
  return rows.slice(Math.max(0, i - n), i + n + 1);
}

/**
 * Fill computed IV/Greeks on a leg that lacks them.
 * @param {object} leg ChainLeg fields (mutated copy returned)
 * @param {{ spot: number | null, strike: number, expiry: string, right: "CE"|"PE", nowMs: number, rate: number }} p
 */
export function withComputedGreeks(leg, { spot, strike, expiry, right, nowMs, rate }) {
  if (!(leg.ltp > 0) || !(spot > 0)) return { ...leg, greeksSource: leg.greeksSource ?? null };
  const daysToExpiry = Math.max(0, daysBetween(new Date(nowMs), expiry));
  const g = computeIVAndGreeks({ ltp: leg.ltp, spot, strike, daysToExpiry, type: right, rate });
  if (!(g.iv > 0)) return { ...leg, greeksSource: leg.greeksSource ?? null };
  const out = { ...leg, iv: round(g.iv, 4), greeksSource: "computed" };
  for (const k of GREEK_KEYS) out[k] = round(g[k], 6);
  return out;
}

const round = (n, dp) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/**
 * Finish one leg: Greeks source, computed Greeks where missing, or none at all when greeks=false.
 * @param {object | null} fields ChainLeg fields without symbol/greeksSource
 * @param {{ symbol: string, declared: "broker"|"computed"|null, greeks: boolean, spot: number|null, strike: number,
 *   expiry: string, right: "CE"|"PE", nowMs: number, rate: number }} p
 */
export function finishLeg(fields, p) {
  if (!fields) return null;
  if (!p.greeks) return { symbol: p.symbol, ...stripGreeks(fields), greeksSource: null };
  if (!legLacksGreeks(fields)) return { symbol: p.symbol, ...fields, greeksSource: p.declared === "computed" ? "computed" : "broker" };
  return { symbol: p.symbol, ...withComputedGreeks({ ...fields, greeksSource: null }, p) };
}

/**
 * Rows from a broker chain (adapter.fetchOptionChain result).
 * @param {object} result { status, data: { oc: { "<strike>": { ce?, pe? } }, last_price } }
 * @param {{ underlying: string, expiry: string, exchange: string, declared: "broker"|"computed"|null, greeks: boolean,
 *   strikes?: number, nowMs: number, rate: number, oiUnit?: "units"|"lots", lotSize?: number | null }} p
 *   oiUnit/lotSize: the broker's OI unit (market/oiUnits.mjs); OI is converted to units
 * @returns {{ underlyingLtp: number | null, atmStrike: number | null, rows: object[] }}
 */
export function rowsFromBrokerChain(result, p) {
  const data = result?.data ?? {};
  const oc = data.oc && typeof data.oc === "object" ? data.oc : {};
  const spotRaw = Number(data.last_price);
  const spot = Number.isFinite(spotRaw) && spotRaw > 0 ? spotRaw : null;
  const rows = [];
  for (const key of Object.keys(oc)) {
    const strike = Number.parseFloat(key);
    if (!Number.isFinite(strike) || strike <= 0) continue;
    const pair = oc[key] ?? {};
    const row = { strike, ce: null, pe: null };
    for (const right of ["CE", "PE"]) {
      const fields = chainLegFields(pair[right.toLowerCase()], { oiUnit: p.oiUnit ?? "units", lotSize: p.lotSize ?? null });
      row[right.toLowerCase()] = finishLeg(fields, {
        ...p,
        symbol: legSymbol(p.exchange, p.underlying, p.expiry, strike, right),
        spot,
        strike,
        right,
      });
    }
    if (row.ce || row.pe) rows.push(row);
  }
  rows.sort((a, b) => a.strike - b.strike);
  const atm = atmStrike(rows.map((r) => r.strike), spot);
  return { underlyingLtp: spot, atmStrike: atm, rows: trimStrikes(rows, atm, p.strikes) };
}

/**
 * Rows built from option instruments plus their quotes (no broker chain).
 * @param {Array<{ canonical: string, strike: number, right: "CE"|"PE" }>} legs
 * @param {Map<string, object>} quotes canonical -> QuoteItem (missing = no quote)
 * @param {{ spot: number | null, expiry: string, greeks: boolean, strikes?: number, nowMs: number, rate: number }} p
 */
export function rowsFromQuotes(legs, quotes, p) {
  const byStrike = new Map();
  for (const leg of legs) {
    const q = quotes.get(leg.canonical);
    const row = byStrike.get(leg.strike) ?? { strike: leg.strike, ce: null, pe: null };
    byStrike.set(leg.strike, row);
    if (!q) continue;
    const fields = { ltp: q.ltp ?? null, bid: q.bid ?? null, ask: q.ask ?? null, oi: q.oi ?? null, oiChange: null, volume: q.volume ?? null, iv: null, close: q.close ?? null, change: q.change ?? null, delta: null, gamma: null, theta: null, vega: null };
    row[leg.right.toLowerCase()] = finishLeg(fields, { ...p, symbol: leg.canonical, declared: null, strike: leg.strike, right: leg.right });
  }
  const rows = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  const atm = atmStrike(rows.map((r) => r.strike), p.spot);
  return { underlyingLtp: p.spot, atmStrike: atm, rows: trimStrikes(rows, atm, p.strikes) };
}

/** The chain IV models: the new single pricing core and the legacy Black-Scholes-on-spot path. */
export const IV_MODELS = Object.freeze(["b76-forward", "legacy-bs-spot"]);

/**
 * Reprice a finished chain (OpenAPI OptionChain) with Black-76 on the parity forward (pure). Every leg gets iv, delta,
 * gamma, theta (₹ per trading-day unit) and vega from pricing.js, `greeksSource: "computed"` and `brokerIv` (the IV
 * the broker sent, else null); legs without an IV get nulls and `ivReason` (SETTLING, NOQUOTE, TICK, INTRINSIC, RANGE,
 * SETTLED, NOFORWARD; null when the IV solved). Adds the chain-level `pricing` object.
 * @param {object} chain  { underlying, expiry, underlyingLtp, rows, ... }
 * @param {{ ctx: object, nowMs: number, rate: number, rateQuality?: string|null }} p  ctx from vol/context.mjs
 */
export function applyB76(chain, { ctx, nowMs, rate, rateQuality = null }) {
  const clock = volTime(ctx, nowMs, chain.expiry);
  const T = clock?.T ?? 0;
  const Tcal = clock?.Tcal ?? 0;
  const fw = parityForward(chain, { rate, Tcal });
  const F = fw.F;
  const df = Math.exp(-rate * Tcal);
  const yearBasis = clock?.yearBasis ?? null;
  const leg = (q, strike, right) => {
    if (!q) return null;
    const brokerIv = q.greeksSource === "broker" && q.iv > 0 ? q.iv : null;
    const out = { ...q, iv: null, delta: null, gamma: null, theta: null, vega: null, greeksSource: "computed", brokerIv, ivReason: null };
    if (!(T > 0)) return { ...out, ivReason: "SETTLED" };
    if (!(F > 0)) return { ...out, ivReason: "NOFORWARD" };
    const r = legIv(q, F, strike, right, { years: T, df, basis: "mid", settling: clock.settling });
    // Why a leg has no IV (§6.1: SETTLING inside the expiry-day settlement window), so clients can tell it from no quote.
    if (!r) return { ...out, ivReason: "NOQUOTE" };
    if (r.iv === null) return { ...out, ivReason: String(r.out ?? "noquote").toUpperCase() };
    const g = greeks76(F, strike, T, r.iv, right, { yearBasis });
    // IV is not rounded (the dashboard's own solve on the same JSON must agree to 1e-9); Greeks to 6 decimals.
    out.iv = round(r.iv, 10);
    for (const k of GREEK_KEYS) out[k] = round(g[k], 6);
    return out;
  };
  const rows = chain.rows.map((r) => ({ ...r, ce: leg(r.ce, r.strike, "CE"), pe: leg(r.pe, r.strike, "PE") }));
  return {
    ...chain,
    rows,
    pricing: {
      model: "black76-parity-forward",
      ivModel: "b76-forward",
      priceBasis: "mid",
      forward: F === null ? null : round(F, 4),
      forwardSource: fw.source,
      forwardStrikes: fw.strikes,
      rate: { value: rate, quality: rateQuality },
      clock: { version: clock?.version ?? "vt1", mode: clock?.mode ?? ctx.mode, T: round(T, 10), units: round(clock?.units ?? 0, 6), Tcal: round(Tcal, 10), yearBasis },
    },
  };
}
