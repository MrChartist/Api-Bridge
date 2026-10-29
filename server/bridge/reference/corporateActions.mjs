/**
 * Corporate-action adjustment calculator and non-standard contract inference (stream S16, docs/spec/p1-02-reference.md
 * §6.1–6.2). Pure. The method is the exchange ratio method as commonly described; the rounding rules, the rights
 * method and the dividend threshold NEED VERIFICATION against the NSE F&O adjustment circulars.
 *
 *   bonus a:b (a new for every b held)   AF = (a + b) / b
 *   split, face value x -> y             AF = x / y
 *   consolidation x -> y (y > x)         AF = x / y (< 1)
 *   rights a:b at S, cum price P         AF = P / TERP, TERP = (b·P + a·S) / (a + b)
 *   extraordinary dividend D             no factor: K' = K − D, L' = L (only above the threshold % of the cum price)
 *
 * Adjusted strike K' = round_tick(K / AF) (half away from zero, in integer paise), adjusted lot L' = round(L × AF); a
 * non-integer L × AF marks the contract non-standard. The factor is always computed here, never taken from input.
 */
import { BridgeError } from "../core/errors.mjs";

export const ACTION_TYPES = Object.freeze(["bonus", "split", "consolidation", "rights", "dividend", "other"]);
export const METHOD_NOTE = "NSE ratio method: factor = cum / TERP; strike / factor rounded to the tick; lot × factor rounded (needs verification)";
const DEFAULT_TICK = 0.05;

const invalid = (msg, path) => new BridgeError("VALIDATION_FAILED", msg, { errors: [{ path, message: msg }] });
const posNum = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
const posInt = (v) => Number.isInteger(v) && v > 0;

/** Round half away from zero to `dp` decimals. */
export function roundDp(x, dp) {
  const f = 10 ** dp;
  return (Math.sign(x) * Math.round(Math.abs(x) * f)) / f;
}

/**
 * Round a price to the tick, working in integer paise so 0.1 + 0.2 style drift cannot move a strike.
 * @param {number} value  rupees
 * @param {number} [tick] rupees (default 0.05)
 */
export function roundToTick(value, tick = DEFAULT_TICK) {
  const tickPaise = Math.max(1, Math.round(tick * 100));
  const paise = roundDp(value * 100, 6); // strip float noise before the tick rounding
  const steps = Math.sign(paise) * Math.round(Math.abs(paise) / tickPaise);
  return roundDp((steps * tickPaise) / 100, 2);
}

/**
 * The adjustment factor of an action. Returns { factor, terp } (factor null for dividends and "other").
 * @param {{ type: string, ratio?: { new: number, held: number }, fv?: { from: number, to: number },
 *   subscriptionPrice?: number, cumPrice?: number }} a
 */
export function adjustmentFactor(a) {
  if (!a || typeof a !== "object") throw invalid("Send an action object.", "(root)");
  if (!ACTION_TYPES.includes(a.type)) throw invalid(`type must be one of ${ACTION_TYPES.join(", ")}.`, "type");
  const ratio = () => {
    if (!a.ratio || !posInt(a.ratio.new) || !posInt(a.ratio.held)) throw invalid("ratio needs whole numbers new and held, both at least 1.", "ratio");
    return a.ratio;
  };
  const fv = () => {
    if (!a.fv || !posNum(a.fv.from) || !posNum(a.fv.to)) throw invalid("fv needs from and to face values above 0.", "fv");
    return a.fv;
  };
  switch (a.type) {
    case "bonus": {
      const r = ratio();
      return { factor: (r.new + r.held) / r.held, terp: null };
    }
    case "split": {
      const f = fv();
      if (!(f.from > f.to)) throw invalid("A split lowers the face value: fv.from must be above fv.to.", "fv");
      return { factor: f.from / f.to, terp: null };
    }
    case "consolidation": {
      const f = fv();
      if (!(f.to > f.from)) throw invalid("A consolidation raises the face value: fv.to must be above fv.from.", "fv");
      return { factor: f.from / f.to, terp: null };
    }
    case "rights": {
      const r = ratio();
      if (!posNum(a.subscriptionPrice)) throw invalid("subscriptionPrice must be above 0.", "subscriptionPrice");
      if (!posNum(a.cumPrice)) throw invalid("cumPrice must be above 0.", "cumPrice");
      if (!(a.subscriptionPrice < a.cumPrice)) throw invalid("A rights issue below the cum price needs subscriptionPrice < cumPrice.", "subscriptionPrice");
      const terp = (r.held * a.cumPrice + r.new * a.subscriptionPrice) / (r.new + r.held);
      return { factor: a.cumPrice / terp, terp };
    }
    default:
      return { factor: null, terp: null };
  }
}

