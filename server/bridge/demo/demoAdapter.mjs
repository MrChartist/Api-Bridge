/**
 * The demo market-data provider: a broker adapter on the strict contract (server/brokers/contract.mjs) that makes
 * NO network calls. It serves deterministic sample data so anyone can try the Bridge without a broker account, and
 * so screenshots look the same every time:
 *
 *  - instruments: NIFTY, BANKNIFTY and SENSEX (index, futures, options) plus the NIFTY 50 stocks;
 *  - prices: a smooth function of wall-clock time per symbol (slow multi-day waves plus minute-scale wiggles), so the
 *    same instant always gives the same price and ticks keep moving even when the real market is shut;
 *  - option chains: Black-Scholes prices from a simple volatility smile, with open interest peaking near the money;
 *  - history: OHLC candles sampled from the same price function, during NSE hours on weekdays;
 *  - a live feed that ticks once a second, and a small sample portfolio.
 *
 * Every instrument name carries "(Demo)". The adapter has no order methods at all, so nothing can ever be sent to a
 * broker from demo mode: the Bridge routes demo orders to the paper engine. It is registered ONLY when demo mode is on
 * (demoMode.mjs), never in server/brokers/registry.mjs.
 */

export const DEMO_BROKER_ID = "demo";
export const DEMO_BROKER_NAME = "Demo market data (sample, not live)";
export const DEMO_NOTICE = "Demo data: sample prices generated on this computer. Not live market data; no broker is connected.";

import { DEFAULT_RATE } from "../reference/defaults.mjs";
import { demoCalendar, demoLotFor } from "../reference/demoTables.mjs";

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
/** The demo prices with the reference default rate (reference/defaults.mjs), the same value demo reference reports. */
const RATE = DEFAULT_RATE;

