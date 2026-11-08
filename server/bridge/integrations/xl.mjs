/**
 * Spreadsheet and AmiBroker endpoints (docs/openapi.yaml, tag "Spreadsheets").
 *
 *   GET /xl/ltp?symbol=NSE:NIFTY                        one number as text/plain
 *   GET /xl/quote?symbol=NSE:RELIANCE&field=changePct   one quote field as text/plain
 *   GET /xl/chain?underlying=NIFTY&expiry=2026-10-27[&format=csv|json][&strikes=10][&greeks=false][&maxChars=]
 *   GET /xl/history?symbol=NSE:NIFTY&interval=5m[&from=][&to=][&countback=][&layout=standard|amibroker]
 *                  [&format=csv|json][&ticker=][&maxChars=]
 *   (all take the optional `account` and, where it makes sense, `maxAgeMs` of the /v1 market-data routes)
 *
 * Designed around what the consumers can do:
 *  - Excel WEBSERVICE is GET-only, Windows desktop only, with 2,048-character URLs and 32,767-character results. The
 *    single-value routes answer a bare number (no thousands separators, "." decimal point) and `#N/A` on any error,
 *    with the error's real HTTP status and an `X-Error-Code` header. Wrap them in VALUE() / IFERROR() in the sheet.
 *  - Power Query, Google Sheets and AmiBroker read flat tables: one header row, one row per strike or bar, IST times
 *    as "YYYY-MM-DD HH:MM:SS". `maxChars` trims a table to fit (oldest bars, or the strikes furthest from ATM, go
 *    first) and sets `X-Truncated: true`; pass maxChars=32767 when a table goes through WEBSERVICE.
 *  - Text cells that start with = + - @ (or a tab/CR) get a leading apostrophe in CSV and JSON so a spreadsheet never
 *    evaluates them as formulas (core/http.mjs toCsv for CSV, guardCell here for JSON).
 *
 * Read-only by construction: every route is GET and the handlers only call deps.marketData. There is no way to place,
 * modify or cancel an order from a formula or a URL.
 */
import { csv, json, text, toCsv } from "../core/http.mjs";
import { BridgeError } from "../core/errors.mjs";
import { istDate, istDateTime, istTime } from "./ist.mjs";
import { asBridgeError, boolParam, enumParam, errorHeaders, intParam, invalid, opt, readOptions, req } from "./params.mjs";

/** Quote fields /xl/quote serves (OpenAPI enum). */
export const QUOTE_FIELDS = Object.freeze(["ltp", "open", "high", "low", "close", "change", "changePct", "volume", "oi", "bid", "ask"]);
export const INTERVALS = Object.freeze(["1m", "3m", "5m", "10m", "15m", "30m", "60m", "1d", "1w", "1M"]);
const DAILY = new Set(["1d", "1w", "1M"]);
/** Excel's limit on the text a WEBSERVICE cell can hold. */
export const EXCEL_CELL_LIMIT = 32_767;
const NA = "#N/A";

const LEG_FIELDS = Object.freeze([
  ["symbol", "symbol"],
  ["ltp", "ltp"],
  ["bid", "bid"],
  ["ask", "ask"],
  ["oi", "oi"],
  ["oi_change", "oiChange"],
  ["volume", "volume"],
  ["iv", "iv"],
  ["delta", "delta"],
  ["gamma", "gamma"],
  ["theta", "theta"],
  ["vega", "vega"],
]);

/** Column order of /xl/chain. */
export const CHAIN_COLUMNS = Object.freeze([
  "underlying",
  "expiry",
  "strike",
  "atm",
  ...LEG_FIELDS.map(([c]) => `ce_${c}`),
  ...LEG_FIELDS.map(([c]) => `pe_${c}`),
  "underlying_ltp",
  "lot_size",
  "as_of",
  "source",
  "stale",
]);

export const HISTORY_COLUMNS = Object.freeze(["datetime", "open", "high", "low", "close", "volume", "oi"]);
/** AmiBroker ASCII import columns; must match integrations/amibroker/*.format. */
export const AMIBROKER_INTRADAY_COLUMNS = Object.freeze(["Ticker", "Date", "Time", "Open", "High", "Low", "Close", "Volume", "OpenInt"]);
export const AMIBROKER_EOD_COLUMNS = Object.freeze(["Ticker", "Date", "Open", "High", "Low", "Close", "Volume", "OpenInt"]);