/**
 * Adjusted strikes and lot for an action (the preview route and the "adjusted" block of listed actions).
 * @param {object} input  action fields + { lot?: number, strikes?: number[], strikeTick?: number, dividend?: number }
 * @param {{ extraordinaryDividendPct?: number }} [opts]
 */
export function previewAdjustment(input, { extraordinaryDividendPct = 2 } = {}) {
  const tick = input?.strikeTick ?? DEFAULT_TICK;
  if (!posNum(tick) || tick > 100) throw invalid("strikeTick must be above 0 (rupees).", "strikeTick");
  const strikes = input?.strikes ?? [];
  if (!Array.isArray(strikes) || strikes.length > 50 || !strikes.every(posNum)) throw invalid("strikes must be up to 50 prices above 0.", "strikes");
  const lot = input?.lot ?? null;
  if (lot !== null && !posInt(lot)) throw invalid("lot must be a whole number of units, at least 1.", "lot");

  if (input?.type === "dividend") {
    if (!posNum(input.dividend)) throw invalid("dividend must be above 0 (rupees per share).", "dividend");
    if (!posNum(input.cumPrice)) throw invalid("cumPrice must be above 0.", "cumPrice");
    const pct = (100 * input.dividend) / input.cumPrice;
    const adjusted = pct >= extraordinaryDividendPct;
    return {
      factor: null,
      terp: null,
      dividendPct: roundDp(pct, 4),
      adjusted,
      lotAfter: lot,
      lotExact: lot,
      nonStandardLot: false,
      strikes: strikes.map((k) => ({ before: k, after: adjusted ? roundToTick(k - input.dividend, tick) : k })),
      method: adjusted
        ? `Extraordinary dividend (${roundDp(pct, 2)} % of the cum price, at or above ${extraordinaryDividendPct} %): strike minus dividend; lot unchanged (needs verification)`
        : `Dividend below ${extraordinaryDividendPct} % of the cum price: no adjustment (needs verification)`,
    };
  }

  const { factor, terp } = adjustmentFactor(input);
  if (factor === null) throw invalid("This action type has no adjustment factor; enter the adjusted contract terms from the circular.", "type");
  const lotExact = lot === null ? null : lot * factor;
  const lotAfter = lotExact === null ? null : Math.round(roundDp(lotExact, 6));
  return {
    factor: roundDp(factor, 6),
    terp: terp === null ? null : roundDp(terp, 4),
    lotAfter,
    lotExact: lotExact === null ? null : roundDp(lotExact, 3),
    nonStandardLot: lotExact === null ? false : Math.abs(lotExact - Math.round(lotExact)) > 1e-9,
    strikes: strikes.map((k) => ({ before: k, after: roundToTick(k / factor, tick) })),
    method: METHOD_NOTE,
  };
}

/**
 * Normalise a corporate action for storage and listing: validates, computes `factor` (input factors are ignored).
 * @param {object} a
 * @param {{ origin: "shipped"|"user"|"inferred", verified?: boolean }} o
 */
