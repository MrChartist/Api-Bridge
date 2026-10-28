/**
 * Option Desk maths: what a trader reads off a chain at a glance (PCR, max pain, OI walls, the ATM straddle) and
 * the small helpers the order ticket needs. Pure (no DOM, no fetch) so it runs in Node tests; numbers are formatted
 * by format.js, never here.
 *
 * A chain is GET /v1/optionchain's data: { underlying, expiry, underlyingLtp, atmStrike, lotSize,
 * rows: [{ strike, ce: { ltp, bid, ask, oi, oiChange, volume, iv, delta, ... } | null, pe: {...} | null }] }.
 */

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const sum = (rows, pick) => rows.reduce((a, r) => a + (num(pick(r)) ?? 0), 0);

/** The row whose strike is closest to `price` (the chain's own atmStrike when it has one). */
export function atmRow(chain) {
  const rows = chain?.rows ?? [];
  if (!rows.length) return null;
  const atm = num(chain.atmStrike);
  if (atm !== null) {
    const exact = rows.find((r) => r.strike === atm);
    if (exact) return exact;
  }
  const spot = num(chain.underlyingLtp);
  if (spot === null) return rows[Math.floor(rows.length / 2)];
  return rows.reduce((best, r) => (Math.abs(r.strike - spot) < Math.abs(best.strike - spot) ? r : best));
}

/**
 * Max pain: the expiry price at which option buyers, all strikes together, would collect the least (writers pay
 * the least). Only the strikes in `rows` count, so ask for a wide chain.
 */
export function maxPain(rows) {
  let best = null;
  for (const k of rows) {
    let pain = 0;
    for (const r of rows) {
      pain += (num(r.ce?.oi) ?? 0) * Math.max(0, k.strike - r.strike);
      pain += (num(r.pe?.oi) ?? 0) * Math.max(0, r.strike - k.strike);
    }
    if (best === null || pain < best.pain) best = { strike: k.strike, pain };
  }
  return best?.strike ?? null;
}

/** The strike with the most open interest on one side ("ce" = resistance, "pe" = support); null without OI. */
export function oiWall(rows, side) {
  let best = null;
  for (const r of rows) {
    const oi = num(r[side]?.oi);
    if (oi !== null && oi > 0 && (best === null || oi > best.oi)) best = { strike: r.strike, oi };
  }
  return best;
}

/**
 * Everything the summary strip shows, from the whole chain the Bridge returned.
 * @returns {{ spot: number|null, atm: number|null, straddle: number|null, upper: number|null, lower: number|null,
 *   atmIv: number|null, pcr: number|null, pcrVolume: number|null, pcrChange: number|null, ceOi: number, peOi: number,
 *   ceOiChange: number, peOiChange: number, ceVolume: number, peVolume: number, maxPain: number|null,
 *   resistance: {strike:number, oi:number}|null, support: {strike:number, oi:number}|null, maxOi: number,
 *   maxOiChange: number }}
 */