/**
 * A number as Excel reads it everywhere: plain decimal, no exponent for normal prices, no grouping. null for anything
 * that is not a finite number.
 */
export function formatNumber(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  if (Number.isInteger(n)) return String(n);
  const s = String(Number(n.toPrecision(15)));
  return /e/i.test(s) ? n.toFixed(10).replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Formula-injection guard for one JSON cell (CSV cells are guarded by core toCsv). */
export function guardCell(v) {
  if (typeof v !== "string") return v;
  return /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : v;
}

/** ISO date-time with offset (Freshness.asOf) -> "YYYY-MM-DD HH:MM:SS" IST; the input when it does not parse. */
export function asOfCell(asOf) {
  const ms = Date.parse(asOf ?? "");
  return Number.isFinite(ms) ? istDateTime(Math.floor(ms / 1000)) : (asOf ?? null);
}

/**
 * Default AmiBroker ticker for a canonical symbol. AmiBroker stores symbols as file names, so the ":" is dropped:
 * NSE, NFO, MCX and CDS symbols keep just the part after the colon (NSE:RELIANCE -> RELIANCE,
 * NFO:NIFTY-2026-10-27-FUT -> NIFTY-2026-10-27-FUT); BSE and BFO get a suffix so they never collide with NSE
 * (BSE:RELIANCE -> RELIANCE.BSE). Pass `ticker=` to choose your own.
 */
export function amibrokerTicker(canonical) {
  const s = String(canonical);
  const i = s.indexOf(":");
  const exchange = s.slice(0, i);
  const rest = s.slice(i + 1);
  return exchange === "BSE" || exchange === "BFO" ? `${rest}.${exchange}` : rest;
}

const TICKER_RE = /^[A-Za-z0-9^][A-Za-z0-9&._^#-]{0,47}$/;

/**
 * Keep as many rows as fit in `maxChars` (header included), choosing by `rank` (lower rank kept first), and return
 * them in their original order.
 * @param {number} headerLength
 * @param {any[]} rows
 * @param {(row: any) => number} lengthOf  serialised length of one row including its separator
 * @param {number} maxChars
 * @param {(row: any, index: number) => number} rank
 * @returns {{ rows: any[], truncated: boolean }}
 */
export function fitRows(headerLength, rows, lengthOf, maxChars, rank) {
  let total = headerLength;
  for (const r of rows) total += lengthOf(r);
  if (total <= maxChars) return { rows, truncated: false };
  const order = rows.map((r, i) => ({ i, k: rank(r, i) })).sort((a, b) => a.k - b.k || a.i - b.i);
  const keep = new Set();
  let used = headerLength;
  for (const { i } of order) {
    const len = lengthOf(rows[i]);
    if (used + len > maxChars) break;
    used += len;
    keep.add(i);
  }
  return { rows: rows.filter((_, i) => keep.has(i)), truncated: true };
}

/** Option chain -> flat records keyed by CHAIN_COLUMNS. */
export function chainRecords(chain) {
  const f = chain?.freshness ?? {};
  return (chain?.rows ?? []).map((row) => {
    const rec = { underlying: chain.underlying, expiry: chain.expiry, strike: row.strike, atm: chain.atmStrike !== null && row.strike === chain.atmStrike };
    for (const side of ["ce", "pe"]) {
      const leg = row[side];
      for (const [col, key] of LEG_FIELDS) rec[`${side}_${col}`] = leg ? (leg[key] ?? null) : null;
    }
    rec.underlying_ltp = chain.underlyingLtp ?? null;
    rec.lot_size = chain.lotSize ?? null;
    rec.as_of = asOfCell(f.asOf);
    rec.source = f.source ?? null;
    rec.stale = typeof f.stale === "boolean" ? f.stale : null;
    return rec;
  });
}

/** Candles -> standard history rows (header HISTORY_COLUMNS). Daily-and-up bars show only the IST date. */
export function historyRows(candles, interval) {
  const daily = DAILY.has(interval);
  return (candles ?? []).map((c) => [daily ? istDate(c.time) : istDateTime(c.time), c.open, c.high, c.low, c.close, c.volume ?? 0, c.oi ?? null]);
}

/** Candles -> AmiBroker ASCII rows. Intraday rows have a Time column; daily-and-up rows do not (EOD format). */
export function amibrokerRows(candles, interval, ticker) {
  const daily = DAILY.has(interval);
  return (candles ?? []).map((c) =>
    daily
      ? [ticker, istDate(c.time), c.open, c.high, c.low, c.close, c.volume ?? 0, c.oi ?? 0]
      : [ticker, istDate(c.time), istTime(c.time), c.open, c.high, c.low, c.close, c.volume ?? 0, c.oi ?? 0],
  );
}

/** `#N/A` with the error's status, code header and Retry-After. */
export function xlError(err) {
  const e = asBridgeError(err);
  return text(NA, { status: e.status, headers: { "X-Error-Code": e.code, "Cache-Control": "no-store", ...errorHeaders(e) } });
}

/** Freshness headers for a single value. */
function freshnessHeaders(f) {
  if (!f) return {};
  const h = { "Cache-Control": "no-store" };
  if (f.source) h["X-Data-Source"] = String(f.source);
  if (Number.isFinite(f.ageMs)) h["X-Data-Age-Ms"] = String(Math.round(f.ageMs));
  if (typeof f.stale === "boolean") h["X-Data-Stale"] = String(f.stale);
  if (f.asOf) h["X-Data-As-Of"] = String(f.asOf);
  return h;
}

/** First item error for a symbol as a BridgeError. */
function itemError(errors, fallbackDetail) {
  const e = (errors ?? [])[0];
  if (!e) return new BridgeError("SYMBOL_NOT_FOUND", fallbackDetail);
  // BridgeError turns a code it does not know into INTERNAL, so a malformed item error cannot invent a status.
  return new BridgeError(String(e.code ?? "SYMBOL_NOT_FOUND"), e.message ?? fallbackDetail);
}

/** A table reply (CSV or JSON records) with optional trimming. */
function tableReply({ format, header, rows, records, maxChars, rank, filename }) {
  if (format === "json") {
    const recs = records.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, guardCell(v)])));
    const fit = maxChars ? fitRows(2, recs, (r) => JSON.stringify(r).length + 1, maxChars, rank) : { rows: recs, truncated: false };
    return json(fit.rows, { headers: fit.truncated ? { "X-Truncated": "true" } : {} });
  }
  const headerLen = toCsv([header]).length;
  const fit = maxChars ? fitRows(headerLen, rows, (r) => toCsv([r]).length, maxChars, rank) : { rows, truncated: false };
  return csv([header, ...fit.rows], { filename, headers: fit.truncated ? { "X-Truncated": "true" } : {} });
}

