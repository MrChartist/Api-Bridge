/**
 * Compat-style <-> Bridge value mapping (stream S14). Pure functions.
 *
 * Compat-style symbols are compact trading symbols with an exchange code: RELIANCE/NSE, NIFTY/NSE_INDEX,
 * NIFTY28OCT2525000CE/NFO, NIFTY30DEC25FUT/NFO. The Bridge already reads and writes
 * that form (core/symbolFormat.mjs parseCompact/toCompact).
 */
import { BridgeError } from "../core/errors.mjs";
import { parseCompact, toCompact } from "../core/symbolFormat.mjs";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export const PRODUCT_IN = Object.freeze({ CNC: "CNC", MIS: "INTRADAY", NRML: "MARGIN" });
export const PRODUCT_OUT = Object.freeze({ CNC: "CNC", INTRADAY: "MIS", MARGIN: "NRML", MTF: "CNC", CO: "MIS", BO: "MIS" });
export const PRICE_TYPES = Object.freeze(["MARKET", "LIMIT", "SL", "SL-M"]);

/** Compat-style history intervals -> Bridge intervals. */
export const INTERVAL_IN = Object.freeze({ "1m": "1m", "3m": "3m", "5m": "5m", "10m": "10m", "15m": "15m", "30m": "30m", "1h": "60m", "60m": "60m", D: "1d", "1d": "1d", W: "1w", M: "1M" });
export const INTERVALS_OUT = Object.freeze({ seconds: [], minutes: ["1m", "3m", "5m", "10m", "15m", "30m"], hours: ["1h"], days: ["D"], weeks: ["W"], months: ["M"] });

/** Bridge OrderStatus -> Compat order_status. */
export const STATUS_OUT = Object.freeze({
  pending: "open",
  open: "open",
  trigger_pending: "trigger pending",
  partially_filled: "open",
  filled: "complete",
  cancelled: "cancelled",
  rejected: "rejected",
  expired: "cancelled",
  outcome_unknown: "unknown",
});

const bad = (msg, path) => new BridgeError("VALIDATION_FAILED", msg, path ? { errors: [{ path, message: msg }] } : undefined);

/** Compat-style symbol + exchange -> canonical Bridge symbol. */
export function toCanonical(symbol, exchange) {
  if (typeof symbol !== "string" || !symbol.trim()) throw bad("symbol is required.", "symbol");
  if (typeof exchange !== "string" || !exchange.trim()) throw bad("exchange is required.", "exchange");
  try {
    return parseCompact(symbol, exchange).canonical;
  } catch (err) {
    throw bad(`${symbol} on ${exchange} is not a symbol the Bridge understands (${err?.detail ?? err?.message ?? "invalid"}).`, "symbol");
  }
}

/** Canonical -> { symbol, exchange } in compat form. */
export const fromCanonical = (canonical) => toCompact(canonical);

/** "2026-10-27" -> "27-OCT-26" (compat expiry endpoint). */
export function isoToDashed(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}-${MONTHS[Number(m) - 1]}-${y.slice(2)}`;
}

/** "27OCT26", "27-OCT-26", "27-Oct-2026" or ISO -> "2026-10-27". */
export function expiryToIso(s) {
  const v = String(s ?? "").trim().toUpperCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = /^(\d{1,2})-?([A-Z]{3})-?(\d{2}|\d{4})$/.exec(v);
  if (!m || !MONTHS.includes(m[2])) throw bad(`expiry_date ${s} is not a date like 28OCT25.`, "expiry_date");
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${year}-${String(MONTHS.indexOf(m[2]) + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/** "2026-10-27" -> "27OCT26". */
export const isoToCompact = (iso) => isoToDashed(iso).replace(/-/g, "");

/** Compat-style instrumenttype for a canonical symbol. */
export function instrumentType(p) {
  if (p.kind === "OPT") return p.right;
  if (p.kind === "FUT") return "FUT";
  if (p.kind === "INDEX") return "INDEX";
  return "EQ";
}

/** Numbers Compat sends as strings or numbers. */
export function num(v, path, { min = -Infinity, int = false, dflt } = {}) {
  if (v === undefined || v === null || v === "") {
    if (dflt !== undefined) return dflt;
    throw bad(`${path} is required.`, path);
  }
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) throw bad(`${path} must be ${int ? "a whole number" : "a number"}${min > -Infinity ? ` of at least ${min}` : ""}.`, path);
  return n;
}

/** 2-decimal string, the way compat replies carry money. */
export const money = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : "0.00");