export function chainSummary(chain) {
  const rows = chain?.rows ?? [];
  const spot = num(chain?.underlyingLtp);
  const atm = atmRow(chain);
  const ceLtp = num(atm?.ce?.ltp);
  const peLtp = num(atm?.pe?.ltp);
  const straddle = ceLtp !== null && peLtp !== null ? ceLtp + peLtp : null;
  const ivs = [num(atm?.ce?.iv), num(atm?.pe?.iv)].filter((v) => v !== null && v > 0);
  const ceOi = sum(rows, (r) => r.ce?.oi);
  const peOi = sum(rows, (r) => r.pe?.oi);
  const ceVol = sum(rows, (r) => r.ce?.volume);
  const peVol = sum(rows, (r) => r.pe?.volume);
  const maxOi = rows.reduce((m, r) => Math.max(m, num(r.ce?.oi) ?? 0, num(r.pe?.oi) ?? 0), 0);
  return {
    spot,
    atm: atm?.strike ?? null,
    straddle,
    upper: straddle !== null && atm ? atm.strike + straddle : null,
    lower: straddle !== null && atm ? atm.strike - straddle : null,
    atmIv: ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null,
    pcr: ceOi > 0 ? peOi / ceOi : null,
    pcrVolume: ceVol > 0 ? peVol / ceVol : null,
    ceOi,
    peOi,
    ceOiChange: sum(rows, (r) => r.ce?.oiChange),
    peOiChange: sum(rows, (r) => r.pe?.oiChange),
    maxPain: maxPain(rows),
    resistance: oiWall(rows, "ce"),
    support: oiWall(rows, "pe"),
    maxOi,
    maxOiChange: rows.reduce((m, r) => Math.max(m, Math.abs(num(r.ce?.oiChange) ?? 0), Math.abs(num(r.pe?.oiChange) ?? 0)), 0),
    ceVolume: ceVol,
    peVolume: peVol,
    pcrChange: (() => {
      const c = sum(rows, (r) => r.ce?.oiChange);
      const p = sum(rows, (r) => r.pe?.oiChange);
      return c > 0 && p > 0 ? p / c : null;
    })(),
  };
}

/** `count` strikes either side of the ATM strike (all rows when there are fewer). */
export function rowsAroundAtm(chain, count) {
  const rows = chain?.rows ?? [];
  const atm = atmRow(chain);
  if (!atm) return [];
  const i = rows.indexOf(atm);
  return rows.slice(Math.max(0, i - count), i + count + 1);
}

/** Whether a strike is in the money for calls ("ce") or puts ("pe") at this spot. */
export const inTheMoney = (strike, side, spot) => (num(spot) === null ? false : side === "ce" ? strike < spot : strike > spot);

/**
 * Round a price to the instrument's tick (0.05 for NSE / BSE options) without float drift. "buy" rounds up and
 * "sell" down so a limit order at the touch is not pushed away from it; anything else rounds to the nearest tick.
 */
export function roundToTick(price, tick = 0.05, direction) {
  const p = num(price);
  const t = num(tick) && num(tick) > 0 ? num(tick) : 0.05;
  if (p === null) return null;
  const steps = p / t;
  const n = direction === "buy" ? Math.ceil(steps - 1e-9) : direction === "sell" ? Math.floor(steps + 1e-9) : Math.round(steps);
  return Math.round(n * t * 100) / 100;
}

/**
 * The price a ticket starts at: the ask to buy, the bid to sell (the touch), else the last price.
 * @param {{ bid?: number, ask?: number, ltp?: number } | null} quote
 * @param {"BUY"|"SELL"} side
 */
export function touchPrice(quote, side, tick = 0.05) {
  const p = side === "BUY" ? (num(quote?.ask) || num(quote?.ltp)) : (num(quote?.bid) || num(quote?.ltp));
  return roundToTick(p, tick, side === "BUY" ? "buy" : "sell");
}

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
/**
 * Time left to an expiry (YYYY-MM-DD, settling at 15:30 IST). `days` is fractional; `label` reads "Expires today",
 * "1 day", "6 days" or "Expired".
 */
export function timeToExpiry(expiry, now = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(expiry ?? ""));
  if (!m) return { days: null, label: "" };
  const close = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 15, 30) - IST_OFFSET_MS;
  const ms = close - now;
  if (ms <= 0) return { days: 0, label: "Expired" };
  const istDay = (t) => Math.floor((t + IST_OFFSET_MS) / 86400000);
  const calendarDays = istDay(close) - istDay(now);
  return { days: ms / 86400000, label: calendarDays === 0 ? "Expires today" : calendarDays === 1 ? "1 day" : `${calendarDays} days` };
}

