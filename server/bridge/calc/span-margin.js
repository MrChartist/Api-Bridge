/**
 * Portfolio margin, approximate (not the exchange's SPAN). Used by the paper engine (server/bridge/paper) for its order
 * checks and margin preview, so every place that shows a paper margin shows the same figure. Pure: no DOM, no fetch, no clock. `nowMs` comes in as an argument.
 *
 * How it works, per underlying (docs/guides/paper-margin.md):
 *  1. Scan risk. Every leg is revalued one trading day ahead under 16 scenarios: the underlying moves 0, ±1/3, ±2/3
 *     and ±1 of the price scan range (index 9 %, stock 15 %), each with volatility up and down 25 % (relative), plus
 *     two extreme moves of twice the range counted at 35 %. Options use Black-76 on the forward at the leg's own IV
 *     (implied from its price), futures move one for one. The scan risk is the worst loss over the grid, against
 *     today's model value. Longs, shorts and futures in the same underlying offset each other, which is where a hedge
 *     earns its benefit.
 *  2. Premium. Option buys pay their premium. A long's loss up to its current value is covered by that premium, so
 *     the scan charge is max(0, scan risk − value of the longs).
 *  3. Exposure. Index 2 %, stock 3.5 % of the notional (units × forward) of short options and futures.
 *  4. Calendar. Legs in more than one expiry of the same underlying: 1 % (index) or 2 % (stock) of the delta that one
 *     expiry offsets against another (a spread across months is not a perfect hedge).
 *  5. Expiry day. Legs expiring today are scanned on their own (no offset against later expiries), and short index
 *     options expiring today carry 2 % extra (ELM).
 * Without a forward for an underlying, its legs fall back to the simple per-leg model (premium for buys, 15 % of strike
 * value for option sells, 15 % of value for futures), marked `fallback`.
 *
 * A leg: { underlying, kind: "OPT"|"FUT", right?: "CE"|"PE", strike?, expiry: "YYYY-MM-DD", qty (signed units: + long,
 *   − short), cost?: entry price per unit (what a buy paid), mark?: current price per unit, iv?: vol points }.
 */
import { b76Delta, black76, impliedVolB76 } from "./pricing.js";

export const SPAN_METHOD = "Approximate, not the exchange's SPAN: a 16-scenario price and volatility scan per underlying, plus exposure margin. Your broker's figure is final.";

export const SPAN_PARAMS = Object.freeze({
  index: Object.freeze({ psr: 0.09, exposure: 0.02, calendar: 0.01 }),
  stock: Object.freeze({ psr: 0.15, exposure: 0.035, calendar: 0.02 }),
  /** Relative volatility shift of the scan (±25 % of the leg's IV). */
  vsr: 0.25,
  /** Extreme moves: this multiple of the range, counted at `extremeWeight`. */
  extremeMult: 2,
  extremeWeight: 0.35,
  /** Revalue this many calendar days ahead. */
  horizonDays: 1,
  /** Extra margin on short index options on their expiry day (share of notional). */
  expiryDayElm: 0.02,
  /** IV used when a leg has none and none can be implied (vol points). */
  fallbackIv: Object.freeze({ index: 15, stock: 30 }),
  /** The simple per-leg model used without a forward (percent). */
  simple: Object.freeze({ optionSellPct: 15, futuresPct: 15 }),
});

export const INDEX_UNDERLYINGS = Object.freeze(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "SENSEX", "BANKEX", "SENSEX50"]);

const YEAR_MS = 365 * 86_400_000;
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const isFut = (l) => l.kind === "FUT";

/** IST date (YYYY-MM-DD) of a time. */
export function istDate(ms) {
  const d = new Date(ms + 5.5 * 3_600_000);
  return d.toISOString().slice(0, 10);
}

/** Years from `nowMs` to 15:30 IST on the expiry day (0 after it). */
export function yearsLeft(expiry, nowMs) {
  const end = Date.parse(`${expiry}T15:30:00+05:30`);
  if (!Number.isFinite(end) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, (end - nowMs) / YEAR_MS);
}

/** Scenario grid: [{ move (share of forward), vol (relative shift), weight }]. */
export function scenarios(psr, p = SPAN_PARAMS) {
  const out = [];
  for (const f of [0, 1 / 3, -1 / 3, 2 / 3, -2 / 3, 1, -1]) for (const v of [1, -1]) out.push({ move: f * psr, vol: v * p.vsr, weight: 1 });
  out.push({ move: p.extremeMult * psr, vol: 0, weight: p.extremeWeight }, { move: -p.extremeMult * psr, vol: 0, weight: p.extremeWeight });
  return out;
}

