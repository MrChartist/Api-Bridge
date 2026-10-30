/**
 * Expiry-day digest and time-machine replay helper, stream S15 (read only). Ported from OptionsDesk's
 * ExpiryDayDashboard and TimeMachine pages, which showed generated sample data; everything here is computed
 * from the Bridge's own chain, quotes and history.
 *
 *   GET /v1/analytics/expiry-day?underlying=[&expiry=][&strikes=][&maxPainPct=][&decayPct=]
 *   GET /v1/analytics/time-machine?symbol=&interval=&from=[&to=][&step=][&account=]
 *
 * Historical option chains are not stored anywhere in the Bridge, so time-machine returns real candles plus the
 * ATM strike each bar would have had; it never invents premiums, OI or Greeks for the past.
 */
import { BridgeError } from "../core/errors.mjs";
import { autoBackupFor, readOptionsBase } from "../market/routes.mjs";
import { istDate, toIstIso } from "../market/time.mjs";
import { gammaExposure, oiAnalysis } from "./math.mjs";

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const opt = (q, name) => {
  const v = q.get(name);
  return v === null || v === "" ? undefined : v;
};
const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function numParam(q, name, { min, max, dflt } = {}) {
  const v = opt(q, name);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || (min !== undefined && n < min) || (max !== undefined && n > max)) {
    throw invalid(name, `${name} must be a number from ${min ?? "-inf"} to ${max ?? "inf"}.`);
  }
  return n;
}

/** Cutoff for an expiring option: 15:30 IST on the expiry date, as epoch ms. */
export const expiryCutoffMs = (expiry) => Date.parse(`${expiry}T15:30:00+05:30`);

/** Hours from `nowMs` to the 15:30 IST cutoff of `expiry`; 0 once it has passed. */
export function hoursToExpiry(expiry, nowMs) {
  return Math.max(0, round((expiryCutoffMs(expiry) - nowMs) / 3_600_000, 2));
}

/** Default strike spacing when the caller gives none (index options). */
const STEPS = { NIFTY: 50, BANKNIFTY: 100, FINNIFTY: 50, MIDCPNIFTY: 25, SENSEX: 100, BANKEX: 100 };
const stepFor = (underlying) => STEPS[String(underlying).toUpperCase()] ?? 50;

