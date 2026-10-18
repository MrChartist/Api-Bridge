/**
 * The Bridge's canonical symbol format: pure parsing and formatting, no data. (SymbolService, stream S4, adds the
 * instrument masters: lot size, tick size, broker tokens.)
 *
 *   Cash / index   NSE:RELIANCE   NSE:NIFTY   BSE:SENSEX   NSE:BAJAJ-AUTO   NSE:M&M
 *   Future         NFO:NIFTY-2026-10-27-FUT            MCX:CRUDEOIL-2026-11-19-FUT
 *   Option         NFO:NIFTY-2026-10-27-25000-CE       BFO:SENSEX-2026-10-30-82500-PE   NFO:VEDL-2026-10-27-292.5-CE
 *
 * Grammar:  EXCHANGE ":" UNDERLYING [ "-" YYYY-MM-DD ( "-FUT" | "-" STRIKE "-" ("CE"|"PE") ) ]
 *   EXCHANGE    NSE | BSE (cash and indices) · NFO | BFO (equity derivatives) · MCX | CDS — the broker contract's codes
 *   UNDERLYING  upper-case exchange symbol; may contain "-", "&" and "_" (BAJAJ-AUTO, M&M)
 *   STRIKE      plain decimal, no exponent, no leading zeros, no trailing zeros after the point (25000, 292.5, 83.25)
 *
 * Why this shape: it reads like the contract (what you trade, when it expires, which strike and side), the ISO date
 * removes the DDMMMYY / YYMDD / weekly-code ambiguity of exchange trading symbols, and it is reversible without any
 * lookup: the expiry/strike/right suffix is parsed from the RIGHT, so hyphens inside the underlying are harmless.
 * The exchange codes are the broker contract's own, so a canonical symbol maps 1:1 onto an InstrumentRef exchange.
 *
 * Accepted aliases on input (parseAny): the "venue" form with NSE/BSE for derivatives (NSE:NIFTY-2026-10-27-FUT ->
 * NFO:...), TradingView tickers, and the OpenAlgo-style trading symbol format (a published format; no code reused).
 */
import { BridgeError } from "./errors.mjs";

export const EXCHANGES = Object.freeze(["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"]);
export const CASH_EXCHANGES = Object.freeze(["NSE", "BSE"]);
export const DERIVATIVE_EXCHANGES = Object.freeze(["NFO", "BFO", "MCX", "CDS"]);
/** Venue -> derivatives segment, for the lenient venue form. */
const VENUE_TO_SEGMENT = Object.freeze({ NSE: "NFO", BSE: "BFO" });
/** Well-known index names. For other cash symbols parse() says EQ; SymbolService corrects kind from the master. */
export const INDEX_NAMES = Object.freeze(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "INDIAVIX", "SENSEX", "BANKEX", "SENSEX50"]);
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

const UNDERLYING_RE = /^[A-Z0-9][A-Z0-9&_-]{0,29}$/;
const CANONICAL_RE = /^([A-Z]{3}):([A-Z0-9][A-Z0-9&_-]*?)(?:-(\d{4}-\d{2}-\d{2})-(?:(FUT)|(\d+(?:\.\d+)?)-(CE|PE)))?$/;

const bad = (msg) => new BridgeError("VALIDATION_FAILED", msg);

function isRealDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && y <= 2100 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Strike number -> canonical text (25000, 292.5, 83.25). Throws on non-positive or more than 4 decimals. */
export function normaliseStrike(strike) {
  const n = typeof strike === "string" ? Number(strike) : strike;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) throw bad(`Strike must be a positive number, got ${strike}.`);
  const fixed = n.toFixed(4).replace(/\.?0+$/, "");
  if (Math.abs(Number(fixed) - n) > 1e-9) throw bad(`Strike ${strike} has more than 4 decimal places.`);
  return fixed;
}

/**
 * Build a canonical symbol from parts.
 * @param {{ exchange: string, underlying: string, kind?: string, expiry?: string | null, strike?: number | string | null, right?: string | null }} p
 */
