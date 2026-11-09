/**
 * TradingView alert receiver.
 *
 * TradingView posts the alert's message as the request body. If the message is valid JSON it sends
 * `Content-Type: application/json`, otherwise `text/plain`; it cannot add headers, so the credential is the secret URL
 * plus a `passphrase` written inside the message (checked by the route, in constant time, before anything else here
 * is read). See docs/guides/webhooks.md for the verified TradingView facts and their sources.
 *
 * Our alert message, JSON form (field names are ours; TradingView placeholders go in the values):
 *   { "symbol": "{{exchange}}:{{ticker}}", "side": "buy", "lots": 1, "orderType": "limit", "price": {{close}},
 *     "product": "MIS", "mode": "paper", "id": "my-alert", "time": "{{timenow}}", "passphrase": "..." }
 * Strategy form: side from {{strategy.order.action}}, "lots" from {{strategy.order.contracts}}, price from
 *   {{strategy.order.price}}, "marketPosition" from {{strategy.market_position}}, "positionSize" from
 *   {{strategy.market_position_size}}, "id" from {{strategy.order.id}}.
 * Plain-text form (one order per alert, words in any order after the side):
 *   BUY NSE:RELIANCE 1 @ 1402.5 MIS mode=paper id=my-alert time=2026-11-09T09:56:00Z passphrase=...
 *
 * Fields: symbol (with its exchange), side, quantity | lots (not both), orderType, price, product, account, mode
 * (default paper), marketPosition, positionSize, time, id, passphrase. Any other field refuses the alert: a typo such
 * as "quantiy" must never turn into a default one-lot order.
 *
 * Alert identity (replay and duplicate protection) is id AND time together, plus symbol and side: TradingView's
 * default strategy order ids ("Long", "Short") repeat every day, so an id alone proves nothing. Without a time the
 * alert is identified by its exact bytes inside the dedupe window only.
 */
import { assertNoPlaceholders, invalid, signalFromObject, signalFromText, toNumber } from "./common.mjs";

/** JSON keys (lower case, as matched) and the name they have in our schema. */
const FIELD_NAMES = Object.freeze({
  symbol: "symbol",
  ticker: "symbol",
  exchange: "exchange",
  side: "side",
  action: "side",
  quantity: "quantity",
  qty: "quantity",
  lots: "lots",
  ordertype: "orderType",
  price: "price",
  product: "product",
  account: "account",
  mode: "mode",
  marketposition: "marketPosition",
  positionsize: "positionSize",
  time: "time",
  id: "id",
  passphrase: "passphrase",
});
const KNOWN_LIST = "symbol, side, quantity or lots, orderType, price, product, account, mode, marketPosition, positionSize, time, id, passphrase";
/** Fields only the TradingView layer reads (the shared text grammar does not know them). */
const TEXT_EXTRAS = new Set(["passphrase", "mode", "account", "marketposition", "positionsize"]);
const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * The passphrase an alert carries, or "" when it has none. Cheap and lenient on purpose: it runs BEFORE the
 * alert is validated, so an unauthenticated caller never learns anything from a validation message.
 * @param {unknown} body object (a JSON alert) or string (a text alert)
 * @returns {string}
 */
export function extractPassphrase(body) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    for (const [k, v] of Object.entries(body)) if (k.toLowerCase() === "passphrase" && typeof v === "string") return v;
    return "";
  }
  if (typeof body !== "string") return "";
  const kv = /(?:^|[\s,;])passphrase=([^\s,;]+)/i.exec(body);
  if (kv) return kv[1];
  // A message that was meant to be JSON but is not valid: still read the quoted value so the person gets the helpful
  // "this is not valid JSON" answer instead of a confusing "wrong passphrase".
  const q = /"passphrase"\s*:\s*"([^"\\]{0,200})"/i.exec(body);
  return q ? q[1] : "";
}