/** Spot instruments. base = the level the slow waves move around. */
export const DEMO_UNDERLYINGS = Object.freeze([
  { symbol: "NIFTY", exchange: "NSE", kind: "INDEX", name: "NIFTY 50 (Demo)", base: 25150, tick: 0.05, step: 50, lot: 65, iv: 0.12, deriv: "NFO", expiry: "weekly-tue" },
  { symbol: "BANKNIFTY", exchange: "NSE", kind: "INDEX", name: "NIFTY BANK (Demo)", base: 56400, tick: 0.05, step: 100, lot: 30, iv: 0.14, deriv: "NFO", expiry: "monthly-tue" },
  { symbol: "SENSEX", exchange: "BSE", kind: "INDEX", name: "S&P BSE SENSEX (Demo)", base: 82300, tick: 0.01, step: 100, lot: 20, iv: 0.125, deriv: "BFO", expiry: "weekly-thu" },
  { symbol: "RELIANCE", exchange: "NSE", kind: "EQ", name: "Reliance Industries (Demo)", base: 1418, tick: 0.1 },
  { symbol: "HDFCBANK", exchange: "NSE", kind: "EQ", name: "HDFC Bank (Demo)", base: 1002, tick: 0.05 },
  { symbol: "ICICIBANK", exchange: "NSE", kind: "EQ", name: "ICICI Bank (Demo)", base: 1395, tick: 0.1 },
  { symbol: "INFY", exchange: "NSE", kind: "EQ", name: "Infosys (Demo)", base: 1512, tick: 0.1 },
  { symbol: "TCS", exchange: "NSE", kind: "EQ", name: "Tata Consultancy Services (Demo)", base: 3086, tick: 0.1 },
  { symbol: "SBIN", exchange: "NSE", kind: "EQ", name: "State Bank of India (Demo)", base: 872, tick: 0.05 },
  // The rest of NIFTY 50, so demo scans cover a whole universe
  { symbol: "ADANIENT", exchange: "NSE", kind: "EQ", name: "Adani Enterprises (Demo)", base: 2450, tick: 0.1 },
  { symbol: "ADANIPORTS", exchange: "NSE", kind: "EQ", name: "Adani Ports and SEZ (Demo)", base: 1420, tick: 0.1 },
  { symbol: "APOLLOHOSP", exchange: "NSE", kind: "EQ", name: "Apollo Hospitals (Demo)", base: 7450, tick: 0.1 },
  { symbol: "ASIANPAINT", exchange: "NSE", kind: "EQ", name: "Asian Paints (Demo)", base: 2380, tick: 0.1 },
  { symbol: "AXISBANK", exchange: "NSE", kind: "EQ", name: "Axis Bank (Demo)", base: 1165, tick: 0.1 },
  { symbol: "BAJAJ-AUTO", exchange: "NSE", kind: "EQ", name: "Bajaj Auto (Demo)", base: 8650, tick: 0.1 },
  { symbol: "BAJAJFINSV", exchange: "NSE", kind: "EQ", name: "Bajaj Finserv (Demo)", base: 2010, tick: 0.1 },
  { symbol: "BAJFINANCE", exchange: "NSE", kind: "EQ", name: "Bajaj Finance (Demo)", base: 985, tick: 0.05 },
  { symbol: "BEL", exchange: "NSE", kind: "EQ", name: "Bharat Electronics (Demo)", base: 405, tick: 0.05 },
  { symbol: "BHARTIARTL", exchange: "NSE", kind: "EQ", name: "Bharti Airtel (Demo)", base: 1940, tick: 0.1 },
  { symbol: "CIPLA", exchange: "NSE", kind: "EQ", name: "Cipla (Demo)", base: 1530, tick: 0.1 },
  { symbol: "COALINDIA", exchange: "NSE", kind: "EQ", name: "Coal India (Demo)", base: 388, tick: 0.05 },
  { symbol: "DRREDDY", exchange: "NSE", kind: "EQ", name: "Dr. Reddy's Laboratories (Demo)", base: 1265, tick: 0.1 },
  { symbol: "EICHERMOT", exchange: "NSE", kind: "EQ", name: "Eicher Motors (Demo)", base: 6850, tick: 0.1 },
  { symbol: "ETERNAL", exchange: "NSE", kind: "EQ", name: "Eternal (Demo)", base: 318, tick: 0.05 },
  { symbol: "GRASIM", exchange: "NSE", kind: "EQ", name: "Grasim Industries (Demo)", base: 2760, tick: 0.1 },
  { symbol: "HCLTECH", exchange: "NSE", kind: "EQ", name: "HCL Technologies (Demo)", base: 1480, tick: 0.1 },
  { symbol: "HDFCLIFE", exchange: "NSE", kind: "EQ", name: "HDFC Life Insurance (Demo)", base: 765, tick: 0.05 },
  { symbol: "HINDALCO", exchange: "NSE", kind: "EQ", name: "Hindalco Industries (Demo)", base: 745, tick: 0.05 },
  { symbol: "HINDUNILVR", exchange: "NSE", kind: "EQ", name: "Hindustan Unilever (Demo)", base: 2510, tick: 0.1 },
  { symbol: "INDIGO", exchange: "NSE", kind: "EQ", name: "InterGlobe Aviation (Demo)", base: 5720, tick: 0.1 },
  { symbol: "ITC", exchange: "NSE", kind: "EQ", name: "ITC (Demo)", base: 408, tick: 0.05 },
  { symbol: "JIOFIN", exchange: "NSE", kind: "EQ", name: "Jio Financial Services (Demo)", base: 305, tick: 0.05 },
  { symbol: "JSWSTEEL", exchange: "NSE", kind: "EQ", name: "JSW Steel (Demo)", base: 1135, tick: 0.1 },
  { symbol: "KOTAKBANK", exchange: "NSE", kind: "EQ", name: "Kotak Mahindra Bank (Demo)", base: 2110, tick: 0.1 },
  { symbol: "LT", exchange: "NSE", kind: "EQ", name: "Larsen & Toubro (Demo)", base: 3780, tick: 0.1 },
  { symbol: "M&M", exchange: "NSE", kind: "EQ", name: "Mahindra & Mahindra (Demo)", base: 3420, tick: 0.1 },
  { symbol: "MARUTI", exchange: "NSE", kind: "EQ", name: "Maruti Suzuki (Demo)", base: 15900, tick: 0.1 },
  { symbol: "MAXHEALTH", exchange: "NSE", kind: "EQ", name: "Max Healthcare (Demo)", base: 1150, tick: 0.1 },
  { symbol: "NESTLEIND", exchange: "NSE", kind: "EQ", name: "Nestle India (Demo)", base: 1240, tick: 0.1 },
  { symbol: "NTPC", exchange: "NSE", kind: "EQ", name: "NTPC (Demo)", base: 342, tick: 0.05 },
  { symbol: "ONGC", exchange: "NSE", kind: "EQ", name: "Oil and Natural Gas Corporation (Demo)", base: 242, tick: 0.05 },
  { symbol: "POWERGRID", exchange: "NSE", kind: "EQ", name: "Power Grid Corporation (Demo)", base: 288, tick: 0.05 },
  { symbol: "SBILIFE", exchange: "NSE", kind: "EQ", name: "SBI Life Insurance (Demo)", base: 1840, tick: 0.1 },
  { symbol: "SHRIRAMFIN", exchange: "NSE", kind: "EQ", name: "Shriram Finance (Demo)", base: 665, tick: 0.05 },
  { symbol: "SUNPHARMA", exchange: "NSE", kind: "EQ", name: "Sun Pharmaceutical (Demo)", base: 1640, tick: 0.1 },
  { symbol: "TATACONSUM", exchange: "NSE", kind: "EQ", name: "Tata Consumer Products (Demo)", base: 1120, tick: 0.1 },
  { symbol: "TATASTEEL", exchange: "NSE", kind: "EQ", name: "Tata Steel (Demo)", base: 168, tick: 0.05 },
  { symbol: "TECHM", exchange: "NSE", kind: "EQ", name: "Tech Mahindra (Demo)", base: 1470, tick: 0.1 },
  { symbol: "TITAN", exchange: "NSE", kind: "EQ", name: "Titan Company (Demo)", base: 3560, tick: 0.1 },
  { symbol: "TMPV", exchange: "NSE", kind: "EQ", name: "Tata Motors Passenger Vehicles (Demo)", base: 405, tick: 0.05 },
  { symbol: "TRENT", exchange: "NSE", kind: "EQ", name: "Trent (Demo)", base: 4780, tick: 0.1 },
  { symbol: "ULTRACEMCO", exchange: "NSE", kind: "EQ", name: "UltraTech Cement (Demo)", base: 12150, tick: 0.1 },
  { symbol: "WIPRO", exchange: "NSE", kind: "EQ", name: "Wipro (Demo)", base: 245, tick: 0.05 },
]);

