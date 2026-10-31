/**
 * Options strategy templates and a view-driven finder (stream S15), ported from OptionsDesk StrategyBuilder and
 * StrategyFinder as a read-only analytics API. Pure builders over a Bridge OptionChain plus thin route handlers.
 * Nothing here can place an order: it only reads the chain (and one futures quote for FUT-leg templates).
 *
 *   GET /v1/analytics/strategies                                      template list
 *   GET /v1/analytics/strategies/build?underlying=&expiry=&template=[&offset=&width=]
 *   GET /v1/analytics/strategies/find?underlying=&expiry=&view=[&maxLoss=]
 *
 * `offset` and `width` count listed strikes, not points. Premiums are leg ltp (bid/ask mid when ltp is missing).
 */
import { BridgeError } from "../core/errors.mjs";
import { defaultOptionExchange } from "../market/chain.mjs";
import { autoBackupFor, readOptionsBase } from "../market/routes.mjs";
import { daysBetween } from "../../lib/blackScholes.mjs";
import { futureExpiryFor, strategyPayoff } from "./math.mjs";

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const opt = (q, name) => {
  const v = q.get(name);
  return v === null || v === "" ? undefined : v;
};
const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const posNum = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" && Number(v) > 0 ? Number(v) : null);

export const VIEWS = Object.freeze(["bullish", "bearish", "neutral", "volatile", "rangebound"]);

// Each leg: [type, side, strike index relative to anchor, lots]. `anchor` is atm + offset (strikes); `w` is width.
const T = (id, name, views, description, { offset = 0, width = 0, usesOffset = true, usesWidth = true, fut = false, legs }) => ({
  id, name, views, description, defaults: { offset, width }, usesOffset, usesWidth, usesFuture: fut, legs,
});

export const TEMPLATES = Object.freeze([
  T("long_straddle", "Long straddle", ["volatile"], "Buy ATM call and put. Profits from a big move either way; loss limited to the premium.", {
    usesOffset: false, usesWidth: false, legs: () => [["CE", "buy", 0], ["PE", "buy", 0]],
  }),
  T("short_straddle", "Short straddle", ["neutral", "rangebound"], "Sell ATM call and put. Collects premium if the underlying stays put; risk is unbounded.", {
    usesOffset: false, usesWidth: false, legs: () => [["CE", "sell", 0], ["PE", "sell", 0]],
  }),
  T("long_strangle", "Long strangle", ["volatile"], "Buy an OTM call and an OTM put. Cheaper than a straddle, needs a bigger move.", {
    offset: 2, usesWidth: false, legs: (o) => [["CE", "buy", o], ["PE", "buy", -o]],
  }),
  T("short_strangle", "Short strangle", ["neutral", "rangebound"], "Sell an OTM call and an OTM put. Wider profit zone than a short straddle; risk is unbounded.", {
    offset: 2, usesWidth: false, legs: (o) => [["CE", "sell", o], ["PE", "sell", -o]],
  }),
  T("bull_call_spread", "Bull call spread", ["bullish"], "Buy a call, sell a higher call. Net debit; capped profit and loss.", {
    offset: 0, width: 2, legs: (o, w) => [["CE", "buy", o], ["CE", "sell", o + w]],
  }),
  T("bear_call_spread", "Bear call spread", ["bearish"], "Sell a call, buy a higher call. Net credit; capped profit and loss.", {
    offset: 1, width: 2, legs: (o, w) => [["CE", "sell", o], ["CE", "buy", o + w]],
  }),
  T("bull_put_spread", "Bull put spread", ["bullish"], "Sell a put, buy a lower put. Net credit; capped profit and loss.", {
    offset: -1, width: 2, legs: (o, w) => [["PE", "sell", o], ["PE", "buy", o - w]],
  }),
  T("bear_put_spread", "Bear put spread", ["bearish"], "Buy a put, sell a lower put. Net debit; capped profit and loss.", {
    offset: 0, width: 2, legs: (o, w) => [["PE", "buy", o], ["PE", "sell", o - w]],
  }),
  T("iron_condor", "Iron condor", ["neutral", "rangebound"], "Short strangle with long wings. Net credit; defined risk.", {
    offset: 2, width: 2, legs: (o, w) => [["PE", "buy", -o - w], ["PE", "sell", -o], ["CE", "sell", o], ["CE", "buy", o + w]],
  }),
  T("iron_butterfly", "Iron butterfly", ["neutral", "rangebound"], "Short ATM straddle with long wings. Net credit; defined risk.", {
    usesOffset: false, width: 3, legs: (_o, w) => [["PE", "buy", -w], ["PE", "sell", 0], ["CE", "sell", 0], ["CE", "buy", w]],
  }),
  T("butterfly", "Long call butterfly", ["neutral", "rangebound"], "Buy one low call, sell two middle calls, buy one high call. Small debit; peak profit at the middle strike.", {
    offset: 0, width: 2, legs: (o, w) => [["CE", "buy", o - w], ["CE", "sell", o, 2], ["CE", "buy", o + w]],
  }),
  T("covered_call", "Covered call", ["bullish", "neutral"], "Long future plus a sold OTM call. Income on a held position; upside capped, downside open to zero.", {
    offset: 2, usesWidth: false, fut: true, legs: (o) => [["FUT", "buy", 0], ["CE", "sell", o]],
  }),
  T("protective_put", "Protective put", ["bullish"], "Long future plus a bought OTM put. Keeps the upside, caps the downside at the put strike less premium.", {
    offset: 2, usesWidth: false, fut: true, legs: (o) => [["FUT", "buy", 0], ["PE", "buy", -o]],
  }),
]);

