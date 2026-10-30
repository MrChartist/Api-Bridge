/**
 * Strategy optimizer (stream S15, read scope). Grid-searches every strategies.mjs template that fits a market view
 * over strike offsets and widths on the live chain, scores each candidate and returns the best few. Read-only.
 *
 *   GET /v1/analytics/optimizer?underlying=&expiry=&view=bullish|bearish|neutral|volatile
 *       [&maxLoss=][&minPop=][&capital=][&objective=expectedValue|popAdjusted|riskReward][&top=5]
 *
 * Model: price at expiry is lognormal with zero drift (E[S] = spot) and sigma = ATM implied volatility (atmIvOf from
 * strategies.mjs) over the calendar time to expiry (floor 0.25 day). Payoff comes from strategyPayoff (math.mjs) on a
 * fixed 801-point grid spanning +/- 5 sigma; probability of profit and expected value integrate that curve cell by cell
 * with lognormal cell masses (cell mid payoff for EV, linear zero-crossing split for PoP; the two tails use the end
 * payoff). One flat ATM IV ignores skew and early exercise: a screening model, not a forecast. Premiums are the chain's
 * ltp (or bid/ask mid).
 *
 * Search: offsets -3..6 and widths 1..5 strikes (only where a template uses them); at most 2,000 candidates are
 * evaluated, duplicates skipped. Sizing: one lot, unless capital is given, then lots = floor(capital / capital-per-lot)
 * (capped by maxLoss when both are given, max 1,000 lots). Capital per lot is a margin-light estimate: max loss for
 * defined-risk structures (at least the net debit); for unbounded or open-to-zero risk it is the worst payoff within
 * +/- 2.5 sigma. Real SPAN margin differs. maxLoss (INR, on the sized position) rejects unbounded-risk strategies;
 * minPop is a percent, 0 to 100.
 *
 * Objectives (score, higher is better): expectedValue = EV of the sized position; popAdjusted = EV per rupee of capital
 * times PoP; riskReward = max profit / max loss (unbounded profit counts 5, unbounded risk counts 0).
 */
import { BridgeError } from "../core/errors.mjs";
import { defaultOptionExchange } from "../market/chain.mjs";
import { autoBackupFor, readOptionsBase } from "../market/routes.mjs";
import { daysBetween } from "../../lib/blackScholes.mjs";
import { strategyPayoff } from "./math.mjs";
import { atmIvOf, buildTemplate, TEMPLATES } from "./strategies.mjs";

export const OPTIMIZER_VIEWS = Object.freeze(["bullish", "bearish", "neutral", "volatile"]);
export const OBJECTIVES = Object.freeze(["expectedValue", "popAdjusted", "riskReward"]);
export const MAX_CANDIDATES = 2000;
const GRID = 800;
const SIGMAS = 5;
const STRESS_SIGMAS = 2.5;
const MAX_LOTS = 1000;
const OFFSETS = Object.freeze([-3, -2, -1, 0, 1, 2, 3, 4, 5, 6]);
const WIDTHS = Object.freeze([1, 2, 3, 4, 5]);

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const opt = (q, name) => {
  const v = q.get(name);
  return v === null || v === "" ? undefined : v;
};
const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const inr = (v) => `Rs ${Math.round(Math.abs(v)).toLocaleString("en-IN")}`;

function erf(x) {
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return Math.sign(x) * y;
}
const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

/** Fixed price grid and lognormal cell masses for one spot / IV / time. */
export function lognormalGrid(spot, ivPct, days) {
  const sd = (ivPct / 100) * Math.sqrt(Math.max(days, 0.25) / 365);
  const mu = Math.log(spot) - 0.5 * sd * sd;
  const from = spot * Math.exp(-SIGMAS * sd);
  const to = spot * Math.exp(SIGMAS * sd);
  const step = (to - from) / GRID;
  const cdf = (p) => (p <= 0 ? 0 : normCdf((Math.log(p) - mu) / sd));
  const edge = Array.from({ length: GRID + 1 }, (_, i) => cdf(from + i * step));
  const cells = Array.from({ length: GRID }, (_, i) => edge[i + 1] - edge[i]);
  return { sd, from, to, step, lowTail: edge[0], highTail: 1 - edge[GRID], cells };
}

/** { pop, ev } per 1 lot from a payoff curve sampled on a lognormalGrid. */
export function integrate(curve, grid) {
  let pop = 0;
  let ev = 0;
  const first = curve[0].pnl;
  const last = curve[curve.length - 1].pnl;
  ev += grid.lowTail * first + grid.highTail * last;
  if (first > 0) pop += grid.lowTail;
  if (last > 0) pop += grid.highTail;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1].pnl;
    const b = curve[i].pnl;
    const m = grid.cells[i - 1];
    ev += m * (a + b) / 2;
    if (a > 0 && b > 0) pop += m;
    else if (a > 0 || b > 0) pop += (m * Math.max(a, b)) / (Math.abs(a) + Math.abs(b));
  }
  return { pop: Math.min(1, Math.max(0, pop)), ev };
}

