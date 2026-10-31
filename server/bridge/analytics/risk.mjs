/**
 * Risk and portfolio analytics for stream S15 (docs: analytics/risk.openapi.yaml). Read-only and plan-only: nothing
 * here places, changes or cancels an order, and nothing touches paper state or the safety layer.
 *
 *   POST /v1/analytics/risk/scenario      full-reprice (Black-Scholes) P&L grid over spot, IV and days, book and per underlying
 *   GET  /v1/analytics/risk/exposure      gross, net, long and short notional, delta-adjusted exposure, funds where known
 *   GET  /v1/analytics/risk/concentration top-N weights, per-underlying and sector share, HHI
 *   GET  /v1/analytics/risk/var           1-day historical-simulation VaR and expected shortfall (delta-normal fallback)
 *   POST /v1/analytics/risk/whatif        exposure, concentration and VaR before and after a hypothetical position
 *   GET  /v1/analytics/risk/tca           slippage, fees and latency from paper fills (what the paper store lacks is listed)
 *
 * Positions are read through deps.orders.positions (which enforces account access; ctx.requireAccountAccess is also
 * called first). Quantities are units (not lots). Spot and option prices come from marketData option chains.
 *
 * Scenario maths. Per option leg: sigma0 is the chain IV (else solved from the price), T0 = max(days to expiry, 0.25)/365
 * (the repo's solver clamp), rate r (default 6.5 %). A cell (dS %, dSigma pts, d days) reprices with Black-Scholes at
 * S(1+dS/100), sigma0 + dSigma/100 (floored at 0.05 %) and T0 - d/365 (intrinsic once T <= 0). P&L is
 * qty x (price(cell) - price(base)) with the MODEL base price, so the (0, 0, 0) cell is exactly 0. Futures and cash
 * legs move one for one with spot. Shocks are parallel across underlyings. The Taylor approximation is
 * qty x (delta dS + 0.5 gamma dS^2 + vega dSigma + theta d) with analytic Greeks at the base point (vega per vol point,
 * theta per calendar day); its error is taylor - full reprice.
 *
 * Everything returned is finite (a value that cannot be computed is null) and every list is bounded.
 */
import { z } from "zod";
import { BridgeError } from "../core/errors.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { ACCOUNT_RE } from "../orders/orderValidation.mjs";
import { autoBackupFor, readOptionsBase } from "../market/routes.mjs";
import { bsPrice, computeIVAndGreeks, DEFAULT_RATE } from "../../lib/blackScholes.mjs";
import { expiryCutoffMs, nowMsOf, pinMarketRead } from "./math.mjs";

export const MAX_CELLS = 400;
export const MAX_LEGS = 200;
const MAX_CHAINS = 25;
const MAX_UNDERLYINGS = 25;
const MIN_OBS = 30;
const MIN_RETURNS = 20;
const DAY_MS = 86_400_000;
const IST_MS = 5.5 * 3_600_000;
const MIN_VOL = 0.0005;

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const R = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const nz = (v) => (Number.isFinite(v) ? v : 0);
const istDay = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);

function parseBody(schema, body) {
  const r = schema.safeParse(body ?? {});
  if (r.success) return r.data;
  const errors = r.error.issues.map((i) => ({ path: i.path.join(".") || "(body)", message: i.message }));
  throw new BridgeError("VALIDATION_FAILED", `The request is not valid: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`, { errors });
}

/** Any error that is not already a BridgeError becomes INTERNAL (the raw message is never shown). */
const guarded = (fn) => async (ctx) => {
  try {
    return await fn(ctx);
  } catch (e) {
    if (e instanceof BridgeError) throw e;
    throw new BridgeError("INTERNAL", "The risk calculation failed.");
  }
};

// ───────────────────────────── Black-Scholes pieces ─────────────────────────────

// Same Abramowitz-Stegun CDF as lib/blackScholes.mjs, so analytic Greeks match the prices bsPrice gives.
function normCDF(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}
const normPDF = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/** Per-unit Greeks at the base point. vega per 1 vol point, theta per calendar day. */
export function optionGreeks({ spot, strike, right, iv, T, rate }) {
  const sq = iv * Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (rate + 0.5 * iv * iv) * T) / sq;
  const d2 = d1 - sq;
  const pdf = normPDF(d1);
  const disc = strike * Math.exp(-rate * T);
  const decay = -(spot * pdf * iv) / (2 * Math.sqrt(T));
  return {
    delta: right === "CE" ? normCDF(d1) : normCDF(d1) - 1,
    gamma: pdf / (spot * sq),
    vega: (spot * pdf * Math.sqrt(T)) / 100,
    theta: (right === "CE" ? decay - rate * disc * normCDF(d2) : decay + rate * disc * normCDF(-d2)) / 365,
  };
}