/** Option positions on one underlying, from GET /v1/positions rows ("NFO:NIFTY-2026-11-03-26400-CE"). */
export function positionsFor(positions, underlying) {
  const u = String(underlying ?? "").toUpperCase();
  const re = new RegExp(`^(NFO|BFO):${u.replace(/[^A-Z0-9&]/g, "")}-\\d{4}-\\d{2}-\\d{2}-[\\d.]+-(CE|PE)$`);
  return (positions ?? []).filter((p) => re.test(String(p.symbol ?? "")));
}

/** "NFO:NIFTY-2026-11-03-26400-CE" → { strike: 26400, right: "CE", expiry: "2026-11-03" } (null when not an option). */
export function parseOptionSymbol(symbol) {
  const m = /^(?:NFO|BFO):(.+)-(\d{4}-\d{2}-\d{2})-([\d.]+)-(CE|PE)$/.exec(String(symbol ?? ""));
  return m ? { underlying: m[1], expiry: m[2], strike: Number(m[3]), right: m[4] } : null;
}

// ── Per-leg reads ──

/**
 * OI build-up from a leg's price change and OI change: LB long build-up (price up, OI up), SB short build-up (down,
 * up), SC short covering (up, down), LU long unwinding (down, down). Null when either change is missing or zero.
 */
export function buildup(leg) {
  const p = num(leg?.change);
  const oi = num(leg?.oiChange);
  if (p === null || oi === null || p === 0 || oi === 0) return null;
  if (oi > 0) return p > 0 ? "LB" : "SB";
  return p > 0 ? "SC" : "LU";
}
export const BUILDUP_NAMES = Object.freeze({ LB: "Long build-up", SB: "Short build-up", SC: "Short covering", LU: "Long unwinding" });

/** Mid of a two-sided quote, else the last price. */
export function mid(leg) {
  const b = num(leg?.bid);
  const a = num(leg?.ask);
  if (b !== null && a !== null && b > 0 && a >= b) return (a + b) / 2;
  return num(leg?.ltp);
}
/** Bid-ask spread as a percent of mid (null without a two-sided quote). */
export function spreadPct(leg) {
  const b = num(leg?.bid);
  const a = num(leg?.ask);
  const m = mid(leg);
  if (b === null || a === null || b <= 0 || a < b || !m) return null;
  return ((a - b) / m) * 100;
}
/** OI change as a percent of the previous session's OI. */
export function oiChangePct(leg) {
  const oi = num(leg?.oi);
  const ch = num(leg?.oiChange);
  if (oi === null || ch === null) return null;
  const prev = oi - ch;
  return prev > 0 ? (ch / prev) * 100 : null;
}
/** Price change as a percent of the previous close. */
export function changePct(leg) {
  const c = num(leg?.close);
  const ch = num(leg?.change);
  return c && ch !== null ? (ch / c) * 100 : null;
}
/**
 * Liquidity 1-5 from the spread (55%) and the leg's volume rank on its side (45%); 0 for a dead leg.
 * @param {number} volRank 0..1 percentile of this leg's volume among its side's legs
 */
export function liquidityScore(leg, volRank) {
  const vol = num(leg?.volume) ?? 0;
  const sp = spreadPct(leg);
  if (!vol && !num(leg?.oi) && sp === null) return 0;
  const spreadScore = sp === null ? 1 : sp <= 1 ? 5 : sp <= 2.5 ? 4 : sp <= 5 ? 3 : sp <= 10 ? 2 : 1;
  const volScore = 1 + Math.round(Math.max(0, Math.min(1, volRank || 0)) * 4);
  return Math.max(1, Math.min(5, Math.round(0.55 * spreadScore + 0.45 * volScore)));
}
/** strike -> volume percentile (0..1) for one side ("ce" / "pe"). */
export function volumeRanks(rows, side) {
  const vols = rows.map((r) => num(r[side]?.volume)).filter((v) => v !== null).sort((a, b) => a - b);
  const out = new Map();
  if (!vols.length) return out;
  for (const r of rows) {
    const v = num(r[side]?.volume);
    if (v === null) continue;
    let below = 0;
    while (below < vols.length && vols[below] < v) below += 1;
    out.set(r.strike, vols.length > 1 ? below / (vols.length - 1) : 1);
  }
  return out;
}