const byId = new Map(TEMPLATES.map((t) => [t.id, t]));
export const templateList = () =>
  TEMPLATES.map(({ id, name, views, description, defaults, usesOffset, usesWidth, usesFuture }) => ({
    id, name, views, description, defaults, params: { offset: usesOffset, width: usesWidth }, requiresFuture: usesFuture,
  }));

const legPrice = (leg) => {
  const ltp = posNum(leg?.ltp);
  if (ltp !== null) return ltp;
  const bid = posNum(leg?.bid);
  const ask = posNum(leg?.ask);
  return bid !== null && ask !== null ? (bid + ask) / 2 : null;
};

/**
 * Concrete legs for one template from a chain. Returns { legs, atmStrike, spot, lotSize } or { error } when a strike
 * falls off the chain or a leg has no price. `futurePrice` is used for FUT legs (falls back to spot).
 */
export function buildTemplate(chain, template, { offset, width, lots = 1, futurePrice = null } = {}) {
  const t = typeof template === "string" ? byId.get(template) : template;
  if (!t) throw new Error(`unknown template ${template}`);
  const rows = (Array.isArray(chain?.rows) ? chain.rows : []).slice().sort((a, b) => a.strike - b.strike);
  const spot = posNum(chain?.underlyingLtp);
  if (!rows.length || !spot) return { error: "The chain has no strikes or no underlying price." };
  let atm = rows.findIndex((r) => r.strike === chain.atmStrike);
  if (atm < 0) atm = rows.reduce((best, r, i) => (Math.abs(r.strike - spot) < Math.abs(rows[best].strike - spot) ? i : best), 0);
  const o = t.usesOffset ? offset ?? t.defaults.offset : 0;
  const w = t.usesWidth ? width ?? t.defaults.width : 0;
  const lotSize = posNum(chain.lotSize) ?? 1;
  const legs = [];
  for (const [type, side, rel, mult = 1] of t.legs(o, w)) {
    if (type === "FUT") {
      legs.push({ type, side, strike: null, price: round(futurePrice ?? spot, 2), lots: lots * mult, lotSize, symbol: null });
      continue;
    }
    const row = rows[atm + rel];
    if (!row) return { error: `Strike ${rel > 0 ? "+" : ""}${rel} from ATM is not on the chain (offset ${o}, width ${w}).` };
    const src = type === "CE" ? row.ce : row.pe;
    const price = legPrice(src);
    if (price === null) return { error: `No price for ${type} ${row.strike}.` };
    legs.push({ type, side, strike: row.strike, price: round(price, 2), lots: lots * mult, lotSize, symbol: src?.symbol ?? null });
  }
  return { legs, atmStrike: rows[atm].strike, spot, lotSize };
}

/** ATM implied volatility in percent: mean of ATM call and put IV, else back-solved from the ATM straddle price. */
export function atmIvOf(chain, days) {
  const rows = Array.isArray(chain?.rows) ? chain.rows : [];
  const spot = posNum(chain?.underlyingLtp);
  const atm = rows.find((r) => r.strike === chain?.atmStrike) ?? (spot ? rows.reduce((b, r) => (!b || Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b), null) : null);
  if (!atm) return { iv: null, source: null };
  const ivs = [atm.ce?.iv, atm.pe?.iv].map(posNum).filter((v) => v !== null);
  if (ivs.length) return { iv: ivs.reduce((a, b) => a + b, 0) / ivs.length, source: "chain" };
  const c = legPrice(atm.ce);
  const p = legPrice(atm.pe);
  if (c !== null && p !== null && spot) {
    // ATM straddle ~ 0.8 * S * sigma * sqrt(T)
    return { iv: ((c + p) / (0.8 * spot * Math.sqrt(Math.max(days, 0.25) / 365))) * 100, source: "straddle" };
  }
  return { iv: null, source: null };
}

function erf(x) {
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}
const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