export function formatSymbol(p) {
  const exchange = String(p.exchange ?? "").toUpperCase();
  const underlying = String(p.underlying ?? "").toUpperCase();
  if (!EXCHANGES.includes(exchange)) throw bad(`Unknown exchange ${p.exchange}. Use one of ${EXCHANGES.join(", ")}.`);
  if (!UNDERLYING_RE.test(underlying)) throw bad(`Not a valid underlying: ${p.underlying}.`);
  const kind = p.kind ?? (p.right ? "OPT" : p.expiry ? "FUT" : INDEX_NAMES.includes(underlying) ? "INDEX" : "EQ");
  if (kind === "EQ" || kind === "INDEX") {
    if (!CASH_EXCHANGES.includes(exchange)) throw bad(`${exchange} has no cash or index instruments; use NSE or BSE.`);
    return `${exchange}:${underlying}`;
  }
  if (!DERIVATIVE_EXCHANGES.includes(exchange)) throw bad(`Derivatives use NFO, BFO, MCX or CDS, not ${exchange}.`);
  const expiry = String(p.expiry ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || !isRealDate(expiry)) throw bad(`Expiry must be an ISO date YYYY-MM-DD, got ${p.expiry}.`);
  if (kind === "FUT") return `${exchange}:${underlying}-${expiry}-FUT`;
  if (kind !== "OPT") throw bad(`Unknown instrument kind ${kind}.`);
  const right = String(p.right ?? "").toUpperCase();
  if (right !== "CE" && right !== "PE") throw bad("Option right must be CE or PE.");
  return `${exchange}:${underlying}-${expiry}-${normaliseStrike(p.strike)}-${right}`;
}

/**
 * Parse a canonical symbol (or the lenient venue form). Returns parts plus the canonical string.
 * @param {string} input
 * @param {{ lenient?: boolean }} [opts] lenient (default true): accept lower case, spaces around, and NSE/BSE for derivatives.
 * @returns {import("./contracts.mjs").ParsedSymbol}
 */
export function parseSymbol(input, { lenient = true } = {}) {
  const raw = String(input ?? "");
  const s = lenient ? raw.trim().toUpperCase() : raw;
  if (s.length === 0 || s.length > 64) throw bad("Symbol must be 1 to 64 characters.");
  const m = CANONICAL_RE.exec(s);
  if (!m) throw bad(`"${raw}" is not a Bridge symbol. Examples: NSE:RELIANCE, NFO:NIFTY-2026-10-27-FUT, NFO:NIFTY-2026-10-27-25000-CE.`);
  let [, exchange, underlying, expiry, fut, strikeText, right] = m;
  if (!EXCHANGES.includes(exchange)) throw bad(`Unknown exchange ${exchange}. Use one of ${EXCHANGES.join(", ")}.`);
  if (!UNDERLYING_RE.test(underlying) || /-$/.test(underlying)) throw bad(`Not a valid underlying: ${underlying}.`);
  if (expiry && lenient && VENUE_TO_SEGMENT[exchange]) exchange = VENUE_TO_SEGMENT[exchange];
  if (!expiry) {
    const kind = INDEX_NAMES.includes(underlying) ? "INDEX" : "EQ";
    const canonical = formatSymbol({ exchange, underlying, kind });
    return { canonical, exchange, kind, underlying, expiry: null, strike: null, right: null };
  }
  const kind = fut ? "FUT" : "OPT";
  const strike = kind === "OPT" ? Number(strikeText) : null;
  const canonical = formatSymbol({ exchange, underlying, kind, expiry, strike, right });
  if (!lenient && canonical !== s) throw bad(`"${raw}" is not in canonical form; did you mean ${canonical}?`);
  return { canonical, exchange, kind, underlying, expiry, strike, right: right ?? null };
}

/** True when `s` is exactly a canonical symbol. */
export function isCanonicalSymbol(s) {
  try {
    return parseSymbol(s, { lenient: false }).canonical === s;
  } catch {
    return false;
  }
}

// ── TradingView tickers ──

/**
 * TradingView spells NSE/BSE tickers without "-" and "&": both become "_" (NSE:M_M for M&M, NSE:BAJAJ_AUTO for
 * BAJAJ-AUTO). "_" is ambiguous on the way back, so names that carry "&" are listed here; every other "_" is "-".
 * Exchange symbols never contain "_" themselves. Keep this list in step with the masters (needs verification).
 */