const SECTORS = Object.freeze({
  NIFTY: "Index", BANKNIFTY: "Index", FINNIFTY: "Index", MIDCPNIFTY: "Index", NIFTYNXT50: "Index", SENSEX: "Index", BANKEX: "Index", SENSEX50: "Index", INDIAVIX: "Index",
  HDFCBANK: "Banks", ICICIBANK: "Banks", SBIN: "Banks", AXISBANK: "Banks", KOTAKBANK: "Banks", INDUSINDBK: "Banks", BANKBARODA: "Banks", PNB: "Banks", FEDERALBNK: "Banks",
  BAJFINANCE: "Financials", BAJAJFINSV: "Financials", HDFCLIFE: "Financials", SBILIFE: "Financials", CHOLAFIN: "Financials", SHRIRAMFIN: "Financials",
  TCS: "IT", INFY: "IT", WIPRO: "IT", HCLTECH: "IT", TECHM: "IT", LTIM: "IT",
  RELIANCE: "Energy", ONGC: "Energy", BPCL: "Energy", IOC: "Energy", COALINDIA: "Energy", NTPC: "Power", POWERGRID: "Power", TATAPOWER: "Power",
  ITC: "FMCG", HINDUNILVR: "FMCG", NESTLEIND: "FMCG", BRITANNIA: "FMCG", TATACONSUM: "FMCG",
  MARUTI: "Auto", TATAMOTORS: "Auto", "M&M": "Auto", "BAJAJ-AUTO": "Auto", EICHERMOT: "Auto", HEROMOTOCO: "Auto",
  SUNPHARMA: "Pharma", DRREDDY: "Pharma", CIPLA: "Pharma", DIVISLAB: "Pharma", APOLLOHOSP: "Healthcare",
  TATASTEEL: "Metals", JSWSTEEL: "Metals", HINDALCO: "Metals", VEDL: "Metals", ADANIENT: "Conglomerate",
  LT: "Industrials", ULTRACEMCO: "Cement", GRASIM: "Cement", BHARTIARTL: "Telecom", TITAN: "Consumer", ASIANPAINT: "Consumer",
});
export const sectorOf = (underlying, exchange) => SECTORS[underlying] ?? (exchange === "MCX" ? "Commodity" : exchange === "CDS" ? "Currency" : "Unclassified");

// ───────────────────────────── legs and models ─────────────────────────────

/**
 * Turn an in-memory leg into a priced model. Options without a usable IV stay in the book (for exposure) but are
 * marked modelled=false and skipped by the scenario and VaR maths.
 */
export function modelLeg(leg, rate) {
  const m = { ...leg, sector: sectorOf(leg.underlying, leg.exchange), modelled: true };
  if (leg.kind !== "OPT") {
    return { ...m, delta: 1, gamma: 0, vega: 0, theta: 0, basePrice: leg.spot, T0: 0, iv: null };
  }
  const bad = { ...m, modelled: false, delta: null, gamma: 0, vega: 0, theta: 0, basePrice: null, T0: 0 };
  if (!(leg.iv > 0) || !(leg.spot > 0) || !(leg.dte > 0) || !(leg.strike > 0)) return bad;
  const T0 = Math.max(leg.dte, 0.25) / 365;
  const g = optionGreeks({ spot: leg.spot, strike: leg.strike, right: leg.right, iv: leg.iv, T: T0, rate });
  const basePrice = bsPrice({ spot: leg.spot, strike: leg.strike, rate, vol: leg.iv, years: T0, type: leg.right });
  if (![g.delta, g.gamma, g.vega, g.theta, basePrice].every(Number.isFinite)) return bad;
  return { ...m, ...g, basePrice, T0 };
}

/** P&L of one modelled leg for a cell: full Black-Scholes reprice against the model base price. */
export function legPnl(m, rate, spotPct, ivPts, days) {
  const S = m.spot * (1 + spotPct / 100);
  if (m.kind !== "OPT") return m.qty * (S - m.spot);
  const vol = Math.max(m.iv + ivPts / 100, MIN_VOL);
  return m.qty * (bsPrice({ spot: S, strike: m.strike, rate, vol, years: m.T0 - days / 365, type: m.right }) - m.basePrice);
}

/** Delta-gamma-vega-theta approximation of legPnl. */
export function legTaylor(m, spotPct, ivPts, days) {
  const dS = (m.spot * spotPct) / 100;
  return m.qty * (m.delta * dS + 0.5 * m.gamma * dS * dS + m.vega * ivPts + m.theta * days);
}

/**
 * Full-reprice scenario grid. `models` are modelLeg() results; non-modelled legs are ignored.
 */
export function scenarioGrid(models, { spotShocksPct, ivShocksPts, daysForward, rate }) {
  const live = models.filter((m) => m.modelled);
  const unds = [...new Set(live.map((m) => m.underlying))];
  const cells = [];
  let worst = null;
  let best = null;
  let maxAbsErr = 0;
  let maxErrCell = null;
  let sumAbsErr = 0;
  for (const d of daysForward) {
    for (const v of ivShocksPts) {
      for (const s of spotShocksPct) {
        const by = Object.fromEntries(unds.map((u) => [u, 0]));
        let pnl = 0;
        let tay = 0;
        for (const m of live) {
          const p = nz(legPnl(m, rate, s, v, d));
          by[m.underlying] += p;
          pnl += p;
          tay += nz(legTaylor(m, s, v, d));
        }
        const cell = { spotPct: s, ivPts: v, days: d, pnl: R(pnl), taylorPnl: R(tay), taylorError: R(tay - pnl), byUnderlying: Object.fromEntries(Object.entries(by).map(([u, x]) => [u, R(x)])) };
        cells.push(cell);
        if (!worst || cell.pnl < worst.pnl) worst = cell;
        if (!best || cell.pnl > best.pnl) best = cell;
        const ae = Math.abs(cell.taylorError);
        sumAbsErr += ae;
        if (ae >= maxAbsErr) {
          maxAbsErr = ae;
          maxErrCell = { spotPct: s, ivPts: v, days: d };
        }
      }
    }
  }
  const base = cells.find((c) => c.spotPct === 0 && c.ivPts === 0 && c.days === 0) ?? null;
  const tot = { delta: 0, gamma: 0, vega: 0, theta: 0, deltaExposure: 0 };
  const legs = live.map((m) => {
    const pos = { delta: m.delta * m.qty, gamma: m.gamma * m.qty, vega: m.vega * m.qty, theta: m.theta * m.qty };
    for (const k of Object.keys(pos)) tot[k] += pos[k];
    tot.deltaExposure += pos.delta * m.spot;
    return { symbol: m.symbol, underlying: m.underlying, kind: m.kind, netQty: m.qty, spot: R(m.spot), price: R(m.price), modelPrice: R(m.basePrice, 4), ivPct: m.iv ? R(m.iv * 100, 2) : null, delta: R(pos.delta), gamma: R(pos.gamma, 4), vega: R(pos.vega), theta: R(pos.theta) };
  });
  const pick = (u, better) => {
    let a = null;
    for (const c of cells) if (a === null || better(c.byUnderlying[u], a.pnl)) a = { pnl: c.byUnderlying[u], spotPct: c.spotPct, ivPts: c.ivPts, days: c.days };
    return a;
  };
  return {
    cells,
    base,
    legs,
    net: { delta: R(tot.delta), gamma: R(tot.gamma, 4), vega: R(tot.vega), theta: R(tot.theta), deltaExposure: R(tot.deltaExposure) },
    summary: {
      cells: cells.length,
      worst: worst && { pnl: worst.pnl, spotPct: worst.spotPct, ivPts: worst.ivPts, days: worst.days },
      best: best && { pnl: best.pnl, spotPct: best.spotPct, ivPts: best.ivPts, days: best.days },
      taylor: { maxAbsError: R(maxAbsErr), maxAbsErrorCell: maxErrCell, meanAbsError: cells.length ? R(sumAbsErr / cells.length) : null },
    },
    byUnderlying: unds.map((u) => ({ underlying: u, worst: pick(u, (x, y) => x < y), best: pick(u, (x, y) => x > y) })),
  };
}

