/**
 * Yahoo Finance chart endpoint as an opt-in, delayed, unofficial source (quotes and history).
 *
 * Facts used here come from the data-source research (checked 2026-11-08): the chart endpoint
 * `query1.finance.yahoo.com/v8/finance/chart/<symbol>` answered with no key, cookie or crumb; the quote endpoint
 * (v7) answered 401 because it needs a cookie plus crumb, so it is NOT used; Yahoo publishes no rate limits and no
 * official API; its terms forbid automated access and commercial use. Intraday look-backs are community-reported, not
 * documented by Yahoo. The Bridge therefore sends one request per second at most, identifies itself honestly, never
 * sends cookies and never fetches a crumb. If Yahoo starts demanding them the provider answers with a clear error.
 *
 * The delay for NSE and BSE is not stated in the payload. 900 seconds is Yahoo's long-standing figure and is
 * UNVERIFIED for today; the descriptor says so.
 */
import { BridgeError } from "../../core/errors.mjs";
import { istDate, istMidnight, istParts } from "../../market/time.mjs";
import { mergeCandles } from "../../market/normalise.mjs";
import { parseSymbol } from "../../core/symbolFormat.mjs";
import { DAY_MS, checkRange, createHttp, createLimiter, num, price, readNow, sessionCloseMinutes, sourceError, systemClock, throwIfAborted, unsupported } from "./common.mjs";

export const YAHOO_NOTICE_VERSION = "yahoo-1";
export const YAHOO_HOST = "query1.finance.yahoo.com";
export const YAHOO_USER_AGENT = "Bridge-DataSource/1.0 (self-hosted market-data bridge; read-only; personal use)";

/** Bridge index names to Yahoo tickers, per exchange. Only tickers verified or widely documented are listed. */
export const YAHOO_INDEX_TABLE = Object.freeze({
  NSE: Object.freeze({ NIFTY: "^NSEI", BANKNIFTY: "^NSEBANK", INDIAVIX: "^INDIAVIX" }),
  BSE: Object.freeze({ SENSEX: "^BSESN" }),
});

const SUFFIX = Object.freeze({ NSE: ".NS", BSE: ".BO" });

/**
 * Bridge symbol to Yahoo ticker. Cash equities map to `.NS` (NSE) and `.BO` (BSE), the indices in the table to their
 * caret tickers. Anything else (derivatives, other indices, other exchanges) is SYMBOL_NOT_FOUND with a plain reason.
 * @param {string} bridgeSymbol  for example NSE:RELIANCE
 * @returns {string}
 */
export function toYahooSymbol(bridgeSymbol) {
  let p;
  try {
    p = parseSymbol(bridgeSymbol);
  } catch {
    throw sourceError("not-found", `"${String(bridgeSymbol).slice(0, 40)}" is not a Bridge symbol Yahoo can look up. Use a form like NSE:RELIANCE.`, { source: "yahoo" });
  }
  if (p.exchange !== "NSE" && p.exchange !== "BSE") throw sourceError("not-found", `Yahoo has no Indian futures or options data, so ${p.canonical} cannot be looked up there.`, { source: "yahoo" });
  if (p.kind === "FUT" || p.kind === "OPT") throw sourceError("not-found", `Yahoo has no Indian futures or options data, so ${p.canonical} cannot be looked up there.`, { source: "yahoo" });
  if (p.kind === "INDEX") {
    const t = YAHOO_INDEX_TABLE[p.exchange]?.[p.underlying];
    if (!t) throw sourceError("not-found", `The Bridge has no confirmed Yahoo ticker for the index ${p.canonical}.`, { source: "yahoo" });
    return t;
  }
  return `${p.underlying}${SUFFIX[p.exchange]}`;
}