const BY_SYMBOL = new Map(DEMO_UNDERLYINGS.map((u) => [u.symbol, u]));
const STRIKES_EACH_SIDE = 30;

// ── Deterministic helpers ──

/** 32-bit FNV-1a hash of a string. */
export function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // murmur3 finaliser, so texts that differ only in their last character still land far apart
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
/** A number in [0, 1) fixed by the text. */
const unit = (s) => hash32(s) / 4294967296;
const phase = (s) => unit(s) * 2 * Math.PI;
const round2 = (n) => Math.round(n * 100) / 100;
const toTick = (n, tick) => Math.max(tick, Math.round(n / tick) * tick);
const fix = (n, tick) => Number(toTick(n, tick).toFixed(2));

/** Spot price of a demo underlying at epoch ms `t`. Smooth, bounded and the same for the same instant. */
export function spotAt(symbol, t) {
  const u = BY_SYMBOL.get(symbol);
  if (!u) return null;
  const s = t / 1000;
  const d = s / 86_400;
  const slow = 0.05 * Math.sin((2 * Math.PI * d) / 41 + phase(`${symbol}:a`)) + 0.012 * Math.sin((2 * Math.PI * d) / 9.3 + phase(`${symbol}:b`)) + 0.004 * Math.sin((2 * Math.PI * d) / 2.1 + phase(`${symbol}:c`));
  const fast = 0.0024 * Math.sin((2 * Math.PI * s) / 3180 + phase(`${symbol}:d`)) + 0.0011 * Math.sin((2 * Math.PI * s) / 660 + phase(`${symbol}:e`)) + 0.0004 * Math.sin((2 * Math.PI * s) / 97 + phase(`${symbol}:f`));
  const amp = u.kind === "EQ" ? 1.6 : 1;
  return fix(u.base * Math.exp(amp * (slow + fast)), u.tick);
}