/** Probability of finishing in profit at expiry, lognormal with zero drift, from a payoff curve. null without IV. */
export function probabilityOfProfit(curve, { spot, ivPct, days }) {
  if (!(ivPct > 0) || !(spot > 0) || curve.length < 2) return null;
  const sd = (ivPct / 100) * Math.sqrt(Math.max(days, 0.25) / 365);
  const mu = Math.log(spot) - 0.5 * sd * sd;
  const cdf = (p) => (p <= 0 ? 0 : normCdf((Math.log(p) - mu) / sd));
  let prob = 0;
  if (curve[0].pnl > 0) prob += cdf(curve[0].price);
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (a.pnl + b.pnl > 0) prob += cdf(b.price) - cdf(a.price);
  }
  const last = curve[curve.length - 1];
  if (last.pnl > 0) prob += 1 - cdf(last.price);
  return round(Math.min(1, Math.max(0, prob)), 4);
}

/** Payoff summary plus probability of profit for built legs. */
export function analyseLegs(legs, { spot, ivPct, days }) {
  const lo = spot * 0.6;
  const hi = spot * 1.4;
  const p = strategyPayoff(legs, { spot, from: lo, to: hi, step: (hi - lo) / 1600 });
  const unboundedLoss = Boolean(p.unboundedLoss);
  const maxLoss = p.maxLoss;
  const lossAtZero = Boolean(p.lossAtZero);
  const loss = maxLoss === null ? null : Math.abs(Math.min(0, maxLoss));
  const riskReward = p.maxProfit !== null && loss !== null && loss > 0 ? round(p.maxProfit / loss, 3) : null;
  return {
    netPremium: p.netPremium,
    credit: p.netPremium > 0,
    maxProfit: p.maxProfit,
    maxLoss: maxLoss === null ? null : round(Math.min(0, maxLoss), 2),
    unboundedProfit: Boolean(p.unboundedProfit),
    unboundedRisk: unboundedLoss,
    lossAtZero,
    riskReward,
    breakevens: p.breakevens,
    probabilityOfProfit: probabilityOfProfit(p.curve, { spot, ivPct, days }),
  };
}

const rank = (a) => {
  const rr = a.unboundedProfit && !a.unboundedRisk ? 1 : a.riskReward === null ? 0 : Math.min(a.riskReward, 3) / 3;
  const pop = a.probabilityOfProfit ?? 0.5;
  return round(0.45 * rr + 0.45 * pop + 0.1 * (a.credit ? 1 : 0) - (a.unboundedRisk ? 0.15 : 0), 4);
};

/**
 * Instantiate every template matching `view` over a small offset/width grid, run the payoff on each, drop those whose
 * max loss is over `maxLoss` (unbounded risk never fits a budget), and rank by a score blending risk-reward,
 * probability of profit and net credit. Unbounded-risk results stay in the list (flagged) when there is no budget.
 */
export function findStrategies(chain, { view, maxLoss, days, futurePrice = null, limit = 10 }) {
  const { iv, source } = atmIvOf(chain, days);
  const seen = new Set();
  const out = [];
  let excluded = 0;
  for (const t of TEMPLATES.filter((x) => x.views.includes(view))) {
    const offsets = t.usesOffset ? [t.defaults.offset, t.defaults.offset + Math.sign(t.defaults.offset || 1)] : [0];
    const widths = t.usesWidth ? [1, 2, 3] : [0];
    for (const offset of offsets) for (const width of widths) {
      const b = buildTemplate(chain, t, { offset, width, futurePrice });
      if (b.error) continue;
      const key = t.id + JSON.stringify(b.legs.map((l) => [l.type, l.side, l.strike, l.lots]));
      if (seen.has(key)) continue;
      seen.add(key);
      const a = analyseLegs(b.legs, { spot: b.spot, ivPct: iv, days });
      if (maxLoss !== undefined && (a.unboundedRisk || a.maxLoss === null || Math.abs(a.maxLoss) > maxLoss)) {
        excluded++;
        continue;
      }
      out.push({ template: t.id, name: t.name, params: { offset: t.usesOffset ? offset : null, width: t.usesWidth ? width : null }, legs: b.legs, ...a, score: rank(a) });
    }
  }
  out.sort((a, b) => b.score - a.score || (b.probabilityOfProfit ?? 0) - (a.probabilityOfProfit ?? 0));
  return { view, atmIv: round(iv, 2), atmIvSource: source, candidates: out.length + excluded, excluded, results: out.slice(0, limit).map((r, i) => ({ rank: i + 1, ...r })) };
}

