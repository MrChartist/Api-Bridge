/**
 * Shared parsing for inbound alerts — stream S11.
 *
 * Every receiver turns an alert into one or more Signals. A Signal is only what the alert ASKED for; the worker
 * then applies the hook's fixed mapping and caps (account, allowed symbols, lots cap, product, order type, side,
 * paper or live, confirmation) and refuses anything the hook does not allow. Parsing is strict: an unknown word in
 * a text alert, an unfilled {{placeholder}} or a malformed number refuses the alert rather than
 * guessing, because a guessed order is worse than no order.
 *
 * @typedef {{ symbol: string, side: "BUY"|"SELL"|null, quantity: number|null, lots: number|null, price: number|null,
 *   triggerPrice: number|null, orderType: "LIMIT"|"MARKET"|"SL"|"SL-M"|null, product: "CNC"|"INTRADAY"|"MARGIN"|null, ref: string|null, time: string|null }} Signal
 *   ref + time: the sender's own identity for the signal (for example an order id plus the alert time).
 * @typedef {{ signals: Signal[], basis: string | null, dropped: number }} ParsedAlert
 *   basis: a stable identity for the alert when the sender supplies one (order id + time);
 *   null means "identify the alert by its exact bytes inside the dedupe window".
 */
import { BridgeError } from "../../core/errors.mjs";

/** Most signals one alert may produce (a ChartInk scan can list many stocks; the rest are dropped and reported). */
export const MAX_SIGNALS_PER_ALERT = 20;
const PLACEHOLDER_RE = /\{\{[^}]{0,80}\}\}/;
const NUM_RE = /^[+]?\d{1,12}(\.\d{1,8})?$/;

/** @param {string} detail @param {string} [path] */
export const invalid = (detail, path = "(body)") => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });

/** Refuse an alert that still contains an unfilled {{placeholder}}. */
export function assertNoPlaceholders(value, path = "(body)") {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const m = PLACEHOLDER_RE.exec(s);
  if (m) {
    throw invalid(
      `The alert still contains the placeholder ${m[0].slice(0, 60)}, which the sender did not fill in; use the alert template for your hook.`,
      path,
    );
  }
}

/**
 * A positive number from a number or numeric string, else null when absent; throws when present but malformed.
 * @param {unknown} v @param {string} path @param {{ integer?: boolean }} [opts]
 */
export function toNumber(v, path, { integer = false } = {}) {
  if (v === undefined || v === null || v === "") return null;
  let n;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && NUM_RE.test(v.trim())) n = Number(v.trim());
  else throw invalid(`${path} must be a number.`, path);
  if (!Number.isFinite(n) || n <= 0) throw invalid(`${path} must be greater than zero.`, path);
  if (integer && !Number.isInteger(n)) throw invalid(`${path} must be a whole number.`, path);
  return n;
}

/** BUY/SELL from common spellings (buy, sell, BUY, Sell). Anything else (long, short, exit) is refused. */
export function toSide(v, path = "side") {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim().toUpperCase();
  if (s === "BUY" || s === "SELL") return s;
  throw invalid(`${path} must be buy or sell (got "${String(v).slice(0, 20)}").`, path);
}

const ORDER_TYPES = { LIMIT: "LIMIT", LMT: "LIMIT", L: "LIMIT", MARKET: "MARKET", MKT: "MARKET", M: "MARKET", SL: "SL", "SL-L": "SL", "SL-LMT": "SL", "SL-M": "SL-M", SLM: "SL-M", "SL-MKT": "SL-M" };
/** LIMIT, MARKET, SL (stop-loss limit) or SL-M (stop-loss market), accepting the common broker spellings. */
export function toOrderType(v, path = "orderType") {
  if (v === undefined || v === null || v === "") return null;
  const t = ORDER_TYPES[String(v).trim().toUpperCase()];
  if (!t) throw invalid(`${path} must be LIMIT, MARKET, SL or SL-M.`, path);
  return t;
}

const PRODUCTS = { CNC: "CNC", DELIVERY: "CNC", INTRADAY: "INTRADAY", MIS: "INTRADAY", MARGIN: "MARGIN", NRML: "MARGIN", CARRYFORWARD: "MARGIN" };
/** CNC/INTRADAY/MARGIN, accepting the common broker spellings MIS and NRML. */
export function toProduct(v, path = "product") {
  if (v === undefined || v === null || v === "") return null;
  const p = PRODUCTS[String(v).trim().toUpperCase()];
  if (!p) throw invalid(`${path} must be CNC, INTRADAY (MIS) or MARGIN (NRML).`, path);
  return p;
}

/** A short identifier string (strategy order id, alert id), else null. */
export function toRef(v, path) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" && typeof v !== "number") throw invalid(`${path} must be text.`, path);
  const s = String(v).trim();
  if (s.length > 128) throw invalid(`${path} is too long (128 characters at most).`, path);
  return s;
}

const pick = (o, names) => {
  for (const n of names) if (o[n] !== undefined && o[n] !== null && o[n] !== "") return o[n];
  return undefined;
};

/**
 * One Signal from a JSON object, accepting the common field spellings used by charting-platform alerts, compact
 * payloads and hand-written scripts.
 * @param {Record<string, unknown>} o
 * @param {string} [prefix] path prefix for error messages
 * @returns {Signal}
 */