function rationale(c, view, underlying) {
  const lot = c.lots === 1 ? "1 lot" : `${c.lots} lots`;
  const legs = c.legs.map((l) => `${l.side} ${l.strike ?? "future"} ${l.type === "FUT" ? "" : l.type}`.trim()).join(", ");
  const be = c.breakevens.length ? `break-even${c.breakevens.length > 1 ? "s" : ""} ${c.breakevens.join(" and ")}` : "no break-even in range";
  const cash = c.netPremium >= 0 ? `collects ${inr(c.netPremium)} up front` : `costs ${inr(c.netPremium)} up front`;
  const risk = c.unboundedRisk ? "risk is not capped" : `the most you can lose is ${inr(c.maxLoss)}`;
  const gain = c.unboundedProfit ? "profit is not capped" : `the most you can make is ${inr(c.maxProfit)}`;
  const fit = { bullish: `suits a rise in ${underlying}`, bearish: `suits a fall in ${underlying}`, neutral: `suits ${underlying} staying in a range`, volatile: `suits a big move in ${underlying} either way` }[view];
  return `${c.name} (${legs}; ${lot}) ${fit}. It ${cash}; ${gain}, ${risk}; ${be}. Model chance of profit ${round(c.probabilityOfProfitPct, 1)}%, expected value ${c.expectedValue < 0 ? "-" : ""}${inr(c.expectedValue)}.`;
}

/**
 * Pure search over a chain. Returns { evaluated, passed, results }. `chain` is a Bridge option chain with atmStrike.
 */
export function optimize(chain, { view, days, futurePrice = null, maxLoss, minPop, capital, objective = "expectedValue", top = 5, underlying = "the underlying" }) {
  const { iv, source } = atmIvOf(chain, days);
  if (!(iv > 0)) throw new BridgeError("UPSTREAM_ERROR", "The chain has no usable implied volatility, so the optimizer cannot model the expiry distribution.");
  const spot = Number(chain.underlyingLtp);
  const grid = lognormalGrid(spot, iv, days);
  const seen = new Set();
  const kept = [];
  let evaluated = 0;
  let unpriced = 0;
  let rejected = 0;
  search: for (const t of TEMPLATES.filter((x) => x.views.includes(view))) {
    for (const offset of t.usesOffset ? OFFSETS : [0]) {
      for (const width of t.usesWidth ? WIDTHS : [0]) {
        if (evaluated >= MAX_CANDIDATES) break search;
        evaluated++;
        const b = buildTemplate(chain, t, { offset, width, futurePrice });
        if (b.error) {
          unpriced++;
          continue;
        }
        const key = t.id + JSON.stringify(b.legs.map((l) => [l.type, l.side, l.strike, l.lots]));
        if (seen.has(key)) continue;
        seen.add(key);
        const p = strategyPayoff(b.legs, { spot: b.spot, from: grid.from, to: grid.to, step: grid.step });
        const { pop, ev } = integrate(p.curve, grid);
        const bounded = !p.unboundedLoss && !p.lossAtZero && p.maxLoss !== null;
        const stress = Math.min(...p.curve.filter((c) => Math.abs(Math.log(c.price / b.spot)) <= STRESS_SIGMAS * grid.sd).map((c) => c.pnl));
        const lossPerLot = bounded ? Math.max(Math.abs(Math.min(0, p.maxLoss)), Math.max(0, -p.netPremium)) : Math.abs(Math.min(0, stress));
        const capPerLot = Math.max(lossPerLot, 1);
        let lots = 1;
        if (capital !== undefined) lots = Math.floor(capital / capPerLot);
        if (maxLoss !== undefined) {
          if (!bounded) {
            rejected++;
            continue;
          }
          lots = Math.min(lots, Math.floor(maxLoss / Math.max(lossPerLot, 1e-9)));
        }
        lots = Math.min(lots, MAX_LOTS);
        if (lots < 1 || (minPop !== undefined && pop * 100 < minPop)) {
          rejected++;
          continue;
        }
        const rr = p.maxProfit !== null && bounded ? (lossPerLot > 0 ? p.maxProfit / lossPerLot : 5) : p.unboundedProfit && bounded ? 5 : 0;
        const score = objective === "riskReward" ? Math.min(rr, 5) : objective === "popAdjusted" ? (ev / capPerLot) * pop : ev * lots;
        kept.push({
          template: t.id, name: t.name, params: { offset: t.usesOffset ? offset : null, width: t.usesWidth ? width : null },
          legs: b.legs.map((l) => ({ ...l, lots: l.lots * lots })), lots, lotSize: b.lotSize,
          netPremium: round(p.netPremium * lots, 2), credit: p.netPremium > 0,
          maxProfit: p.maxProfit === null ? null : round(p.maxProfit * lots, 2), unboundedProfit: Boolean(p.unboundedProfit),
          maxLoss: bounded ? round(Math.min(0, p.maxLoss) * lots, 2) : null, unboundedRisk: !bounded,
          breakevens: p.breakevens,
          probabilityOfProfitPct: round(pop * 100, 2), expectedValue: round(ev * lots, 2),
          capitalRequired: round(capPerLot * lots, 2), capitalBasis: bounded ? "max loss" : `stress loss at ${STRESS_SIGMAS} sigma`,
          riskReward: round(Math.min(rr, 5), 3), score: round(score, 6),
        });
      }
    }
  }
  kept.sort((a, b) => b.score - a.score || b.probabilityOfProfitPct - a.probabilityOfProfitPct || (a.template < b.template ? -1 : 1));
  const results = kept.slice(0, top).map((c, i) => ({ rank: i + 1, ...c, rationale: rationale({ ...c, maxLoss: c.maxLoss === null ? null : c.maxLoss, expectedValue: c.expectedValue }, view, underlying) }));
  return { atmIv: round(iv, 2), atmIvSource: source, evaluated, unpriced, rejected, passed: kept.length, results };
}

