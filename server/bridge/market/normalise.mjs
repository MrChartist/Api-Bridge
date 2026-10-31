/**
 * Normalisers — stream S5. Turn broker contract shapes (server/brokers/contract.mjs: Quote, Depth, Candle, Dhan-shaped
 * option-chain legs) and StreamHub ticks into the OpenAPI shapes (QuoteItem, LtpItem, DepthItem, Candle, ChainLeg),
 * and build the Freshness label every market-data item carries. Pure functions, no I/O.
 *
 * Rule for missing data: a field the broker did not send is null, never 0 (0 is a real price for nothing and a real
 * open interest). The only exception is a candle's volume, which the contract defines as a number.
 */
import { toIstIso } from "./time.mjs";

/** Finite number or null. Accepts numeric strings (several brokers send them). */
export function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Positive finite number or null (prices, where 0 means "no price"). */
export function priceOrNull(v) {
  const n = numOrNull(v);
  return n !== null && n > 0 ? n : null;
}

const round = (n, dp) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/**
 * Build a Freshness label.
 * @param {{ source: "stream"|"cache"|"broker"|"paper"|"backup", at: number, now: number, targetMs: number, stale?: boolean,
 *   accountId?: string | null, broker?: string | null, provider?: string }} p
 *   stale defaults to "older than the target"; pass it explicitly to force a label (live stream ticks are never stale).
 * @returns {import("../core/contracts.mjs").Freshness}
 */
export function freshness({ source, at, now, targetMs, stale, accountId = null, broker = null, provider }) {
  const ageMs = Math.max(0, Math.round(now - at));
  const out = { source, asOf: toIstIso(at), ageMs, stale: stale ?? ageMs > targetMs, accountId: accountId ?? null, broker: broker ?? null };
  if (provider) out.provider = provider;
  return out;
}

/**
 * The quote fields of a QuoteItem (no symbol, no freshness) from a contract Quote row, or null when the row has no
 * usable last price.
 * @param {object} row contract Quote: { token, exchange, ltp, open, high, low, close, volume, oi, bid, ask, bidQty?, askQty? }
 */
export function quoteFields(row) {
  if (!row || typeof row !== "object") return null;
  const ltp = priceOrNull(row.ltp ?? row.last_price);
  if (ltp === null) return null;
  const close = priceOrNull(row.close ?? row.prevClose ?? row.previous_close);
  const change = close !== null ? round(ltp - close, 4) : null;
  return {
    ltp,
    open: priceOrNull(row.open),
    high: priceOrNull(row.high),
    low: priceOrNull(row.low),
    close,
    change,
    changePct: close !== null ? round(((ltp - close) / close) * 100, 4) : null,
    volume: numOrNull(row.volume),
    oi: numOrNull(row.oi),
    bid: priceOrNull(row.bid),
    ask: priceOrNull(row.ask),
    bidQty: numOrNull(row.bidQty ?? row.bid_qty),
    askQty: numOrNull(row.askQty ?? row.ask_qty),
  };
}

/** Quote fields from an LTP-only read (fetchLTP), with every other field null. */
export function ltpOnlyFields(ltp) {
  const p = priceOrNull(ltp);
  if (p === null) return null;
  return { ltp: p, open: null, high: null, low: null, close: null, change: null, changePct: null, volume: null, oi: null, bid: null, ask: null, bidQty: null, askQty: null };
}

/** Quote fields from a StreamHub Tick. */
export function tickFields(tick) {
  return quoteFields(tick);
}

/** Whether a tick carries quote-mode data (not just a last price). */
export function tickHasQuote(tick) {
  return Boolean(tick) && (numOrNull(tick.open) !== null || numOrNull(tick.close) !== null || numOrNull(tick.bid) !== null || numOrNull(tick.volume) !== null);
}

/** QuoteItem from fields. */
export function toQuoteItem(symbol, fields, fresh) {
  return { symbol, ...fields, freshness: fresh };
}

/** LtpItem from fields. */
export function toLtpItem(symbol, fields, fresh) {
  return { symbol, ltp: fields.ltp, freshness: fresh };
}

/** DepthLevel[] from a contract side, dropping malformed levels. */
function levels(side) {
  if (!Array.isArray(side)) return [];
  const out = [];
  for (const l of side) {
    const price = numOrNull(l?.price);
    const qty = numOrNull(l?.qty ?? l?.quantity);
    if (price === null || qty === null) continue;
    const orders = numOrNull(l?.orders);
    out.push({ price, qty, orders: orders === null ? null : Math.trunc(orders) });
  }
  return out;
}

/**
 * Depth { bids, asks } from a contract Depth (adapter result data). Bids are sorted best (highest) first and asks
 * best (lowest) first, whatever order the broker sent.
 */
