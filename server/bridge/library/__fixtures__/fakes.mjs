/**
 * Test doubles for the library module: an instrument list with option chains of different shapes (a weekly index, a monthly-only
 * index, a stock with an uneven strike ladder, a BSE index), a market-data fake whose price freshness the test controls, and a
 * calendar with holidays the test chooses. Nothing here talks to a broker or the network.
 */
import { notImplementedService } from "../../core/contracts.mjs";
import { createCalendar } from "../../reference/calendar.mjs";
import { BridgeError } from "../../core/errors.mjs";
import { createFakeSymbolService } from "../../symbols/fake.mjs";
import { parseSymbol } from "../../core/symbolFormat.mjs";

/** Monday 9 November 2026, 11:00 IST. */
export const NOW = Date.parse("2026-11-09T11:00:00+05:30");
export const at = (iso) => Date.parse(iso);

export const NIFTY_EXPIRIES = Object.freeze(["2026-11-10", "2026-11-17", "2026-11-24", "2026-12-01", "2026-12-08", "2026-12-15", "2026-12-29", "2027-01-26"]);
/** The same list when Tuesday 17 November is a holiday: the exchange lists Monday the 16th instead. */
export const NIFTY_EXPIRIES_HOLIDAY_SHIFT = Object.freeze(["2026-11-10", "2026-11-16", "2026-11-24", "2026-12-01", "2026-12-08", "2026-12-15", "2026-12-29", "2027-01-26"]);
export const BANKNIFTY_EXPIRIES = Object.freeze(["2026-11-24", "2026-12-29", "2027-01-26"]);
export const RELIANCE_EXPIRIES = Object.freeze(["2026-11-24", "2026-12-29"]);
export const SENSEX_EXPIRIES = Object.freeze(["2026-11-12", "2026-11-19", "2026-11-26", "2026-12-03"]);

const range = (from, to, step) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

function chain(exchange, underlying, expiries, strikes, lotSize) {
  return expiries.flatMap((e) => strikes.flatMap((k) => ["CE", "PE"].map((r) => ({ symbol: `${exchange}:${underlying}-${e}-${k}-${r}`, lotSize, tickSize: 0.05 }))));
}

/** RELIANCE: 20 apart through the middle, 40 and 100 apart far from the price (a real stock ladder is uneven). */
export const RELIANCE_STRIKES = Object.freeze([1100, 1200, 1300, 1340, 1360, ...range(1380, 1500, 20), 1540, 1600, 1700]);

export function instruments({ niftyExpiries = NIFTY_EXPIRIES } = {}) {
  return [
    { symbol: "NSE:NIFTY", kind: "INDEX", lotSize: 1, tickSize: 0.05 },
    { symbol: "NSE:BANKNIFTY", kind: "INDEX", lotSize: 1, tickSize: 0.05 },
    { symbol: "NSE:FINNIFTY", kind: "INDEX", lotSize: 1, tickSize: 0.05 },
    { symbol: "BSE:SENSEX", kind: "INDEX", lotSize: 1, tickSize: 0.01 },
    { symbol: "NSE:RELIANCE", lotSize: 1, tickSize: 0.1 },
    { symbol: "NSE:M&M", lotSize: 1, tickSize: 0.05 },
    { symbol: "NFO:NIFTY-2026-11-24-FUT", lotSize: 75, tickSize: 0.1 },
    { symbol: "NFO:NIFTY-2026-12-29-FUT", lotSize: 75, tickSize: 0.1 },
    { symbol: "NFO:RELIANCE-2026-11-24-FUT", lotSize: 500, tickSize: 0.1 },
    ...chain("NFO", "NIFTY", niftyExpiries, range(24000, 26000, 50), 75),
    ...chain("NFO", "BANKNIFTY", BANKNIFTY_EXPIRIES, range(51000, 54000, 100), 35),
    ...chain("NFO", "RELIANCE", RELIANCE_EXPIRIES, RELIANCE_STRIKES, 500),
    ...chain("BFO", "SENSEX", SENSEX_EXPIRIES, range(81000, 83000, 100), 20),
  ];
}

