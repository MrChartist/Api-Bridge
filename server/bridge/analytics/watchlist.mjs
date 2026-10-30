/**
 * Symbol and quote helpers kept from PR 17's watchlist module (stream S15). The watchlists themselves are the Bridge's
 * one watchlist service (server/bridge/watchlists, GET /v1/watchlists); PR 17's /v1/analytics/watchlists routes are
 * aliases registered there (docs/design/pr17-integration.md). Markets overview uses normaliseSymbol and quotesFor.
 */
import { BridgeError } from "../core/errors.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { defaultOptionExchange } from "../market/chain.mjs";

export const QUOTE_CHUNK = 50;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const invalid = (path, message) => new BridgeError("VALIDATION_FAILED", message, { errors: [{ path, message }] });

/** Canonical symbol for user input, or a VALIDATION_FAILED naming the field and position. */
export function normaliseSymbol(input, path) {
  const raw = String(input ?? "").trim();
  const withVenue = raw && !raw.includes(":") ? `${defaultOptionExchange(raw.toUpperCase()) === "BFO" ? "BSE" : "NSE"}:${raw}` : raw;
  try {
    return parseSymbol(withVenue).canonical;
  } catch (err) {
    throw invalid(path, err?.detail ?? `"${raw}" is not a Bridge symbol.`);
  }
}

const quoteRow = (q) => ({
  symbol: q.symbol,
  ltp: num(q.ltp),
  change: num(q.change),
  changePct: num(q.changePct),
  volume: num(q.volume),
  oi: num(q.oi),
  dayHigh: num(q.high),
  dayLow: num(q.low),
  open: num(q.open),
  prevClose: num(q.close),
});

/** The error entry for a failed chunk: codes of BridgeErrors pass through, anything else is INTERNAL. */
const chunkError = (symbol, err) => ({ symbol, code: err instanceof BridgeError ? err.code : "INTERNAL", message: err instanceof BridgeError ? (err.detail ?? err.message) : "The quote read failed." });

/**
 * Quotes for a symbol list in chunks, in list order. Never throws for one bad symbol or a failed chunk.
 * @returns {Promise<{ items: object[], errors: object[], freshness: object | null, stale: boolean }>}
 */
export async function quotesFor(marketData, list, opts = {}) {
  const bySymbol = new Map();
  const errors = new Map();
  for (let i = 0; i < list.length; i += QUOTE_CHUNK) {
    const chunk = list.slice(i, i + QUOTE_CHUNK);
    try {
      const r = await marketData.quotes(chunk, opts);
      for (const q of r.items ?? []) bySymbol.set(q.symbol, q);
      for (const e of r.errors ?? []) errors.set(e.symbol, { symbol: e.symbol, code: e.code ?? "INTERNAL", message: e.message ?? "No quote." });
    } catch (err) {
      for (const s of chunk) errors.set(s, chunkError(s, err));
    }
  }
  const items = [];
  const errs = [];
  let stalest = null;
  let stale = false;
  for (const s of list) {
    const q = bySymbol.get(s);
    if (q) {
      items.push(quoteRow(q));
      if (q.freshness?.stale) stale = true;
      if (q.freshness && (!stalest || q.freshness.ageMs > stalest.ageMs)) stalest = q.freshness;
    } else errs.push(errors.get(s) ?? { symbol: s, code: "SYMBOL_NOT_FOUND", message: `No quote came back for ${s}.` });
  }
  return { items, errors: errs, freshness: stalest, stale };
}

