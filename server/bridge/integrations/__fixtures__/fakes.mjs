/**
 * Test doubles for stream S10: deterministic marketData, symbols and keyStore fakes that satisfy the core contracts.
 * Nothing here talks to a broker. Candles exist for weekdays from DATA_START, with no data on HOLIDAYS, so UDF
 * `no_data` / `nextTime` behaviour can be tested exactly.
 */
import { notImplementedService } from "../../core/contracts.mjs";
import { BridgeError } from "../../core/errors.mjs";
import { parseSymbol } from "../../core/symbolFormat.mjs";

export const IST = 19_800;
export const DATA_START = "2026-01-01";
export const HOLIDAYS = new Set(["2026-10-02", "2026-10-20"]);
/** Fixed "now" for tests: Friday 16 Oct 2026, 15:00 IST. */
export const NOW_MS = Date.UTC(2026, 9, 16, 9, 30);

/** Epoch seconds of HH:MM IST on an ISO date. */
export const istAt = (iso, hh = 0, mm = 0) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) / 1000 - IST;
};
const isoOf = (sec) => new Date((sec + IST) * 1000).toISOString().slice(0, 10);

export const INSTRUMENTS = Object.freeze({
  "NSE:NIFTY": { kind: "INDEX", name: "NIFTY 50", lotSize: 1, tickSize: 0.05, base: 25000 },
  "NSE:RELIANCE": { kind: "EQ", name: "Reliance Industries Ltd", lotSize: 1, tickSize: 0.1, base: 2900 },
  "NSE:M&M": { kind: "EQ", name: "Mahindra & Mahindra Ltd", lotSize: 1, tickSize: 0.05, base: 3100 },
  "BSE:SENSEX": { kind: "INDEX", name: "S&P BSE SENSEX", lotSize: 1, tickSize: 0.01, base: 82000 },
  "NFO:NIFTY-2026-10-27-FUT": { kind: "FUT", name: null, lotSize: 75, tickSize: 0.1, base: 25050 },
  "NFO:NIFTY-2026-10-27-25000-CE": { kind: "OPT", name: null, lotSize: 75, tickSize: 0.05, base: 180 },
  "NFO:NIFTY-2026-10-27-25000-PE": { kind: "OPT", name: null, lotSize: 75, tickSize: 0.05, base: 140 },
  "NFO:NIFTY-2026-09-29-25000-CE": { kind: "OPT", name: null, lotSize: 75, tickSize: 0.05, base: 0.05 },
  "MCX:CRUDEOIL-2026-11-19-FUT": { kind: "FUT", name: "Crude Oil", lotSize: 100, tickSize: 1, base: 6100 },
  "CDS:USDINR-2026-10-28-FUT": { kind: "FUT", name: "USD/INR", lotSize: 1000, tickSize: 0.0025, base: 88.1234 },
});

function resolvedOf(canonical) {
  const meta = INSTRUMENTS[canonical];
  const p = parseSymbol(canonical);
  return { ...p, name: meta.name, lotSize: meta.lotSize, tickSize: meta.tickSize, freezeQty: null, isin: null, refs: {} };
}

function canonicalOf(input) {
  let s = String(input ?? "").trim().toUpperCase();
  if (s === "NSE:NIFTY1!") s = "NFO:NIFTY-2026-10-27-FUT";
  let c;
  try {
    c = parseSymbol(s).canonical;
  } catch {
    throw new BridgeError("SYMBOL_NOT_FOUND", `${input} could not be resolved.`);
  }
  if (!INSTRUMENTS[c]) throw new BridgeError("SYMBOL_NOT_FOUND", `${c} is not in any connected broker's instrument master.`);
  return c;
}