/** Normalise one leg; null when it cannot be margined here. */
function cleanLeg(l) {
  const qty = num(l?.qty);
  const kind = l?.kind === "FUT" ? "FUT" : l?.kind === "OPT" ? "OPT" : null;
  if (!kind || !qty || typeof l.underlying !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(String(l.expiry ?? ""))) return null;
  if (kind === "OPT" && (!(num(l.strike) > 0) || (l.right !== "CE" && l.right !== "PE"))) return null;
  return { underlying: l.underlying, kind, right: kind === "OPT" ? l.right : null, strike: kind === "OPT" ? Number(l.strike) : null, expiry: l.expiry, qty, cost: num(l.cost), mark: num(l.mark), iv: num(l.iv) };
}

/** Legs on the same contract net into one (a buy against a held short closes it). Cost follows the side that is left. */
export function netLegs(legs) {
  const by = new Map();
  for (const l of legs) {
    const key = `${l.underlying}|${l.kind}|${l.expiry}|${l.strike ?? ""}|${l.right ?? ""}`;
    const prev = by.get(key);
    if (!prev) {
      by.set(key, { ...l });
      continue;
    }
    const qty = prev.qty + l.qty;
    const keep = Math.sign(qty) === Math.sign(l.qty) && Math.abs(l.qty) > Math.abs(prev.qty) ? l : prev;
    by.set(key, { ...prev, qty, cost: keep.cost ?? prev.cost, mark: prev.mark ?? l.mark, iv: prev.iv ?? l.iv });
  }
  return [...by.values()].filter((l) => Math.abs(l.qty) > 1e-9);
}

/** The simple per-leg block (no forward): premium for buys, a share of strike or contract value for sells and futures. */
export function simpleLegMargin(l, p = SPAN_PARAMS) {
  const units = Math.abs(l.qty);
  const px = l.cost ?? l.mark ?? 0;
  if (isFut(l)) return (units * (l.mark ?? px) * p.simple.futuresPct) / 100;
  if (l.qty > 0) return units * px;
  return (units * l.strike * p.simple.optionSellPct) / 100;
}

/**
 * Scan one set of legs (same underlying) around forward F. Returns the worst loss and where it happens.
 * Each leg carries `iv`, `T` (years now) and `Th` (years at the horizon), filled in by the caller.
 */
function scan(legs, F, psr, p) {
  const base = legs.map((l) => (isFut(l) ? F : black76(F, l.strike, l.T, l.ivUse, l.right) ?? 0));
  let worst = 0;
  let at = { move: 0, vol: 0 };
  for (const s of scenarios(psr, p)) {
    const Fs = F * (1 + s.move);
    let pnl = 0;
    legs.forEach((l, i) => {
      const v = isFut(l) ? Fs : black76(Fs, l.strike, l.Th, l.ivUse * (1 + s.vol), l.right) ?? 0;
      pnl += l.qty * (v - base[i]);
    });
    const loss = -pnl * s.weight;
    if (loss > worst) {
      worst = loss;
      at = { move: s.move, vol: s.vol };
    }
  }
  return { loss: worst, at };
}

/**
 * Margin of a set of legs.
 * @param {object[]} legs
 * @param {{ nowMs: number, forwards?: Record<string, number>, ivs?: Record<string, number>, params?: object }} ctx
 *   forwards: underlying -> forward (or spot); ivs: underlying -> ATM IV, used for legs without their own.
 * @returns {{ required: number, premium: number, span: number, exposure: number, calendar: number, elm: number,
 *   standalone: number, benefit: number, groups: object[], method: string }}
 */
export function portfolioMargin(legs, ctx = {}) {
  const r = core(legs, ctx);
  // What the same legs would need one by one (each margined on its own, with no offset).
  const standalone = r.clean.reduce((a, l) => a + core([l], ctx).required, 0);
  return { required: r.required, premium: r.premium, span: r.span, exposure: r.exposure, calendar: r.calendar, elm: r.elm, standalone, benefit: Math.max(0, standalone - r.required), groups: r.groups, method: SPAN_METHOD };
}

/** The required figure only (no breakdown or standalone pass): what the paper engine calls on every check. */
export function marginRequired(legs, ctx = {}) {
  return core(legs, ctx).required;
}

/** Each leg margined on its own with this same model (the "naked" figure a hedge benefit is measured against). */
export function standaloneMargin(legs, ctx = {}) {
  return (legs ?? []).reduce((a, l) => a + core([l], ctx).required, 0);
}