// ───────────────────────────── exposure and concentration ─────────────────────────────

export function exposureOf(models) {
  let long = 0;
  let short = 0;
  let deltaNet = 0;
  let deltaGross = 0;
  let deltaUnavailable = 0;
  const by = new Map();
  for (const m of models) {
    const signed = m.qty * m.spot;
    const u = by.get(m.underlying) ?? { underlying: m.underlying, sector: m.sector, spot: m.spot, positions: 0, longNotional: 0, shortNotional: 0, deltaExposure: 0 };
    u.positions += 1;
    if (signed >= 0) {
      long += signed;
      u.longNotional += signed;
    } else {
      short -= signed;
      u.shortNotional -= signed;
    }
    if (Number.isFinite(m.delta)) {
      const de = m.qty * m.delta * m.spot;
      u.deltaExposure += de;
      deltaNet += de;
      deltaGross += Math.abs(de);
    } else deltaUnavailable += 1;
    by.set(m.underlying, u);
  }
  return {
    grossNotional: R(long + short),
    netNotional: R(long - short),
    longNotional: R(long),
    shortNotional: R(short),
    deltaAdjusted: { net: R(deltaNet), gross: R(deltaGross), legsWithoutDelta: deltaUnavailable },
    byUnderlying: [...by.values()]
      .map((u) => ({ underlying: u.underlying, sector: u.sector, spot: R(u.spot), positions: u.positions, longNotional: R(u.longNotional), shortNotional: R(u.shortNotional), grossNotional: R(u.longNotional + u.shortNotional), netNotional: R(u.longNotional - u.shortNotional), deltaExposure: R(u.deltaExposure) }))
      .sort((a, b) => b.grossNotional - a.grossNotional),
    units: "Notional is |quantity| x underlying price (futures and cash: the leg's price); delta-adjusted is quantity x delta x underlying price, in INR.",
  };
}

export function concentrationOf(models, topN = 5) {
  const gross = models.reduce((t, m) => t + Math.abs(m.qty * m.spot), 0);
  if (!(gross > 0)) return { grossNotional: 0, basis: "gross notional", topPositions: [], byUnderlying: [], bySector: [], hhi: null, hhi10000: null, hhiPositions: null, effectiveUnderlyings: null, note: "No open positions with a price." };
  const pos = new Map();
  const und = new Map();
  const sec = new Map();
  for (const m of models) {
    const n = Math.abs(m.qty * m.spot);
    pos.set(m.symbol, (pos.get(m.symbol) ?? 0) + n);
    und.set(m.underlying, (und.get(m.underlying) ?? 0) + n);
    sec.set(m.sector, (sec.get(m.sector) ?? 0) + n);
  }
  const share = (map, key) => [...map.entries()].map(([k, n]) => ({ [key]: k, notional: R(n), weight: R(n / gross, 4) })).sort((a, b) => b.notional - a.notional);
  const hhi = [...und.values()].reduce((t, n) => t + (n / gross) ** 2, 0);
  const hhiPos = [...pos.values()].reduce((t, n) => t + (n / gross) ** 2, 0);
  return {
    grossNotional: R(gross),
    basis: "gross notional",
    topPositions: share(pos, "symbol").slice(0, topN),
    byUnderlying: share(und, "underlying"),
    bySector: share(sec, "sector"),
    hhi: R(hhi, 4),
    hhi10000: R(hhi * 10_000, 0),
    hhiPositions: R(hhiPos, 4),
    effectiveUnderlyings: R(1 / hhi, 2),
    note: "HHI is the sum of squared underlying weights (1 = one underlying, 1/N = even across N). Sectors come from a small static map; unmapped names are Unclassified.",
  };
}

// ───────────────────────────── VaR ─────────────────────────────

/**
 * The one-day P&Ls of a historical simulation as a histogram (pure): `bins` equal-width buckets from the worst to the
 * best day, each { from, to, count }. A bounded list whatever the lookback; empty for no P&Ls.
 */
export function pnlHistogram(pnls, bins = 24) {
  const xs = (pnls ?? []).filter(Number.isFinite);
  if (!xs.length) return [];
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const n = hi > lo ? bins : 1;
  const w = hi > lo ? (hi - lo) / n : 1;
  const out = Array.from({ length: n }, (_, i) => ({ from: R(lo + i * w), to: R(i === n - 1 ? hi : lo + (i + 1) * w), count: 0 }));
  for (const x of xs) out[Math.min(n - 1, Math.floor((x - lo) / w))].count += 1;
  return out;
}