export function normaliseAction(a, { origin, verified }) {
  if (!a || typeof a !== "object") throw invalid("Send an action object.", "(root)");
  const symbol = String(a.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9&-]{1,30}$/.test(symbol)) throw invalid("symbol must be 1-30 letters, digits, & or -.", "symbol");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a.exDate ?? ""))) throw invalid("exDate must be YYYY-MM-DD.", "exDate");
  if (!ACTION_TYPES.includes(a.type)) throw invalid(`type must be one of ${ACTION_TYPES.join(", ")}.`, "type");
  const { factor } = a.type === "dividend" || a.type === "other" ? { factor: null } : adjustmentFactor(a);
  if (a.type === "dividend" && !posNum(a.dividend)) throw invalid("dividend must be above 0 (rupees per share).", "dividend");
  const source = typeof a.source === "string" && a.source.trim() ? a.source.trim().slice(0, 200) : origin === "user" ? "entered on this Bridge" : "unknown";
  return {
    id: a.id ?? `ca_${symbol}_${a.exDate}_${a.type}`,
    symbol,
    exchange: a.exchange === "BSE" ? "BSE" : "NSE",
    type: a.type,
    ratio: a.ratio ? { new: a.ratio.new, held: a.ratio.held } : null,
    exDate: a.exDate,
    subscriptionPrice: a.subscriptionPrice ?? null,
    cumPrice: a.cumPrice ?? null,
    dividend: a.dividend ?? null,
    fv: a.fv ? { from: a.fv.from, to: a.fv.to } : null,
    factor: factor === null ? null : roundDp(factor, 6),
    lotRule: "round",
    strikeTick: posNum(a.strikeTick) ? a.strikeTick : DEFAULT_TICK,
    source,
    verified: verified ?? a.verified === true,
    ...(a.illustrative ? { illustrative: true } : {}),
    origin,
  };
}

/** The most common gap between consecutive strikes (ties: the smaller gap). */
export function modalStrikeStep(strikes) {
  const s = [...new Set(strikes)].sort((a, b) => a - b);
  const counts = new Map();
  for (let i = 1; i < s.length; i += 1) {
    const g = roundDp(s[i] - s[i - 1], 2);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let best = null;
  let n = 0;
  for (const [g, c] of counts) if (c > n || (c === n && g < best)) [best, n] = [g, c];
  return best;
}

/**
 * Non-standard contract inference (§6.2): a listed stock option whose lot differs from the series' standard lot, or
 * whose strike is off the series' modal strike step, is flagged "probably adjusted for a corporate action".
 * @param {Array<{ canonical: string, underlying: string, expiry: string, strike: number, lotSize: number }>} contracts
 * @param {(underlying: string, expiry: string) => number | null} standardLotFor
 * @returns {Array<{ canonical, underlying, expiry, strike, lot, standardLot, lotMismatch, offGrid, step, nonStandard: true, quality: "inferred", text }>}
 */
export function inferNonStandard(contracts, standardLotFor) {
  const groups = new Map();
  for (const c of contracts) {
    const k = `${c.underlying}|${c.expiry}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const out = [];
  for (const list of groups.values()) {
    const step = modalStrikeStep(list.map((c) => c.strike).filter(posNum));
    for (const c of list) {
      const std = standardLotFor(c.underlying, c.expiry);
      const lotMismatch = posInt(std) && c.lotSize !== std;
      // On the grid means a whole number of steps (listed strikes are multiples of the series' step).
      const offGrid = Boolean(step) && Math.abs(roundDp(c.strike / step, 6) - Math.round(c.strike / step)) > 1e-6;
      if (lotMismatch || offGrid) {
        out.push({ canonical: c.canonical, underlying: c.underlying, expiry: c.expiry, strike: c.strike, lot: c.lotSize, standardLot: posInt(std) ? std : null, lotMismatch: Boolean(lotMismatch), offGrid, step, nonStandard: true, quality: "inferred", text: "Probably adjusted for a corporate action" });
      }
    }
  }
  return out;
}