/** @param {object} deps full deps passed to register(); only deps.marketData is used (reads). */
export function strategyRoutes(deps) {
  const md = () => deps.marketData;
  const meta = (ctx, opts, freshness) => ({ requestId: ctx.requestId, accountId: opts.accountId ?? null, ...(freshness ? { freshness } : {}) });
  const nowDate = () => new Date(typeof deps.now === "function" ? deps.now() : deps.clock?.now ? deps.clock.now() : Date.now());

  function intParam(q, name, min, max) {
    const v = opt(q, name);
    if (v === undefined) return undefined;
    if (!/^-?\d+$/.test(v) || Number(v) < min || Number(v) > max) throw invalid(name, `${name} must be a whole number from ${min} to ${max}.`);
    return Number(v);
  }

  async function load(ctx, needFuture) {
    const q = ctx.query;
    const underlying = opt(q, "underlying");
    if (!underlying) throw invalid("underlying", "underlying is required, for example NIFTY.");
    const expiry = opt(q, "expiry");
    if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw invalid("expiry", "expiry is required as YYYY-MM-DD.");
    const opts = readOptionsBase(ctx, { autoBackup: autoBackupFor(deps) });
    const chain = await md().optionChain({ underlying, expiry, strikes: 12, greeks: true }, opts);
    let futurePrice = null;
    if (needFuture) {
      try {
        const u = underlying.toUpperCase();
        // Futures are monthly: a weekly option expiry uses its month's future.
        const futExpiry = futureExpiryFor((await md().expiries(underlying, opts))?.expiries, expiry) ?? expiry;
        const sym = `${defaultOptionExchange(u)}:${u}-${futExpiry}-FUT`;
        futurePrice = (await md().quotes([sym], opts)).items.find((i) => i.symbol === sym)?.ltp ?? null;
      } catch {
        futurePrice = null; // FUT legs then price at spot
      }
    }
    const days = Math.max(daysBetween(nowDate(), expiry), 0.25);
    return { underlying: underlying.toUpperCase(), expiry, chain, opts, days, futurePrice };
  }

  const list = async (ctx) => ({ data: { views: VIEWS, templates: templateList() }, meta: { requestId: ctx.requestId } });

  const build = async (ctx) => {
    const id = (opt(ctx.query, "template") ?? "").toLowerCase();
    const t = byId.get(id);
    if (!t) throw invalid("template", `template must be one of ${TEMPLATES.map((x) => x.id).join(", ")}.`);
    const offset = intParam(ctx.query, "offset", -20, 20);
    const width = intParam(ctx.query, "width", 1, 20);
    const lots = intParam(ctx.query, "lots", 1, 1000);
    const r = await load(ctx, t.usesFuture);
    const b = buildTemplate(r.chain, t, { offset, width, lots, futurePrice: r.futurePrice });
    if (b.error) throw invalid("offset", b.error);
    const { iv, source } = atmIvOf(r.chain, r.days);
    const a = analyseLegs(b.legs, { spot: b.spot, ivPct: iv, days: r.days });
    const curve = strategyPayoff(b.legs, { spot: b.spot }).curve;
    return {
      data: {
        template: t.id, name: t.name, underlying: r.underlying, expiry: r.expiry, spot: b.spot, atmStrike: b.atmStrike, lotSize: b.lotSize,
        daysToExpiry: round(r.days, 2), atmIv: round(iv, 2), atmIvSource: source,
        params: { offset: t.usesOffset ? offset ?? t.defaults.offset : null, width: t.usesWidth ? width ?? t.defaults.width : null },
        legs: b.legs, ...a, curve,
      },
      meta: meta(ctx, r.opts, r.chain.freshness),
    };
  };

  const find = async (ctx) => {
    const view = (opt(ctx.query, "view") ?? "").toLowerCase();
    if (!VIEWS.includes(view)) throw invalid("view", `view must be one of ${VIEWS.join(", ")}.`);
    let maxLoss;
    const raw = opt(ctx.query, "maxLoss");
    if (raw !== undefined) {
      maxLoss = Number(raw);
      if (!Number.isFinite(maxLoss) || maxLoss <= 0) throw invalid("maxLoss", "maxLoss must be a positive number of rupees.");
    }
    const r = await load(ctx, TEMPLATES.some((t) => t.usesFuture && t.views.includes(view)));
    const found = findStrategies(r.chain, { view, maxLoss, days: r.days, futurePrice: r.futurePrice });
    return {
      data: { underlying: r.underlying, expiry: r.expiry, spot: r.chain.underlyingLtp ?? null, daysToExpiry: round(r.days, 2), maxLoss: maxLoss ?? null, ...found },
      meta: meta(ctx, r.opts, r.chain.freshness),
    };
  };

  return [
    ["GET", "/v1/analytics/strategies", { scope: "read" }, list],
    ["GET", "/v1/analytics/strategies/build", { scope: "read" }, build],
    ["GET", "/v1/analytics/strategies/find", { scope: "read" }, find],
  ];
}