const Z = { 95: 1.6448536269514722, 99: 2.3263478740408408 };

function returnsByDate(candles) {
  const out = new Map();
  const c = (candles ?? []).filter((x) => x && x.close > 0 && Number.isFinite(x.time)).sort((a, b) => a.time - b.time);
  for (let i = 1; i < c.length; i++) out.set(istDay(c[i].time * 1000), c[i].close / c[i - 1].close - 1);
  return out;
}

function quantileSorted(sorted, p) {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * 1-day VaR and expected shortfall (positive loss numbers). `history` maps underlying -> candles.
 * Historical simulation reprices the book fully for each historical day's return (spot move only; IV and time held;
 * underlyings aligned by IST date). With too few aligned days it falls back to delta-normal.
 */
export function varOf(models, history, { confidence = 95, rate = DEFAULT_RATE, method = "auto" } = {}) {
  const live = models.filter((m) => m.modelled);
  const warnings = [];
  const rets = new Map();
  const unmodelled = [];
  for (const u of new Set(live.map((m) => m.underlying))) {
    const r = returnsByDate(history[u]);
    if (r.size >= MIN_RETURNS) rets.set(u, r);
    else unmodelled.push(u);
  }
  if (unmodelled.length) warnings.push(`No usable daily history (at least ${MIN_RETURNS} returns) for ${unmodelled.join(", ")}; left out of VaR.`);
  const skippedLegs = models.length - live.length;
  if (skippedLegs) warnings.push(`${skippedLegs} option leg(s) without a usable IV were left out.`);
  const included = live.filter((m) => rets.has(m.underlying));
  const base = { confidence, horizonDays: 1, label: "Estimate only: a statistical loss figure from past daily moves, not a guaranteed limit.", unmodelledUnderlyings: unmodelled, warnings };
  if (!included.length) return { ...base, method: null, var: null, expectedShortfall: null, observations: 0, deltaNormal: null, reason: "No underlying has enough daily history." };

  const unds = [...rets.keys()].filter((u) => included.some((m) => m.underlying === u));
  let dates = [...rets.get(unds[0]).keys()];
  for (const u of unds.slice(1)) dates = dates.filter((d) => rets.get(u).has(d));
  dates.sort();

  // Delta-normal (also reported beside the historical figure as a cross-check).
  const expo = Object.fromEntries(unds.map((u) => [u, included.filter((m) => m.underlying === u).reduce((t, m) => t + nz(m.qty * m.delta * m.spot), 0)]));
  const cov = (a, b) => {
    const ra = rets.get(a);
    const rb = rets.get(b);
    let s = 0;
    let n = 0;
    for (const [d, x] of ra) {
      if (rb.has(d)) {
        s += x * rb.get(d);
        n++;
      }
    }
    return n >= MIN_RETURNS ? s / n : null;
  };
  let variance = 0;
  for (const a of unds) for (const b of unds) variance += expo[a] * expo[b] * (cov(a, b) ?? 0);
  const sigma = Math.sqrt(Math.max(0, variance));
  const z = Z[confidence];
  const dn = Number.isFinite(sigma) ? { var: R(Math.max(0, z * sigma)), expectedShortfall: R((sigma * normPDF(z)) / (1 - confidence / 100)), portfolioSigma1d: R(sigma), basis: "delta exposure x past daily return covariance, zero mean" } : null;

  const wantHist = method !== "delta-normal" && dates.length >= MIN_OBS;
  if (!wantHist) {
    if (method === "historical") warnings.push(`Only ${dates.length} aligned days of history (need ${MIN_OBS}); historical simulation was not possible.`);
    return { ...base, method: "delta-normal", var: dn?.var ?? null, expectedShortfall: dn?.expectedShortfall ?? null, observations: dates.length, deltaNormal: dn, note: method === "delta-normal" ? "Delta-normal was requested." : `Fell back to delta-normal: only ${dates.length} aligned days of history.` };
  }
  const pnls = dates.map((d) => {
    let p = 0;
    for (const m of included) p += nz(legPnl(m, rate, rets.get(m.underlying).get(d) * 100, 0, 0));
    return p;
  });
  const sorted = [...pnls].sort((a, b) => a - b);
  const p = 1 - confidence / 100;
  const q = quantileSorted(sorted, p);
  const k = Math.max(1, Math.ceil(sorted.length * p - 1e-9));
  const es = -(sorted.slice(0, k).reduce((t, x) => t + x, 0) / k);
  const v = Math.max(0, -q);
  return { ...base, method: "historical-simulation", var: R(v), expectedShortfall: R(Math.max(es, v)), observations: dates.length, period: { from: dates[0], to: dates.at(-1) }, worstDayPnl: R(sorted[0]), bestDayPnl: R(sorted.at(-1)), distribution: pnlHistogram(sorted), deltaNormal: dn, assumptions: "Full Black-Scholes reprice for each past daily return of the underlyings, spot only (IV and time held), underlyings aligned by IST date." };
}

// ───────────────────────────── request schemas ─────────────────────────────

const posSchema = z.strictObject({
  symbol: z.string().min(1).max(64),
  netQty: z.number().int().min(-1_000_000_000).max(1_000_000_000).refine((n) => n !== 0, "netQty must not be 0"),
  price: z.number().positive().max(1e9).optional(),
  spot: z.number().positive().max(1e9).optional(),
  ivPct: z.number().positive().max(500).optional(),
});

