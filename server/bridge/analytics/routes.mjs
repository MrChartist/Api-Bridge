/**
 * Route handlers for stream S15 (docs/openapi.yaml, tag "Analytics"). Read-only: nothing here can place an order.
 *
 *   GET  /v1/analytics/oi?underlying=&expiry=[&strikes=]           PCR, max pain, support/resistance, OI by strike
 *   GET  /v1/analytics/gex?underlying=&expiry=[&strikes=]          dealer gamma exposure by strike, flip strike
 *   GET  /v1/analytics/skew?underlying=&expiry=[&strikes=][&width=] IV by strike, ATM IV, risk reversal
 *   GET  /v1/analytics/surface?underlying=[&expiries=3][&strikes=]  ATM IV and skew across the next expiries
 *   GET  /v1/analytics/basis?underlying=&expiry=                   futures basis, percent and annualised carry
 *   GET  /v1/analytics/greeks?spot=&strike=&type=&days=&(iv=|price=) Black-Scholes IV and Greeks for one option
 *   POST /v1/analytics/payoff                                      expiry payoff curve for a multi-leg strategy
 *   POST /v1/analytics/position-size                               lots for a given risk budget
 *
 * Chain-based routes read through marketData (same freshness, account pinning and rate limits as /v1/optionchain).
 */