/** IST calendar parts for epoch ms. */
function ist(t) {
  const d = new Date(t + IST_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate(), dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
/** Epoch ms of hh:mm IST on the IST date of `t`. */
function istAt(t, hh, mm) {
  const p = ist(t);
  return Date.UTC(p.y, p.m, p.day, hh, mm) - IST_OFFSET_MS;
}
const isoDate = (y, m, d) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const isWeekday = (t) => {
  const dow = ist(t).dow;
  return dow !== 0 && dow !== 6;
};

/** The last weekday 15:30 IST strictly before the IST date of `t` (yesterday's close). */
function previousClose(t) {
  let x = istAt(t, 15, 30) - DAY_MS;
  while (!isWeekday(x)) x -= DAY_MS;
  return x;
}
/** 09:15 IST on the most recent weekday at or before `t`. */
function sessionOpen(t) {
  let x = istAt(t, 9, 15);
  if (x > t) x -= DAY_MS;
  while (!isWeekday(x)) x -= DAY_MS;
  return x;
}

// ── Expiries ──

/**
 * An expiry that lands on an exchange holiday moves to the previous trading day (the demo calendar: the shipped
 * holiday list, reference/demoTables.mjs), so the reference "shifted" explanation can be seen in demo mode.
 */
function shiftForHoliday(date, exchange) {
  const cal = demoCalendar();
  return cal.isTradingDay(date, exchange) ? date : cal.prevTradingDay(date, exchange);
}

/** Next `count` expiry dates (YYYY-MM-DD, IST) on or after the IST date of `t`, holiday-shifted. */
export function expiriesFor(symbol, t, count) {
  const u = BY_SYMBOL.get(symbol);
  if (!u?.expiry) return [];
  const start = ist(t);
  const today = isoDate(start.y, start.m, start.day);
  const out = [];
  if (u.expiry.startsWith("weekly")) {
    const target = u.expiry.endsWith("tue") ? 2 : 4;
    let x = Date.UTC(start.y, start.m, start.day);
    while (out.length < (count ?? 4)) {
      const d = new Date(x);
      if (d.getUTCDay() === target) {
        const e = shiftForHoliday(isoDate(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), u.deriv);
        if (e >= today) out.push(e);
      }
      x += DAY_MS;
    }
    return out;
  }
  // monthly: last Tuesday of the month
  let y = start.y;
  let m = start.m;
  while (out.length < (count ?? 3)) {
    const last = new Date(Date.UTC(y, m + 1, 0));
    while (last.getUTCDay() !== 2) last.setUTCDate(last.getUTCDate() - 1);
    const iso = shiftForHoliday(isoDate(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate()), u.deriv);
    if (iso >= today) out.push(iso);
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return out;
}

/** Years from `t` to 15:30 IST on the expiry date (at least a few minutes). */
function yearsTo(expiry, t) {
  const end = Date.parse(`${expiry}T15:30:00+05:30`);
  return Math.max((end - t) / (365 * DAY_MS), 10 / (365 * 24 * 60));
}

// ── Option maths ──

function normCdf(x) {
  const a = Math.abs(x) / Math.SQRT2;
  const k = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * k - 1.453152027) * k + 1.421413741) * k - 0.284496736) * k + 0.254829592) * k * Math.exp(-a * a);
  return 0.5 * (1 + (x < 0 ? -y : y));
}
function bs(spot, strike, years, vol, right) {
  const d1 = (Math.log(spot / strike) + (RATE + 0.5 * vol * vol) * years) / (vol * Math.sqrt(years));
  const d2 = d1 - vol * Math.sqrt(years);
  if (right === "CE") return spot * normCdf(d1) - strike * Math.exp(-RATE * years) * normCdf(d2);
  return strike * Math.exp(-RATE * years) * normCdf(-d2) - spot * normCdf(-d1);
}
/**
 * Implied volatility (decimal) for a strike and tenor, the same for CE and PE (so put-call parity holds): a smile in
 * moneyness scaled by √T, steeper on the put side, with front expiries richer than later ones (a term structure).
 */
export function smileVol(u, spot, strike, years) {
  const x = Math.log(strike / spot) / Math.sqrt(Math.max(years, 1 / 365));
  const base = u.iv * (1 + 0.3 * Math.exp((-years * 365) / 6));
  // Smooth in strike (no per-strike wiggle): adjacent strikes then never form a butterfly arbitrage.
  return base * (1 + 1.2 * x * x + (x < 0 ? 0.8 : 0.1) * Math.abs(x));
}

export function optionPrice(symbol, expiry, strike, right, t) {
  const u = BY_SYMBOL.get(symbol);
  const spot = spotAt(symbol, t);
  if (!u || spot === null) return null;
  const years = yearsTo(expiry, t);
  const p = bs(spot, strike, years, smileVol(u, spot, strike, years), right);
  return fix(Math.max(0.05, p), 0.05);
}

function futurePrice(symbol, expiry, t) {
  const spot = spotAt(symbol, t);
  return fix(spot * Math.exp(RATE * yearsTo(expiry, t)), 0.05);
}