// ── Pricing (Black-76 on the forward, r = 0: what NSE index options settle against) ──

/** Standard normal CDF (Abramowitz-Stegun 26.2.17, |error| < 7.5e-8). */
export function normCdf(x) {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
/** Black-76 price of a CE / PE; intrinsic value at or after expiry or without a volatility. */
export function black76(forward, strike, years, ivPct, right) {
  const F = num(forward);
  const K = num(strike);
  const sig = (num(ivPct) ?? 0) / 100;
  if (F === null || K === null || F <= 0 || K <= 0) return null;
  const intrinsic = right === "CE" ? Math.max(0, F - K) : Math.max(0, K - F);
  if (!(years > 0) || !(sig > 0)) return intrinsic;
  const sd = sig * Math.sqrt(years);
  const d1 = (Math.log(F / K) + (sd * sd) / 2) / sd;
  const d2 = d1 - sd;
  return right === "CE" ? F * normCdf(d1) - K * normCdf(d2) : K * normCdf(-d2) - F * normCdf(-d1);
}
/** Probability the option finishes in the money (N(d2) on the forward). */
export function probItm(forward, strike, years, ivPct, right) {
  const F = num(forward);
  const K = num(strike);
  const sig = (num(ivPct) ?? 0) / 100;
  if (F === null || K === null || F <= 0 || K <= 0 || !(years > 0) || !(sig > 0)) return null;
  const sd = sig * Math.sqrt(years);
  const d2 = (Math.log(F / K) - (sd * sd) / 2) / sd;
  return right === "CE" ? normCdf(d2) : normCdf(-d2);
}
/** P(price at expiry < x) under the same log-normal model. */
function cdfAt(x, forward, years, sig) {
  if (x <= 0) return 0;
  const sd = sig * Math.sqrt(years);
  return normCdf((Math.log(x / forward) + (sd * sd) / 2) / sd);
}

/**
 * The forward the options price in: median of K + C − P (put-call parity, mids) over the three two-sided strikes
 * nearest spot; spot when parity cannot be read.
 */
export function forwardPrice(chain) {
  const spot = num(chain?.underlyingLtp);
  const rows = [...(chain?.rows ?? [])].filter((r) => mid(r.ce) !== null && mid(r.pe) !== null && num(r.ce?.bid) && num(r.pe?.bid));
  if (spot === null) return null;
  rows.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  const f = rows.slice(0, 3).map((r) => r.strike + mid(r.ce) - mid(r.pe)).sort((a, b) => a - b);
  return f.length ? f[Math.floor(f.length / 2)] : spot;
}
/** Years to expiry (15:30 IST), for pricing. */
export const yearsToExpiry = (expiry, now = Date.now()) => {
  const d = timeToExpiry(expiry, now).days;
  return d === null ? null : d / 365;
};
/** One-standard-deviation move of a log-normal price: half the width of the ±1σ band. */
export function sigmaMove(forward, ivPct, years) {
  const F = num(forward);
  const sig = (num(ivPct) ?? 0) / 100;
  if (F === null || !(sig > 0) || !(years > 0)) return null;
  const sd = sig * Math.sqrt(years);
  return (F * Math.exp(sd) - F * Math.exp(-sd)) / 2;
}
/** For each side, the strikes whose |delta| is nearest 0.16 and 0.30 (within 0.08): strike -> "16Δ" / "30Δ". */
export function deltaTargets(rows) {
  const out = { ce: new Map(), pe: new Map() };
  for (const side of ["ce", "pe"]) {
    for (const target of [0.16, 0.3]) {
      let best = null;
      for (const r of rows) {
        const d = num(r[side]?.delta);
        if (d === null) continue;
        const gap = Math.abs(Math.abs(d) - target);
        if (gap <= 0.08 && (best === null || gap < best.gap)) best = { strike: r.strike, gap };
      }
      if (best) out[side].set(best.strike, `${Math.round(target * 100)}Δ`);
    }
  }
  return out;
}

// ── Strategies ──

/**
 * A basket leg: { symbol, right: "CE"|"PE", strike, side: "BUY"|"SELL", lots, price (entry, per unit), iv? }.
 * P&L figures are in rupees for the whole basket (lots × lotSize units per leg).
 */
const legSign = (l) => (l.side === "SELL" ? -1 : 1);
const legUnits = (l, lotSize) => Math.max(0, Math.floor(num(l.lots) ?? 0)) * (num(lotSize) || 1);

/** P&L at expiry if the underlying settles at `price`. */
export function payoffAt(legs, price, lotSize) {
  let t = 0;
  for (const l of legs) {
    const intrinsic = l.right === "CE" ? Math.max(0, price - l.strike) : Math.max(0, l.strike - price);
    t += legSign(l) * (intrinsic - (num(l.price) ?? 0)) * legUnits(l, lotSize);
  }
  return t;
}
/** P&L today (Black-76 at each leg's IV) if the underlying moved to `price`; `basis` = forward − spot. */
export function valueAt(legs, price, lotSize, years, basis = 0) {
  let t = 0;
  for (const l of legs) {
    const v = black76(price + basis, l.strike, years, l.iv, l.right);
    if (v === null) return null;
    t += legSign(l) * (v - (num(l.price) ?? 0)) * legUnits(l, lotSize);
  }
  return t;
}
/** Net premium: positive = you receive (credit), negative = you pay (debit). */
export const netPremium = (legs, lotSize) => legs.reduce((a, l) => a - legSign(l) * (num(l.price) ?? 0) * legUnits(l, lotSize), 0);

/**
 * Max profit / loss (null = unlimited), breakevens, and probability of profit at expiry under the log-normal model.
 * Payoff is piecewise linear between strikes, so checking the kinks and the slopes beyond them is exact.
 */
export function strategyStats(legs, lotSize, { forward = null, ivPct = null, years = null } = {}) {
  if (!legs.length) return null;
  const strikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  const lo = Math.max(0.01, strikes[0] * 0.5);
  const hi = strikes[strikes.length - 1] * 1.5;
  const pts = [lo, ...strikes, hi];
  const vals = pts.map((x) => payoffAt(legs, x, lotSize));
  // Slope above the top strike: net calls bought; below the bottom strike: net puts bought (in units).
  const upSlope = legs.reduce((a, l) => a + (l.right === "CE" ? legSign(l) * legUnits(l, lotSize) : 0), 0);
  const downSlope = legs.reduce((a, l) => a + (l.right === "PE" ? legSign(l) * legUnits(l, lotSize) : 0), 0);
  const inner = vals.slice(1, -1);
  let maxProfit = Math.max(...inner);
  let maxLoss = Math.min(...inner);
  if (upSlope > 0 || downSlope > 0) maxProfit = null;
  else maxProfit = Math.max(maxProfit, vals[0], vals[vals.length - 1]);
  if (upSlope < 0 || downSlope < 0) maxLoss = null;
  else maxLoss = Math.min(maxLoss, vals[0], vals[vals.length - 1]);
  const breakevens = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = vals[i];
    const b = vals[i + 1];
    if (a === 0 && i > 0) breakevens.push(pts[i]);
    else if ((a < 0 && b > 0) || (a > 0 && b < 0)) breakevens.push(pts[i] + ((pts[i + 1] - pts[i]) * -a) / (b - a));
  }
  let pop = null;
  const F = num(forward);
  const sig = (num(ivPct) ?? 0) / 100;
  if (F && sig > 0 && years > 0) {
    // Integrate P(profit) over the intervals between breakevens (and 0 / ∞).
    const cuts = [0, ...breakevens, Infinity];
    pop = 0;
    for (let i = 0; i < cuts.length - 1; i += 1) {
      const a = cuts[i];
      const b = cuts[i + 1];
      const probe = b === Infinity ? Math.max(a * 1.5, hi * 2) : a === 0 ? b / 2 : (a + b) / 2;
      if (payoffAt(legs, probe, lotSize) > 0) pop += (b === Infinity ? 1 : cdfAt(b, F, years, sig)) - cdfAt(a, F, years, sig);
    }
  }
  return { maxProfit, maxLoss, breakevens, pop, net: netPremium(legs, lotSize) };
}
/** Net Greeks of a basket (delta in units of the underlying, theta and vega in rupees). */
export function netGreeks(legs, chain) {
  const lotSize = num(chain?.lotSize) || 1;
  const out = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  for (const l of legs) {
    const row = chain?.rows?.find((r) => r.strike === l.strike);
    const q = row?.[l.right.toLowerCase()];
    for (const k of Object.keys(out)) out[k] += legSign(l) * (num(q?.[k]) ?? 0) * legUnits(l, lotSize);
  }
  return out;
}

