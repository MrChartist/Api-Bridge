/**
 * Greeks grid, synthetic futures and ATM straddle analytics (stream S15), ported from OptionsDesk GreeksHeatmap,
 * SyntheticFutures and StraddleCharts. Read-only. Pure functions first, then `greeksGridRoutes(deps)`.
 *
 *   GET /v1/analytics/greeks-grid?underlying=&expiry=[&strikes=]   per-strike Greeks and IV, totals, peak gamma/vega
 *   GET /v1/analytics/synthetic?underlying=&expiry=[&strikes=]     put-call parity synthetic future per strike
 *   GET /v1/analytics/straddle?underlying=&expiry=[&interval=5m][&countback=]  ATM straddle now and its history
 */
import { BridgeError } from "../core/errors.mjs";
import { defaultOptionExchange, legSymbol } from "../market/chain.mjs";
import { autoBackupFor, readOptionsBase } from "../market/routes.mjs";

const num = (v) => (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const rowsOf = (chain) => (Array.isArray(chain?.rows) ? chain.rows : []);
const sumOf = (list) => list.reduce((t, v) => t + (v ?? 0), 0);

const GREEKS = ["delta", "gamma", "theta", "vega"];
const cell = (leg) => ({
  ltp: num(leg?.ltp),
  iv: num(leg?.iv),
  delta: num(leg?.delta),
  gamma: num(leg?.gamma),
  theta: num(leg?.theta),
  vega: num(leg?.vega),
});

/** Strike with the largest `pick(row)` (first on ties), or null when nothing is positive. */
function peak(strikes, pick) {
  let best = null;
  for (const s of strikes) {
    const v = pick(s);
    if (v !== null && v > 0 && (best === null || v > best.value)) best = { strike: s.strike, value: v };
  }
  return best;
}

/** Per-strike Greeks and IV for CE and PE, column totals, and the strike of peak gamma and vega. */
export function greeksGrid(chain) {
  const strikes = rowsOf(chain).map((r) => ({ strike: r.strike, ce: cell(r.ce), pe: cell(r.pe) }));
  const side = (key) => {
    const t = {};
    for (const g of GREEKS) t[g] = round(sumOf(strikes.map((s) => s[key][g])), 6);
    const ivs = strikes.map((s) => s[key].iv).filter((v) => v !== null && v > 0);
    t.avgIv = ivs.length ? round(sumOf(ivs) / ivs.length, 2) : null;
    return t;
  };
  const both = (g) => (s) => (s.ce[g] === null && s.pe[g] === null ? null : (s.ce[g] ?? 0) + (s.pe[g] ?? 0));
  const peakOf = (g) => ({
    combined: peak(strikes, both(g)),
    ce: peak(strikes, (s) => s.ce[g]),
    pe: peak(strikes, (s) => s.pe[g]),
  });
  return {
    underlying: chain?.underlying ?? null,
    expiry: chain?.expiry ?? null,
    underlyingLtp: chain?.underlyingLtp ?? null,
    atmStrike: chain?.atmStrike ?? null,
    strikes,
    totals: { ce: side("ce"), pe: side("pe") },
    peakGamma: peakOf("gamma"),
    peakVega: peakOf("vega"),
    peakGammaStrike: peakOf("gamma").combined?.strike ?? null,
    peakVegaStrike: peakOf("vega").combined?.strike ?? null,
  };
}

/**
 * Synthetic future per strike via put-call parity: strike + CE - PE. `future` (optional) is the traded futures
 * price; the arbitrage gap is synthetic minus the futures price (spot when there is no futures price).
 * A positive gap means the synthetic is rich: sell the synthetic, buy the future.
 */
export function syntheticFutures(chain, { future = null } = {}) {
  const spot = num(chain?.underlyingLtp);
  const fut = num(future) > 0 ? Number(future) : null;
  const ref = fut ?? (spot > 0 ? spot : null);
  const strikes = [];
  for (const r of rowsOf(chain)) {
    const ce = num(r.ce?.ltp);
    const pe = num(r.pe?.ltp);
    if (!(ce > 0) || !(pe > 0)) continue;
    const synthetic = r.strike + ce - pe;
    const gap = ref === null ? null : synthetic - ref;
    strikes.push({
      strike: r.strike,
      ce,
      pe,
      synthetic: round(synthetic),
      vsSpot: spot > 0 ? round(synthetic - spot) : null,
      vsFuture: fut ? round(synthetic - fut) : null,
      arbitrageGap: round(gap),
      arbitrageGapPct: gap === null ? null : round((gap / ref) * 100, 4),
      direction: gap === null || gap === 0 ? null : gap > 0 ? "sell-synthetic" : "buy-synthetic",
    });
  }
  const widest = strikes.reduce((b, s) => (s.arbitrageGap !== null && (b === null || Math.abs(s.arbitrageGap) > Math.abs(b.arbitrageGap)) ? s : b), null);
  const atm = strikes.find((s) => s.strike === chain?.atmStrike) ?? null;
  return {
    underlying: chain?.underlying ?? null,
    expiry: chain?.expiry ?? null,
    spot,
    future: fut,
    referenceSource: fut ? "future" : spot > 0 ? "spot" : null,
    atmStrike: chain?.atmStrike ?? null,
    atmSynthetic: atm?.synthetic ?? null,
    widestGapStrike: widest?.strike ?? null,
    strikes,
  };
}

/** Join CE and PE candles on time; each point is straddle close = ce.close + pe.close. Candles missing on either side are dropped. */
export function straddleHistory(ceCandles, peCandles) {
  const pe = new Map();
  for (const c of peCandles ?? []) if (num(c?.close) !== null) pe.set(c.time, c);
  const out = [];
  for (const c of ceCandles ?? []) {
    const p = pe.get(c.time);
    if (!p || num(c.close) === null) continue;
    out.push({ time: c.time, ce: c.close, pe: p.close, straddle: round(c.close + p.close, 2) });
  }
  return out.sort((a, b) => a.time - b.time);
}

/**
 * ATM straddle now, with history, percent change from the first history point, and implied move (straddle / spot).
 * @param {object} chain
 * @param {Array<{time:number, ce:number, pe:number, straddle:number}>} [history]
 */
export function straddleSummary(chain, history = []) {
  const spot = num(chain?.underlyingLtp);
  const row = rowsOf(chain).find((r) => r.strike === chain?.atmStrike) ?? null;
  const ce = num(row?.ce?.ltp);
  const pe = num(row?.pe?.ltp);
  const premium = ce > 0 && pe > 0 ? round(ce + pe) : null;
  const first = history[0]?.straddle ?? null;
  const last = history.at(-1)?.straddle ?? null;
  const base = first > 0 ? first : null;
  const change = premium !== null && base !== null ? premium - base : null;
  const impliedMove = premium !== null && spot > 0 ? premium : null;
  return {
    underlying: chain?.underlying ?? null,
    expiry: chain?.expiry ?? null,
    spot,
    atmStrike: row?.strike ?? null,
    ceSymbol: row?.ce?.symbol ?? null,
    peSymbol: row?.pe?.symbol ?? null,
    ce,
    pe,
    premium,
    change: round(change),
    changePct: change === null ? null : round((change / base) * 100, 2),
    impliedMove,
    impliedMovePct: impliedMove === null ? null : round((impliedMove / spot) * 100, 2),
    upperBreakeven: premium !== null && row ? round(row.strike + premium) : null,
    lowerBreakeven: premium !== null && row ? round(row.strike - premium) : null,
    historyHigh: history.length ? Math.max(...history.map((h) => h.straddle)) : null,
    historyLow: history.length ? Math.min(...history.map((h) => h.straddle)) : null,
    lastHistoryPoint: last,
    history,
  };
}

const INTERVALS = ["1m", "3m", "5m", "10m", "15m", "30m", "60m"];
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

/** @param {object} deps full deps (needs marketData) */
export function greeksGridRoutes(deps) {
  const md = () => deps.marketData;
  const readOptions = (ctx) => readOptionsBase(ctx, { autoBackup: autoBackupFor(deps) });
  const meta = (ctx, opts, freshness) => ({ requestId: ctx.requestId, accountId: opts.accountId ?? null, ...(freshness ? { freshness } : {}) });

  async function chainFor(ctx, { greeks = true } = {}) {
    const q = ctx.query;
    const underlying = opt(q, "underlying");
    if (!underlying) throw invalid("underlying", "underlying is required, for example NIFTY.");
    const expiry = opt(q, "expiry");
    if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw invalid("expiry", "expiry is required as YYYY-MM-DD.");
    const params = { underlying, expiry, greeks };
    const strikes = intParam(q, "strikes", 1, 100);
    if (strikes !== undefined) params.strikes = strikes;
    const opts = readOptions(ctx);
    return { chain: await md().optionChain(params, opts), opts, underlying: underlying.toUpperCase(), expiry };
  }

  return [
    [
      "GET",
      "/v1/analytics/greeks-grid",
      { scope: "read" },
      async (ctx) => {
        const { chain, opts } = await chainFor(ctx);
        return { data: greeksGrid(chain), meta: meta(ctx, opts, chain.freshness) };
      },
    ],
    [
      "GET",
      "/v1/analytics/synthetic",
      { scope: "read" },
      async (ctx) => {
        const { chain, opts, underlying, expiry } = await chainFor(ctx, { greeks: false });
        const fx = defaultOptionExchange(underlying);
        const futureSymbol = `${fx}:${underlying}-${expiry}-FUT`;
        let future = null;
        let errors;
        try {
          const r = await md().quotes([futureSymbol], opts);
          future = r.items.find((i) => i.symbol === futureSymbol)?.ltp ?? r.items[0]?.ltp ?? null;
          if (r.errors?.length) errors = r.errors;
        } catch (err) {
          if (err?.code === "VALIDATION_FAILED") throw err;
          errors = [{ symbol: futureSymbol, code: err?.code ?? "INTERNAL", message: err?.detail ?? err?.message ?? "futures quote failed" }];
        }
        const data = { ...syntheticFutures(chain, { future }), futureSymbol };
        return { data, ...(errors ? { errors } : {}), meta: meta(ctx, opts, chain.freshness) };
      },
    ],
    [
      "GET",
      "/v1/analytics/straddle",
      { scope: "read" },
      async (ctx) => {
        const interval = opt(ctx.query, "interval") ?? "5m";
        if (!INTERVALS.includes(interval)) throw invalid("interval", `interval must be one of ${INTERVALS.join(", ")}.`);
        const countback = intParam(ctx.query, "countback", 1, 5000, 75);
        const { chain, opts, underlying, expiry } = await chainFor(ctx, { greeks: false });
        const atm = chain.atmStrike;
        const row = rowsOf(chain).find((r) => r.strike === atm);
        let history = [];
        if (row) {
          const fx = defaultOptionExchange(underlying);
          const ceSym = row.ce?.symbol ?? legSymbol(fx, underlying, expiry, atm, "CE");
          const peSym = row.pe?.symbol ?? legSymbol(fx, underlying, expiry, atm, "PE");
          const [ce, pe] = await Promise.all([
            md().history({ symbol: ceSym, interval, countback }, opts),
            md().history({ symbol: peSym, interval, countback }, opts),
          ]);
          history = straddleHistory(ce.candles, pe.candles);
        }
        return { data: { interval, countback, ...straddleSummary(chain, history) }, meta: meta(ctx, opts, chain.freshness) };
      },
    ],
  ];
}