/** Fake SymbolService. */
export function createFakeSymbols() {
  const calls = [];
  return {
    ...notImplementedService("symbols"),
    calls,
    parse: (input) => parseSymbol(input),
    async resolve(input) {
      calls.push(["resolve", input]);
      return resolvedOf(canonicalOf(input));
    },
    async search(params) {
      calls.push(["search", params]);
      const q = String(params.q).toUpperCase();
      const items = Object.keys(INSTRUMENTS)
        .filter((c) => c.includes(q) || String(INSTRUMENTS[c].name ?? "").toUpperCase().includes(q))
        .map(resolvedOf)
        .filter((r) => (!params.exchange || r.exchange === params.exchange) && (!params.kind || r.kind === params.kind))
        .map(({ refs, ...r }) => r);
      return { items: items.slice(0, params.limit ?? 100), nextCursor: null };
    },
  };
}

const freshness = (source = "stream") => ({
  source,
  asOf: "2026-10-16T15:00:00+05:30",
  ageMs: 120,
  stale: false,
  accountId: "dhan-main",
  broker: "dhan",
});

const MINUTES = { "1m": 1, "3m": 3, "5m": 5, "10m": 10, "15m": 15, "30m": 30, "60m": 60 };

/** Parse a fake history time: epoch seconds (number or digits) or an IST date. */
function timeOf(v, { endOfDay = false } = {}) {
  if (typeof v === "number") return v;
  const s = String(v);
  if (/^\d+$/.test(s)) return Number(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return istAt(s) + (endOfDay ? 86_399 : 0);
  throw new BridgeError("VALIDATION_FAILED", `bad time ${s}`);
}

/** Deterministic candles for [from, to] (epoch seconds, inclusive), ascending. */
export function makeCandles(symbol, interval, from, to) {
  const base = INSTRUMENTS[symbol]?.base ?? 100;
  const out = [];
  const startDay = Math.max(istAt(DATA_START), istAt(isoOf(from)));
  for (let day = startDay; day <= to; day += 86_400) {
    const iso = isoOf(day);
    const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6 || HOLIDAYS.has(iso)) continue;
    const times = [];
    if (interval === "1d") times.push(istAt(iso));
    else if (interval === "1w") {
      // first trading day of each Monday-based week
      const monday = isoOf(day - (dow - 1) * 86_400);
      if (!out.length || isoOf(out.at(-1).time - (new Date(`${isoOf(out.at(-1).time)}T00:00:00Z`).getUTCDay() - 1) * 86_400) !== monday) times.push(istAt(iso));
    } else if (interval === "1M") {
      if (!out.length || isoOf(out.at(-1).time).slice(0, 7) !== iso.slice(0, 7)) times.push(istAt(iso));
    } else {
      const step = MINUTES[interval];
      for (let m = 9 * 60 + 15; m < 15 * 60 + 30; m += step) times.push(istAt(iso, Math.floor(m / 60), m % 60));
    }
    for (const t of times) {
      if (t < from || t > to) continue;
      const k = (t / 60) % 97;
      const open = Number((base + k * 0.05).toFixed(2));
      out.push({ time: t, open, high: open + 1, low: open - 1, close: open + 0.5, volume: 1000 + (k | 0), oi: symbol.startsWith("NFO") ? 5000 : undefined });
    }
  }
  return out.map((c) => (c.oi === undefined ? (({ oi, ...rest }) => rest)(c) : c));
}

