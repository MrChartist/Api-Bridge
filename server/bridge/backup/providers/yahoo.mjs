/**
 * Yahoo Finance backup provider: the public chart API (query1/query2.finance.yahoo.com/v8/finance/chart), which needs
 * no account, cookie or crumb (checked Oct 2026). It covers NSE and BSE cash stocks (RELIANCE.NS, RELIANCE.BO) and the
 * main indices (^NSEI, ^NSEBANK, ^BSESN ...). It has no Indian futures or options.
 *
 * Unofficial and undocumented: Yahoo can change or block it at any time, it asks for a browser User-Agent, and its
 * Indian prices may be delayed. That is why every value it supplies is labelled source "backup", provider "yahoo",
 * with asOf set from Yahoo's own regularMarketTime, never the time we fetched it.
 *
 * Intraday lookback limits (Yahoo error messages, Oct 2026): 1m bars 8 days per request and about 30 days back,
 * 2m-30m bars the last 60 days, 60m bars the last 730 days, daily and longer all history.
 */
import { BridgeError } from "../../core/errors.mjs";
import { parseSymbol } from "../../core/symbolFormat.mjs";

export const YAHOO_HOSTS = Object.freeze(["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"]);

/** Canonical index name -> Yahoo ticker. */
export const YAHOO_INDEX = Object.freeze({
  "NSE:NIFTY": "^NSEI",
  "NSE:BANKNIFTY": "^NSEBANK",
  "NSE:FINNIFTY": "NIFTY_FIN_SERVICE.NS",
  "NSE:MIDCPNIFTY": "NIFTY_MID_SELECT.NS",
  "NSE:NIFTYNXT50": "^NSMIDCP",
  "NSE:INDIAVIX": "^INDIAVIX",
  "BSE:SENSEX": "^BSESN",
  "BSE:BANKEX": "BSE-BANK.BO",
});

/** Bar sizes Yahoo serves directly, as Bridge intervals. Others are built from these (3m from 1m, 10m from 5m ...). */
export const YAHOO_INTERVALS = Object.freeze(["1m", "5m", "15m", "30m", "60m", "1d"]);
const INTERVAL_PARAM = Object.freeze({ "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "60m": "60m", "1d": "1d" });
/** How far back Yahoo serves each base bar size, in days (with a margin under its limit). */
export const YAHOO_LOOKBACK_DAYS = Object.freeze({ "1m": 29, "5m": 59, "15m": 59, "30m": 59, "60m": 729, "1d": 36500 });
/** Largest span one 1m request may cover. */
const ONE_MINUTE_SPAN_DAYS = 7;
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;

/**
 * Yahoo ticker for a canonical symbol, or null when Yahoo has no such instrument (derivatives, MCX, CDS).
 * @param {string} canonical
 */
export function yahooTicker(canonical) {
  let p;
  try {
    p = parseSymbol(canonical);
  } catch {
    return null;
  }
  if (p.kind === "INDEX") return YAHOO_INDEX[p.canonical] ?? null;
  if (p.kind !== "EQ") return null;
  if (p.exchange === "NSE") return `${p.underlying}.NS`;
  if (p.exchange === "BSE") return `${p.underlying}.BO`;
  return null;
}

/** Yahoo sends float32 noise (1186.0999755859375); prices are rounded to 4 decimals. */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10_000) / 10_000 : null);
const pos = (v) => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};
const lastFinite = (arr) => {
  if (!Array.isArray(arr)) return null;
  for (let i = arr.length - 1; i >= 0; i -= 1) if (num(arr[i]) !== null) return arr[i];
  return null;
};

/** chart.result[0] or a BridgeError from chart.error. */
function chartResult(json, ticker) {
  const err = json?.chart?.error;
  if (err) {
    const code = String(err.code ?? "");
    if (/not found/i.test(code) || /no data|delisted|not found/i.test(String(err.description ?? ""))) {
      throw new BridgeError("SYMBOL_NOT_FOUND", `Yahoo Finance has no data for ${ticker}.`);
    }
    throw new BridgeError("UPSTREAM_ERROR", `Yahoo Finance refused the request for ${ticker}: ${String(err.description ?? code).slice(0, 160)}`, {
      broker: { id: "yahoo", code: code.slice(0, 40) || "CHART_ERROR" },
    });
  }
  const r = json?.chart?.result?.[0];
  if (!r || typeof r !== "object") throw new BridgeError("UPSTREAM_ERROR", `Yahoo Finance returned no chart for ${ticker}.`);
  return r;
}

/**
 * Quote fields (contract Quote shape: ltp, open, high, low, close = previous close, volume) from a 1-day chart.
 * @returns {{ fields: object, at: number }} at = Yahoo's regularMarketTime in epoch ms
 */