/** Bridge interval to Yahoo's, the per-request span and how far back Yahoo keeps each (community-reported). */
export const YAHOO_INTERVALS = Object.freeze({
  "1m": { yahoo: "1m", sec: 60, maxSpanDays: 7, lookbackDays: 30 },
  "5m": { yahoo: "5m", sec: 300, maxSpanDays: 60, lookbackDays: 60 },
  "15m": { yahoo: "15m", sec: 900, maxSpanDays: 60, lookbackDays: 60 },
  "30m": { yahoo: "30m", sec: 1800, maxSpanDays: 60, lookbackDays: 60 },
  "60m": { yahoo: "60m", sec: 3600, maxSpanDays: 730, lookbackDays: 730 },
  "1d": { yahoo: "1d", sec: 86400, daily: true },
  "1w": { yahoo: "1wk", sec: 604800, daily: true },
  "1M": { yahoo: "1mo", sec: 2592000, daily: true },
});

/** The most requests one history call makes; older chunks beyond this come back as `partial`. */
export const YAHOO_MAX_CHUNKS = 5;

const SESSION_CLOSE_MIN = sessionCloseMinutes("NSE");

const minutesOfDayIst = (ms) => {
  const p = istParts(ms);
  return p.hour * 60 + p.minute;
};

const descriptor = Object.freeze({
  id: "yahoo",
  name: "Yahoo Finance (unofficial)",
  kind: "free",
  tier: "opt-in",
  class: "delayed",
  delaySec: 900,
  official: false,
  capabilities: Object.freeze(["quotes", "history"]),
  limits: Object.freeze({ perSecond: 1, perMinute: 60 }),
  needsKey: false,
  noticeVersion: YAHOO_NOTICE_VERSION,
  terms: Object.freeze({
    url: "https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html",
    note: 'Yahoo\'s terms say you may not "access or collect data ... from our Services using any automated means" without its permission or use it commercially, so this unofficial source is only for your own personal cross-checks.',
  }),
  note: "Delay of 900 seconds is Yahoo's historical figure for NSE and BSE quotes and has not been verified against current Yahoo documentation. Yahoo publishes no rate limits; the Bridge uses 1 request per second and 60 per minute to be safe.",
});

/**
 * @param {{ fetch?: typeof fetch, clock?: { now(): number, sleep(ms: number, signal?: AbortSignal): Promise<void> },
 *   userAgent?: string, timeoutMs?: number, maxWaitMs?: number }} [opts]
 * @returns {import("../contract.mjs").SourceProvider & { hosts: string[], usage(): { lastMinute: number, today: number } }}
 */