export const TV_AMPERSAND_NAMES = Object.freeze(["M&M", "M&MFIN", "J&KBANK", "GMRP&UI", "S&SPOWER"]);
const TV_AMPERSAND_BY_TV = Object.freeze(Object.fromEntries(TV_AMPERSAND_NAMES.map((n) => [n.replace(/&/g, "_"), n])));

/**
 * Index tickers TradingView names differently from the exchange (needs verification against TradingView's symbol
 * search). TradingView name -> canonical underlying, per venue.
 */
export const TV_INDEX_ALIASES = Object.freeze({
  NSE: Object.freeze({ CNXFINANCE: "FINNIFTY", NIFTY_MID_SELECT: "MIDCPNIFTY" }),
  BSE: Object.freeze({}),
});
const TV_INDEX_BY_CANONICAL = Object.freeze(
  Object.fromEntries(Object.entries(TV_INDEX_ALIASES).map(([v, m]) => [v, Object.fromEntries(Object.entries(m).map(([tv, c]) => [c, tv]))])),
);

/** TradingView underlying -> exchange underlying ("M_M" -> "M&M", "BAJAJ_AUTO" -> "BAJAJ-AUTO"). */
export function fromTradingViewName(name) {
  const n = String(name ?? "").toUpperCase();
  if (!n.includes("_")) return n;
  return TV_AMPERSAND_BY_TV[n] ?? n.replace(/_/g, "-");
}

/** Exchange underlying -> TradingView underlying ("M&M" -> "M_M", "BAJAJ-AUTO" -> "BAJAJ_AUTO"). */
export function toTradingViewName(name) {
  return String(name ?? "").replace(/[-&]/g, "_");
}

/**
 * Parse a TradingView ticker. Cash/index tickers map directly. Continuous futures ("NSE:NIFTY1!") need an expiry
 * lookup, so they come back with `continuous` set and `canonical: null` for SymbolService to resolve. Option tickers
 * "NSE:NIFTY261027C25000" (YYMMDD + C|P + strike) follow TradingView's NSE convention (needs verification).
 * @returns {{ canonical: string | null, exchange: string, underlying: string, kind: string, continuous?: number,
 *   expiry?: string, strike?: number, right?: string }}
 */
export function parseTradingView(ticker) {
  const s = String(ticker ?? "").trim().toUpperCase();
  const m = /^([A-Z]+):([A-Z0-9&_-]+?)(?:(\d)!|(\d{2})(\d{2})(\d{2})([CP])(\d+(?:\.\d+)?))?$/.exec(s);
  if (!m) throw bad(`"${ticker}" is not a TradingView ticker like NSE:NIFTY or NSE:NIFTY1!.`);
  const [, venue, tvUnderlying, cont, yy, mm, dd, cp, strike] = m;
  if (!CASH_EXCHANGES.includes(venue) && !DERIVATIVE_EXCHANGES.includes(venue)) throw bad(`Unknown TradingView exchange ${venue}.`);
  const indexAlias = !cont && !cp ? TV_INDEX_ALIASES[venue]?.[tvUnderlying] : undefined;
  const underlying = indexAlias ?? fromTradingViewName(tvUnderlying);
  if (cont) {
    const exchange = VENUE_TO_SEGMENT[venue] ?? venue;
    return { canonical: null, exchange, underlying, kind: "FUT", continuous: Number(cont) };
  }
  if (cp) {
    const exchange = VENUE_TO_SEGMENT[venue] ?? venue;
    const expiry = `20${yy}-${mm}-${dd}`;
    const right = cp === "C" ? "CE" : "PE";
    const canonical = formatSymbol({ exchange, underlying, kind: "OPT", expiry, strike: Number(strike), right });
    return { canonical, exchange, underlying, kind: "OPT", expiry, strike: Number(strike), right };
  }
  const p = parseSymbol(`${venue}:${underlying}`);
  return { canonical: p.canonical, exchange: p.exchange, underlying: p.underlying, kind: p.kind };
}