/** "2026-11-09T09:56:00Z" (also with milliseconds or a +05:30 offset) to epoch milliseconds. */
export function parseAlertTime(value, path = "time") {
  const s = String(value ?? "").trim();
  if (!TIME_RE.test(s)) {
    throw invalid(`${path} must look like 2026-11-09T09:56:00Z, which is what {{timenow}} gives (got "${s.slice(0, 40)}").`, path);
  }
  const ms = Date.parse(/[+-]\d{4}$/.test(s) ? s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2") : s);
  if (!Number.isFinite(ms)) throw invalid(`${path} is not a real date and time.`, path);
  return ms;
}

/** The time as epoch milliseconds when it is written the way TradingView writes it, else null (never throws). */
export function tryAlertTime(value) {
  try {
    return value === null || value === undefined || value === "" ? null : parseAlertTime(value);
  } catch {
    return null;
  }
}

/** A dated canonical contract such as NFO:NIFTY-2026-10-27-FUT: it is not a charting ticker and keeps its own form. */
export function isDatedCanonical(symbol) {
  return /^[A-Za-z]{3}:.+-\d{4}-\d{2}-\d{2}(-|$)/.test(String(symbol));
}

/** A size that may be zero (a flat strategy), from a number or numeric string; negative values are refused with a hint. */
function nonNegative(v, path) {
  if (typeof v === "string" && /^\s*-/.test(v)) throw invalid(`${path} must not be negative: send the size as a positive number and the direction in marketPosition ({{strategy.market_position_size}} already is).`, path);
  if (typeof v === "number" && v < 0) throw invalid(`${path} must not be negative: send the size as a positive number and the direction in marketPosition ({{strategy.market_position_size}} already is).`, path);
  if (v === 0 || v === "0") return 0;
  return toNumber(v, path);
}

/** Validate the fields only this source has (mode, account, marketPosition, positionSize) and the time. */
function extras(o, path = (n) => n) {
  const out = { account: null, mode: null, marketPosition: null, positionSize: null };
  if (o.account !== undefined && o.account !== "") {
    const a = String(o.account).trim();
    if (!ACCOUNT_RE.test(a)) throw invalid("account must be an account id from your config, such as dhan-main.", path("account"));
    out.account = a;
  }
  if (o.mode !== undefined && o.mode !== "") {
    const m = String(o.mode).trim().toLowerCase();
    if (m !== "paper" && m !== "live") throw invalid(`mode must be paper or live (got "${String(o.mode).slice(0, 20)}").`, path("mode"));
    out.mode = m;
  }
  if (o.marketPosition !== undefined && o.marketPosition !== "") {
    const p = String(o.marketPosition).trim().toLowerCase();
    if (p !== "long" && p !== "flat" && p !== "short") throw invalid(`marketPosition must be long, flat or short (got "${String(o.marketPosition).slice(0, 20)}").`, path("marketPosition"));
    out.marketPosition = p;
  }
  if (o.positionSize !== undefined && o.positionSize !== "") out.positionSize = nonNegative(o.positionSize, path("positionSize"));
  return out;
}

/** Our canonical field names for a JSON alert's keys; refuses any key that is not ours. */
function canonicalFields(body) {
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    const name = FIELD_NAMES[k.toLowerCase()];
    if (!name) {
      const hint =
        k.toLowerCase() === "contracts"
          ? ' In a futures or options strategy {{strategy.order.contracts}} counts lots, so send it as "lots" (or as "quantity" for shares).'
          : "";
      throw invalid(`The alert has a field the Bridge does not know: "${k.slice(0, 30)}".${hint} Fields: ${KNOWN_LIST}.`, k.slice(0, 30));
    }
    if (out[name] !== undefined && out[name] !== "" && v !== undefined && v !== "") throw invalid(`The alert gives ${name} twice.`, name);
    if (out[name] === undefined || out[name] === "") out[name] = v;
  }
  return out;
}

/**
 * @param {unknown} body  a parsed JSON object (application/json) or a string (text/plain)
 * @returns {import("./common.mjs").ParsedAlert}
 */
export function parseTradingView(body) {
  let fields;
  /** @type {import("./common.mjs").Signal} */
  let signal;
  if (typeof body === "string") {
    const text = body.trim();
    if (!text) throw invalid("The alert text is empty.");
    if (/^[{[]/.test(text)) {
      throw invalid(
        'The alert looks like JSON but is not valid JSON (TradingView only sends it as JSON when it is valid). Put text placeholders in quotes, for example "symbol": "{{exchange}}:{{ticker}}", and leave numbers such as {{close}} without quotes.',
      );
    }
    if (text.length > 2000) throw invalid("The alert text is too long (2,000 characters at most).");
    assertNoPlaceholders(text);
    const kv = {};
    const rest = [];
    for (const tok of text.split(/[\s,;]+/).filter(Boolean)) {
      const eq = tok.indexOf("=");
      const key = eq > 0 ? tok.slice(0, eq).toLowerCase() : "";
      if (TEXT_EXTRAS.has(key)) kv[FIELD_NAMES[key]] = tok.slice(eq + 1);
      else rest.push(tok);
    }
    signal = signalFromText(rest.join(" "));
    fields = kv;
  } else if (body && typeof body === "object" && !Array.isArray(body)) {
    const f = canonicalFields(/** @type {Record<string, unknown>} */ (body));
    delete f.passphrase;
    assertNoPlaceholders(f);
    fields = f;
    signal = signalFromObject({
      symbol: f.symbol,
      exchange: f.exchange,
      side: f.side,
      quantity: f.quantity,
      lots: f.lots,
      price: f.price,
      orderType: f.orderType,
      product: f.product,
      id: f.id,
      time: f.time,
    });
  } else {
    throw invalid("A TradingView alert must be JSON or one line of text.");
  }
  if (!signal.symbol.includes(":")) {
    throw invalid(
      `The symbol "${signal.symbol.slice(0, 40)}" has no exchange, and the same name can exist on more than one exchange. Send {{exchange}}:{{ticker}} (for example NSE:RELIANCE).`,
      "symbol",
    );
  }
  const x = extras(fields);
  const timeMs = signal.time ? parseAlertTime(signal.time) : null;
  const full = { ...signal, ...x, timeMs, symbolFrom: /** @type {const} */ ("chart") };
  const basis = full.time ? `tv|${full.ref ?? ""}|${full.time}|${full.symbol}|${full.side ?? ""}|${full.lots ?? full.quantity ?? ""}` : null;
  return { signals: [full], basis, dropped: 0 };
}