export function createYahooProvider({ fetch: fetchImpl = globalThis.fetch, clock = systemClock, userAgent = YAHOO_USER_AGENT, timeoutMs, maxWaitMs } = {}) {
  const limiter = createLimiter({ limits: descriptor.limits, clock, source: "yahoo", label: "Yahoo Finance", maxWaitMs });
  const http = createHttp({ id: "yahoo", name: "Yahoo Finance", fetch: fetchImpl, clock, hosts: [YAHOO_HOST], limiter, userAgent, timeoutMs });
  const flags = () => ["unofficial", "delayed"];

  /** One chart request. Returns { result } with Yahoo's first result object. */
  async function chart(ticker, query, signal) {
    const url = `https://${YAHOO_HOST}/v8/finance/chart/${encodeURIComponent(ticker)}?${new URLSearchParams(query)}`;
    const res = await http.get(url, { signal });
    const err = res.json?.chart?.error;
    if (res.status === 429) throw http.rateLimited(res);
    if (res.status === 401 || res.status === 403) {
      throw sourceError("blocked", "Yahoo now asks for a login cookie or crumb for this request. The Bridge does not use those, so Yahoo is unavailable until that changes.", { source: "yahoo", status: 502 });
    }
    if (res.status === 404 || /not found|no data found/i.test(`${err?.code ?? ""} ${err?.description ?? ""}`)) {
      throw sourceError("not-found", `Yahoo has no data for ${ticker}.`, { source: "yahoo" });
    }
    if (res.status === 422 || /must be within|unprocessable/i.test(`${err?.code ?? ""} ${err?.description ?? ""}`)) {
      throw sourceError("unsupported", "Yahoo does not provide candles for that period and interval.", { source: "yahoo" });
    }
    if (res.status >= 500) throw http.upstream(`Yahoo Finance is having trouble (status ${res.status}).`);
    if (res.status !== 200 || !res.json || typeof res.json !== "object") throw http.upstream("Yahoo Finance sent an answer the Bridge could not read.");
    if (err) throw http.upstream(`Yahoo Finance reported: ${String(err.description ?? err.code ?? "an error").slice(0, 120)}`);
    const result = res.json?.chart?.result?.[0];
    if (!result || typeof result !== "object" || !result.meta) throw sourceError("not-found", `Yahoo has no data for ${ticker}.`, { source: "yahoo" });
    return result;
  }

  /** Candles (epoch seconds) from a chart result. Rows with a null or non-positive price are gaps and are skipped. */
  function candlesOf(result) {
    const ts = Array.isArray(result.timestamp) ? result.timestamp : [];
    const q = result.indicators?.quote?.[0] ?? {};
    const out = [];
    for (let i = 0; i < ts.length; i += 1) {
      const time = num(ts[i]);
      const open = price(q.open?.[i]);
      const high = price(q.high?.[i]);
      const low = price(q.low?.[i]);
      const close = price(q.close?.[i]);
      if (time === null || open === null || high === null || low === null || close === null) continue;
      out.push({ time: Math.floor(time), open, high, low, close, volume: Math.max(0, num(q.volume?.[i]) ?? 0) });
    }
    return out;
  }

  /**
   * Is the newest point possibly a live snapshot rather than a closed bar? True when it starts at or after the 15:30
   * IST close (Yahoo adds such a trailing point), or when the bar has not finished at the time of Yahoo's last
   * update.
   */
  function isProvisional(last, spec, meta, nowMs) {
    const startMs = last.time * 1000;
    if (minutesOfDayIst(startMs) >= SESSION_CLOSE_MIN) return true;
    const endMs = spec.daily ? istMidnight(startMs) + SESSION_CLOSE_MIN * 60_000 : startMs + spec.sec * 1000;
    const rmt = num(meta.regularMarketTime);
    const ref = rmt !== null ? rmt * 1000 : nowMs;
    return endMs > ref;
  }

  async function quotes(symbols, ctx = {}) {
    const items = [];
    let firstError = null;
    for (const symbol of symbols) {
      throwIfAborted(ctx.signal);
      try {
        const ticker = toYahooSymbol(symbol);
        const r = await chart(ticker, { range: "5d", interval: "1d", includePrePost: "false" }, ctx.signal);
        const item = quoteItem(symbol, r);
        if (item) items.push(item);
        else firstError ??= http.upstream(`Yahoo Finance sent no price for ${symbol}.`);
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        if (!(err instanceof BridgeError)) throw http.upstream("Yahoo Finance could not be read.");
        firstError ??= err;
        // A 429 or a block affects every later symbol too; stop instead of asking again.
        if (err.fields?.kind === "rate-limited" || err.fields?.kind === "blocked") break;
      }
    }
    if (!items.length && firstError) throw firstError;
    return { items };
  }

  function quoteItem(symbol, result) {
    const meta = result.meta;
    const ltp = price(meta.regularMarketPrice);
    const at = num(meta.regularMarketTime);
    if (ltp === null || at === null) return null;
    const atMs = at * 1000;
    const day = istDate(atMs);
    const bars = candlesOf(result).filter((c) => minutesOfDayIst(c.time * 1000) < SESSION_CLOSE_MIN);
    // Previous close: the last finished daily close dated before the quote's own day.
    const before = bars.filter((c) => istDate(c.time * 1000) < day);
    const prev = before.length ? before[before.length - 1].close : price(meta.previousClose) ?? price(meta.chartPreviousClose);
    const today = bars.find((c) => istDate(c.time * 1000) === day);
    return {
      symbol,
      fields: {
        ltp,
        open: today?.open ?? null,
        high: price(meta.regularMarketDayHigh) ?? today?.high ?? null,
        low: price(meta.regularMarketDayLow) ?? today?.low ?? null,
        close: prev,
        volume: num(meta.regularMarketVolume) ?? today?.volume ?? null,
      },
      at: atMs,
      provider: "yahoo",
      flags: flags(),
    };
  }

  async function history(req, ctx = {}) {
    const { fromMs, toMs: rawTo } = checkRange(req);
    const spec = YAHOO_INTERVALS[req.interval];
    if (!spec) throw unsupported("Yahoo Finance", `${req.interval} candles (it offers ${Object.keys(YAHOO_INTERVALS).join(", ")})`);
    const ticker = toYahooSymbol(req.symbol);
    const nowMs = readNow(ctx, clock);
    const toMs = Math.min(rawTo, nowMs);
    if (toMs <= fromMs) throw new BridgeError("VALIDATION_FAILED", "The history range ends in the future, so there is nothing to fetch yet.");

    let effFrom = fromMs;
    let partial = false;
    if (spec.lookbackDays) {
      const earliest = nowMs - spec.lookbackDays * DAY_MS;
      if (toMs < earliest) throw unsupported("Yahoo Finance", `${req.interval} candles older than about ${spec.lookbackDays} days`);
      if (fromMs < earliest) {
        effFrom = earliest;
        partial = true;
      }
    }

    // Plan chunks newest first so a capped plan keeps the most recent data.
    const chunks = [];
    if (spec.maxSpanDays) {
      const span = spec.maxSpanDays * DAY_MS;
      for (let end = toMs; end > effFrom; end -= span) chunks.push({ from: Math.max(effFrom, end - span), to: end });
    } else chunks.push({ from: effFrom, to: toMs });
    if (chunks.length > YAHOO_MAX_CHUNKS) {
      chunks.length = YAHOO_MAX_CHUNKS;
      effFrom = chunks[chunks.length - 1].from;
      partial = true;
    }

    const lists = [];
    let newestMeta = null;
    for (const [i, c] of chunks.entries()) {
      throwIfAborted(ctx.signal);
      const result = await chart(ticker, { period1: String(Math.floor(c.from / 1000)), period2: String(Math.ceil(c.to / 1000)), interval: spec.yahoo, includePrePost: "false" }, ctx.signal);
      if (i === 0) newestMeta = result.meta;
      lists.push(candlesOf(result));
    }
    let candles = mergeCandles(lists).filter((c) => c.time * 1000 >= effFrom && c.time * 1000 <= toMs);
    const out = { candles, at: nowMs, provider: "yahoo", flags: flags() };
    if (partial) out.partial = true;
    const last = candles[candles.length - 1];
    if (last && newestMeta && isProvisional(last, spec, newestMeta, nowMs)) {
      // The newest point may still change (or is a snapshot, not a bar): consumers must not cache or treat it as closed.
      out.provisionalFrom = last.time;
      out.flags.push("last-bar-provisional");
    }
    return out;
  }

  async function test(ctx = {}) {
    const started = clock.now();
    try {
      await chart("^NSEI", { range: "1d", interval: "1d" }, ctx.signal);
      return { ok: true, latencyMs: clock.now() - started, detail: "Yahoo answered for the NIFTY 50 index." };
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      return { ok: false, latencyMs: clock.now() - started, detail: err instanceof BridgeError ? err.detail : "Yahoo could not be reached." };
    }
  }

  const refuse = (what) => async () => {
    throw unsupported("Yahoo Finance", what);
  };

  return { descriptor, hosts: [YAHOO_HOST], quotes, history, test, usage: () => limiter.usage(), expiries: refuse("option expiry lists"), optionChain: refuse("option chains") };
}
