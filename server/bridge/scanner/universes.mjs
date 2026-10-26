/**
 * Named symbol lists a scan can run over (stream S13).
 *
 *   FNO        every stock with NSE futures, read from the loaded instrument masters (always current)
 *   NIFTY50    the NIFTY 50 constituents as shipped with this release (index changes twice a year: check the list,
 *              or define your own in config scanner.universes)
 *   INDICES    the main NSE/BSE indices
 *   <your own> config scanner.universes: { "MYLIST": ["NSE:RELIANCE", "NSE:TCS"] }
 */
import { BridgeError } from "../core/errors.mjs";

/** NIFTY 50, as published by NSE Indices for the Sept 2026 rebalance (verify against niftyindices.com). */
export const NIFTY50 = Object.freeze(
  [
    "ADANIENT", "ADANIPORTS", "APOLLOHOSP", "ASIANPAINT", "AXISBANK", "BAJAJ-AUTO", "BAJAJFINSV", "BAJFINANCE", "BEL", "BHARTIARTL",
    "CIPLA", "COALINDIA", "DRREDDY", "EICHERMOT", "ETERNAL", "GRASIM", "HCLTECH", "HDFCBANK", "HDFCLIFE", "HINDALCO",
    "HINDUNILVR", "ICICIBANK", "INDIGO", "INFY", "ITC", "JIOFIN", "JSWSTEEL", "KOTAKBANK", "LT", "M&M",
    "MARUTI", "MAXHEALTH", "NESTLEIND", "NTPC", "ONGC", "POWERGRID", "RELIANCE", "SBILIFE", "SBIN", "SHRIRAMFIN",
    "SUNPHARMA", "TATACONSUM", "TATASTEEL", "TCS", "TECHM", "TITAN", "TMPV", "TRENT", "ULTRACEMCO", "WIPRO",
  ].map((s) => `NSE:${s}`),
);

export const INDICES = Object.freeze(["NSE:NIFTY", "NSE:BANKNIFTY", "NSE:FINNIFTY", "NSE:MIDCPNIFTY", "NSE:NIFTYNXT50", "NSE:INDIAVIX", "BSE:SENSEX", "BSE:BANKEX"]);

const BUILTIN = Object.freeze({
  NIFTY50: { description: "NIFTY 50 constituents (shipped list; check after each index rebalance)", symbols: NIFTY50 },
  INDICES: { description: "Main NSE and BSE indices", symbols: INDICES },
});

/**
 * Stocks with NSE futures, from the instrument master (no broker call).
 * @param {object} symbols SymbolService
 */
async function fnoStocks(symbols) {
  const set = new Set();
  let cursor;
  for (let page = 0; page < 40; page += 1) {
    const q = { q: "FUT", kind: "FUT", exchange: "NFO", limit: 500 };
    if (cursor) q.cursor = cursor;
    let res;
    try {
      res = await symbols.search(q);
    } catch {
      break;
    }
    for (const r of res?.items ?? []) if (r?.underlying) set.add(r.underlying);
    cursor = res?.nextCursor;
    if (!cursor) break;
  }
  const indices = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"]);
  return [...set].filter((u) => !indices.has(u)).sort().map((u) => `NSE:${u}`);
}

/**
 * @param {{ symbols?: object, custom?: Record<string, string[]> }} deps
 */
export function createUniverses({ symbols, custom = {} }) {
  return {
    /** Names and sizes (FNO size is null until asked: it needs the instrument master). */
    list() {
      return [
        { name: "FNO", description: "Every stock with NSE futures, from the loaded instrument master", size: null, source: "instrument master" },
        ...Object.entries(BUILTIN).map(([name, u]) => ({ name, description: u.description, size: u.symbols.length, source: "built in" })),
        ...Object.entries(custom).map(([name, list]) => ({ name, description: "Defined in bridge.config.json (scanner.universes)", size: list.length, source: "config" })),
      ];
    },
    /** @returns {Promise<string[]>} */
    async resolve(name) {
      const key = String(name ?? "").toUpperCase();
      if (Object.hasOwn(custom, key)) return [...custom[key]];
      if (Object.hasOwn(BUILTIN, key)) return [...BUILTIN[key].symbols];
      if (key === "FNO") {
        const list = symbols ? await fnoStocks(symbols) : [];
        if (!list.length) throw new BridgeError("SYMBOL_NOT_FOUND", "The FNO list comes from a broker's instrument master: connect an account first, or use NIFTY50 or your own list.");
        return list;
      }
      throw new BridgeError("VALIDATION_FAILED", `Unknown universe "${name}". Use FNO, NIFTY50, INDICES or one from scanner.universes in the config.`, {
        errors: [{ path: "universe", message: "unknown" }],
      });
    },
  };
}
