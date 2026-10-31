/**
 * Mapping from broker-contract instrument rows (server/brokers/contract.mjs `Instrument`) to canonical Bridge symbols,
 * plus the name aliases needed to merge the same instrument across brokers.
 *
 * Adapters already normalise most things (ISO expiry, numeric strike, CE/PE, CANONICAL_UNDERLYINGS for index
 * derivatives, contract exchange codes). What still differs between brokers, and is handled here:
 *  - index spot names: Zerodha says "NIFTY 50" / "NIFTY BANK", Upstox and Dhan say "NIFTY" / "BANKNIFTY";
 *  - equity series suffixes in trading symbols ("RELIANCE-EQ");
 *  - ISINs, which only some masters carry (Upstox puts them inside the cash instrument key);
 *  - float noise in strikes, and the odd derivative row tagged with the venue (NSE) instead of the segment (NFO).
 *
 * Pure functions, no I/O.
 */
import { DERIVATIVE_EXCHANGES, EXCHANGES, INDEX_NAMES, formatSymbol, normaliseStrike } from "../core/symbolFormat.mjs";

/** Normalised (upper case, single-spaced) index display names -> canonical underlying. */
export const INDEX_NAME_ALIASES = Object.freeze({
  "NIFTY": "NIFTY",
  "NIFTY 50": "NIFTY",
  "NIFTY50": "NIFTY",
  "NIFTY BANK": "BANKNIFTY",
  "BANK NIFTY": "BANKNIFTY",
  "BANKNIFTY": "BANKNIFTY",
  "NIFTY FIN SERVICE": "FINNIFTY",
  "NIFTY FINANCIAL SERVICES": "FINNIFTY",
  "FINNIFTY": "FINNIFTY",
  "NIFTY MID SELECT": "MIDCPNIFTY",
  "NIFTY MIDCAP SELECT": "MIDCPNIFTY",
  "MIDCPNIFTY": "MIDCPNIFTY",
  "NIFTY NEXT 50": "NIFTYNXT50",
  "NIFTYNXT50": "NIFTYNXT50",
  "INDIA VIX": "INDIAVIX",
  "INDIAVIX": "INDIAVIX",
  "SENSEX": "SENSEX",
  "BSE SENSEX": "SENSEX",
  "S&P BSE SENSEX": "SENSEX",
  "BANKEX": "BANKEX",
  "BSE BANKEX": "BANKEX",
  "S&P BSE BANKEX": "BANKEX",
  "SENSEX 50": "SENSEX50",
  "SENSEX50": "SENSEX50",
  "SNSX50": "SENSEX50",
  "BSE SENSEX 50": "SENSEX50",
});

const UNDERLYING_RE = /^[A-Z0-9][A-Z0-9&_-]{0,29}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const ISIN_RE = /^IN[A-Z0-9]{9}\d$/;
const ISIN_IN_TEXT_RE = /(?:^|[^A-Z0-9])(IN[A-Z0-9]{9}\d)(?:$|[^A-Z0-9])/;

/** Sort rank for instrument kinds: spot before derivatives. */
export const KIND_RANK = Object.freeze({ INDEX: 0, EQ: 1, FUT: 2, OPT: 3 });
/** Sort rank for exchanges: NSE family before BSE family, then commodities and currency. */
export const EXCHANGE_RANK = Object.freeze({ NSE: 0, NFO: 1, BSE: 2, BFO: 3, MCX: 4, CDS: 5 });

/**
 * Canonical underlying for an index display name ("NIFTY 50" -> "NIFTY", "NIFTY IT" -> "NIFTYIT").
 * @param {string} name
 * @returns {string | null} null when nothing usable remains
 */
export function canonicalIndexName(name) {
  const key = String(name ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  if (!key) return null;
  if (INDEX_NAME_ALIASES[key]) return INDEX_NAME_ALIASES[key];
  const squashed = key.replace(/[^A-Z0-9&]/g, "");
  return UNDERLYING_RE.test(squashed) ? squashed : null;
}

/**
 * Contract instrumentType -> Bridge kind. Accepts the contract's six types and the commodity/currency variants
 * some adapters emit (FUTCOM, OPTFUT, FUTCUR, OPTCUR).
 * @returns {"INDEX"|"EQ"|"FUT"|"OPT"|null}
 */
export function kindFromInstrumentType(type) {
  const t = String(type ?? "").toUpperCase();
  if (t === "INDEX") return "INDEX";
  if (t === "EQ") return "EQ";
  if (t.startsWith("FUT")) return "FUT";
  if (t.startsWith("OPT")) return "OPT";
  return null;
}

/** ISIN from an explicit field or embedded in a token/key ("NSE_EQ|INE002A01018"). */
export function extractIsin(row) {
  if (typeof row?.isin === "string" && ISIN_RE.test(row.isin.trim().toUpperCase())) return row.isin.trim().toUpperCase();
  const m = ISIN_IN_TEXT_RE.exec(String(row?.token ?? "").toUpperCase());
  return m ? m[1] : null;
}

/** Equity underlying from a cash row: prefer `underlying`, drop a trailing "-EQ" series tag. */
function cashUnderlying(row) {
  const raw = String(row.underlying || row.tradingSymbol || "").trim().toUpperCase();
  return raw.replace(/-EQ$/, "");
}

/** Strike with float noise removed (292.50000000001 -> 292.5); null when not a positive number. */
export function cleanStrike(strike) {
  const n = typeof strike === "string" ? Number(strike) : strike;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 10_000) / 10_000;
}