/** Fake MarketDataService; `calls` records every call for assertions. */
export function createFakeMarketData({ now = () => NOW_MS } = {}) {
  const calls = [];
  const quoteOf = (c) => {
    const base = INSTRUMENTS[c].base;
    return {
      symbol: c,
      ltp: base,
      open: base - 10,
      high: base + 20,
      low: base - 30,
      close: base - 5,
      change: 5,
      changePct: Number(((5 / (base - 5)) * 100).toFixed(4)),
      volume: c.startsWith("NSE:NIFTY") || c === "BSE:SENSEX" ? null : 123456,
      oi: c.startsWith("NFO") ? 987650 : null,
      bid: base - 0.05,
      ask: base + 0.05,
      bidQty: 10,
      askQty: 12,
      freshness: freshness(),
    };
  };
  const split = (symbols) => {
    const items = [];
    const errors = [];
    for (const s of symbols) {
      try {
        items.push(canonicalOf(s));
      } catch (e) {
        errors.push({ symbol: s, code: e.code, message: e.message });
      }
    }
    return { items, errors };
  };
  return {
    ...notImplementedService("marketData"),
    calls,
    async ltp(symbols, opts) {
      calls.push(["ltp", symbols, opts]);
      if (symbols.includes("NSE:BUSY")) throw new BridgeError("UPSTREAM_RATE_LIMITED", "Broker busy", { retryAfterMs: 2000 });
      const { items, errors } = split(symbols);
      return { items: items.map((c) => ({ symbol: c, ltp: INSTRUMENTS[c].base, freshness: freshness() })), errors };
    },
    async quotes(symbols, opts) {
      calls.push(["quotes", symbols, opts]);
      const { items, errors } = split(symbols);
      return { items: items.map(quoteOf), errors };
    },
    async history(params, opts) {
      calls.push(["history", params, opts]);
      const symbol = canonicalOf(params.symbol);
      const to = params.to === undefined ? Math.floor(now() / 1000) : timeOf(params.to, { endOfDay: true });
      let candles;
      if (params.from !== undefined) candles = makeCandles(symbol, params.interval, timeOf(params.from), to);
      else {
        // countback: look back far enough, then keep the last N
        const all = makeCandles(symbol, params.interval, istAt(DATA_START), to);
        candles = all.slice(Math.max(0, all.length - params.countback));
      }
      return { symbol, interval: params.interval, candles, freshness: freshness("broker"), partial: false };
    },
    async optionChain(params, opts) {
      calls.push(["optionChain", params, opts]);
      if (String(params.underlying).toUpperCase() !== "NIFTY") throw new BridgeError("SYMBOL_NOT_FOUND", "No options for this underlying.");
      const strikes = [24800, 24900, 25000, 25100, 25200];
      const leg = (strike, right, price) => ({
        symbol: `NFO:NIFTY-${params.expiry}-${strike}-${right}`,
        ltp: price,
        bid: price - 0.05,
        ask: price + 0.05,
        oi: 100000 + strike,
        oiChange: -250,
        volume: 5000,
        iv: 12.5,
        delta: right === "CE" ? 0.5 : -0.5,
        gamma: 0.001,
        theta: -8.2,
        vega: 11.3,
        greeksSource: "computed",
      });
      let rows = strikes.map((s) => ({ strike: s, ce: leg(s, "CE", (25100 - s) / 2 + 100), pe: leg(s, "PE", (s - 24900) / 2 + 100) }));
      if (params.strikes) rows = rows.slice(2 - params.strikes < 0 ? 0 : 2 - params.strikes, 3 + params.strikes);
      return { underlying: "NIFTY", expiry: params.expiry, underlyingLtp: 25012.35, atmStrike: 25000, lotSize: 75, rows, freshness: freshness("cache") };
    },
  };
}

/** API keys for route tests. */
export const KEYS = Object.freeze({
  READ: "mcb_read0000001_aaaaaaaaaaaaaaaaaaaa",
  XL: "mcb_xlread00001_bbbbbbbbbbbbbbbbbbbb",
  PAPER_Q: "mcb_paper000001_cccccccccccccccccccc",
  ONE_ACCOUNT: "mcb_onlyacct001_dddddddddddddddddddd",
});
const RECORDS = {
  [KEYS.READ]: { id: "read0000001", label: "reader", scopes: ["read"], accounts: "*", allowQuery: false },
  [KEYS.XL]: { id: "xlread00001", label: "excel", scopes: ["read"], accounts: "*", allowQuery: true },
  [KEYS.PAPER_Q]: { id: "paper000001", label: "paper", scopes: ["paper"], accounts: "*", allowQuery: true },
  [KEYS.ONE_ACCOUNT]: { id: "onlyacct001", label: "one", scopes: ["read"], accounts: ["dhan-main"], allowQuery: false },
};

/** Fake KeyStore: authenticate only. */
export function createFakeKeyStore() {
  return { ...notImplementedService("keyStore"), authenticate: async (raw) => RECORDS[raw] ?? null };
}