export function fakeSymbols(opts = {}) {
  return createFakeSymbolService({ instruments: instruments(opts), today: "2026-11-09" });
}

/** A calendar: no holidays unless you list them as ISO dates (NSE and BSE). */
export function calendarWith(holidays = []) {
  return createCalendar({ holidays: holidays.map((date) => ({ date, label: "Test holiday", exchanges: ["NSE", "BSE"], verified: true })) });
}

/**
 * Market data whose price and expiries the test sets.
 *   md.setPrice("NSE:NIFTY", 25012, { class: "delayed" })   or { stale: true } or { ageMs: 9000 }
 *   md.setExpiries("NIFTY", [...])   md.fail("NSE:NIFTY", "UPSTREAM_ERROR")   md.calls
 */
export function fakeMarketData({ now = () => NOW, prices = {}, expiries = {} } = {}) {
  const calls = [];
  const quote = new Map();
  const exp = new Map(Object.entries(expiries));
  const failing = new Map();
  const asOfIso = (ms) => new Date(ms + 330 * 60_000).toISOString().replace("Z", "+05:30");
  const svc = {
    ...notImplementedService("marketData"),
    calls,
    setPrice(symbol, ltp, f = {}) {
      quote.set(symbol, { ltp, f });
    },
    setExpiries(u, list) {
      exp.set(u, [...list]);
    },
    fail(symbol, code = "UPSTREAM_ERROR") {
      failing.set(symbol, code);
    },
    async ltp(symbols, opts) {
      calls.push(["ltp", symbols, opts]);
      const items = [];
      const errors = [];
      for (const s of symbols) {
        if (failing.has(s)) {
          errors.push({ symbol: s, code: failing.get(s), message: `fake failure for ${s}` });
          continue;
        }
        const q = quote.get(s);
        if (!q) {
          errors.push({ symbol: s, code: "SYMBOL_NOT_FOUND", message: `no price for ${s}` });
          continue;
        }
        const ageMs = q.f.ageMs ?? 150;
        items.push({
          symbol: s,
          ltp: q.ltp,
          freshness: { source: q.f.source ?? "stream", asOf: asOfIso(now() - ageMs), ageMs, stale: q.f.stale ?? false, class: q.f.class ?? "realtime", delaySec: q.f.class === "delayed" ? 900 : 0, accountId: "fake-1", broker: "fake" },
        });
      }
      return { items, errors };
    },
    async expiries(underlying, opts) {
      calls.push(["expiries", underlying, opts]);
      const list = exp.get(underlying);
      if (!list) throw new BridgeError("SYMBOL_NOT_FOUND", `No expiries for ${underlying}.`);
      return { underlying, expiries: [...list], freshness: { source: "cache", class: "realtime", stale: false } };
    },
  };
  for (const [s, p] of Object.entries(prices)) svc.setPrice(s, p);
  return svc;
}

/** The usual market data of the tests: NIFTY, BANKNIFTY, RELIANCE and SENSEX with prices and expiries. */
export function standardMarket(o = {}) {
  const md = fakeMarketData({
    ...o,
    prices: { "NSE:NIFTY": 25012, "NSE:BANKNIFTY": 52340, "NSE:RELIANCE": 1412, "BSE:SENSEX": 82040, "NSE:FINNIFTY": 24110, ...(o.prices ?? {}) },
    expiries: { NIFTY: [...NIFTY_EXPIRIES], BANKNIFTY: [...BANKNIFTY_EXPIRIES], RELIANCE: [...RELIANCE_EXPIRIES], SENSEX: [...SENSEX_EXPIRIES], FINNIFTY: ["2026-11-24", "2026-12-29"], ...(o.expiries ?? {}) },
  });
  return md;
}

/** Strike numbers of the option symbols in a list, per expiry and side. */
export function optionsOf(symbols) {
  const out = {};
  for (const s of symbols) {
    const p = parseSymbol(s);
    if (p.kind !== "OPT") continue;
    ((out[p.expiry] ??= {})[p.right] ??= []).push(p.strike);
  }
  return out;
}