/**
 * @typedef {{ canonical: string, exchange: string, kind: "INDEX"|"EQ"|"FUT"|"OPT", underlying: string,
 *   expiry: string | null, strike: number | null, right: "CE"|"PE"|null, name: string | null,
 *   lotSize: number | null, tickSize: number | null, freezeQty: number | null, isin: string | null,
 *   ref: { token: string, exchange: string, tradingSymbol: string | null } }} MappedRow
 */

/**
 * Map one contract Instrument row to a canonical entry.
 * lotSize/tickSize come back null when the row's values are unusable (the store then refuses to resolve the symbol
 * unless another broker supplies them). Rows that cannot be named at all come back as { skip: reason }.
 * @param {object} row  contract Instrument (extra fields such as name, isin, freezeQty are used when present)
 * @returns {MappedRow | { skip: string }}
 */
export function mapContractRow(row) {
  if (!row || typeof row !== "object") return { skip: "not an object" };
  const token = row.token === undefined || row.token === null ? "" : String(row.token);
  if (!token) return { skip: "no token" };
  let exchange = String(row.exchange ?? "").toUpperCase();
  if (!EXCHANGES.includes(exchange)) return { skip: `unknown exchange ${row.exchange}` };
  const kind = kindFromInstrumentType(row.instrumentType);
  if (!kind) return { skip: `unknown instrumentType ${row.instrumentType}` };

  let underlying;
  let expiry = null;
  let strike = null;
  let right = null;
  if (kind === "INDEX") {
    underlying = canonicalIndexName(row.underlying || row.tradingSymbol);
    if (exchange !== "NSE" && exchange !== "BSE") return { skip: `index on ${exchange}` };
  } else if (kind === "EQ") {
    underlying = cashUnderlying(row);
    if (exchange !== "NSE" && exchange !== "BSE") return { skip: `cash row on ${exchange}` };
  } else {
    if (exchange === "NSE") exchange = "NFO";
    else if (exchange === "BSE") exchange = "BFO";
    if (!DERIVATIVE_EXCHANGES.includes(exchange)) return { skip: `derivative on ${exchange}` };
    const u = String(row.underlying ?? "").trim().toUpperCase();
    underlying = INDEX_NAME_ALIASES[u.replace(/\s+/g, " ")] ?? u;
    expiry = typeof row.expiry === "string" && ISO_DATE_RE.test(row.expiry) ? row.expiry : null;
    if (!expiry) return { skip: "derivative without an ISO expiry" };
    if (kind === "OPT") {
      strike = cleanStrike(row.strike);
      right = row.optionType === "CE" || row.optionType === "PE" ? row.optionType : null;
      if (strike === null || right === null) return { skip: "option without strike or CE/PE" };
    }
  }
  if (!underlying || !UNDERLYING_RE.test(underlying) || underlying.endsWith("-")) return { skip: `unusable underlying ${row.underlying}` };

  let canonical;
  try {
    canonical = formatSymbol({ exchange, underlying, kind, expiry, strike: strike === null ? null : normaliseStrike(strike), right });
  } catch (err) {
    return { skip: err?.message ?? "format failed" };
  }
  const lotSize = Number.isInteger(row.lotSize) && row.lotSize > 0 ? row.lotSize : null;
  const tickSize = typeof row.tickSize === "number" && Number.isFinite(row.tickSize) && row.tickSize > 0 ? row.tickSize : null;
  const freezeQty = Number.isInteger(row.freezeQty) && row.freezeQty > 0 ? row.freezeQty : null;
  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim().slice(0, 120) : null;
  const tradingSymbol = typeof row.tradingSymbol === "string" && row.tradingSymbol ? row.tradingSymbol : null;
  return {
    canonical,
    exchange,
    kind,
    underlying,
    expiry,
    strike,
    right,
    name,
    lotSize,
    tickSize,
    freezeQty,
    isin: kind === "EQ" ? extractIsin(row) : null,
    ref: { token, exchange: String(row.exchange).toUpperCase(), tradingSymbol },
  };
}

/** True for the well-known index names parse() already classifies as INDEX. */
export function isKnownIndex(underlying) {
  return INDEX_NAMES.includes(underlying);
}