const uniqNums = (a) => [...new Set(a)].sort((x, y) => x - y);
const shocks = (lo, hi, def) => z.array(z.number().min(lo).max(hi)).min(1).max(41).default(def).transform(uniqNums);
const scenarioBody = z.strictObject({
  account: z.string().regex(ACCOUNT_RE).optional(),
  mode: z.enum(["paper", "live"]).optional(),
  positions: z.array(posSchema).min(1).max(MAX_LEGS).optional(),
  spotShocksPct: shocks(-99, 100, [-5, -2.5, 0, 2.5, 5]),
  ivShocksPts: shocks(-100, 100, [-5, 0, 5]),
  daysForward: shocks(0, 365, [0, 1, 3]),
  maxCells: z.number().int().min(1).max(MAX_CELLS).default(MAX_CELLS),
  ratePct: z.number().min(0).max(100).optional(),
});
const orderLeg = z.strictObject({
  symbol: z.string().min(1).max(64),
  side: z.string().transform((s) => s.toUpperCase()).pipe(z.enum(["BUY", "SELL"])),
  quantity: z.number().int().min(1).max(1_000_000_000),
  price: z.number().positive().max(1e9).optional(),
  spot: z.number().positive().max(1e9).optional(),
  ivPct: z.number().positive().max(500).optional(),
});
const whatifBody = z.strictObject({
  account: z.string().regex(ACCOUNT_RE),
  mode: z.enum(["paper", "live"]).optional(),
  add: z.array(orderLeg).min(1).max(20),
  days: z.number().int().min(30).max(1000).default(250),
  confidence: z.union([z.literal(95), z.literal(99)]).default(95),
  topN: z.number().int().min(1).max(20).default(5),
  ratePct: z.number().min(0).max(100).optional(),
});

function qInt(q, name, min, max, dflt) {
  const v = q.get(name);
  if (v === null || v === "") return dflt;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw invalid(name, `${name} must be a whole number from ${min} to ${max}.`);
  return Number(v);
}
function qAccount(ctx) {
  const a = ctx.query.get("account");
  if (!a) throw invalid("account", "account is required: the account id from your config, such as dhan-main.");
  if (!ACCOUNT_RE.test(a)) throw invalid("account", "account is not a valid account id.");
  return a;
}
function qMode(ctx) {
  const m = ctx.query.get("mode") || undefined;
  if (m !== undefined && m !== "paper" && m !== "live") throw invalid("mode", "mode must be paper or live.");
  return m;
}
const rateOf = (pct) => (pct === undefined ? DEFAULT_RATE : pct / 100);