/**
 * Route handlers. `deps` is the full deps object from register(); services are read lazily on each call.
 * @param {object} deps
 * @param {ReturnType<typeof import("./config.mjs").parseIntegrationsConfig>} cfg
 */
export function createXlRoutes(deps, cfg) {
  const single = (fn) => async (ctx) => {
    try {
      return await fn(ctx);
    } catch (err) {
      return xlError(err);
    }
  };

  async function oneQuote(ctx, kind) {
    const symbol = req(ctx.query, "symbol", "NSE:NIFTY");
    const opts = readOptions(ctx);
    const r = kind === "ltp" ? await deps.marketData.ltp([symbol], opts) : await deps.marketData.quotes([symbol], opts);
    const item = (r?.items ?? [])[0];
    if (!item) throw itemError(r?.errors, `No ${kind === "ltp" ? "price" : "quote"} for ${symbol}.`);
    return item;
  }

  return {
    ltp: single(async (ctx) => {
      const item = await oneQuote(ctx, "ltp");
      const v = formatNumber(item.ltp);
      if (v === null) throw new BridgeError("NOT_FOUND", `No last price for ${item.symbol}.`);
      return text(v, { headers: freshnessHeaders(item.freshness) });
    }),

    quote: single(async (ctx) => {
      const field = enumParam(ctx.query, "field", QUOTE_FIELDS, undefined);
      if (field === undefined) throw invalid("field", `field is required: one of ${QUOTE_FIELDS.join(", ")}.`);
      const item = await oneQuote(ctx, "quote");
      const v = formatNumber(item[field]);
      if (v === null) throw new BridgeError("NOT_FOUND", `${field} has no value for ${item.symbol} right now.`);
      return text(v, { headers: freshnessHeaders(item.freshness) });
    }),

    async chain(ctx) {
      const q = ctx.query;
      const underlying = req(q, "underlying", "NIFTY");
      const expiry = req(q, "expiry", "2026-10-27");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw invalid("expiry", "expiry must be a date in YYYY-MM-DD form.");
      const format = enumParam(q, "format", ["csv", "json"], cfg.xl.chainFormat);
      const strikes = intParam(q, "strikes", 1, 100);
      const greeks = boolParam(q, "greeks", true);
      const maxChars = intParam(q, "maxChars", 256, 50_000_000);
      const opts = readOptions(ctx);
      const params = { underlying, expiry, greeks };
      if (strikes !== undefined) params.strikes = strikes;
      const chain = await deps.marketData.optionChain(params, opts);
      const records = chainRecords(chain);
      const atm = chain?.atmStrike ?? chain?.underlyingLtp ?? null;
      const rank = (r) => (atm === null ? 0 : Math.abs((Array.isArray(r) ? r[2] : r.strike) - atm));
      return tableReply({
        format,
        header: CHAIN_COLUMNS,
        rows: records.map((r) => CHAIN_COLUMNS.map((c) => r[c])),
        records,
        maxChars,
        rank,
        filename: `chain-${String(chain?.underlying ?? underlying).replace(/[^A-Za-z0-9]/g, "")}-${expiry}.csv`,
      });
    },

    async history(ctx) {
      const q = ctx.query;
      const symbol = req(q, "symbol", "NSE:NIFTY");
      const interval = opt(q, "interval");
      if (!interval || !INTERVALS.includes(interval)) throw invalid("interval", `interval is required: one of ${INTERVALS.join(", ")}.`);
      const layout = enumParam(q, "layout", ["standard", "amibroker"], cfg.xl.historyLayout);
      const format = enumParam(q, "format", ["csv", "json"], "csv");
      if (format === "json" && layout === "amibroker") throw invalid("format", "layout=amibroker is CSV only.");
      const from = opt(q, "from");
      const to = opt(q, "to");
      let countback = intParam(q, "countback", 1, 5000);
      if (from === undefined && countback === undefined) countback = cfg.xl.defaultCountback;
      const maxChars = intParam(q, "maxChars", 256, 50_000_000);
      const tickerParam = opt(q, "ticker");
      if (tickerParam !== undefined && !TICKER_RE.test(tickerParam)) throw invalid("ticker", "ticker may use letters, digits and & . _ ^ # - (up to 48 characters).");
      const opts = readOptions(ctx, { maxAge: false });
      const params = { symbol, interval };
      if (from !== undefined) params.from = from;
      if (to !== undefined) params.to = to;
      if (countback !== undefined) params.countback = countback;
      const r = await deps.marketData.history(params, opts);
      const candles = r?.candles ?? [];
      const canonical = r?.symbol ?? symbol;
      const newestFirst = (_row, i) => -i;
      const safeName = String(canonical).replace(/[^A-Za-z0-9.-]/g, "_");
      if (r?.partial) ctx.setHeader("X-Partial", "true");
      if (layout === "amibroker") {
        const ticker = tickerParam ?? amibrokerTicker(canonical);
        const header = DAILY.has(interval) ? AMIBROKER_EOD_COLUMNS : AMIBROKER_INTRADAY_COLUMNS;
        return tableReply({ format: "csv", header, rows: amibrokerRows(candles, interval, ticker), records: [], maxChars, rank: newestFirst, filename: `${safeName}-${interval}.csv` });
      }
      const rows = historyRows(candles, interval);
      const records = rows.map((row) => Object.fromEntries(HISTORY_COLUMNS.map((c, i) => [c, row[i]])));
      return tableReply({ format, header: HISTORY_COLUMNS, rows, records, maxChars, rank: newestFirst, filename: `${safeName}-${interval}.csv` });
    },
  };
}