function core(legs, { nowMs, forwards = {}, ivs = {}, params = SPAN_PARAMS } = {}) {
  const p = params;
  const today = istDate(nowMs);
  const clean = netLegs((legs ?? []).map(cleanLeg).filter(Boolean));
  const byU = new Map();
  for (const l of clean) {
    if (!byU.has(l.underlying)) byU.set(l.underlying, []);
    byU.get(l.underlying).push(l);
  }
  const groups = [];
  for (const [u, ls] of byU) {
    const index = INDEX_UNDERLYINGS.includes(u);
    const k = index ? p.index : p.stock;
    const F = num(forwards[u]);
    if (!(F > 0)) {
      const standalone = ls.reduce((a, l) => a + simpleLegMargin(l, p), 0);
      groups.push({ underlying: u, index, forward: null, fallback: true, required: standalone, premium: 0, span: 0, exposure: 0, calendar: 0, elm: 0, standalone, worst: null });
      continue;
    }
    const uIv = num(ivs[u]);
    const horizon = (p.horizonDays * 86_400_000) / YEAR_MS;
    for (const l of ls) {
      l.T = yearsLeft(l.expiry, nowMs);
      l.Th = Math.max(0, l.T - horizon);
      if (!isFut(l)) {
        const implied = l.mark !== null && l.T > 0 ? impliedVolB76(l.mark, F, l.strike, l.T, l.right) : null;
        l.ivUse = l.iv ?? implied ?? uIv ?? (index ? p.fallbackIv.index : p.fallbackIv.stock);
      }
    }
    // Premium paid by buys (at cost, else the current price) and the current value of the longs.
    const longs = ls.filter((l) => !isFut(l) && l.qty > 0);
    const premium = longs.reduce((a, l) => a + l.qty * (l.cost ?? l.mark ?? black76(F, l.strike, l.T, l.ivUse, l.right) ?? 0), 0);
    // Expiry day: legs expiring today are scanned on their own.
    const expiring = ls.filter((l) => l.expiry === today);
    const later = ls.filter((l) => l.expiry !== today);
    const parts = [expiring, later].filter((x) => x.length);
    let span = 0;
    let worst = null;
    for (const part of parts) {
      const s = scan(part, F, k.psr, p);
      const longValue = part.filter((l) => !isFut(l) && l.qty > 0).reduce((a, l) => a + l.qty * (black76(F, l.strike, l.T, l.ivUse, l.right) ?? 0), 0);
      span += Math.max(0, s.loss - longValue);
      if (!worst || s.loss > worst.loss) worst = s;
    }
    const exposure = ls.filter((l) => isFut(l) || l.qty < 0).reduce((a, l) => a + Math.abs(l.qty) * F * k.exposure, 0);
    // Calendar: delta one expiry offsets against another (only among later expiries on expiry day).
    const deltas = new Map();
    for (const l of later) {
      const d = isFut(l) ? 1 : (b76Delta(F, l.strike, l.T, l.ivUse, l.right) ?? 0);
      deltas.set(l.expiry, (deltas.get(l.expiry) ?? 0) + l.qty * d);
    }
    let calendar = 0;
    if (deltas.size > 1) {
      const vals = [...deltas.values()];
      const pos = vals.filter((v) => v > 0).reduce((a, v) => a + v, 0);
      const neg = -vals.filter((v) => v < 0).reduce((a, v) => a + v, 0);
      calendar = Math.min(pos, neg) * F * k.calendar;
    }
    const elm = index ? expiring.filter((l) => !isFut(l) && l.qty < 0).reduce((a, l) => a + Math.abs(l.qty) * F * p.expiryDayElm, 0) : 0;
    const required = premium + span + exposure + calendar + elm;
    groups.push({ underlying: u, index, forward: F, fallback: false, required, premium, span, exposure, calendar, elm, worst: worst ? { move: worst.at.move, vol: worst.at.vol } : null });
  }
  const sum = (key) => groups.reduce((a, g) => a + g[key], 0);
  return { clean, required: sum("required"), premium: sum("premium"), span: sum("span"), exposure: sum("exposure"), calendar: sum("calendar"), elm: sum("elm"), groups };
}

/**
 * Margin change from adding legs to what is held: { before, after, change, alone }. `alone` is the added legs on
 * their own. The paper engine refuses an order when `after` exceeds what the account has.
 */
export function marginImpact(held, added, ctx) {
  const before = core(held, ctx).required;
  const after = core([...(held ?? []), ...(added ?? [])], ctx).required;
  return { before, after, change: after - before, alone: core(added, ctx).required };
}

/**
 * Builder, ticket and position legs -> margin legs. A leg: { kind: "OPT"|"FUT", side: "BUY"|"SELL", strike, right,
 * expiry, lots, lotSize?, units?, price, iv? }. `units` (exact quantity) wins over lots × lot size.
 * @param {object[]} legs
 * @param {{ underlying: string, lotSize?: number, expiry?: string }} opts  expiry: for legs that carry none
 */
export function marginLegsOf(legs, { underlying, lotSize = 1, expiry = null } = {}) {
  return (legs ?? [])
    .filter((l) => l && l.on !== false)
    .map((l) => {
      const units = num(l.units) ?? (num(l.lots) ?? 0) * (num(l.lotSize) ?? num(lotSize) ?? 1);
      const px = num(l.price);
      return { underlying, kind: l.kind === "FUT" ? "FUT" : "OPT", right: l.right ?? null, strike: num(l.strike), expiry: l.expiry ?? expiry, qty: (l.side === "SELL" ? -1 : 1) * units, cost: px, mark: px, iv: num(l.iv) };
    });
}
