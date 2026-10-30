// watchlist-core.js: the watchlists' maths, shared by the Bridge (server/bridge/watchlists) and the page
// (watchlists.js). Pure: no DOM, no fetch, no clock.
import { INDEX_UNDERLYINGS } from "./span-margin.js";

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const SYM_RE = /^(NSE|BSE|NFO|BFO|MCX|CDS):[A-Z0-9&_.-]{1,40}$/;
const DERIV = { NSE: "NFO", BSE: "BFO" };

/** "nse:reliance" → "NSE:RELIANCE"; "RELIANCE" → "NSE:RELIANCE"; "SENSEX" → "BSE:SENSEX"; anything else → null. */
export function normaliseSymbol(s) {
  let t = String(s ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!t) return null;
  if (!t.includes(":")) t = `${["SENSEX", "BANKEX", "SENSEX50"].includes(t) ? "BSE" : "NSE"}:${t}`;
  return SYM_RE.test(t) ? t : null;
}

/**
 * The near-month future of a cash or index symbol, from its option expiries (futures expire on the last expiry of a
 * month): "NSE:RELIANCE" with 2026-11-24 → "NFO:RELIANCE-2026-11-24-FUT". Null for a derivative or without expiries.
 */
export function nearFuture(symbol, expiries, today) {
  const [ex, name] = String(symbol).split(":");
  if (!DERIV[ex] || !name) return null;
  const by = new Map();
  for (const e of [...(expiries ?? [])].filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x))).sort()) by.set(e.slice(0, 7), e);
  const monthly = [...by.values()].find((e) => e >= today);
  return monthly ? `${DERIV[ex]}:${name}-${monthly}-FUT` : null;
}

/** OI change from the first OI seen today: { oi, change, changePct }. */
export function oiChange(oi, first) {
  const o = num(oi);
  const f = num(first);
  if (o === null) return null;
  if (f === null || f === 0) return { oi: o, change: null, changePct: null };
  return { oi: o, change: o - f, changePct: ((o - f) / f) * 100 };
}

/**
 * The front expiry: the first listed expiry on or after today, the one the Option Chain opens on (its ATM IV is the
 * watchlist's IV, for indices and stocks alike). Null without one.
 */
export function frontExpiry(expiries, today) {
  return [...(expiries ?? [])].filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x)) && x >= today).sort()[0] ?? null;
}

/**
 * The previous trading day's OI of a future from the recorder's daily rows (raw S3 rows: { date, fut: { x, oi } }):
 * the latest row before `today` whose near future is `expiry`. Null when none was recorded.
 */
export function prevFutureOi(rows, expiry, today) {
  let best = null;
  for (const r of rows ?? []) {
    const f = r?.fut ?? r?.future;
    const x = f?.x ?? f?.expiry;
    const oi = num(f?.oi);
    if (!r?.date || r.date >= today || x !== expiry || oi === null || oi <= 0) continue;
    if (!best || r.date > best.date) best = { date: r.date, oi };
  }
  return best;
}

/**
 * One priced row: symbol, name, index, ltp, change, changePct, the future's OI and change, IV (the front expiry's ATM
 * IV, as on the Option Chain and Volatility: the mean of the ATM call and put IV) with its expiry, IV rank, HV20.
 */
export function watchRow(symbol, quote, { future = null, oi = null, vol = null } = {}) {
  const ltp = num(quote?.ltp);
  const close = num(quote?.close);
  const change = num(quote?.change) ?? (ltp !== null && close ? ltp - close : null);
  const changePct = num(quote?.changePct) ?? (change !== null && close ? (change / close) * 100 : null);
  const name = String(symbol).split(":")[1] ?? symbol;
  return {
    symbol,
    name,
    index: INDEX_UNDERLYINGS.includes(name),
    ltp,
    change,
    changePct,
    future,
    oi: oi?.oi ?? null,
    oiChange: oi?.change ?? null,
    oiChangePct: oi?.changePct ?? null,
    iv: num(vol?.iv),
    ivExpiry: vol?.expiry ?? null,
    ivr: num(vol?.ivr),
    hv20: num(vol?.hv20),
  };
}

/** Sort rows by a column ("name", "changePct", "oiChangePct", "iv"); missing values last either way. */
export function sortRows(rows, key = "name", dir = 1) {
  return [...(rows ?? [])].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (key === "name") return dir * String(x).localeCompare(String(y));
    if (num(x) === null) return num(y) === null ? 0 : 1;
    if (num(y) === null) return -1;
    return dir * (x - y);
  });
}

/** Excel / Sheets: the Bridge's quote formula for a symbol, as the Integrations snippets write it. */
export const excelQuote = (symbol, field = "ltp") => `=BRIDGE.QUOTE("${symbol}","${field}")`;