export function signalFromObject(o, prefix = "") {
  if (!o || typeof o !== "object" || Array.isArray(o)) throw invalid("The alert must be a JSON object.", prefix || "(body)");
  const p = (n) => (prefix ? `${prefix}.${n}` : n);
  let symbol = pick(o, ["symbol", "ticker", "tradingsymbol", "tradingSymbol"]);
  if (typeof symbol === "number") symbol = String(symbol);
  if (typeof symbol !== "string" || !symbol.trim()) throw invalid("symbol is required, for example NSE:RELIANCE.", p("symbol"));
  symbol = symbol.trim();
  const exchange = pick(o, ["exchange"]);
  if (!symbol.includes(":") && typeof exchange === "string" && /^[A-Za-z]{2,4}$/.test(exchange.trim())) symbol = `${exchange.trim().toUpperCase()}:${symbol}`;
  if (symbol.length > 64) throw invalid("symbol is too long.", p("symbol"));
  const quantity = toNumber(pick(o, ["quantity", "qty", "contracts"]), p("quantity"), { integer: true });
  const lots = toNumber(pick(o, ["lots"]), p("lots"), { integer: true });
  if (quantity !== null && lots !== null) throw invalid("Send quantity or lots, not both.", p("quantity"));
  return {
    symbol,
    side: toSide(pick(o, ["side", "action", "transaction_type", "transactionType"]), p("side")),
    quantity,
    lots,
    price: toNumber(pick(o, ["price", "limit_price", "limitPrice"]), p("price")),
    triggerPrice: toNumber(pick(o, ["triggerPrice", "trigger_price", "stopPrice", "stop_price"]), p("triggerPrice")),
    orderType: toOrderType(pick(o, ["orderType", "order_type", "pricetype", "priceType"]), p("orderType")),
    product: toProduct(pick(o, ["product"]), p("product")),
    ref: toRef(pick(o, ["id", "orderId", "order_id", "signalId"]), p("id")),
    time: toRef(pick(o, ["time", "timenow", "timestamp"]), p("time")),
  };
}

/**
 * One Signal from a plain-text alert. Two styles, which may be mixed:
 *   positional:  "BUY NSE:RELIANCE 10 @ 1402.5"   "SELL NFO:NIFTY-2026-10-27-25000-CE 2 lots MKT INTRADAY"
 *   key=value:   "side=buy symbol=NSE:RELIANCE qty=10 price=1402.5 id=42"
 *   stop-loss:   "SELL NSE:RELIANCE 10 SL-M trigger=1390"   "SELL NSE:RELIANCE 10 @ 1388 SL trigger=1390"
 * Separators: spaces, commas, semicolons, new lines. Any word the grammar does not know refuses the alert.
 * @param {string} text
 * @returns {Signal}
 */
export function signalFromText(text) {
  if (typeof text !== "string" || !text.trim()) throw invalid("The alert text is empty.");
  if (text.length > 2000) throw invalid("The alert text is too long (2,000 characters at most).");
  assertNoPlaceholders(text);
  const kv = {};
  const tokens = text.trim().split(/[\s,;]+/).filter(Boolean);
  let side = null;
  let symbol = null;
  let quantity = null;
  let lots = null;
  let price = null;
  let orderType = null;
  let product = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const eq = t.indexOf("=");
    if (eq > 0) {
      kv[t.slice(0, eq).toLowerCase()] = t.slice(eq + 1);
      continue;
    }
    const up = t.toUpperCase();
    if (up === "BUY" || up === "SELL") {
      if (side && side !== up) throw invalid("The alert says both buy and sell.");
      side = up;
    } else if (t === "@") {
      i += 1;
      price = toNumber(tokens[i], "price");
    } else if (t.startsWith("@")) {
      price = toNumber(t.slice(1), "price");
    } else if (NUM_RE.test(t)) {
      const next = (tokens[i + 1] ?? "").toUpperCase();
      if (next === "LOT" || next === "LOTS") {
        lots = toNumber(t, "lots", { integer: true });
        i += 1;
      } else if (quantity === null && lots === null) quantity = toNumber(t, "quantity", { integer: true });
      else if (price === null) price = toNumber(t, "price");
      else throw invalid(`The alert has an extra number "${t.slice(0, 20)}".`);
    } else if (ORDER_TYPES[up] && up.length > 1) {
      orderType = ORDER_TYPES[up];
    } else if (PRODUCTS[up]) {
      product = PRODUCTS[up];
    } else if (symbol === null && /^[A-Za-z0-9:&._!-]{1,64}$/.test(t)) {
      symbol = t;
    } else {
      throw invalid(`The alert has a word the Bridge does not understand: "${t.slice(0, 30)}".`);
    }
  }
  const obj = {
    ...kv,
    ...(symbol !== null && kv.symbol === undefined ? { symbol } : {}),
    ...(side !== null && kv.side === undefined ? { side } : {}),
    ...(quantity !== null && kv.qty === undefined && kv.quantity === undefined ? { quantity } : {}),
    ...(lots !== null && kv.lots === undefined ? { lots } : {}),
    ...(price !== null && kv.price === undefined ? { price } : {}),
    ...(orderType !== null && kv.ordertype === undefined ? { orderType } : {}),
    ...(product !== null && kv.product === undefined ? { product } : {}),
  };
  if (kv.ordertype !== undefined) obj.orderType = kv.ordertype;
  if (kv.trigger !== undefined || kv.triggerprice !== undefined) obj.triggerPrice = kv.trigger ?? kv.triggerprice;
  const known = new Set(["trigger", "triggerprice", "symbol", "ticker", "exchange", "side", "action", "qty", "quantity", "contracts", "lots", "price", "ordertype", "orderType", "product", "id", "orderid", "time"]);
  for (const k of Object.keys(kv)) if (!known.has(k)) throw invalid(`The alert has a field the Bridge does not understand: "${k.slice(0, 30)}".`);
  if (kv.orderid !== undefined && obj.id === undefined) obj.id = kv.orderid;
  return signalFromObject(obj);
}