export function depthFields(data) {
  const bids = levels(data?.bids).sort((a, b) => b.price - a.price);
  const asks = levels(data?.asks).sort((a, b) => a.price - b.price);
  return { bids, asks };
}

/**
 * Normalise contract candles: finite OHLC, integer epoch-second times, volume a number, oi kept when present.
 * Malformed rows are dropped.
 */
export function normaliseCandles(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const c of rows) {
    const time = numOrNull(c?.time);
    const open = numOrNull(c?.open);
    const high = numOrNull(c?.high);
    const low = numOrNull(c?.low);
    const close = numOrNull(c?.close);
    if (time === null || open === null || high === null || low === null || close === null) continue;
    // Some brokers send epoch ms; the contract says seconds.
    const t = time > 1e11 ? Math.floor(time / 1000) : Math.floor(time);
    const candle = { time: t, open, high, low, close, volume: numOrNull(c.volume) ?? 0 };
    const oi = numOrNull(c.oi);
    if (oi !== null) candle.oi = oi;
    out.push(candle);
  }
  return out;
}

/**
 * Merge candle lists: de-duplicate by time (a later list wins, so newer chunks replace overlapping bars) and sort
 * ascending.
 */
export function mergeCandles(lists) {
  const byTime = new Map();
  for (const list of lists) for (const c of list) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

const GREEK_KEYS = ["delta", "gamma", "theta", "vega"];

/**
 * Open interest in UNITS (docs/spec/p1-01-recorder.md §10). `unit` is what the broker sends (market/oiUnits.mjs):
 * "units" passes through; "lots" is multiplied by the leg's lot size, and becomes null when the lot size is unknown
 * (never a guess).
 * @param {unknown} value
 * @param {"units"|"lots"} [unit]
 * @param {number | null} [lotSize]
 * @returns {number | null}
 */
export function oiToUnits(value, unit = "units", lotSize = null) {
  const n = numOrNull(value);
  if (n === null || unit !== "lots") return n;
  return Number.isFinite(lotSize) && lotSize > 0 ? n * lotSize : null;
}

/**
 * ChainLeg fields (no symbol) from a Dhan-shaped contract leg (the same aliases brokers/contractShapes.mjs
 * toOptionData reads), keeping nulls for missing fields. OI fields are converted to units (`oiUnit`, `lotSize`).
 * @param {object | null | undefined} leg
 * @param {{ oiUnit?: "units"|"lots", lotSize?: number | null }} [opts]
 * @returns {{ ltp, bid, ask, oi, oiChange, volume, iv, close, change, delta, gamma, theta, vega } | null}
 */
export function chainLegFields(leg, { oiUnit = "units", lotSize = null } = {}) {
  if (!leg || typeof leg !== "object") return null;
  const g = leg.greeks && typeof leg.greeks === "object" ? leg.greeks : {};
  const oi = oiToUnits(leg.oi, oiUnit, lotSize);
  const prevOi = oiToUnits(leg.previous_oi, oiUnit, lotSize);
  const oiChg = oiToUnits(leg.oi_chg ?? leg.oiChange, oiUnit, lotSize);
  const iv = numOrNull(leg.implied_volatility ?? leg.iv);
  const ltp = priceOrNull(leg.last_price ?? leg.ltp);
  // Previous session's close, when the broker sends it: lets clients read price change (and OI build-up) per leg.
  const close = priceOrNull(leg.previous_close_price ?? leg.prev_close ?? leg.previous_close ?? leg.prevClose ?? leg.close);
  const out = {
    ltp,
    bid: priceOrNull(leg.top_bid_price ?? leg.best_bid_price ?? leg.bid_price ?? leg.bid),
    ask: priceOrNull(leg.top_ask_price ?? leg.best_ask_price ?? leg.ask_price ?? leg.ask),
    oi,
    oiChange: oiChg !== null ? oiChg : oi !== null && prevOi !== null ? oi - prevOi : null,
    volume: numOrNull(leg.volume),
    iv: iv !== null && iv > 0 ? iv : null,
    close,
    change: ltp !== null && close !== null ? round(ltp - close, 4) : null,
  };
  for (const k of GREEK_KEYS) out[k] = numOrNull(g[k] ?? leg[k]);
  return out;
}

/** True when a leg has no usable Greeks (all missing, or the all-zero placeholder some brokers send). */
export function legLacksGreeks(fields) {
  return GREEK_KEYS.every((k) => fields[k] === null || fields[k] === 0) || fields.iv === null;
}

/** Null out a leg's Greeks (greeks=false). IV stays: it is a price measure, not a Greek. */
export function stripGreeks(fields) {
  const out = { ...fields };
  for (const k of GREEK_KEYS) out[k] = null;
  return out;
}

export { GREEK_KEYS };