/** @param {object} deps full deps passed to register(); only deps.marketData is used (reads). */
export function optimizerRoutes(deps) {
  const md = () => deps.marketData;
  const nowDate = () => new Date(typeof deps.now === "function" ? deps.now() : deps.clock?.now ? deps.clock.now() : Date.now());

  function numParam(q, name, { min, max, gt = false }) {
    const v = opt(q, name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || (gt ? n <= min : n < min) || n > max) throw invalid(name, `${name} must be a number ${gt ? "above" : "from"} ${min}${max < Infinity ? ` ${gt ? "up to" : "to"} ${max}` : ""}.`);
    return n;
  }

  async function handler(ctx) {
    const q = ctx.query;
    const underlying = opt(q, "underlying");
    if (!underlying) throw invalid("underlying", "underlying is required, for example NIFTY.");
    const expiry = opt(q, "expiry");
    if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw invalid("expiry", "expiry is required as YYYY-MM-DD.");
    const view = (opt(q, "view") ?? "").toLowerCase();
    if (!OPTIMIZER_VIEWS.includes(view)) throw invalid("view", `view must be one of ${OPTIMIZER_VIEWS.join(", ")}.`);
    const objective = opt(q, "objective") ?? "expectedValue";
    if (!OBJECTIVES.includes(objective)) throw invalid("objective", `objective must be one of ${OBJECTIVES.join(", ")}.`);
    const maxLoss = numParam(q, "maxLoss", { min: 0, max: Infinity, gt: true });
    const minPop = numParam(q, "minPop", { min: 0, max: 100 });
    const capital = numParam(q, "capital", { min: 0, max: Infinity, gt: true });
    const topRaw = opt(q, "top");
    if (topRaw !== undefined && (!/^\d+$/.test(topRaw) || Number(topRaw) < 1 || Number(topRaw) > 20)) throw invalid("top", "top must be a whole number from 1 to 20.");
    const top = topRaw === undefined ? 5 : Number(topRaw);

    const opts = readOptionsBase(ctx, { autoBackup: autoBackupFor(deps) });
    const u = underlying.toUpperCase();
    const chain = await md().optionChain({ underlying, expiry, strikes: 15, greeks: true }, opts);
    let futurePrice = null;
    if (TEMPLATES.some((t) => t.usesFuture && t.views.includes(view))) {
      try {
        const sym = `${defaultOptionExchange(u)}:${u}-${expiry}-FUT`;
        futurePrice = (await md().quotes([sym], opts)).items.find((i) => i.symbol === sym)?.ltp ?? null;
      } catch {
        futurePrice = null;
      }
    }
    const days = Math.max(daysBetween(nowDate(), expiry), 0.25);
    const found = optimize(chain, { view, days, futurePrice, maxLoss, minPop, capital, objective, top, underlying: u });
    return {
      data: {
        underlying: u, expiry, view, objective, spot: chain.underlyingLtp ?? null, atmStrike: chain.atmStrike ?? null, daysToExpiry: round(days, 2),
        constraints: { maxLoss: maxLoss ?? null, minPopPct: minPop ?? null, capital: capital ?? null },
        model: "Lognormal expiry price, zero drift, flat ATM IV, payoff integrated numerically on an 801-point grid over +/-5 sigma. Screening model, not a forecast.",
        ...found,
      },
      meta: { requestId: ctx.requestId, accountId: opts.accountId ?? null, ...(chain.freshness ? { freshness: chain.freshness } : {}) },
    };
  }

  return [["GET", "/v1/analytics/optimizer", { scope: "read" }, handler]];
}
