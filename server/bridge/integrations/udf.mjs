/**
 * TradingView UDF-compatible datafeed — stream S10 (docs/openapi.yaml, tag "Charting (UDF)").
 *
 *   GET /udf/config                                    datafeed configuration
 *   GET /udf/symbols?symbol=NSE:NIFTY                  LibrarySymbolInfo (session in Asia/Kolkata, minmov/pricescale)
 *   GET /udf/search?query=NIF[&type=][&exchange=][&limit=]
 *   GET /udf/history?symbol=&resolution=5&from=&to=[&countback=]
 *   GET /udf/time                                      server time, Unix seconds, plain text
 *   GET /udf/quotes?symbols=NSE:NIFTY,NSE:RELIANCE
 *
 * Wire format follows the UDF convention, not the /v1 envelope: Unix seconds, column arrays, and `s` = "ok" |
 * "no_data" | "error". Errors keep their real HTTP status and carry both the UDF fields (`s: "error"`, `errmsg`) and
 * the Bridge's `code`/`retryable`/`requestId`, so the TradingView library (which reads `s`) and scripts (which read the
 * status) both understand them.
 *
 * History rules (TradingView UDF spec):
 *  - `from` is inclusive and `to` exclusive (Unix seconds).
 *  - `countback`, when given, wins over `from`: return that many bars ending before `to`.
 *  - Daily, weekly and monthly bars are stamped 00:00 UTC of their trading date (IST calendar).
 *  - An empty range answers `{ s: "no_data", nextTime }` when an earlier bar exists (one small countback read),
 *    or `{ s: "no_data" }` when the history starts later, which tells the chart to stop scrolling back.
 *
 * Every read goes through deps.marketData, so it is streaming-first, cached, coalesced and rate limited like any
 * other Bridge read. Nothing here can place, modify or cancel an order: the module only reads marketData, symbols
 * and the clock.
 */
import { EXCHANGES, parseSymbol } from "../core/symbolFormat.mjs";
import { json, text } from "../core/http.mjs";
import { UDF_RESOLUTIONS } from "./config.mjs";
import { DAY_SECONDS, istInstant, utcMidnightOfIstDate } from "./ist.mjs";
import { asBridgeError, errorHeaders, intParam, invalid, listParam, opt, readOptions, req } from "./params.mjs";

/** UDF symbol type <-> Bridge instrument kind. */
export const UDF_TYPES = Object.freeze({ INDEX: "index", EQ: "stock", FUT: "futures", OPT: "option" });
const KIND_BY_TYPE = Object.freeze(Object.fromEntries(Object.entries(UDF_TYPES).map(([k, v]) => [v, k])));