/** @param {object} deps full deps passed to register() */
export function riskRoutes(deps) {
  const md = () => deps.marketData;
  const baseOpts = (ctx, account) => {
    const o = readOptionsBase(ctx, { autoBackup: autoBackupFor(deps) });
    return pinMarketRead(o, deps.config, account, autoBackupFor(deps));
  };
  const errLine = (e, extra = {}) => ({ ...extra, code: e?.code ?? "UPSTREAM_ERROR", message: String(e?.message ?? e).slice(0, 200) });

  /**
   * Resolve raw legs [{ symbol, qty, price?, fallbackPrice?, spot?, ivPct? }] into priced legs.
   * Anything given explicitly is used as is; the rest comes from option chains and ltp (bounded).
   */
  async function resolveLegs(raws, opts, nowMs) {
    const legs = [];
    const skipped = [];
    const errors = [];
    const parsed = [];
    for (const r of raws) {
      try {
        parsed.push({ r, p: parseSymbol(r.symbol) });
      } catch {
        skipped.push({ symbol: r.symbol, reason: "symbol is not a Bridge symbol" });
      }
    }
    const chainKeys = new Map();
    const ltpSyms = new Set();
    for (const { r, p } of parsed) {
      if (p.kind === "OPT" && !(r.spot > 0 && r.price > 0)) chainKeys.set(`${p.underlying}|${p.expiry}`, { underlying: p.underlying, expiry: p.expiry });
      else if (p.kind !== "OPT" && !(r.price > 0) && !(r.fallbackPrice > 0)) ltpSyms.add(p.canonical);
    }
    const chains = new Map();
    let freshness;
    let n = 0;
    for (const [key, w] of chainKeys) {
      if (++n > MAX_CHAINS) {
        errors.push({ underlying: w.underlying, expiry: w.expiry, code: "VALIDATION_FAILED", message: `More than ${MAX_CHAINS} distinct expiries; this one was not read.` });
        continue;
      }
      try {
        const c = await md().optionChain({ underlying: w.underlying, expiry: w.expiry, greeks: true }, opts);
        chains.set(key, c);
        freshness ??= c.freshness;
      } catch (e) {
        errors.push(errLine(e, { underlying: w.underlying, expiry: w.expiry }));
      }
    }
    const ltps = new Map();
    if (ltpSyms.size) {
      try {
        const res = await md().ltp([...ltpSyms].slice(0, 100), opts);
        for (const it of res.items ?? []) if (it.ltp > 0) ltps.set(it.symbol, it.ltp);
        for (const e of res.errors ?? []) errors.push(errLine(e, { symbol: e.symbol }));
        freshness ??= res.items?.[0]?.freshness;
      } catch (e) {
        errors.push(errLine(e));
      }
    }
    for (const { r, p } of parsed) {
      const qty = r.qty;
      const dte = p.expiry ? (expiryCutoffMs(p.expiry) - nowMs) / DAY_MS : null;
      if (p.expiry && !(dte > 0)) {
        skipped.push({ symbol: p.canonical, reason: "expired" });
        continue;
      }
      if (p.kind === "OPT") {
        const chain = chains.get(`${p.underlying}|${p.expiry}`);
        const row = chain?.rows?.find((x) => x.strike === p.strike);
        const cl = row ? (p.right === "CE" ? row.ce : row.pe) : null;
        const spot = r.spot > 0 ? r.spot : chain?.underlyingLtp > 0 ? chain.underlyingLtp : null;
        const price = r.price > 0 ? r.price : cl?.ltp > 0 ? cl.ltp : r.fallbackPrice > 0 ? r.fallbackPrice : null;
        if (!(spot > 0)) {
          skipped.push({ symbol: p.canonical, reason: "no underlying price" });
          continue;
        }
        let iv = r.ivPct > 0 ? r.ivPct / 100 : cl?.iv > 0 ? cl.iv / 100 : null;
        if (iv === null && price > 0) {
          const g = computeIVAndGreeks({ ltp: price, spot, strike: p.strike, daysToExpiry: dte, type: p.right });
          iv = g.iv > 0 ? g.iv / 100 : null;
        }
        legs.push({ symbol: p.canonical, exchange: p.exchange, underlying: p.underlying, kind: "OPT", right: p.right, strike: p.strike, expiry: p.expiry, dte, qty, spot, price, iv });
      } else {
        const price = r.price > 0 ? r.price : ltps.get(p.canonical) ?? (r.fallbackPrice > 0 ? r.fallbackPrice : null);
        if (!(price > 0)) {
          skipped.push({ symbol: p.canonical, reason: "no price" });
          continue;
        }
        legs.push({ symbol: p.canonical, exchange: p.exchange, underlying: p.underlying, kind: p.kind, right: null, strike: null, expiry: p.expiry, dte, qty, spot: price, price, iv: null });
      }
    }
    return { legs, skipped, errors, freshness };
  }

  async function accountRaws(ctx, account, mode, includeHoldings) {
    ctx.requireAccountAccess(account);
    const r = await deps.orders.positions(ctx, account, mode ? { mode } : {});
    const raws = (r.items ?? []).filter((p) => p && Number.isFinite(p.netQty) && p.netQty !== 0).map((p) => ({ symbol: p.symbol, qty: p.netQty, fallbackPrice: p.ltp > 0 ? p.ltp : undefined }));
    const notes = [];
    if (includeHoldings) {
      try {
        const h = await deps.orders.holdings(ctx, account);
        for (const x of h.items ?? []) if (x && x.qty > 0) raws.push({ symbol: x.symbol, qty: x.qty, fallbackPrice: x.ltp > 0 ? x.ltp : undefined });
      } catch (e) {
        notes.push(`Holdings were not included: ${String(e?.code ?? "unavailable")}.`);
      }
    }
    if (raws.length > MAX_LEGS) {
      notes.push(`Only the first ${MAX_LEGS} of ${raws.length} positions were used.`);
      raws.length = MAX_LEGS;
    }
    return { raws, freshness: r.freshness ?? null, notes };
  }

  async function loadBook(ctx, account, mode, rate, includeHoldings = false) {
    const { raws, freshness, notes } = await accountRaws(ctx, account, mode, includeHoldings);
    const res = await resolveLegs(raws, baseOpts(ctx, account), nowMsOf(deps));
    return { ...res, models: res.legs.map((l) => modelLeg(l, rate)), positionsFreshness: freshness, notes };
  }

  async function readFunds(ctx, account, mode) {
    try {
      const r = await deps.orders.funds(ctx, account, mode ? { mode } : {});
      const f = r?.funds ?? null;
      if (!f) return { funds: null, note: "The broker returned no funds." };
      const keep = {};
      for (const k of ["availableCash", "usedMargin", "totalBalance", "collateral", "withdrawable", "realisedPnl", "unrealisedPnl"]) keep[k] = Number.isFinite(f[k]) ? f[k] : null;
      return { funds: keep, note: null };
    } catch (e) {
      return { funds: null, note: `Funds and margin are not available for this account (${String(e?.code ?? "error")}); nothing is estimated.` };
    }
  }

  async function fetchHistory(ctx, models, days, account) {
    const seen = new Map();
    for (const m of models) {
      if (seen.has(m.underlying)) continue;
      const cash = m.exchange === "BFO" ? "BSE" : m.exchange === "NFO" ? "NSE" : m.exchange;
      seen.set(m.underlying, m.kind === "OPT" || m.kind === "FUT" ? `${cash}:${m.underlying}` : m.symbol);
    }
    const history = {};
    const errors = [];
    const opts = pinMarketRead(readOptionsBase(ctx, { maxAge: false, autoBackup: autoBackupFor(deps) }), deps.config, account, autoBackupFor(deps));
    let n = 0;
    for (const [u, symbol] of seen) {
      if (++n > MAX_UNDERLYINGS) {
        errors.push({ underlying: u, code: "VALIDATION_FAILED", message: `More than ${MAX_UNDERLYINGS} underlyings; ${u} has no history.` });
        continue;
      }
      try {
        const h = await md().history({ symbol, interval: "1d", countback: days + 1 }, opts);
        history[u] = h.candles ?? [];
      } catch (e) {
        errors.push(errLine(e, { underlying: u }));
      }
    }
    return { history, errors };
  }

  const meta = (ctx, account, book) => ({ requestId: ctx.requestId, accountId: account ?? null, ...(book?.positionsFreshness ? { positionsFreshness: book.positionsFreshness } : {}), ...(book?.freshness ? { freshness: book.freshness } : {}) });
  const reply = (data, metaObj, ...lists) => {
    const e = lists.flat().filter(Boolean);
    return e.length ? { data, errors: e, meta: metaObj } : { data, meta: metaObj };
  };

  // ── POST /risk/scenario ──
  const scenario = guarded(async (ctx) => {
    const b = parseBody(scenarioBody, ctx.body);
    if ((b.account === undefined) === (b.positions === undefined)) throw invalid("account", "Send exactly one of account (read the book) or positions (explicit legs).");
    const cellCount = b.spotShocksPct.length * b.ivShocksPts.length * b.daysForward.length;
    if (cellCount > b.maxCells) throw invalid("maxCells", `That grid has ${cellCount} cells; the limit is ${b.maxCells}. Send fewer shocks.`);
    const rate = rateOf(b.ratePct);
    let book;
    if (b.account) {
      book = await loadBook(ctx, b.account, b.mode, rate);
    } else {
      const res = await resolveLegs(b.positions.map((p) => ({ symbol: p.symbol, qty: p.netQty, price: p.price, spot: p.spot, ivPct: p.ivPct })), baseOpts(ctx, undefined), nowMsOf(deps));
      book = { ...res, models: res.legs.map((l) => modelLeg(l, rate)), notes: [] };
    }
    const noIv = book.models.filter((m) => !m.modelled).map((m) => ({ symbol: m.symbol, reason: "no usable IV or price" }));
    const grid = scenarioGrid(book.models, { spotShocksPct: b.spotShocksPct, ivShocksPts: b.ivShocksPts, daysForward: b.daysForward, rate });
    const data = {
      asOf: new Date(nowMsOf(deps)).toISOString(),
      ratePct: R(rate * 100, 3),
      grid: { spotShocksPct: b.spotShocksPct, ivShocksPts: b.ivShocksPts, daysForward: b.daysForward },
      ...grid,
      skipped: [...book.skipped, ...noIv],
      notes: [...book.notes, "P&L is against the Black-Scholes model price at the current spot, IV and time, so the (0, 0, 0) cell is 0. Shocks are parallel across underlyings; IV shocks are absolute vol points; futures and cash legs move one for one with spot.", "taylorError is the delta-gamma-vega-theta approximation minus the full reprice."],
    };
    return reply(data, meta(ctx, b.account, book), book.errors);
  });

  // ── GET /risk/exposure ──
  const exposure = guarded(async (ctx) => {
    const account = qAccount(ctx);
    const mode = qMode(ctx);
    const book = await loadBook(ctx, account, mode, DEFAULT_RATE, ctx.query.get("includeHoldings") === "true");
    const f = await readFunds(ctx, account, mode);
    const data = { ...exposureOf(book.models), funds: f.funds, fundsNote: f.note, marginUtilisationPct: null, grossLeverage: null };
    if (f.funds) {
      const { usedMargin: used, availableCash: avail, totalBalance: total } = f.funds;
      if (Number.isFinite(used) && Number.isFinite(avail) && used + avail > 0) data.marginUtilisationPct = R((used / (used + avail)) * 100, 2);
      if (Number.isFinite(total) && total > 0) data.grossLeverage = R(data.grossNotional / total, 2);
    }
    data.marginNote = "Margin and funds are exactly what the account reports; the Bridge does not compute SPAN or exposure margin.";
    data.skipped = book.skipped;
    data.notes = book.notes;
    return reply(data, meta(ctx, account, book), book.errors);
  });

  // ── GET /risk/concentration ──
  const concentration = guarded(async (ctx) => {
    const account = qAccount(ctx);
    const topN = qInt(ctx.query, "top", 1, 20, 5);
    const book = await loadBook(ctx, account, qMode(ctx), DEFAULT_RATE, ctx.query.get("includeHoldings") === "true");
    return reply({ ...concentrationOf(book.models, topN), skipped: book.skipped, notes: book.notes }, meta(ctx, account, book), book.errors);
  });

  // ── GET /risk/var ──
  const varRoute = guarded(async (ctx) => {
    const account = qAccount(ctx);
    const days = qInt(ctx.query, "days", 30, 1000, 250);
    const confidence = qInt(ctx.query, "confidence", 95, 99, 95);
    if (confidence !== 95 && confidence !== 99) throw invalid("confidence", "confidence must be 95 or 99.");
    const method = ctx.query.get("method") || "auto";
    if (!["auto", "historical", "delta-normal"].includes(method)) throw invalid("method", "method must be auto, historical or delta-normal.");
    const book = await loadBook(ctx, account, qMode(ctx), DEFAULT_RATE);
    const h = await fetchHistory(ctx, book.models, days, account);
    const v = varOf(book.models, h.history, { confidence, method });
    const gross = exposureOf(book.models).grossNotional;
    const data = { ...v, lookbackDays: days, grossNotional: gross, varPctOfGross: gross > 0 && v.var !== null ? R((v.var / gross) * 100, 3) : null, skipped: book.skipped, notes: book.notes };
    return reply(data, meta(ctx, account, book), book.errors, h.errors);
  });

  // ── POST /risk/whatif ──
  const whatif = guarded(async (ctx) => {
    const b = parseBody(whatifBody, ctx.body);
    const rate = rateOf(b.ratePct);
    const book = await loadBook(ctx, b.account, b.mode, rate);
    const added = await resolveLegs(b.add.map((a) => ({ symbol: a.symbol, qty: a.side === "BUY" ? a.quantity : -a.quantity, price: a.price, spot: a.spot, ivPct: a.ivPct })), baseOpts(ctx, b.account), nowMsOf(deps));
    const addModels = added.legs.map((l) => modelLeg(l, rate));
    const merged = new Map();
    for (const m of [...book.models, ...addModels]) {
      const prev = merged.get(m.symbol);
      if (prev === undefined) merged.set(m.symbol, m);
      else if (prev === null) merged.set(m.symbol, m);
      else {
        // netted legs keep the existing mark; a position netted to zero drops out
        const qty = prev.qty + m.qty;
        merged.set(m.symbol, qty === 0 ? null : modelLeg({ ...prev, qty }, rate));
      }
    }
    const after = [...merged.values()].filter(Boolean);
    const h = await fetchHistory(ctx, [...book.models, ...addModels], b.days, b.account);
    const snap = (models) => ({ exposure: exposureOf(models), concentration: concentrationOf(models, b.topN), var: varOf(models, h.history, { confidence: b.confidence, rate }) });
    const before = snap(book.models);
    const post = snap(after);
    const d = (a, c) => (Number.isFinite(a) && Number.isFinite(c) ? R(c - a, 4) : null);
    const f = await readFunds(ctx, b.account, b.mode);
    const data = {
      planOnly: true,
      note: "Nothing was sent. This is a what-if on the current book; place any order through POST /v1/orders where every safety gate still applies.",
      added: added.legs.map((l) => ({ symbol: l.symbol, netQty: l.qty, spot: R(l.spot), price: R(l.price), ivPct: l.iv ? R(l.iv * 100, 2) : null })),
      skipped: added.skipped,
      before,
      after: post,
      change: {
        grossNotional: d(before.exposure.grossNotional, post.exposure.grossNotional),
        netNotional: d(before.exposure.netNotional, post.exposure.netNotional),
        deltaExposureNet: d(before.exposure.deltaAdjusted.net, post.exposure.deltaAdjusted.net),
        hhi: d(before.concentration.hhi, post.concentration.hhi),
        var: d(before.var.var, post.var.var),
        expectedShortfall: d(before.var.expectedShortfall, post.var.expectedShortfall),
      },
      margin: { fundsNow: f.funds, requiredForAdd: null, note: "Margin for the added legs is not computed: the adapters expose funds and used margin, not a margin calculator. Check the broker's own margin tool." },
    };
    return reply(data, meta(ctx, b.account, book), book.errors, added.errors, h.errors);
  });

  // ── GET /risk/tca ──
  const tca = guarded(async (ctx) => {
    const account = qAccount(ctx);
    ctx.requireAccountAccess(account);
    const limit = qInt(ctx.query, "limit", 1, 500, 200);
    const [tr, od] = await Promise.all([deps.orders.trades(ctx, { accountId: account, mode: "paper", limit }), deps.orders.list(ctx, { accountId: account, mode: "paper", limit: 500 })]);
    const orders = new Map((od.items ?? []).map((o) => [o.orderId, o]));
    const fills = [];
    for (const t of tr.items ?? []) {
      if (!t || !(t.price > 0) || !(t.qty > 0)) continue;
      const o = orders.get(t.orderId) ?? null;
      const side = t.side === "SELL" ? -1 : 1;
      const limitRef = o && o.orderType === "LIMIT" && o.price > 0 ? o.price : null;
      const slipInr = limitRef === null ? null : side * (t.price - limitRef);
      const placed = o?.placedAt ? Date.parse(o.placedAt) : NaN;
      const traded = t.tradedAt ? Date.parse(t.tradedAt) : NaN;
      const notional = t.price * t.qty;
      fills.push({
        tradeId: t.tradeId, orderId: t.orderId, symbol: t.symbol, side: t.side, qty: t.qty, price: t.price, notional: R(notional),
        orderType: o?.orderType ?? null, referencePrice: limitRef, referenceKind: limitRef === null ? null : "limit",
        slippageInr: R(slipInr, 4), slippageBps: limitRef === null ? null : R((slipInr / limitRef) * 1e4, 3),
        charges: Number.isFinite(t.charges) ? t.charges : null, chargesBps: Number.isFinite(t.charges) ? R((t.charges / notional) * 1e4, 3) : null,
        latencyMs: Number.isFinite(placed) && Number.isFinite(traded) ? Math.max(0, traded - placed) : null,
      });
    }
    const avg = (xs) => (xs.length ? R(xs.reduce((a, c) => a + c, 0) / xs.length, 3) : null);
    const lat = fills.map((f) => f.latencyMs).filter(Number.isFinite).sort((a, c) => a - c);
    const slipW = fills.filter((f) => f.slippageBps !== null);
    const chargeFills = fills.filter((f) => f.charges !== null);
    const notionalAll = fills.reduce((t, f) => t + f.notional, 0);
    const chargeNotional = chargeFills.reduce((t, f) => t + f.notional, 0);
    const chargeSum = chargeFills.reduce((t, f) => t + f.charges, 0);
    const data = {
      account,
      fillCount: fills.length,
      truncated: Boolean(tr.nextCursor),
      totals: { notional: R(notionalAll), charges: chargeFills.length ? R(chargeSum) : null, chargesBps: chargeNotional > 0 ? R((chargeSum / chargeNotional) * 1e4, 3) : null },
      slippage: { measuredFills: slipW.length, vs: "limit price of the order (the only reference the paper store keeps)", avgBps: avg(slipW.map((f) => f.slippageBps)), worstBps: slipW.length ? Math.max(...slipW.map((f) => f.slippageBps)) : null, note: "Positive means worse than the reference: a buy above it or a sell below it. Market orders have no reference and are not measured." },
      latencyMs: { measuredFills: lat.length, avg: avg(lat), median: lat.length ? lat[Math.floor((lat.length - 1) / 2)] : null, p95: lat.length ? lat[Math.min(lat.length - 1, Math.ceil(lat.length * 0.95) - 1)] : null, note: "Fill time minus order placement time; the paper engine fills inside its own tick, so this reflects the engine, not an exchange." },
      unavailable: [
        "arrivalPrice: the paper store does not record the market price when the order arrived, so slippage versus arrival is not computed",
        "bid, ask or depth at order or fill time",
        "price after the fill (no reversion or impact measure)",
        "charges breakdown: only a single brokerage figure per trade, no statutory taxes or exchange fees",
        "partial fills, queue position and market impact (the paper engine fills whole orders)",
      ],
      fills,
    };
    return { data, meta: { requestId: ctx.requestId, accountId: account, mode: "paper" } };
  });

  return [
    ["POST", "/v1/analytics/risk/scenario", { scope: "read" }, scenario],
    ["GET", "/v1/analytics/risk/exposure", { scope: "read" }, exposure],
    ["GET", "/v1/analytics/risk/concentration", { scope: "read" }, concentration],
    ["GET", "/v1/analytics/risk/var", { scope: "read" }, varRoute],
    ["POST", "/v1/analytics/risk/whatif", { scope: "read" }, whatif],
    ["GET", "/v1/analytics/risk/tca", { scope: "read" }, tca],
  ];
}