import { z } from "zod";
import { BridgeError } from "../core/errors.mjs";
import { defaultOptionExchange } from "../market/chain.mjs";
import { autoBackupFor, readOptionsBase } from "../market/routes.mjs";
import { bsPrice, computeGreeks, daysBetween, DEFAULT_RATE } from "../../lib/blackScholes.mjs";
import { futuresBasis, gammaExposure, ivSkew, oiAnalysis, positionSize, strategyPayoff } from "./math.mjs";

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const opt = (q, name) => {
  const v = q.get(name);
  return v === null || v === "" ? undefined : v;
};
function intParam(q, name, min, max, dflt) {
  const v = opt(q, name);
  if (v === undefined) return dflt;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw invalid(name, `${name} must be a whole number from ${min} to ${max}.`);
  return Number(v);
}
function numParam(q, name, { min = -Infinity, required = false } = {}) {
  const v = opt(q, name);
  if (v === undefined) {
    if (required) throw invalid(name, `${name} is required.`);
    return undefined;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw invalid(name, `${name} must be a number${min > -Infinity ? ` of at least ${min}` : ""}.`);
  return n;
}

function parseBody(schema, body) {
  const r = schema.safeParse(body ?? {});
  if (r.success) return r.data;
  const errors = r.error.issues.map((i) => ({ path: i.path.join(".") || "(body)", message: i.message }));
  throw new BridgeError("VALIDATION_FAILED", `The request is not valid: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`, { errors });
}

const leg = z.strictObject({
  type: z.enum(["CE", "PE", "FUT"]),
  side: z.enum(["buy", "sell"]),
  strike: z.number().positive().optional(),
  price: z.number().min(0),
  lots: z.number().int().min(1).max(10_000).default(1),
  lotSize: z.number().int().min(1).max(100_000).default(1),
});
const payoffBody = z.strictObject({
  legs: z.array(leg).min(1).max(12),
  spot: z.number().positive().optional(),
  from: z.number().min(0).optional(),
  to: z.number().positive().optional(),
  step: z.number().positive().optional(),
});
const sizeBody = z.strictObject({
  capital: z.number().positive(),
  riskPct: z.number().positive().max(100),
  entry: z.number().positive(),
  stop: z.number().positive(),
  lotSize: z.number().int().min(1).default(1),
  maxLots: z.number().int().min(0).optional(),
});

/** @param {object} deps full deps passed to register() */
export function createAnalyticsRoutes(deps) {
  const md = () => deps.marketData;
  const readOptions = (ctx) => readOptionsBase(ctx, { autoBackup: autoBackupFor(deps) });
  const meta = (ctx, opts, freshness) => ({ requestId: ctx.requestId, accountId: opts.accountId ?? null, ...(freshness ? { freshness } : {}) });

  async function chainFor(ctx) {
    const q = ctx.query;
    const underlying = opt(q, "underlying");
    if (!underlying) throw invalid("underlying", "underlying is required, for example NIFTY.");
    const expiry = opt(q, "expiry");
    if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw invalid("expiry", "expiry is required as YYYY-MM-DD.");
    const params = { underlying, expiry, greeks: true };
    const strikes = intParam(q, "strikes", 1, 100);
    if (strikes !== undefined) params.strikes = strikes;
    const opts = readOptions(ctx);
    return { chain: await md().optionChain(params, opts), opts };
  }

  const fromChain = (compute) => async (ctx) => {
    const { chain, opts } = await chainFor(ctx);
    return { data: compute(chain, ctx), meta: meta(ctx, opts, chain.freshness) };
  };

  return {
    oi: fromChain((c) => oiAnalysis(c)),
    gex: fromChain((c) => gammaExposure(c)),
    skew: fromChain((c, ctx) => ivSkew(c, { width: intParam(ctx.query, "width", 1, 20, 3) })),

    async surface(ctx) {
      const underlying = opt(ctx.query, "underlying");
      if (!underlying) throw invalid("underlying", "underlying is required, for example NIFTY.");
      const count = intParam(ctx.query, "expiries", 1, 6, 3);
      const strikes = intParam(ctx.query, "strikes", 1, 100, 10);
      const opts = readOptions(ctx);
      const list = await md().expiries(underlying, opts);
      const today = new Date().toISOString().slice(0, 10);
      const picked = list.expiries.filter((e) => e >= today).slice(0, count);
      const slices = [];
      for (const expiry of picked) {
        const chain = await md().optionChain({ underlying, expiry, strikes, greeks: true }, opts);
        const s = ivSkew(chain);
        slices.push({ expiry, daysToExpiry: Math.round(daysBetween(new Date(), expiry) * 100) / 100, atmIv: s.atmIv, riskReversal: s.riskReversal, points: s.points });
      }
      const [near, far] = [slices[0]?.atmIv, slices.at(-1)?.atmIv];
      const termStructure = slices.length < 2 || near == null || far == null ? null : far > near ? "contango" : far < near ? "backwardation" : "flat";
      return { data: { underlying, termStructure, expiries: slices }, meta: meta(ctx, opts, list.freshness) };
    },

    async basis(ctx) {
      const underlying = opt(ctx.query, "underlying");
      if (!underlying) throw invalid("underlying", "underlying is required, for example NIFTY.");
      const expiry = opt(ctx.query, "expiry");
      if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw invalid("expiry", "expiry is required as YYYY-MM-DD.");
      const opts = readOptions(ctx);
      const fx = defaultOptionExchange(underlying);
      const cash = fx === "BFO" ? "BSE" : "NSE";
      const spotSym = `${cash}:${underlying.toUpperCase()}`;
      const futSym = `${fx}:${underlying.toUpperCase()}-${expiry}-FUT`;
      const r = await md().quotes([spotSym, futSym], opts);
      const px = (sym) => r.items.find((i) => i.symbol === sym)?.ltp ?? null;
      const spot = px(spotSym);
      const future = px(futSym);
      const days = daysBetween(new Date(), expiry);
      return {
        data: { underlying: underlying.toUpperCase(), expiry, spotSymbol: spotSym, futureSymbol: futSym, spot, future, daysToExpiry: Math.round(days * 100) / 100, ...futuresBasis({ spot, future, daysToExpiry: days }) },
        errors: r.errors,
        meta: meta(ctx, opts),
      };
    },

    async greeks(ctx) {
      const q = ctx.query;
      const spot = numParam(q, "spot", { required: true, min: 0.01 });
      const strike = numParam(q, "strike", { required: true, min: 0.01 });
      const days = numParam(q, "days", { required: true, min: 0 });
      const type = (opt(q, "type") ?? "").toUpperCase();
      if (type !== "CE" && type !== "PE") throw invalid("type", "type must be CE or PE.");
      const iv = numParam(q, "iv", { min: 0.01 });
      const price = numParam(q, "price", { min: 0.01 });
      if ((iv === undefined) === (price === undefined)) throw invalid("iv", "Send exactly one of iv (percent) or price (option premium).");
      const rate = numParam(q, "rate", { min: 0 }) ?? DEFAULT_RATE * 100;
      let vol = iv === undefined ? undefined : iv / 100;
      if (vol === undefined) {
        // Same bisection the chain uses for brokers without Greeks, kept local so the calculator takes a bare price.
        const years = Math.max(days, 0.25) / 365;
        let lo = 0.001;
        let hi = 5;
        if (bsPrice({ spot, strike, rate: rate / 100, vol: hi, years, type }) < price) throw invalid("price", "That premium cannot be explained by any volatility below 500 %.");
        for (let i = 0; i < 60; i++) {
          const mid = (lo + hi) / 2;
          if (bsPrice({ spot, strike, rate: rate / 100, vol: mid, years, type }) > price) hi = mid;
          else lo = mid;
        }
        vol = (lo + hi) / 2;
      }
      const g = computeGreeks({ spot, strike, daysToExpiry: days, type, vol, rate: rate / 100 });
      const years = Math.max(days, 0.25) / 365;
      const theoretical = bsPrice({ spot, strike, rate: rate / 100, vol, years, type });
      const r4 = (v) => Math.round(v * 1e4) / 1e4;
      return { data: { spot, strike, type, daysToExpiry: days, ratePct: rate, ivPct: r4(vol * 100), price: r4(theoretical), delta: r4(g.delta), gamma: Math.round(g.gamma * 1e6) / 1e6, theta: r4(g.theta), vega: r4(g.vega) }, meta: { requestId: ctx.requestId } };
    },

    async payoff(ctx) {
      const b = parseBody(payoffBody, ctx.body);
      for (const [i, l] of b.legs.entries()) if (l.type !== "FUT" && !l.strike) throw invalid(`legs.${i}.strike`, "strike is required for CE and PE legs.");
      return { data: strategyPayoff(b.legs, b), meta: { requestId: ctx.requestId } };
    },

    async positionSize(ctx) {
      return { data: positionSize(parseBody(sizeBody, ctx.body)), meta: { requestId: ctx.requestId } };
    },
  };
}