const DAILY_INTERVALS = new Set(["1d", "1w", "1M"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Earliest `to` worth asking a broker about (1 Jan 1990). Older ranges answer no_data without a broker call. */
const EARLIEST = 631_152_000;

/**
 * UDF resolution -> Bridge interval. Accepts "5", "60", "1D", "D", "1W", "W", "1M", "M" (D/W case-insensitive; M must
 * be upper case because a lower-case "1m" would read as one minute elsewhere).
 * @param {string} resolution
 * @param {readonly string[]} supported  configured resolutions (UDF spelling)
 * @returns {string} Bridge interval
 */
export function resolutionToInterval(resolution, supported) {
  let r = String(resolution ?? "").trim();
  if (/^[dw]$/i.test(r) || /^1[dw]$/i.test(r)) r = `1${r.slice(-1).toUpperCase()}`;
  else if (r === "M") r = "1M";
  if (!supported.includes(r) || !Object.hasOwn(UDF_RESOLUTIONS, r)) {
    throw invalid("resolution", `resolution ${resolution || "(empty)"} is not supported. Use one of ${supported.join(", ")}.`);
  }
  return UDF_RESOLUTIONS[r];
}

/**
 * minmov / pricescale for a tick size: price steps are minmov / pricescale. 0.05 -> 5/100, 0.0025 -> 25/10000, 1 -> 1/1.
 * @param {number} tickSize
 */
export function priceFormat(tickSize) {
  const t = Number(tickSize);
  if (!(t > 0) || !Number.isFinite(t)) return { minmov: 1, pricescale: 100 };
  let decimals = 0;
  while (decimals < 8) {
    const scaled = t * 10 ** decimals;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-7) break;
    decimals += 1;
  }
  const pricescale = 10 ** decimals;
  return { minmov: Math.max(1, Math.round(t * pricescale)), pricescale };
}

/** "NSE:RELIANCE" -> "RELIANCE"; the chart shows this with `exchange` beside it. */
export const shortName = (canonical) => String(canonical).slice(String(canonical).indexOf(":") + 1);

/** Human description when the instrument master has no name: "NIFTY 27 Oct 2026 25000 CE". */
export function describe(p) {
  if (!p.expiry) return p.underlying;
  const [y, m, d] = p.expiry.split("-");
  const date = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  if (p.kind === "FUT") return `${p.underlying} ${date} FUT`;
  return `${p.underlying} ${date} ${p.strike} ${p.right}`;
}

/**
 * LibrarySymbolInfo for a resolved instrument.
 * @param {import("../core/contracts.mjs").ResolvedInstrument} r
 * @param {{ supportedResolutions: string[], sessions: Record<string, string> }} udf
 * @param {number} nowSeconds
 */
export function symbolInfo(r, udf, nowSeconds) {
  const { minmov, pricescale } = priceFormat(r.tickSize);
  const intraday = udf.supportedResolutions.filter((x) => /^\d+$/.test(x));
  const has = (x) => udf.supportedResolutions.includes(x);
  const info = {
    name: shortName(r.canonical),
    ticker: r.canonical,
    full_name: r.canonical,
    description: r.name || describe(r),
    type: UDF_TYPES[r.kind] ?? "stock",
    session: udf.sessions[r.exchange] ?? "0915-1530",
    exchange: r.exchange,
    listed_exchange: r.exchange,
    timezone: "Asia/Kolkata",
    format: "price",
    minmov,
    pricescale,
    has_intraday: intraday.length > 0,
    intraday_multipliers: intraday,
    has_daily: has("1D"),
    daily_multipliers: ["1"],
    has_weekly_and_monthly: has("1W") || has("1M"),
    weekly_multipliers: ["1"],
    monthly_multipliers: ["1"],
    has_empty_bars: false,
    supported_resolutions: [...udf.supportedResolutions],
    volume_precision: 0,
    visible_plots_set: r.kind === "INDEX" ? "ohlc" : "ohlcv",
    data_status: "streaming",
    currency_code: "INR",
    lot_size: r.lotSize,
    tick_size: r.tickSize,
  };
  if (r.expiry) {
    // Contracts expire at the close (15:30 IST for equity derivatives; MCX and CDS close later, which only matters
    // for the `expired` flag on expiry day itself).
    const expiration = istInstant(r.expiry, 15, 30);
    if (expiration !== null) {
      info.expiration_date = expiration;
      info.expired = nowSeconds > expiration;
    }
  }
  return info;
}

/** Datafeed configuration for /udf/config. */
export function udfConfig(udf) {
  return {
    supported_resolutions: [...udf.supportedResolutions],
    supports_search: true,
    supports_group_request: false,
    supports_marks: false,
    supports_timescale_marks: false,
    supports_time: true,
    exchanges: [{ value: "", name: "All exchanges", desc: "" }, ...EXCHANGES.map((e) => ({ value: e, name: e, desc: e }))],
    symbols_types: [
      { name: "All types", value: "" },
      { name: "Stock", value: "stock" },
      { name: "Index", value: "index" },
      { name: "Futures", value: "futures" },
      { name: "Option", value: "option" },
    ],
    currency_codes: ["INR"],
  };
}

/**
 * Bridge candles -> UDF bars for the window [from, to). Daily-and-up bars are restamped at 00:00 UTC of their IST date
 * (and de-duplicated, keeping the last); then the window and countback are applied.
 * @param {import("../core/contracts.mjs").Candle[]} candles ascending
 * @param {{ interval: string, from?: number, to: number, countback?: number }} w
 */
export function toUdfBars(candles, { interval, from, to, countback }) {
  const daily = DAILY_INTERVALS.has(interval);
  const byTime = new Map();
  for (const c of candles ?? []) {
    if (!c || !Number.isFinite(c.time)) continue;
    const t = daily ? utcMidnightOfIstDate(c.time) : Math.floor(c.time);
    byTime.set(t, { ...c, time: t });
  }
  let bars = [...byTime.values()].sort((a, b) => a.time - b.time).filter((b) => b.time < to);
  if (countback !== undefined) bars = bars.slice(Math.max(0, bars.length - countback));
  else if (from !== undefined) bars = bars.filter((b) => b.time >= from);
  return bars;
}

/** Column-array UDF history body. */
export function historyBody(bars) {
  if (!bars.length) return { s: "no_data" };
  return {
    s: "ok",
    t: bars.map((b) => b.time),
    o: bars.map((b) => b.open),
    h: bars.map((b) => b.high),
    l: bars.map((b) => b.low),
    c: bars.map((b) => b.close),
    v: bars.map((b) => (Number.isFinite(b.volume) ? b.volume : 0)),
  };
}

/** UDF quote values from a Bridge QuoteItem; null fields are left out. */
export function quoteValues(q) {
  const v = {
    short_name: shortName(q.symbol),
    exchange: q.symbol.slice(0, q.symbol.indexOf(":")),
    description: q.symbol,
    lp: q.ltp,
    ch: q.change,
    chp: q.changePct,
    open_price: q.open,
    high_price: q.high,
    low_price: q.low,
    prev_close_price: q.close,
    volume: q.volume,
    bid: q.bid,
    ask: q.ask,
    spread: q.bid !== null && q.bid !== undefined && q.ask !== null && q.ask !== undefined ? Number((q.ask - q.bid).toFixed(6)) : null,
  };
  for (const k of Object.keys(v)) if (v[k] === null || v[k] === undefined) delete v[k];
  return v;
}

/** Canonical form of a symbol if it parses (lenient), else the trimmed upper-cased input. */
function canonicalOrSelf(s) {
  try {
    return parseSymbol(s).canonical;
  } catch {
    return String(s).trim().toUpperCase();
  }
}

/** UDF error reply that keeps the HTTP status and the Bridge error fields. */
export function udfError(err, ctx) {
  const e = asBridgeError(err);
  return json(
    { s: "error", errmsg: e.detail, code: e.code, retryable: e.retryable, requestId: ctx.requestId },
    { status: e.status, headers: errorHeaders(e) },
  );
}

/**
 * Route handlers. `deps` is the full deps object from register(); services are read lazily on each call.
 * @param {object} deps
 * @param {ReturnType<typeof import("./config.mjs").parseIntegrationsConfig>} cfg
 */
export function createUdfRoutes(deps, cfg) {
  const udf = cfg.udf;
  const nowSeconds = () => Math.floor((deps.clock?.now?.() ?? Date.now()) / 1000);
  const guarded = (fn) => async (ctx) => {
    try {
      return await fn(ctx);
    } catch (err) {
      return udfError(err, ctx);
    }
  };

  /** One history read through marketData; returns UDF bars. */
  async function readBars(ctx, { symbol, interval, from, to, countback }, opts) {
    const daily = DAILY_INTERVALS.has(interval);
    // Daily bars are stamped at UTC midnight but live at IST times: widen by a day each side, then filter exactly.
    const pad = daily ? DAY_SECONDS : 0;
    const params = { symbol, interval, to: to + pad };
    // One or two spare bars cover the exclusive `to` and the daily restamp; marketData accepts at most 5000.
    if (countback !== undefined) params.countback = Math.min(5000, countback + (daily ? 2 : 1));
    else params.from = Math.max(0, from - pad);
    const r = await deps.marketData.history(params, opts);
    return toUdfBars(r?.candles ?? [], { interval, from, to, countback });
  }

  return {
    config: guarded(() => udfConfig(udf)),

    time: guarded(() => text(String(nowSeconds()))),

    symbols: guarded(async (ctx) => {
      const symbol = req(ctx.query, "symbol", "NSE:NIFTY");
      const resolved = await deps.symbols.resolve(symbol);
      return symbolInfo(resolved, udf, nowSeconds());
    }),

    search: guarded(async (ctx) => {
      const q = opt(ctx.query, "query") ?? "";
      const limit = intParam(ctx.query, "limit", 1, 100) ?? udf.searchLimit;
      const type = opt(ctx.query, "type");
      const exchange = opt(ctx.query, "exchange")?.toUpperCase();
      if (!q || q.length > 64) return [];
      const params = { q, limit: Math.min(limit, udf.searchLimit) };
      if (type) {
        const kind = KIND_BY_TYPE[type.toLowerCase()];
        if (!kind) return [];
        params.kind = kind;
      }
      if (exchange) {
        if (!EXCHANGES.includes(exchange)) return [];
        params.exchange = exchange;
      }
      const page = await deps.symbols.search(params);
      return (page?.items ?? []).map((r) => ({
        symbol: shortName(r.canonical),
        full_name: r.canonical,
        description: r.name || describe(r),
        exchange: r.exchange,
        ticker: r.canonical,
        type: UDF_TYPES[r.kind] ?? "stock",
      }));
    }),

    history: guarded(async (ctx) => {
      const q = ctx.query;
      const symbol = req(q, "symbol", "NSE:NIFTY");
      const interval = resolutionToInterval(req(q, "resolution", "5"), udf.supportedResolutions);
      const to = intParam(q, "to", 0, 99_999_999_999) ?? nowSeconds();
      const countback = intParam(q, "countback", 1, udf.maxCountback);
      const from = intParam(q, "from", 0, 99_999_999_999);
      if (from === undefined && countback === undefined) throw invalid("from", "from is required (Unix seconds), or give countback.");
      if (to <= EARLIEST || (countback === undefined && from >= to)) return { s: "no_data" };
      const opts = readOptions(ctx, { maxAge: false });
      const bars = await readBars(ctx, { symbol, interval, from, to, countback }, opts);
      if (bars.length) return historyBody(bars);
      if (!udf.nextTimeLookup) return { s: "no_data" };
      // Find the closest earlier bar so the chart can jump over the gap. Failures here only lose the hint.
      const edge = countback !== undefined ? to : from;
      try {
        const prev = await readBars(ctx, { symbol, interval, to: edge, countback: 1 }, opts);
        if (prev.length && prev[0].time < edge) return { s: "no_data", nextTime: prev[0].time };
      } catch {
        /* no hint */
      }
      return { s: "no_data" };
    }),

    quotes: guarded(async (ctx) => {
      const inputs = listParam(ctx.query, "symbols", udf.maxQuoteSymbols, "NSE:NIFTY,NSE:RELIANCE");
      const opts = readOptions(ctx);
      const r = await deps.marketData.quotes(inputs, opts);
      const byCanonical = new Map((r?.items ?? []).map((it) => [it.symbol, it]));
      const errByKey = new Map();
      for (const e of r?.errors ?? []) {
        if (e?.symbol) {
          errByKey.set(e.symbol, e);
          errByKey.set(canonicalOrSelf(e.symbol), e);
        }
      }
      const d = inputs.map((input) => {
        const key = canonicalOrSelf(input);
        const item = byCanonical.get(key) ?? byCanonical.get(input);
        if (item) return { s: "ok", n: input, v: quoteValues(item) };
        const e = errByKey.get(input) ?? errByKey.get(key);
        return { s: "error", n: input, v: {}, errmsg: e?.message ?? "No quote for this symbol.", code: e?.code ?? "SYMBOL_NOT_FOUND" };
      });
      return { s: "ok", d };
    }),
  };
}