/** Open interest in units, peaking near the money and at round strikes. */
function openInterest(u, spot, strike, right, expiry) {
  const dist = (strike - spot) / (u.step * 6);
  const side = right === "CE" ? (strike >= spot ? 1.15 : 0.55) : strike <= spot ? 1.15 : 0.55;
  const round = strike % (u.step * 10) === 0 ? 1.8 : strike % (u.step * 2) === 0 ? 1.2 : 1;
  const lots = Math.round(9000 * Math.exp(-dist * dist) * side * round * (0.85 + 0.3 * unit(`${u.symbol}:${expiry}:${strike}:${right}`)));
  return Math.max(1, lots) * u.lot;
}

// ── Instruments ──

/**
 * Lot of one demo contract: the demo reference lot table (reference/demoTables.mjs), including the rolling BANKNIFTY
 * revision for contracts after the next monthly expiry, so masters and reference agree.
 */
export function contractLot(u, expiry, t) {
  const nextMonthly = monthlyExpiries(u, t)[0] ?? null;
  return demoLotFor(u.symbol, expiry, nextMonthly) ?? u.lot;
}

/** Every demo instrument for the IST day of `t` (Instrument rows of the broker contract, plus `name`). */
export function demoInstruments(t) {
  const rows = [];
  for (const u of DEMO_UNDERLYINGS) {
    rows.push({ token: `DM-${u.symbol}`, exchange: u.exchange, tradingSymbol: u.symbol, underlying: u.symbol, instrumentType: u.kind, expiry: null, strike: null, optionType: null, lotSize: 1, tickSize: u.tick, name: u.name });
    if (!u.deriv) continue;
    for (const e of monthlyExpiries(u, t)) {
      rows.push({ token: `DM-${u.symbol}-${e}-FUT`, exchange: u.deriv, tradingSymbol: `${u.symbol}-${e}-FUT`, underlying: u.symbol, instrumentType: "FUTIDX", expiry: e, strike: null, optionType: null, lotSize: contractLot(u, e, t), tickSize: 0.05, name: `${u.name} future` });
    }
    const centre = Math.round(spotAt(u.symbol, t) / u.step) * u.step;
    for (const e of expiriesFor(u.symbol, t)) {
      const lot = contractLot(u, e, t);
      for (let i = -STRIKES_EACH_SIDE * 2; i <= STRIKES_EACH_SIDE * 2; i += 1) {
        const k = centre + i * u.step;
        for (const r of ["CE", "PE"]) {
          rows.push({ token: `DM-${u.symbol}-${e}-${k}-${r}`, exchange: u.deriv, tradingSymbol: `${u.symbol}-${e}-${k}-${r}`, underlying: u.symbol, instrumentType: "OPTIDX", expiry: e, strike: k, optionType: r, lotSize: lot, tickSize: 0.05, name: `${u.name} ${k} ${r}` });
        }
      }
    }
  }
  return rows;
}

