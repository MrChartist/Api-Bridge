/**
 * NSE India backup provider: the JSON the public www.nseindia.com pages use. No account needed, but the site sits
 * behind Akamai: it wants browser headers and its own cookies, blocks many datacenter and VPN addresses (HTTP 403),
 * and throttles bursts. It is best effort, slow (a few calls a second at most) and labelled as such.
 *
 * Endpoints (checked Oct 2026):
 *   /api/allIndices                                             every NSE index: last, open, high, low, previousClose
 *   /api/NextApi/apiClient/GetQuoteApi?functionName=getSymbolData&marketType=N&series=EQ&symbol=RELIANCE   stock quote
 *   /api/option-chain-contract-info?symbol=NIFTY               expiry dates ("27-Oct-2026") and strikes
 *   /api/option-chain-v3?type=Indices|Equity&symbol=NIFTY&expiry=27-Oct-2026   option chain for one expiry
 * The older /api/option-chain-indices and /api/quote-equity are retired or blocked.
 */
import { BridgeError } from "../../core/errors.mjs";
import { parseSymbol } from "../../core/symbolFormat.mjs";

export const NSE_BASE = "https://www.nseindia.com";
/** Canonical NSE index -> the name /api/allIndices uses. */
export const NSE_INDEX_NAMES = Object.freeze({
  NIFTY: "NIFTY 50",
  BANKNIFTY: "NIFTY BANK",
  FINNIFTY: "NIFTY FINANCIAL SERVICES",
  MIDCPNIFTY: "NIFTY MIDCAP SELECT",
  NIFTYNXT50: "NIFTY NEXT 50",
  INDIAVIX: "INDIA VIX",
});
/** Index underlyings whose options use type=Indices. */
const INDEX_OPTION_UNDERLYINGS = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"]);
const MONTHS = Object.freeze({ JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" });
const MONTH_NAMES = Object.freeze(Object.fromEntries(Object.entries(MONTHS).map(([k, v]) => [v, k[0] + k.slice(1).toLowerCase()])));
/** Cookies are refreshed from the home page this often. */
const COOKIE_TTL_MS = 60_000;
/** allIndices is one call for every index; reuse it briefly. */
const ALL_INDICES_TTL_MS = 2_000;

const num = (v) => {
  if (v === null || v === undefined || v === "" || v === "-") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const pos = (v) => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};

/** "27-Oct-2026" -> "2026-10-27"; null when it does not parse. */
export function nseDateToIso(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(s ?? "").trim());
  if (!m || !MONTHS[m[2].toUpperCase()]) return null;
  return `${m[3]}-${MONTHS[m[2].toUpperCase()]}-${m[1].padStart(2, "0")}`;
}

/** "2026-10-27" -> "27-Oct-2026". */
export function isoToNseDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!m) throw new BridgeError("VALIDATION_FAILED", "expiry must be YYYY-MM-DD.");
  return `${m[3]}-${MONTH_NAMES[m[2]]}-${m[1]}`;
}

/** Quote fields from one /api/allIndices row. */
export function indexFields(row) {
  const ltp = pos(row?.last);
  if (ltp === null) return null;
  return { ltp, open: pos(row.open), high: pos(row.high), low: pos(row.low), close: pos(row.previousClose), volume: null, oi: null, bid: null, ask: null };
}

/** Quote fields from GetQuoteApi getSymbolData. */
export function equityFields(json) {
  const r = json?.equityResponse?.[0];
  if (!r) return null;
  const ob = r.orderBook ?? {};
  const md = r.metaData ?? {};
  const ti = r.tradeInfo ?? {};
  const ltp = pos(ob.lastPrice) ?? pos(ti.lastPrice) ?? pos(md.lastPrice);
  if (ltp === null) return null;
  return {
    ltp,
    open: pos(md.open),
    high: pos(md.dayHigh),
    low: pos(md.dayLow),
    close: pos(md.previousClose),
    volume: num(ti.totalTradedVolume),
    oi: null,
    bid: pos(ob.buyPrice1),
    ask: pos(ob.sellPrice1),
    bidQty: num(ob.buyQuantity1),
    askQty: num(ob.sellQuantity1),
  };
}

/**
 * Option chain rows (ChainRow shape, legs without greeks: those are computed by the caller) from option-chain-v3.
 * IV comes as percent from NSE; 0 means "not computed" and becomes null.
 */
export function chainFromV3(json, { underlying, expiry, exchange = "NFO" }) {
  const rec = json?.records ?? {};
  const data = Array.isArray(rec.data) ? rec.data : Array.isArray(json?.filtered?.data) ? json.filtered.data : [];
  const ymd = expiry;
  const legOf = (raw, strike, right) => {
    if (!raw || typeof raw !== "object") return null;
    const iv = num(raw.impliedVolatility);
    return {
      symbol: `${exchange}:${underlying}-${ymd}-${strike}-${right}`,
      ltp: pos(raw.lastPrice),
      bid: pos(raw.buyPrice1 ?? raw.bidprice),
      ask: pos(raw.sellPrice1 ?? raw.askPrice),
      oi: num(raw.openInterest),
      oiChange: num(raw.changeinOpenInterest),
      volume: num(raw.totalTradedVolume),
      iv: iv !== null && iv > 0 ? iv : null,
      delta: null,
      gamma: null,
      theta: null,
      vega: null,
      greeksSource: null,
    };
  };
  const rows = [];
  for (const d of data) {
    const strike = num(d?.strikePrice);
    if (strike === null || strike <= 0) continue;
    const rowExpiry = nseDateToIso(d.expiryDate ?? d.expiryDates ?? d.CE?.expiryDate ?? d.PE?.expiryDate);
    if (rowExpiry && rowExpiry !== expiry) continue;
    rows.push({ strike, ce: legOf(d.CE, strike, "CE"), pe: legOf(d.PE, strike, "PE") });
  }
  rows.sort((a, b) => a.strike - b.strike);
  const underlyingLtp = pos(rec.underlyingValue) ?? pos(data.find((d) => d?.CE?.underlyingValue)?.CE?.underlyingValue) ?? null;
  return { rows, underlyingLtp, timestamp: rec.timestamp ?? null };
}