/** Ready-made strategies around the ATM strike (σ-wide strikes use the chain's own expected move). */
export const PRESETS = Object.freeze([
  { id: "long-straddle", name: "Long straddle", view: "Big move either way" },
  { id: "short-straddle", name: "Short straddle", view: "Stays near ATM" },
  { id: "long-strangle", name: "Long strangle", view: "Bigger move, cheaper" },
  { id: "short-strangle", name: "Short strangle", view: "Stays in a range" },
  { id: "bull-call", name: "Bull call spread", view: "Moderately up" },
  { id: "bear-put", name: "Bear put spread", view: "Moderately down" },
  { id: "iron-condor", name: "Iron condor", view: "Range, defined risk" },
  { id: "iron-fly", name: "Iron fly", view: "Pin near ATM, defined risk" },
]);

/** Legs for a preset: [{ right, strike, side, lots }] (prices are filled from the chain by the caller). */
export function presetLegs(id, chain, { move = null } = {}) {
  const rows = chain?.rows ?? [];
  const atm = atmRow(chain);
  if (!atm) return [];
  const strikes = rows.map((r) => r.strike);
  const step = strikes.length > 1 ? Math.min(...strikes.slice(1).map((s, i) => s - strikes[i])) : 50;
  const near = (x) => strikes.reduce((b, s) => (Math.abs(s - x) < Math.abs(b - x) ? s : b), strikes[0]);
  const m = num(move) && move > 0 ? move : step * 4;
  const K = atm.strike;
  const up = Math.max(near(K + m), K + step);
  const dn = Math.min(near(K - m), K - step);
  const L = (right, strike, side) => ({ right, strike, side, lots: 1 });
  switch (id) {
    case "long-straddle": return [L("CE", K, "BUY"), L("PE", K, "BUY")];
    case "short-straddle": return [L("CE", K, "SELL"), L("PE", K, "SELL")];
    case "long-strangle": return [L("CE", up, "BUY"), L("PE", dn, "BUY")];
    case "short-strangle": return [L("CE", up, "SELL"), L("PE", dn, "SELL")];
    case "bull-call": return [L("CE", K, "BUY"), L("CE", up, "SELL")];
    case "bear-put": return [L("PE", K, "BUY"), L("PE", dn, "SELL")];
    case "iron-condor": return [L("PE", near(dn - m / 2) < dn ? near(dn - m / 2) : dn - step, "BUY"), L("PE", dn, "SELL"), L("CE", up, "SELL"), L("CE", near(up + m / 2) > up ? near(up + m / 2) : up + step, "BUY")];
    case "iron-fly": {
      const wing = Math.max(step, Math.round(m / step) * step);
      return [L("PE", near(K - wing), "BUY"), L("PE", K, "SELL"), L("CE", K, "SELL"), L("CE", near(K + wing), "BUY")];
    }
    default: return [];
  }
}