/** Futures run on the monthly cycle (last Tuesday for NSE indices, last Thursday for SENSEX). */
function monthlyExpiries(u, t) {
  const start = ist(t);
  const target = u.deriv === "BFO" ? 4 : 2;
  const out = [];
  let y = start.y;
  let m = start.m;
  while (out.length < 2) {
    const last = new Date(Date.UTC(y, m + 1, 0));
    while (last.getUTCDay() !== target) last.setUTCDate(last.getUTCDate() - 1);
    const iso = shiftForHoliday(isoDate(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate()), u.deriv);
    if (iso >= isoDate(start.y, start.m, start.day)) out.push(iso);
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return out;
}

/** Parse a demo token: DM-<SYM>[-<expiry>-FUT | -<expiry>-<strike>-<CE|PE>]. */
export function parseToken(token) {
  const m = /^DM-([A-Z0-9&-]+?)(?:-(\d{4}-\d{2}-\d{2})-(?:(FUT)|(\d+(?:\.\d+)?)-(CE|PE)))?$/.exec(String(token));
  if (!m || !BY_SYMBOL.has(m[1])) return null;
  if (!m[2]) return { symbol: m[1], kind: "spot" };
  if (m[3]) return { symbol: m[1], kind: "fut", expiry: m[2] };
  return { symbol: m[1], kind: "opt", expiry: m[2], strike: Number(m[4]), right: m[5] };
}

/** Last traded price of any demo token at `t`. */
export function priceOf(token, t) {
  const p = parseToken(token);
  if (!p) return null;
  if (p.kind === "spot") return spotAt(p.symbol, t);
  if (p.kind === "fut") return futurePrice(p.symbol, p.expiry, t);
  return optionPrice(p.symbol, p.expiry, p.strike, p.right, t);
}

/** A full quote for a token at `t`. */
export function quoteOf(token, exchange, t) {
  const p = parseToken(token);
  if (!p) return null;
  const u = BY_SYMBOL.get(p.symbol);
  const ltp = priceOf(token, t);
  const open = priceOf(token, sessionOpen(t)) ?? ltp;
  const close = priceOf(token, previousClose(t)) ?? ltp;
  const samples = [open, ltp];
  const from = sessionOpen(t);
  const to = Math.min(t, from + 375 * 60_000);
  for (let x = from; x <= to; x += 15 * 60_000) samples.push(priceOf(token, x));
  const tick = p.kind === "spot" ? u.tick : 0.05;
  const minutes = Math.max(1, Math.min(375, (to - from) / 60_000));
  const near = p.kind === "opt" ? Math.exp(-(((p.strike - spotAt(p.symbol, t)) / (u.step * 8)) ** 2)) : 1;
  // Never a locked quote: bid < ask by at least a tick, bid <= LTP <= ask. Options widen away from the money (0.15% of
  // price near it; one to four ticks more far out, so cheap far strikes show the > 5% and > 10% spread cues).
  const spread = p.kind === "opt" ? Math.max(tick * (1 + Math.round(3 * (1 - near))), ltp * 0.0015) : Math.max(tick, ltp * 0.0002);
  const down = (n) => Math.max(0, Math.floor(n / tick + 1e-9) * tick);
  const up = (n) => Math.ceil(n / tick - 1e-9) * tick;
  const bid = Number(down(Math.min(ltp, ltp - spread / 2)).toFixed(2));
  const ask = Number(Math.max(up(ltp + spread / 2), bid + tick).toFixed(2));
  const perMinute = p.kind === "spot" ? 5200 : p.kind === "fut" ? 30 : 4 + 200 * near;
  const volume = p.kind === "spot" && u.kind === "INDEX" ? 0 : Math.round(perMinute * minutes * (0.7 + 0.6 * unit(`${token}:vol`))) * (p.kind === "spot" ? 1 : u.lot);
  const oi = p.kind === "opt" ? openInterest(u, spotAt(p.symbol, t), p.strike, p.right, p.expiry) : p.kind === "fut" ? Math.round(120_000 * (0.8 + 0.4 * unit(`${token}:oi`))) * u.lot : null;
  return {
    token,
    exchange,
    ltp,
    open,
    high: Math.max(...samples),
    low: Math.min(...samples),
    close,
    volume,
    oi,
    bid,
    ask,
  };
}

// ── The adapter ──

/**
 * @param {{ now?: () => number, tickMs?: number }} [opts]  now: clock (tests); tickMs: feed interval (default 1000)
 */
export function createDemoAdapter({ now = () => Date.now(), tickMs = 1000 } = {}) {
  const ok = (data) => ({ status: "success", data });
  const underlyingOf = (name) => {
    const s = String(name ?? "").toUpperCase().replace(/^(NSE|BSE):/, "");
    const u = BY_SYMBOL.get(s);
    if (!u) throw Object.assign(new Error(`Demo data covers ${DEMO_UNDERLYINGS.map((x) => x.symbol).join(", ")}; ${name} is not one of them.`), { code: "BROKER_INPUT_INVALID", statusCode: 422 });
    return u;
  };

  const adapter = {
    id: DEMO_BROKER_ID,
    displayName: DEMO_BROKER_NAME,
    demo: true,
    credentialFields: ["demoToken"],
    capabilities: Object.freeze({
      auth: { kind: "apiKeyToken" },
      testConnection: true,
      instruments: true,
      expiries: true,
      optionChain: { greeks: "computed" },
      ltp: true,
      quotes: true,
      depth: true,
      historical: { intervals: ["1m", "3m", "5m", "15m", "30m", "60m", "1d"] },
      feed: true,
      positions: true,
      holdings: true,
      funds: true,
      orderBook: true,
      tradeBook: true,
    }),

    async testConnection() {
      return { status: "success", message: "Demo market data is ready (sample prices, not live)." };
    },

    async fetchInstruments() {
      return ok(demoInstruments(now()));
    },

    async fetchExpiryList(_creds, underlying) {
      const u = underlyingOf(underlying);
      return ok(expiriesFor(u.symbol, now()));
    },

    async fetchLTP(_creds, underlying) {
      const u = underlyingOf(underlying);
      return ok({ last_price: spotAt(u.symbol, now()) });
    },

    async fetchOptionChain(_creds, underlying, expiry) {
      const u = underlyingOf(underlying);
      const t = now();
      if (!expiriesFor(u.symbol, t).includes(expiry)) {
        throw Object.assign(new Error(`No demo expiry ${expiry} for ${u.symbol}.`), { code: "BROKER_INPUT_INVALID", statusCode: 422 });
      }
      const spot = spotAt(u.symbol, t);
      const centre = Math.round(spot / u.step) * u.step;
      const oc = {};
      for (let i = -STRIKES_EACH_SIDE; i <= STRIKES_EACH_SIDE; i += 1) {
        const k = centre + i * u.step;
        const leg = (r) => {
          const q = quoteOf(`DM-${u.symbol}-${expiry}-${k}-${r}`, u.deriv, t);
          const prevOi = Math.round(q.oi * (0.88 + 0.2 * unit(`${u.symbol}:${expiry}:${k}:${r}:prev`)));
          return { last_price: q.ltp, oi: q.oi, previous_oi: prevOi, oi_chg: q.oi - prevOi, volume: q.volume, top_bid_price: q.bid, top_ask_price: q.ask, previous_close_price: q.close, security_id: `DM-${u.symbol}-${expiry}-${k}-${r}` };
        };
        oc[k.toFixed(6)] = { ce: leg("CE"), pe: leg("PE") };
      }
      return ok({ oc, last_price: spot });
    },

    async fetchQuotes(_creds, refs) {
      const t = now();
      return ok(refs.map((r) => quoteOf(r.token, r.exchange, t)).filter(Boolean));
    },

    async fetchDepth(_creds, ref) {
      const q = quoteOf(ref.token, ref.exchange, now());
      if (!q) throw Object.assign(new Error(`Unknown demo instrument ${ref.token}.`), { code: "BROKER_INPUT_INVALID", statusCode: 422 });
      const step = Math.max(0.05, round2(q.ask - q.bid));
      const level = (side, i) => ({
        price: fix(side === "bid" ? q.bid - i * step : q.ask + i * step, 0.05),
        qty: (5 + Math.round(40 * unit(`${ref.token}:${side}:${i}:${Math.floor(now() / 5000)}`))) * 25,
        orders: 1 + Math.round(12 * unit(`${ref.token}:${side}:o${i}`)),
      });
      return ok({ bids: [0, 1, 2, 3, 4].map((i) => level("bid", i)), asks: [0, 1, 2, 3, 4].map((i) => level("ask", i)) });
    },

    async fetchHistorical(_creds, req) {
      const token = req?.instrument?.token;
      if (!parseToken(token)) throw Object.assign(new Error(`Unknown demo instrument ${token}.`), { code: "BROKER_INPUT_INVALID", statusCode: 422 });
      const interval = String(req.interval ?? "1d");
      const fromMs = parseIst(req.from, false);
      const toMs = Math.min(parseIst(req.to, true), now());
      return ok(candles(token, interval, fromMs, toMs));
    },

    createFeed(_creds, { onTick, onStatus } = {}) {
      const subs = new Map();
      let closed = false;
      const emit = () => {
        if (closed) return;
        const t = now();
        for (const [token, exchange] of subs) {
          const q = quoteOf(token, exchange, t);
          if (q) onTick?.(q);
        }
      };
      const timer = setInterval(emit, tickMs);
      timer.unref?.();
      queueMicrotask(() => {
        if (!closed) onStatus?.({ connected: true });
      });
      return {
        subscribe(refs) {
          for (const r of refs ?? []) if (parseToken(r.token)) subs.set(r.token, r.exchange);
          queueMicrotask(emit);
        },
        unsubscribe(refs) {
          for (const r of refs ?? []) subs.delete(r.token);
        },
        close() {
          closed = true;
          clearInterval(timer);
          onStatus?.({ connected: false, reason: "closed" });
        },
      };
    },

    async fetchPositions() {
      const t = now();
      const e = expiriesFor("NIFTY", t)[0];
      const k = Math.round(spotAt("NIFTY", t) / 50) * 50;
      const token = `DM-NIFTY-${e}-${k}-CE`;
      const ltp = priceOf(token, t);
      const avg = fix(ltp * 0.94, 0.05);
      const qty = contractLot(BY_SYMBOL.get("NIFTY"), e, t);
      return ok([{ tradingSymbol: `NIFTY-${e}-${k}-CE`, exchange: "NFO", token, product: "MARGIN", netQty: qty, avgPrice: avg, ltp, pnl: round2((ltp - avg) * qty), realisedPnl: 0, unrealisedPnl: round2((ltp - avg) * qty) }]);
    },

    async fetchHoldings() {
      const t = now();
      const rows = [
        ["RELIANCE", 10, 0.91],
        ["INFY", 15, 1.04],
        ["SBIN", 40, 0.83],
      ];
      return ok(
        rows.map(([sym, qty, f]) => {
          const ltp = spotAt(sym, t);
          const avg = fix(BY_SYMBOL.get(sym).base * f, 0.05);
          return { tradingSymbol: sym, exchange: "NSE", token: `DM-${sym}`, isin: null, qty, avgPrice: avg, ltp, pnl: round2((ltp - avg) * qty) };
        }),
      );
    },

    async fetchFunds() {
      return ok({ availableCash: 250000, usedMargin: 48210.5, totalBalance: 298210.5, collateral: 0, withdrawable: 250000 });
    },

    async fetchOrderBook() {
      return ok([]);
    },

    async fetchTradeBook() {
      return ok([]);
    },

    normaliseError(err) {
      const code = typeof err?.code === "string" ? err.code : "UPSTREAM_ERROR";
      const statusCode = err?.statusCode === 422 ? 422 : 502;
      return { statusCode, code, message: String(err?.message ?? "Demo data error").slice(0, 240) };
    },
  };
  return adapter;
}

/** "YYYY-MM-DD" or "YYYY-MM-DD HH:mm" (IST) -> epoch ms. Date-only `to` means the end of that day. */
function parseIst(text, endOfDay) {
  const s = String(text ?? "");
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s);
  if (!m) return endOfDay ? Date.now() : Date.now() - 5 * DAY_MS;
  const [, y, mo, d, hh, mm] = m;
  if (hh === undefined) return Date.UTC(+y, +mo - 1, +d, endOfDay ? 23 : 0, endOfDay ? 59 : 0) - IST_OFFSET_MS;
  return Date.UTC(+y, +mo - 1, +d, +hh, +mm) - IST_OFFSET_MS;
}