export function parseQuote(json, ticker) {
  const r = chartResult(json, ticker);
  const m = r.meta ?? {};
  const q = r.indicators?.quote?.[0] ?? {};
  const ltp = pos(m.regularMarketPrice) ?? pos(lastFinite(q.close));
  if (ltp === null) throw new BridgeError("UPSTREAM_ERROR", `Yahoo Finance returned no price for ${ticker}.`);
  const prev = pos(m.previousClose) ?? pos(m.chartPreviousClose);
  const at = num(m.regularMarketTime) !== null ? m.regularMarketTime * 1000 : null;
  return {
    fields: {
      ltp,
      open: pos(Array.isArray(q.open) ? q.open.find((v) => pos(v) !== null) : null),
      high: pos(m.regularMarketDayHigh) ?? pos(lastFinite(q.high)),
      low: pos(m.regularMarketDayLow) ?? pos(lastFinite(q.low)),
      close: prev,
      volume: num(m.regularMarketVolume) ?? num(lastFinite(q.volume)),
      oi: null,
      bid: null,
      ask: null,
    },
    at,
  };
}

/**
 * Candles from a chart response. Daily bars are stamped at IST midnight (the Bridge convention), intraday bars at
 * their open. Bars with a missing open/high/low/close (Yahoo pads gaps with null) are dropped.
 */
export function parseCandles(json, ticker, base) {
  const r = chartResult(json, ticker);
  const ts = Array.isArray(r.timestamp) ? r.timestamp : [];
  const q = r.indicators?.quote?.[0] ?? {};
  const out = [];
  for (let i = 0; i < ts.length; i += 1) {
    const o = num(q.open?.[i]);
    const h = num(q.high?.[i]);
    const l = num(q.low?.[i]);
    const c = num(q.close?.[i]);
    if (o === null || h === null || l === null || c === null || num(ts[i]) === null) continue;
    let time = ts[i];
    if (base === "1d") {
      const ms = time * 1000;
      time = Math.floor((Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS) / 1000);
    }
    out.push({ time, open: o, high: h, low: l, close: c, volume: num(q.volume?.[i]) ?? 0 });
  }
  // de-duplicate (Yahoo can repeat the live bar) keeping the last
  const byTime = new Map(out.map((c) => [c.time, c]));
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * @param {{ http: { get: Function }, now: () => number }} deps
 */
export function createYahooProvider({ http, now }) {
  let hostIndex = 0;

  async function chart(ticker, params) {
    const qs = new URLSearchParams({ ...params, includePrePost: "false", events: "" });
    let lastErr;
    // Try the current host, then the other one (query2 sometimes answers when query1 throttles).
    for (let attempt = 0; attempt < YAHOO_HOSTS.length; attempt += 1) {
      const host = YAHOO_HOSTS[(hostIndex + attempt) % YAHOO_HOSTS.length];
      try {
        const { json } = await http.get(`${host}/v8/finance/chart/${encodeURIComponent(ticker)}?${qs}`, { accept404: true });
        hostIndex = (hostIndex + attempt) % YAHOO_HOSTS.length;
        return json;
      } catch (err) {
        lastErr = err;
        if (err?.code !== "UPSTREAM_RATE_LIMITED" && err?.code !== "BROKER_UNAVAILABLE" && err?.code !== "UPSTREAM_TIMEOUT") throw err;
      }
    }
    throw lastErr;
  }

  return {
    id: "yahoo",
    name: "Yahoo Finance",
    covers: { quotes: ["INDEX", "EQ"], history: ["INDEX", "EQ"], optionChain: false },
    supports: (canonical) => yahooTicker(canonical) !== null,

    /** @returns {Promise<{ fields: object, at: number }>} */
    async quote(canonical) {
      const ticker = yahooTicker(canonical);
      if (!ticker) throw new BridgeError("CAPABILITY_UNSUPPORTED", `Yahoo Finance has no Indian derivatives or ${canonical}.`);
      const json = await chart(ticker, { range: "1d", interval: "1d" });
      const q = parseQuote(json, ticker);
      return { fields: q.fields, at: q.at ?? now() };
    },

    /**
     * Candles in Yahoo's own bar sizes (YAHOO_INTERVALS). The caller builds other sizes.
     * @returns {Promise<{ candles: object[], partial: boolean }>}
     */
    async history(canonical, base, fromMs, toMs) {
      const ticker = yahooTicker(canonical);
      if (!ticker) throw new BridgeError("CAPABILITY_UNSUPPORTED", `Yahoo Finance has no Indian derivatives or ${canonical}.`);
      if (!INTERVAL_PARAM[base]) throw new BridgeError("CAPABILITY_UNSUPPORTED", `Yahoo Finance has no ${base} candles.`);
      const earliest = now() - YAHOO_LOOKBACK_DAYS[base] * DAY_MS;
      let partial = false;
      let from = fromMs;
      if (from < earliest) {
        from = earliest;
        partial = true;
      }
      if (from >= toMs) return { candles: [], partial: true };
      const spans = [];
      const step = base === "1m" ? ONE_MINUTE_SPAN_DAYS * DAY_MS : Infinity;
      for (let s = from; s < toMs; s += step) spans.push([s, Math.min(toMs, s + step)]);
      const lists = [];
      for (const [a, b] of spans) {
        const json = await chart(ticker, { interval: INTERVAL_PARAM[base], period1: String(Math.floor(a / 1000)), period2: String(Math.ceil(b / 1000)) });
        lists.push(parseCandles(json, ticker, base));
      }
      const byTime = new Map();
      for (const l of lists) for (const c of l) byTime.set(c.time, c);
      return { candles: [...byTime.values()].sort((x, y) => x.time - y.time), partial };
    },
  };
}