/**
 * @param {{ http: { get: Function, clearCookies: Function, hasCookies: Function }, now: () => number }} deps
 */
export function createNseProvider({ http, now }) {
  let cookiesAt = 0;
  let allIndices = null; // { at, rows }

  async function warm(force = false) {
    if (!force && http.hasCookies() && now() - cookiesAt < COOKIE_TTL_MS) return;
    if (force) http.clearCookies();
    try {
      await http.get(`${NSE_BASE}/`, { raw: true, headers: { Accept: "text/html,application/xhtml+xml" } });
    } catch {
      // The home page itself is often blocked while the API still answers; carry on without cookies.
    }
    cookiesAt = now();
  }

  /** GET an NSE API path with one cookie refresh and retry on a refusal. */
  async function api(path, referer = "/") {
    await warm();
    const headers = { Referer: `${NSE_BASE}${referer}` };
    try {
      return (await http.get(`${NSE_BASE}${path}`, { headers })).json;
    } catch (err) {
      if (err?.code !== "UPSTREAM_ERROR") throw err;
      await warm(true);
      return (await http.get(`${NSE_BASE}${path}`, { headers })).json;
    }
  }

  async function indexRows() {
    if (allIndices && now() - allIndices.at < ALL_INDICES_TTL_MS) return allIndices.rows;
    const json = await api("/api/allIndices", "/market-data/live-market-indices");
    const rows = Array.isArray(json?.data) ? json.data : [];
    if (!rows.length) throw new BridgeError("UPSTREAM_ERROR", "NSE returned no index data.");
    allIndices = { at: now(), rows };
    return rows;
  }

  function supports(canonical) {
    try {
      const p = parseSymbol(canonical);
      if (p.exchange !== "NSE") return false;
      return p.kind === "EQ" || (p.kind === "INDEX" && Boolean(NSE_INDEX_NAMES[p.underlying]));
    } catch {
      return false;
    }
  }

  return {
    id: "nse",
    name: "NSE India website",
    covers: { quotes: ["INDEX", "EQ"], history: [], optionChain: true },
    supports,

    async quote(canonical) {
      if (!supports(canonical)) throw new BridgeError("CAPABILITY_UNSUPPORTED", `The NSE website backup covers NSE stocks and NSE indices only, not ${canonical}.`);
      const p = parseSymbol(canonical);
      if (p.kind === "INDEX") {
        const name = NSE_INDEX_NAMES[p.underlying];
        const row = (await indexRows()).find((r) => String(r?.index ?? "").toUpperCase() === name || String(r?.indexSymbol ?? "").toUpperCase() === name);
        const fields = indexFields(row);
        if (!fields) throw new BridgeError("SYMBOL_NOT_FOUND", `NSE returned no value for ${name}.`);
        return { fields, at: now() };
      }
      const sym = encodeURIComponent(p.underlying);
      const json = await api(`/api/NextApi/apiClient/GetQuoteApi?functionName=getSymbolData&marketType=N&series=EQ&symbol=${sym}`, `/get-quotes/equity?symbol=${sym}`);
      const fields = equityFields(json);
      if (!fields) throw new BridgeError("SYMBOL_NOT_FOUND", `NSE returned no quote for ${p.underlying}.`);
      return { fields, at: now() };
    },

    /** Upcoming expiries as ISO dates, ascending. */
    async expiries(underlying) {
      const json = await api(`/api/option-chain-contract-info?symbol=${encodeURIComponent(underlying)}`, "/option-chain");
      const list = (Array.isArray(json?.expiryDates) ? json.expiryDates : []).map(nseDateToIso).filter(Boolean);
      if (!list.length) throw new BridgeError("SYMBOL_NOT_FOUND", `NSE lists no option expiries for ${underlying}.`);
      return [...new Set(list)].sort();
    },

    /** { rows, underlyingLtp } for one expiry. */
    async optionChain(underlying, expiry) {
      const type = INDEX_OPTION_UNDERLYINGS.has(underlying) ? "Indices" : "Equity";
      const qs = new URLSearchParams({ type, symbol: underlying, expiry: isoToNseDate(expiry) });
      const json = await api(`/api/option-chain-v3?${qs}`, "/option-chain");
      const built = chainFromV3(json, { underlying, expiry });
      if (!built.rows.length) throw new BridgeError("SYMBOL_NOT_FOUND", `NSE returned no options for ${underlying} expiring ${expiry}.`);
      return { rows: built.rows, underlyingLtp: built.underlyingLtp, at: now() };
    },
  };
}