const INTERVAL_MIN = Object.freeze({ "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "60m": 60 });

/** OHLCV candles sampled from the price function, NSE hours on weekdays (epoch-second bar opens). */
export function candles(token, interval, fromMs, toMs) {
  const out = [];
  const p = parseToken(token);
  if (!p || !(toMs >= fromMs)) return out;
  const u = BY_SYMBOL.get(p.symbol);
  const lotMul = p.kind === "spot" ? 1 : u.lot;
  const indexSpot = p.kind === "spot" && u.kind === "INDEX";
  const bar = (start, end) => {
    const pts = [];
    const n = 6;
    for (let i = 0; i <= n; i += 1) pts.push(priceOf(token, start + ((end - start) * i) / n));
    const open = pts[0];
    const close = pts[n];
    const wick = Math.abs(close - open) * 0.25 + (p.kind === "spot" ? u.tick : 0.05);
    const vol = indexSpot ? 0 : Math.round((800 + 2400 * unit(`${token}:${start}`)) * ((end - start) / 60_000) ** 0.8) * lotMul;
    return {
      time: Math.floor(start / 1000),
      open,
      high: round2(Math.max(...pts) + wick * unit(`${token}:${start}:h`)),
      low: round2(Math.min(...pts) - wick * unit(`${token}:${start}:l`)),
      close,
      volume: vol,
    };
  };
  if (interval === "1d") {
    let d = istAt(fromMs, 9, 15);
    if (d < fromMs - DAY_MS) d += DAY_MS;
    for (; d <= toMs; d += DAY_MS) {
      if (!isWeekday(d)) continue;
      const end = Math.min(d + 375 * 60_000, toMs);
      if (end <= d) continue;
      const c = bar(d, end);
      c.time = Math.floor((d - (9 * 60 + 15) * 60_000) / 1000); // daily bars open at IST midnight
      out.push(c);
    }
    return out;
  }
  const size = (INTERVAL_MIN[interval] ?? 1) * 60_000;
  let day = istAt(fromMs, 9, 15);
  if (day > fromMs) day -= DAY_MS;
  for (; day <= toMs; day += DAY_MS) {
    if (!isWeekday(day)) continue;
    const close = day + 375 * 60_000;
    for (let s = day; s < close; s += size) {
      const e = Math.min(s + size, close);
      if (e <= fromMs || s > toMs) continue;
      if (s > toMs) break;
      out.push(bar(s, Math.min(e, toMs)));
    }
  }
  return out;
}

export const demoAdapter = createDemoAdapter();