/** Canonical -> TradingView ticker (cash, index and options; futures need "1!"-style continuous names, so null). */
export function toTradingView(symbol) {
  const p = parseSymbol(symbol);
  if (p.kind === "INDEX" && TV_INDEX_BY_CANONICAL[p.exchange]?.[p.underlying]) return `${p.exchange}:${TV_INDEX_BY_CANONICAL[p.exchange][p.underlying]}`;
  if (p.kind === "EQ" || p.kind === "INDEX") return `${p.exchange}:${toTradingViewName(p.underlying)}`;
  if (p.kind === "FUT") return null;
  const venue = p.exchange === "NFO" ? "NSE" : p.exchange === "BFO" ? "BSE" : p.exchange;
  const [y, m, d] = p.expiry.split("-");
  return `${venue}:${toTradingViewName(p.underlying)}${y.slice(2)}${m}${d}${p.right === "CE" ? "C" : "P"}${normaliseStrike(p.strike)}`;
}

// ── OpenAlgo-style trading symbols (published format, facts only) ──

const OA_EXCHANGE_IN = Object.freeze({ NSE: "NSE", BSE: "BSE", NFO: "NFO", BFO: "BFO", MCX: "MCX", CDS: "CDS", NSE_INDEX: "NSE", BSE_INDEX: "BSE" });

/**
 * Parse "NIFTY27OCT2625000CE" / "NIFTY27OCT26FUT" / "RELIANCE" with its exchange code (NFO, NSE, NSE_INDEX ...).
 * @returns {import("./contracts.mjs").ParsedSymbol}
 */
export function parseOpenAlgo(symbol, exchange) {
  const s = String(symbol ?? "").trim().toUpperCase();
  const exIn = String(exchange ?? "").trim().toUpperCase();
  const ex = OA_EXCHANGE_IN[exIn];
  if (!ex) throw bad(`Unknown exchange ${exchange} for an OpenAlgo-style symbol.`);
  const m = /^([A-Z0-9&_-]+?)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(?:(FUT)|(\d+(?:\.\d+)?)(CE|PE))$/.exec(s);
  if (!m) {
    const kind = exIn.endsWith("_INDEX") ? "INDEX" : undefined;
    const p = parseSymbol(`${ex}:${s}`);
    return kind ? { ...p, kind } : p;
  }
  const [, underlying, dd, mon, yy, fut, strike, right] = m;
  const expiry = `20${yy}-${String(MONTHS.indexOf(mon) + 1).padStart(2, "0")}-${dd}`;
  const exchangeOut = VENUE_TO_SEGMENT[ex] ?? ex;
  return parseSymbol(formatSymbol({ exchange: exchangeOut, underlying, kind: fut ? "FUT" : "OPT", expiry, strike: strike ? Number(strike) : null, right }));
}

/** Canonical -> { symbol, exchange } in the OpenAlgo-style format. */
export function toOpenAlgo(symbol) {
  const p = parseSymbol(symbol);
  if (p.kind === "EQ") return { symbol: p.underlying, exchange: p.exchange };
  if (p.kind === "INDEX") return { symbol: p.underlying, exchange: `${p.exchange}_INDEX` };
  const [y, m, d] = p.expiry.split("-");
  const date = `${d}${MONTHS[Number(m) - 1]}${y.slice(2)}`;
  const tail = p.kind === "FUT" ? "FUT" : `${normaliseStrike(p.strike)}${p.right}`;
  return { symbol: `${p.underlying}${date}${tail}`, exchange: p.exchange };
}

/**
 * Best-effort format detection for /v1/symbols/convert with from="auto".
 * @returns {"canonical" | "tradingview" | "openalgo" | "unknown"}
 */
export function detectFormat(input, exchange) {
  const s = String(input ?? "").trim().toUpperCase();
  // TradingView option and continuous tickers first: "NSE:NIFTY261027C25000" would otherwise look like a cash symbol.
  if (/^[A-Z]+:[A-Z][A-Z0-9&_-]*?(\d!|\d{6}[CP]\d+(\.\d+)?)$/.test(s)) return "tradingview";
  if (CANONICAL_RE.test(s)) return "canonical";
  if (exchange && /^[A-Z0-9&_-]+$/.test(s)) return "openalgo";
  return "unknown";
}