export function expiryDayRoutes(deps) {
  const md = () => deps.marketData;
  const now = () => (typeof deps.now === "function" ? deps.now() : Date.now());
  const readOptions = (ctx, o) => readOptionsBase(ctx, { ...o, autoBackup: autoBackupFor(deps) });
  const meta = (ctx, opts, freshness) => ({ requestId: ctx.requestId, accountId: opts.accountId ?? null, ...(freshness ? { freshness } : {}) });

  async function expiryDay(ctx) {
    const q = ctx.query;
    const underlying = opt(q, "underlying");
    if (!underlying) throw invalid("underlying", "underlying is required, for example NIFTY.");
    let expiry = opt(q, "expiry");
    if (expiry !== undefined && !DATE_RE.test(expiry)) throw invalid("expiry", "expiry must be YYYY-MM-DD.");
    const strikes = numParam(q, "strikes", { min: 1, max: 100 });
    if (strikes !== undefined && !Number.isInteger(strikes)) throw invalid("strikes", "strikes must be a whole number from 1 to 100.");
    const maxPainPct = numParam(q, "maxPainPct", { min: 0, dflt: 0.5 });
    const decayPct = numParam(q, "decayPct", { min: 0, max: 100, dflt: 50 });
    const opts = readOptions(ctx);
    const nowMs = now();

    if (!expiry) {
      const list = await md().expiries(underlying, opts);
      const today = istDate(nowMs);
      expiry = list.expiries.filter((e) => e >= today).sort()[0];
      if (!expiry) throw new BridgeError("SYMBOL_NOT_FOUND", `No upcoming expiry was found for ${underlying}.`);
    }

    const params = { underlying, expiry, greeks: true };
    if (strikes !== undefined) params.strikes = strikes;
    const chain = await md().optionChain(params, opts);
    const spot = chain.underlyingLtp ?? null;
    const row = chain.rows.find((r) => r.strike === chain.atmStrike) ?? null;
    const oi = oiAnalysis(chain);
    const gex = gammaExposure(chain);

    // ATM straddle: live price and, from the day's open prices of the same two legs, how much of it has decayed.
    const ce = row?.ce?.ltp ?? null;
    const pe = row?.pe?.ltp ?? null;
    const price = ce != null && pe != null ? round(ce + pe) : null;
    let openPrice = null;
    if (price !== null && row?.ce?.symbol && row?.pe?.symbol) {
      try {
        const r = await md().quotes([row.ce.symbol, row.pe.symbol], opts);
        const o = (s) => r.items.find((i) => i.symbol === s)?.open ?? null;
        const [oc, op] = [o(row.ce.symbol), o(row.pe.symbol)];
        if (oc != null && op != null) openPrice = round(oc + op);
      } catch {
        openPrice = null;
      }
    }
    const decayedPct = openPrice && price !== null ? round(((openPrice - price) / openPrice) * 100) : null;
    const straddle = {
      strike: chain.atmStrike ?? null,
      cePrice: ce,
      pePrice: pe,
      price,
      impliedMove: price,
      impliedMovePct: price !== null && spot > 0 ? round((price / spot) * 100, 3) : null,
      upperBreakeven: price !== null ? round(chain.atmStrike + price) : null,
      lowerBreakeven: price !== null ? round(chain.atmStrike - price) : null,
      dayOpenPrice: openPrice,
      decayedPct,
    };

    const mp = oi.maxPain;
    const distance = mp != null && spot != null ? round(spot - mp) : null;
    const distancePct = distance !== null && mp > 0 ? round((distance / mp) * 100, 3) : null;

    const flags = [];
    if (distancePct !== null && Math.abs(distancePct) >= maxPainPct) {
      flags.push({
        code: "SPOT_BEYOND_MAX_PAIN",
        severity: Math.abs(distancePct) >= maxPainPct * 2 ? "high" : "medium",
        message: `Spot ${spot} is ${Math.abs(distancePct)}% ${distance > 0 ? "above" : "below"} max pain ${mp} (threshold ${maxPainPct}%).`,
        value: distancePct,
        threshold: maxPainPct,
      });
    }
    if (decayedPct !== null && decayedPct >= decayPct) {
      flags.push({
        code: "STRADDLE_DECAYED",
        severity: "medium",
        message: `ATM straddle is down ${decayedPct}% from its day-open price ${openPrice} to ${price} (threshold ${decayPct}%).`,
        value: decayedPct,
        threshold: decayPct,
      });
    }
    if (gex.regime === "negative") {
      flags.push({ code: "NEGATIVE_GAMMA", severity: "medium", message: "Dealer gamma is net negative, so moves can be amplified.", value: gex.netGex, threshold: 0 });
    }
    const hours = hoursToExpiry(expiry, nowMs);
    if (hours === 0) {
      flags.push({ code: "EXPIRY_PASSED", severity: "low", message: `The 15:30 IST cutoff for ${expiry} has passed.`, value: 0, threshold: 0 });
    }

    const data = {
      underlying: chain.underlying,
      expiry,
      asOf: toIstIso(nowMs),
      spot,
      timeToExpiry: { cutoff: `${expiry}T15:30:00+05:30`, hours, isExpiryDay: istDate(nowMs) === expiry },
      straddle,
      maxPain: { strike: mp, spotDistance: distance, spotDistancePct: distancePct, side: distance === null ? null : distance > 0 ? "spot above" : distance < 0 ? "spot below" : "at max pain" },
      oiWalls: { resistance: oi.resistance, support: oi.support, pcrOi: oi.pcrOi },
      gamma: { regime: gex.regime, netGex: gex.netGex, unit: gex.unit, flipStrike: gex.flipStrike, largestStrike: gex.largestStrike },
      flags,
      thresholds: { maxPainPct, decayPct },
    };
    return { data, meta: meta(ctx, opts, chain.freshness) };
  }

  async function timeMachine(ctx) {
    const q = ctx.query;
    const symbol = opt(q, "symbol");
    if (!symbol) throw invalid("symbol", "symbol is required, for example NSE:NIFTY.");
    const interval = opt(q, "interval");
    if (!interval) throw invalid("interval", "interval is required: 1m, 3m, 5m, 10m, 15m, 30m, 60m, 1d, 1w or 1M.");
    const from = opt(q, "from");
    if (!from) throw invalid("from", "from is required.");
    const step = numParam(q, "step", { min: 0.01 });
    const params = { symbol, interval, from };
    const to = opt(q, "to");
    if (to !== undefined) params.to = to;
    const opts = readOptions(ctx, { maxAge: false });
    const h = await md().history(params, opts);
    const bare = h.symbol.split(":").pop().split("-")[0];
    const strikeStep = step ?? stepFor(bare);
    const atmOf = (px) => Math.round(px / strikeStep) * strikeStep;
    let prevAtm = null;
    const first = h.candles[0]?.open ?? null;
    const bars = h.candles.map((c) => {
      const atm = atmOf(c.close);
      const bar = {
        time: c.time,
        timeIst: toIstIso(c.time * 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        atmStrike: atm,
        atmShift: prevAtm === null ? 0 : atm - prevAtm,
        moveFromStart: first ? round(c.close - first) : null,
        moveFromStartPct: first ? round(((c.close - first) / first) * 100, 3) : null,
        barRange: round(c.high - c.low),
      };
      prevAtm = atm;
      return bar;
    });
    const data = {
      symbol: h.symbol,
      interval: h.interval,
      strikeStep,
      strikeStepSource: step === undefined ? "default for underlying" : "request",
      count: bars.length,
      partial: Boolean(h.partial),
      bars,
      limitations: [
        "Historical option chains are not stored by the Bridge, so premiums, OI, IV, Greeks, max pain and straddle prices are not available for past bars and are not estimated.",
        "atmStrike is the nearest multiple of strikeStep to each bar's close; it shows which strike was at the money, not what it cost.",
        "Use the live /v1/analytics/expiry-day digest for current option data.",
      ],
    };
    return { data, meta: meta(ctx, opts, h.freshness) };
  }

  return [
    ["GET", "/v1/analytics/expiry-day", { scope: "read" }, expiryDay],
    ["GET", "/v1/analytics/time-machine", { scope: "read" }, timeMachine],
  ];
}
