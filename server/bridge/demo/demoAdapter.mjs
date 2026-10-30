/**
 * The demo market-data provider: a broker adapter on the strict contract (server/brokers/contract.mjs) that makes
 * NO network calls. It serves deterministic sample data so anyone can try the Bridge without a broker account, and
 * so screenshots look the same every time:
 *
 *  - instruments: NIFTY, BANKNIFTY, SENSEX, FINNIFTY and MIDCPNIFTY (index, futures, options) and the NIFTY 50 stocks,
 *    each with monthly stock futures and options on the nearest 3 monthly expiries (P1-6: lots from the demo
 *    reference table, the demo strike-step table including fractional strikes, ±20 strikes, and 6 adjusted "-ADJ"
 *    contracts on the demo split stock);
 *  - prices: a function of wall-clock time per symbol (a seeded day-to-day random walk with drift, plus minute-scale
 *    wiggles), so the same instant always gives the same price and ticks keep moving even when the real market is shut;
 *  - option chains: Black-76 prices on the vol-time clock (dashboard/pricing.js, the same core the server and pages
 *    use) from a smile around a time-varying IV level anchored to the demo's own realised vol, with open interest
 *    peaking near the money that changes through the day (whole lots), and bid/ask sizes; ±45 strikes per chain;
 *    INDIA VIX (Demo) follows NIFTY's 30-day IV;
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

import { black76, realisedVol, volTime } from "../dashboard/pricing.js";
import { DEFAULT_RATE, DEFAULT_SESSIONS } from "../reference/defaults.mjs";
import { DEMO_STOCK_LOT, demoCalendar, demoLotFor } from "../reference/demoTables.mjs";
import { clockSettings } from "../vol/config.mjs";
import { buildClockContext, holidayDates } from "../vol/context.mjs";

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
/** The demo prices with the reference default rate (reference/defaults.mjs), the same value demo reference reports. */
const RATE = DEFAULT_RATE;

/** Spot instruments. base = the level the slow waves move around. */
export const DEMO_UNDERLYINGS = Object.freeze([
  { symbol: "NIFTY", exchange: "NSE", kind: "INDEX", name: "NIFTY 50 (Demo)", base: 25150, tick: 0.05, step: 50, lot: 65, iv: 0.12, deriv: "NFO", expiry: "weekly-tue" },
  { symbol: "BANKNIFTY", exchange: "NSE", kind: "INDEX", name: "NIFTY BANK (Demo)", base: 56400, tick: 0.05, step: 100, lot: 30, iv: 0.14, deriv: "NFO", expiry: "monthly-tue" },
  { symbol: "SENSEX", exchange: "BSE", kind: "INDEX", name: "S&P BSE SENSEX (Demo)", base: 82300, tick: 0.01, step: 100, lot: 20, iv: 0.125, deriv: "BFO", expiry: "weekly-thu" },
  { symbol: "FINNIFTY", exchange: "NSE", kind: "INDEX", name: "NIFTY FIN SERVICE (Demo)", base: 26900, tick: 0.05, step: 50, lot: 60, iv: 0.13, deriv: "NFO", expiry: "monthly-tue" },
  { symbol: "MIDCPNIFTY", exchange: "NSE", kind: "INDEX", name: "NIFTY MIDCAP SELECT (Demo)", base: 13100, tick: 0.05, step: 25, lot: 120, iv: 0.16, deriv: "NFO", expiry: "monthly-tue" },
  // INDIA VIX: an index with no derivatives, priced from NIFTY's 30-day IV (vixAt below).
  { symbol: "INDIAVIX", exchange: "NSE", kind: "INDEX", name: "India VIX (Demo)", base: 13, tick: 0.0025 },
  { symbol: "RELIANCE", exchange: "NSE", kind: "EQ", name: "Reliance Industries (Demo)", base: 1418, tick: 0.1, step: 20, lot: DEMO_STOCK_LOT.RELIANCE, iv: 0.22, deriv: "NFO", expiry: "monthly-tue" },
  { symbol: "HDFCBANK", exchange: "NSE", kind: "EQ", name: "HDFC Bank (Demo)", base: 1002, tick: 0.05, step: 10, lot: DEMO_STOCK_LOT.HDFCBANK, iv: 0.19, deriv: "NFO", expiry: "monthly-tue" },
  { symbol: "ICICIBANK", exchange: "NSE", kind: "EQ", name: "ICICI Bank (Demo)", base: 1395, tick: 0.1, step: 10, lot: DEMO_STOCK_LOT.ICICIBANK, iv: 0.2, deriv: "NFO", expiry: "monthly-tue" },
  { symbol: "INFY", exchange: "NSE", kind: "EQ", name: "Infosys (Demo)", base: 1512, tick: 0.1, step: 20, lot: DEMO_STOCK_LOT.INFY, iv: 0.24, deriv: "NFO", expiry: "monthly-tue" },
  { symbol: "TCS", exchange: "NSE", kind: "EQ", name: "Tata Consultancy Services (Demo)", base: 3086, tick: 0.1 },
  { symbol: "SBIN", exchange: "NSE", kind: "EQ", name: "State Bank of India (Demo)", base: 872, tick: 0.05, step: 5, lot: DEMO_STOCK_LOT.SBIN, iv: 0.25, deriv: "NFO", expiry: "monthly-tue" },
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

/**
 * Demo strike step by price (P1-6 §4.1; labelled demo, real steps come from the masters): < 100: 1 · 100–250: 2.5 ·
 * 250–500: 5 · 500–1000: 10 · 1000–2500: 20 · 2500–5000: 50 · 5000–10000: 100 · ≥ 10000: 250.
 */
export function demoStrikeStep(base) {
  const table = [
    [100, 1],
    [250, 2.5],
    [500, 5],
    [1000, 10],
    [2500, 20],
    [5000, 50],
    [10000, 100],
  ];
  for (const [below, step] of table) if (base < below) return step;
  return 250;
}

/**
 * The derivative fields of a demo stock (P1-6 §4.1): NFO monthly options and futures, the demo lot table, the strike
 * step table, an IV of 20–45 % (P1-1's five option stocks keep theirs), a flatter put wing (0.35 vs the index 0.8) and
 * OI scaled by 0.15 (about 1,000–2,500 lots near the money).
 */
function withStockDerivatives(u) {
  if (u.kind !== "EQ") return u;
  return Object.freeze({ ...u, deriv: "NFO", expiry: "monthly-tue", step: demoStrikeStep(u.base), lot: DEMO_STOCK_LOT[u.symbol], iv: u.iv ?? 0.2 + 0.25 * (hash32(u.symbol) / 4294967296), putWing: 0.35, oiScale: 0.15, stock: true });
}

const BY_SYMBOL = new Map(DEMO_UNDERLYINGS.map((u) => [u.symbol, withStockDerivatives(u)]));
const STRIKES_EACH_SIDE = 30;
/** Strikes each side of ATM in a broker-style chain (fetchOptionChain); instruments list ±60. */
export const CHAIN_STRIKES_EACH_SIDE = 45;
/** Stocks list ±20 strikes around the IST-day centre, in the master and in a chain (P1-6 §4.1). */
const STOCK_STRIKES_EACH_SIDE = 20;
/** Underlyings with listed options: indices first, then the demo stocks. */
export const DEMO_OPTION_UNDERLYINGS = Object.freeze([...BY_SYMBOL.values()].filter((u) => u.deriv).map((u) => u.symbol));
/** The demo underlying with derivative fields (stocks included), or null. */
export const demoUnderlying = (symbol) => BY_SYMBOL.get(symbol) ?? null;

/** Demo stocks that may carry the adjusted (split) series; the one not taking this week's bonus is used. */
export const DEMO_SPLIT_CANDIDATES = Object.freeze(["BHARTIARTL", "BAJAJFINSV"]);
const DEMO_STOCK_LIST = Object.freeze(Object.keys(DEMO_STOCK_LOT).sort());
/** Monday of the week of an IST date. */
function weekStart(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
/** The demo stock taking the rolling 1:1 bonus in the week of `date` (reference/demoReference.mjs uses it too). */
export const demoBonusSymbol = (date) => DEMO_STOCK_LIST[hash32(weekStart(date)) % DEMO_STOCK_LIST.length];
/** The demo split stock: its nearest expiry lists the adjusted -ADJ contracts (lot × 5, off-grid strikes). */
export const demoSplitSymbol = (date) => DEMO_SPLIT_CANDIDATES.find((s) => s !== demoBonusSymbol(date));
/** The adjusted series' lot factor (the split's factor). */
export const DEMO_ADJ_FACTOR = 5;

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
/** Round outward onto the tick grid (4 dp clears float noise, enough for the 0.0025 VIX tick). */
const ceilTick = (n, tick) => Number((Math.ceil(n / tick - 1e-9) * tick).toFixed(4));
const floorTick = (n, tick) => Number((Math.floor(n / tick + 1e-9) * tick).toFixed(4));

// ── The multi-day path: a seeded random walk ──
// Day to day, a demo price is a geometric random walk (no pull back to a fixed level, so a backtest or a trend reads
// like a market): each IST calendar day k has a standard normal shock z(k) fixed by hash32(symbol, k), drift mu and
// volatility sigma a year (indices 18 to 22 %, stocks 25 to 35 %, drift 10 to 12 %), and the log level is the sum of
// the daily steps from WALK_ANCHOR (where it is 0, so prices sit near their base around the anchor). The day's step
// is spread over the session (09:15 to 15:30 IST); outside it the level holds. Deterministic: the same instant always
// gives the same price.
const WALK_ANCHOR = Math.floor((Date.UTC(2026, 9, 1) + IST_OFFSET_MS) / DAY_MS); // 1 Oct 2026, an IST day number
const WALK_SPAN = 4000; // days each side of the anchor that the walk covers (about 11 years); beyond it the level holds
/** A standard normal number fixed by the text (Box-Muller on two hash units). */
function normalOf(text) {
  const a = Math.max(1e-12, unit(`${text}:u1`));
  const b = unit(`${text}:u2`);
  return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
}
/** Drift and volatility a year of a demo underlying (decimals). */
export function walkParams(symbol) {
  const u = BY_SYMBOL.get(symbol);
  const eq = u?.kind === "EQ";
  return { mu: 0.1 + 0.02 * unit(`${symbol}:mu`), sigma: eq ? 0.25 + 0.1 * unit(`${symbol}:sigma`) : 0.18 + 0.04 * unit(`${symbol}:sigma`) };
}
const WALKS = new Map();
/** Log level at the END of IST day number k (cumulative steps from the anchor; 0 at the anchor). */
function walkLevel(symbol, k) {
  let w = WALKS.get(symbol);
  if (!w) {
    const { mu, sigma } = walkParams(symbol);
    const drift = (mu - (sigma * sigma) / 2) / 365;
    const vol = sigma / Math.sqrt(365);
    // Volatility comes in regimes (calm months and busy ones, so IV rank travels): a slow factor around 1.
    const p1 = phase(`${symbol}:regime1`);
    const p2 = phase(`${symbol}:regime2`);
    const regime = (j) => 1 + 0.3 * Math.sin((2 * Math.PI * j) / 157 + p1) + 0.12 * Math.sin((2 * Math.PI * j) / 47 + p2);
    w = { step: (j) => drift + vol * regime(j) * normalOf(`${symbol}:walk:${j}`), up: [0], down: [0] };
    WALKS.set(symbol, w);
  }
  const off = Math.max(-WALK_SPAN, Math.min(WALK_SPAN, k - WALK_ANCHOR));
  if (off >= 0) {
    while (w.up.length <= off) w.up.push(w.up[w.up.length - 1] + w.step(WALK_ANCHOR + w.up.length));
    return w.up[off];
  }
  // Day k ends where day k + 1's step starts: level(k) = level(k + 1) - step(k + 1).
  while (w.down.length <= -off) w.down.push(w.down[w.down.length - 1] - w.step(WALK_ANCHOR - w.down.length + 1));
  return w.down[-off];
}
/** The walk's log level at epoch ms t: yesterday's close level plus today's step spread over the session. */
export function walkAt(symbol, t) {
  const k = Math.floor((t + IST_OFFSET_MS) / DAY_MS);
  const min = ((t + IST_OFFSET_MS) % DAY_MS) / 60_000;
  const f = Math.max(0, Math.min(1, (min - 555) / 375));
  const a = walkLevel(symbol, k - 1);
  return a + f * (walkLevel(symbol, k) - a);
}

/** Spot price of a demo underlying at epoch ms `t`. The same for the same instant. */
export function spotAt(symbol, t) {
  const u = BY_SYMBOL.get(symbol);
  if (!u) return null;
  if (symbol === "INDIAVIX") return vixAt(t);
  const s = t / 1000;
  // Minute-scale wiggles on top of the day-to-day walk, so ticks keep moving inside a session.
  const fast = 0.0024 * Math.sin((2 * Math.PI * s) / 3180 + phase(`${symbol}:d`)) + 0.0011 * Math.sin((2 * Math.PI * s) / 660 + phase(`${symbol}:e`)) + 0.0004 * Math.sin((2 * Math.PI * s) / 97 + phase(`${symbol}:f`));
  const amp = u.kind === "EQ" ? 1.6 : 1;
  return fix(u.base * Math.exp(walkAt(symbol, t) + amp * fast), u.tick);
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

// ── The vol-time clock and the IV level ──

/** Bounded memo: clears itself when full (the demo asks for the same few instants over and over). */
function memo(limit) {
  const m = new Map();
  return (key, make) => {
    if (m.has(key)) return m.get(key);
    if (m.size >= limit) m.clear();
    const v = make();
    m.set(key, v);
    return v;
  };
}

const CLOCK_CTX = new Map();
/**
 * The demo's clock context for a derivatives exchange: default `vol.clock` settings, the demo calendar's holidays and
 * the default session — what the server's vol/context.mjs builds from the demo reference data, so server, pages and
 * demo prices all use one clock.
 */
export function demoClockContext(exchange = "NFO") {
  if (!CLOCK_CTX.has(exchange)) {
    const session = DEFAULT_SESSIONS[exchange] ?? DEFAULT_SESSIONS.NFO;
    CLOCK_CTX.set(exchange, buildClockContext({ settings: clockSettings(null), kind: "index", session: { open: session.open, close: session.close }, holidays: holidayDates(demoCalendar().holidays, exchange), holidaysSource: "reference" }));
  }
  return CLOCK_CTX.get(exchange);
}

const clockMemo = memo(20_000);
/** { T, Tcal } from `t` to an expiry's settlement on the demo clock (T on vol-time, Tcal calendar). */
function clockTo(exchange, expiry, t) {
  return clockMemo(`${exchange}|${expiry}|${t}`, () => volTime(demoClockContext(exchange), t, expiry) ?? { T: 0, Tcal: 0 });
}

/** IST date and the epoch ms of 15:30 IST on it. */
const istDateOf = (t) => {
  const p = ist(t);
  return isoDate(p.y, p.m, p.day);
};

/**
 * The last `n` daily closes (15:30 IST) of a demo underlying on demo-calendar trading days strictly before the IST date
 * of `t`, oldest first.
 */
export function dailyCloses(symbol, t, n) {
  const u = BY_SYMBOL.get(symbol);
  if (!u) return [];
  const cal = demoCalendar();
  const out = [];
  let x = istAt(t, 15, 30) - DAY_MS;
  for (let guard = 0; out.length < n && guard < n * 3; guard += 1, x -= DAY_MS) {
    if (cal.isTradingDay(istDateOf(x), u.exchange)) out.push(spotAt(symbol, x));
  }
  return out.reverse();
}

const levelMemo = memo(2000);
/**
 * The demo IV level (decimal) of an underlying on the IST day of `t` (§4.1, re-weighted for the random-walk prices):
 * clamp(0.06, 0.60, (0.35 × HV60 + 0.65 × HV20) × (1.10 + 0.08 × sin(2π·d/61 + φ))), where HV20/HV60 are the demo's own close-to-close realised vols over the
 * trailing sessions and d is the IST day number. IV runs above realised on most days (a positive variance premium) and
 * IV rank travels 0–100 over a year. Constant within a day.
 */
export function ivLevel(symbol, t) {
  const date = istDateOf(t);
  return levelMemo(`${symbol}|${date}`, () => {
    const closes = dailyCloses(symbol, t, 61);
    const hv20 = (realisedVol(closes, 20) ?? 15) / 100;
    const hv60 = (realisedVol(closes, 60) ?? 15) / 100;
    const d = Math.floor((t + IST_OFFSET_MS) / DAY_MS);
    // The walk's volatility comes in regimes, so IV leans on the recent HV20 (as a market's does) more than on HV60.
    const level = (0.35 * hv60 + 0.65 * hv20) * (1.1 + 0.08 * Math.sin((2 * Math.PI * d) / 61 + phase(`${symbol}:iv`)));
    return Math.min(0.6, Math.max(0.06, level));
  });
}

/**
 * INDIA VIX (Demo) at `t`: 100 × NIFTY's 30-day ATM vol on calendar time (the demo smile level and term factor on the
 * vol-time clock to the close 30 calendar days ahead, rolled back to the previous trading day as §6.6 does, converted
 * through total variance), × (1.03 + 0.03·sin(2π·d/17)), on a 0.0025 tick.
 */
function vixAt(t) {
  const target = shiftForHoliday(istDateOf(t + 30 * DAY_MS), "NFO");
  const c = clockTo("NFO", target, t);
  const nifty = BY_SYMBOL.get("NIFTY");
  const S = spotAt("NIFTY", t);
  const sigVt = smileVol(nifty, S, S, c.T, ivLevel("NIFTY", t));
  const sigCal = c.Tcal > 0 ? sigVt * Math.sqrt(c.T / c.Tcal) : sigVt;
  const d = Math.floor((t + IST_OFFSET_MS) / DAY_MS);
  const v = 100 * sigCal * (1.03 + 0.03 * Math.sin((2 * Math.PI * d) / 17));
  return Number((Math.round(v / 0.0025) * 0.0025).toFixed(4));
}

// ── Option maths ──

/**
 * Implied volatility (decimal) for a strike and tenor, the same for CE and PE (so put-call parity holds): a smile in
 * moneyness scaled by √T, steeper on the put side, with front expiries richer than later ones (a term structure),
 * around `level` (the underlying's fixed demo IV when not given; the time-varying ivLevel when pricing).
 */
export function smileVol(u, spot, strike, years, level = u.iv) {
  const x = Math.log(strike / spot) / Math.sqrt(Math.max(years, MIN_SMILE_YEARS));
  const base = level * (1 + 0.3 * Math.exp((-years * CAL_DAYS) / 6));
  // Smooth in strike (no per-strike wiggle): adjacent strikes then never form a butterfly arbitrage.
  return base * (1 + 1.2 * x * x + (x < 0 ? u.putWing ?? 0.8 : 0.1) * Math.abs(x));
}
/** The smile's shape constants (in calendar days, as the smile was tuned): a one-day floor on √T and the term decay. */
const CAL_DAYS = 365;
const MIN_SMILE_YEARS = 1 / CAL_DAYS;

/**
 * Demo option price at `t`: Black-76 on F = S·e^(r·Tcal), discounted by e^(−r·Tcal), with σ√T on the vol-time clock
 * (dashboard/pricing.js) and σ from the smile at the day's IV level. The pricing engine therefore recovers the demo
 * smile vol (up to tick rounding). After the settlement the price is intrinsic (never below one tick).
 */
export function optionPrice(symbol, expiry, strike, right, t) {
  const ctx = priceContext(symbol, expiry, t);
  return ctx ? priceWith(ctx, strike, right) : null;
}

/** What every strike of one (underlying, expiry, instant) shares: spot, clock, discount, IV level. */
function priceContext(symbol, expiry, t) {
  const u = BY_SYMBOL.get(symbol);
  const spot = spotAt(symbol, t);
  if (!u?.deriv || spot === null) return null;
  const { T, Tcal } = clockTo(u.deriv, expiry, t);
  const df = Math.exp(-RATE * Tcal);
  return { u, spot, T, df, F: spot / df, level: ivLevel(symbol, t) };
}

function priceWith(ctx, strike, right) {
  const vol = smileVol(ctx.u, ctx.spot, strike, ctx.T, ctx.level);
  const p = ctx.df * black76(ctx.F, strike, ctx.T, vol * 100, right);
  return fix(Math.max(0.05, p), 0.05);
}

function futurePrice(symbol, expiry, t) {
  const u = BY_SYMBOL.get(symbol);
  const spot = spotAt(symbol, t);
  return fix(spot * Math.exp(RATE * clockTo(u.deriv, expiry, t).Tcal), 0.05);
}

/** The day's base open interest in LOTS (fractional), peaking near the money and at round strikes. */
function baseOiLots(u, spot, strike, right, expiry) {
  const dist = (strike - spot) / (u.step * OI_WIDTH_STEPS);
  const side = right === "CE" ? (strike >= spot ? 1.15 : 0.55) : strike <= spot ? 1.15 : 0.55;
  const round = onGrid(strike, u.step * 10) ? 1.8 : onGrid(strike, u.step * 2) ? 1.2 : 1;
  const scale = 9000 * (u.oiScale ?? 1);
  // Centred on a slow anchor (oiContext), so the far strikes' day change stays in the tens of percent. A heavier tail
  // was tried and dropped: it pushes the recorder's demo day past its 3 KB-per-snapshot budget (store.test.mjs).
  return scale * Math.exp(-dist * dist) * side * round * (0.85 + 0.3 * unit(`${u.symbol}:${expiry}:${strike}:${right}`));
}

/** Whether x sits on a grid of `step` (fractional steps such as 2.5 included). */
const onGrid = (x, step) => Math.abs(x / step - Math.round(x / step)) < 1e-9;

/** Fraction of the demo day elapsed at `t`: the IST calendar day (the demo recorder's "always open" clock). */
const dayFraction = (t) => (((t + IST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / DAY_MS;

/**
 * Open interest in UNITS at `t` (docs/spec/p1-01-recorder.md §8): base × (1 + a·s(t) + 0.03·sin(2π·min/47 + φ)),
 * where base is the day's profile peaking near the money (centred on the spot, so the profile follows the demo's
 * multi-day price waves; "previous OI" is this same function at the previous close), s(t) the fraction of the demo
 * day elapsed, and
 * a ∈ [−0.15, +0.35] per (strike, right, expiry), biased so out-of-the-money calls build while the slow price wave
 * falls and out-of-the-money puts build while it rises. Deterministic (the same instant gives the same OI) and always a
 * whole number of lots. P1-7 (day story) and P1-8 (writer-structured base) multiply into this; rounding happens once.
 */
export function openInterestAt(symbol, strike, right, expiry, t) {
  const ctx = oiContext(symbol, expiry, t);
  return ctx ? oiWith(ctx, strike, right) : null;
}

/** What every strike of one (underlying, expiry, instant) shares for OI. */
function oiContext(symbol, expiry, t) {
  const u = BY_SYMBOL.get(symbol);
  if (!u?.deriv) return null;
  const d = (t + IST_OFFSET_MS) / DAY_MS;
  return {
    u,
    symbol,
    expiry,
    t,
    spot: spotAt(symbol, t),
    // The profile is laid at a slow anchor (the last two closes), not the live spot: open interest does not follow
    // the price within the day, so a far strike's "previous OI" is not a near-empty tail (whose change would read
    // "+26800 %"), and a day's ΔOI stays in the tens of percent, as in a real chain.
    anchor: lagged(spotAt(symbol, t), oiAnchor(symbol, t), u.step * OI_WIDTH_STEPS * 0.5),
    wave: Math.cos((2 * Math.PI * d) / 9.3 + phase(`${symbol}:b`)), // > 0 while the 9.3-day wave rises
    lot: contractLot(u, expiry, t),
    fraction: dayFraction(t),
    minute: Math.floor(t / 60_000),
  };
}

/** The mean spot over the ANCHOR_DAYS closes before `t` (memoised per symbol and day: every strike of a chain shares it). */
const ANCHORS = new Map();
const ANCHOR_DAYS = 2;
/** The OI hump's width in strike steps. */
const OI_WIDTH_STEPS = 7;
/** `slow`, but never more than `max` from `live` (after a big move the profile catches up, near the money stays full). */
const lagged = (live, slow, max) => live + Math.max(-max, Math.min(max, slow - live));
function oiAnchor(symbol, t) {
  let c = previousClose(t);
  const key = `${symbol}|${c}`;
  const hit = ANCHORS.get(key);
  if (hit !== undefined) return hit;
  let sum = 0;
  for (let i = 0; i < ANCHOR_DAYS; i += 1) {
    sum += spotAt(symbol, c);
    c = previousClose(c);
  }
  if (ANCHORS.size > 512) ANCHORS.clear();
  ANCHORS.set(key, sum / ANCHOR_DAYS);
  return sum / ANCHOR_DAYS;
}

function oiWith(ctx, strike, right) {
  const { u, symbol, expiry, spot, wave } = ctx;
  const base = baseOiLots(u, ctx.anchor, strike, right, expiry);
  const otm = right === "CE" ? strike > spot : strike < spot;
  const bias = otm ? (right === "CE" ? -0.12 * wave : 0.12 * wave) : 0;
  const a = Math.min(0.35, Math.max(-0.15, -0.15 + 0.5 * unit(`${symbol}:${expiry}:${strike}:${right}:a`) + bias));
  const wobble = 0.03 * Math.sin((2 * Math.PI * ctx.minute) / 47 + phase(`${symbol}:${strike}:${right}:w`));
  return Math.max(1, Math.round(base * (1 + a * ctx.fraction + wobble))) * ctx.lot;
}

/**
 * OI of a demo option contract at `t` in units (the same figure quotes and chains carry), adjusted -ADJ contracts in
 * their own lot (× 5). Exported for the fno sweep's demo ΔOI baseline (P1-6 §4.2).
 */
export function demoOptionOi(token, t) {
  const p = parseToken(token);
  if (!p || p.kind !== "opt") return null;
  const ctx = oiContext(p.symbol, p.expiry, t);
  if (!ctx) return null;
  return oiWith(p.adjusted ? { ...ctx, lot: ctx.lot * DEMO_ADJ_FACTOR } : ctx, p.strike, p.right);
}

/**
 * Bid and ask sizes in units: whole lots, deterministic per token. The resting size at the touch holds for 15 minutes,
 * then moves, like a quiet order book (and so the recorded minutes compress well).
 */
function depthSizes(token, lot, t) {
  const k = Math.floor((t + 300_000 * unit(`${token}:k`)) / 900_000);
  return { bidQty: (1 + Math.round(40 * unit(`${token}:bq:${k}`))) * lot, askQty: (1 + Math.round(40 * unit(`${token}:aq:${k}`))) * lot };
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
  for (const u of BY_SYMBOL.values()) {
    rows.push({ token: `DM-${u.symbol}`, exchange: u.exchange, tradingSymbol: u.symbol, underlying: u.symbol, instrumentType: u.kind, expiry: null, strike: null, optionType: null, lotSize: 1, tickSize: u.tick, name: u.name });
    if (!u.deriv) continue;
    const stock = u.kind === "EQ";
    // Stock futures on the same 3 monthly expiries as the options (P1-6); index futures on the next 2 monthlies.
    for (const e of stock ? expiriesFor(u.symbol, t) : monthlyExpiries(u, t)) {
      rows.push({ token: `DM-${u.symbol}-${e}-FUT`, exchange: u.deriv, tradingSymbol: `${u.symbol}-${e}-FUT`, underlying: u.symbol, instrumentType: stock ? "FUTSTK" : "FUTIDX", expiry: e, strike: null, optionType: null, lotSize: contractLot(u, e, t), tickSize: 0.05, name: `${u.name} future` });
    }
    const centre = stock ? dayCentre(u, t) : Math.round(spotAt(u.symbol, t) / u.step) * u.step;
    const each = stock ? STOCK_STRIKES_EACH_SIDE : STRIKES_EACH_SIDE * 2;
    for (const e of expiriesFor(u.symbol, t)) {
      const lot = contractLot(u, e, t);
      for (let i = -each; i <= each; i += 1) {
        const k = strikeAt(centre, i, u.step);
        if (k <= 0) continue;
        for (const r of ["CE", "PE"]) {
          rows.push({ token: `DM-${u.symbol}-${e}-${k}-${r}`, exchange: u.deriv, tradingSymbol: `${u.symbol}-${e}-${k}-${r}`, underlying: u.symbol, instrumentType: stock ? "OPTSTK" : "OPTIDX", expiry: e, strike: k, optionType: r, lotSize: lot, tickSize: 0.05, name: `${u.name} ${k} ${r}` });
        }
      }
    }
    if (u.symbol === demoSplitSymbol(istDateOf(t))) rows.push(...adjustedContracts(u, t));
  }
  return rows;
}

/** Strike i steps from `centre` (2 dp: fractional steps such as 2.5 stay exact). */
const strikeAt = (centre, i, step) => Math.round((centre + i * step) * 100) / 100;
/** A stock's strike-grid centre for the IST day of `t` (the spot at 09:15, so a day's listed strikes do not move). */
function dayCentre(u, t) {
  const s = spotAt(u.symbol, istAt(t, 9, 15));
  return Math.round(s / u.step) * u.step;
}

/**
 * The demo split stock's adjusted series (P1-6 §4.1): on the nearest expiry, 3 strikes × CE/PE left from before the
 * split, with lot × 5 and off-grid strikes (the pre-split strike / 5, on a 0.05 tick). Tokens end in "-ADJ".
 */
export function adjustedContracts(u, t) {
  const e = expiriesFor(u.symbol, t)[0];
  if (!e) return [];
  const lot = contractLot(u, e, t) * DEMO_ADJ_FACTOR;
  const centre = dayCentre(u, t);
  const rows = [];
  for (const j of [-1, 0, 1]) {
    const pre = centre * DEMO_ADJ_FACTOR + (j + 0.5) * u.step * DEMO_ADJ_FACTOR + 7;
    const strike = Math.round(Math.round(pre / DEMO_ADJ_FACTOR / 0.05) * 0.05 * 100) / 100;
    for (const r of ["CE", "PE"]) {
      rows.push({ token: `DM-${u.symbol}-${e}-${strike}-${r}-ADJ`, exchange: u.deriv, tradingSymbol: `${u.symbol}-${e}-${strike}-${r}-ADJ`, underlying: u.symbol, instrumentType: "OPTSTK", expiry: e, strike, optionType: r, lotSize: lot, tickSize: 0.05, name: `${u.name} ${strike} ${r} (adjusted)` });
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

/** Parse a demo token: DM-<SYM>[-<expiry>-FUT | -<expiry>-<strike>-<CE|PE>[-ADJ]]. */
export function parseToken(token) {
  const m = /^DM-([A-Z0-9&-]+?)(?:-(\d{4}-\d{2}-\d{2})-(?:(FUT)|(\d+(?:\.\d+)?)-(CE|PE)(-ADJ)?))?$/.exec(String(token));
  if (!m || !BY_SYMBOL.has(m[1])) return null;
  if (!m[2]) return { symbol: m[1], kind: "spot" };
  if (m[3]) return { symbol: m[1], kind: "fut", expiry: m[2] };
  return { symbol: m[1], kind: "opt", expiry: m[2], strike: Number(m[4]), right: m[5], ...(m[6] ? { adjusted: true } : {}) };
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
  const bid = Number(down(Math.min(ltp, ltp - spread / 2)).toFixed(4));
  const ask = Number(Math.max(up(ltp + spread / 2), bid + tick).toFixed(4));
  const perMinute = p.kind === "spot" ? 5200 : p.kind === "fut" ? 30 : 4 + 200 * near;
  // Contract lot (an adjusted contract's own lot); stock derivatives' volume scaled like their OI (P1-6).
  const lot = p.kind === "spot" ? 1 : contractLot(u, p.expiry, t) * (p.adjusted ? DEMO_ADJ_FACTOR : 1);
  const scale = p.kind === "opt" ? u.oiScale ?? 1 : 1;
  const volume = p.kind === "spot" && u.kind === "INDEX" ? 0 : Math.max(p.kind === "spot" ? 0 : 1, Math.round(perMinute * scale * minutes * (0.7 + 0.6 * unit(`${token}:vol`)))) * lot;
  const oi = p.kind === "opt" ? demoOptionOi(token, t) : p.kind === "fut" ? Math.round((u.kind === "EQ" ? 9000 : 120_000) * (0.8 + 0.4 * unit(`${token}:oi`))) * lot : null;
  const sizes = p.kind === "spot" && u.kind === "INDEX" ? { bidQty: null, askQty: null } : depthSizes(token, lot, t);
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
    bidQty: sizes.bidQty,
    askQty: sizes.askQty,
  };
}

/**
 * A light OptionChain-shaped chain at `t` for history seeding (vol/demoVol.mjs, P1-3b): ltp, bid, ask, oi and volume
 * per leg from optionPrice only (no intraday high/low walk), `strikesEachSide` strikes around the spot. About 120 legs
 * in well under a millisecond each. Null for a symbol without options.
 */
export function demoChainAt(symbol, expiry, t, strikesEachSide = STRIKES_EACH_SIDE) {
  const pctx = priceContext(symbol, expiry, t);
  if (!pctx) return null;
  const { u, spot } = pctx;
  const octx = oiContext(symbol, expiry, t);
  const lot = octx.lot;
  const minutes = Math.max(1, Math.min(375, (t - sessionOpen(t)) / 60_000));
  const centre = Math.round(spot / u.step) * u.step;
  const rows = [];
  const each = u.stock ? Math.min(strikesEachSide, STOCK_STRIKES_EACH_SIDE) : strikesEachSide;
  for (let i = -each; i <= each; i += 1) {
    const k = strikeAt(centre, i, u.step);
    if (k <= 0) continue;
    const near = Math.exp(-(((k - spot) / (u.step * 8)) ** 2));
    const leg = (right) => {
      const ltp = priceWith(pctx, k, right);
      const spread = Math.max(0.05 * (1 + Math.round(3 * (1 - near))), ltp * 0.0015);
      const bid = Number(Math.max(0, Math.floor((ltp - spread / 2) / 0.05 + 1e-9) * 0.05).toFixed(2));
      const ask = Number(Math.max(Math.ceil((ltp + spread / 2) / 0.05 - 1e-9) * 0.05, bid + 0.05).toFixed(2));
      const volume = Math.max(1, Math.round((4 + 200 * near) * (u.oiScale ?? 1) * minutes * (0.7 + 0.6 * unit(`${symbol}:${expiry}:${k}:${right}:vol`)))) * lot;
      const sizes = depthSizes(`DM-${symbol}-${expiry}-${k}-${right}`, lot, t);
      return { symbol: `${u.deriv}:${symbol}-${expiry}-${k}-${right}`, ltp, bid, ask, bidQty: sizes.bidQty, askQty: sizes.askQty, oi: oiWith(octx, k, right), volume };
    };
    rows.push({ strike: k, ce: leg("CE"), pe: leg("PE") });
  }
  return { underlying: symbol, expiry, underlyingLtp: spot, atmStrike: centre, lotSize: lot, rows };
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
      // Indices: ±45 around the spot. Stocks: the ±20 strikes listed today (the master grid), so chain = master.
      const centre = u.stock ? dayCentre(u, t) : Math.round(spot / u.step) * u.step;
      const each = u.stock ? STOCK_STRIKES_EACH_SIDE : CHAIN_STRIKES_EACH_SIDE;
      const oc = {};
      const pc = previousClose(t);
      for (let i = -each; i <= each; i += 1) {
        const k = strikeAt(centre, i, u.step);
        if (k <= 0) continue;
        const leg = (r) => {
          const q = quoteOf(`DM-${u.symbol}-${expiry}-${k}-${r}`, u.deriv, t);
          // "Prev close" OI is the same function at the previous close, so recorded windows and the chain agree.
          const prevOi = openInterestAt(u.symbol, k, r, expiry, pc);
          return { last_price: q.ltp, oi: q.oi, previous_oi: prevOi, oi_chg: q.oi - prevOi, volume: q.volume, top_bid_price: q.bid, top_ask_price: q.ask, top_bid_quantity: q.bidQty, top_ask_quantity: q.askQty, previous_close_price: q.close, security_id: `DM-${u.symbol}-${expiry}-${k}-${r}` };
        };
        oc[k.toFixed(6)] = { ce: leg("CE"), pe: leg("PE") };
      }
      // The split stock's adjusted contracts on the nearest expiry (off-grid strikes, lot × 5).
      if (u.stock && u.symbol === demoSplitSymbol(istDateOf(t))) {
        for (const r of adjustedContracts(u, t)) {
          if (r.expiry !== expiry) continue;
          const q = quoteOf(r.token, u.deriv, t);
          const key = r.strike.toFixed(6);
          oc[key] ??= {};
          oc[key][r.optionType.toLowerCase()] = { last_price: q.ltp, oi: q.oi, previous_oi: null, oi_chg: null, volume: q.volume, top_bid_price: q.bid, top_ask_price: q.ask, top_bid_quantity: q.bidQty, top_ask_quantity: q.askQty, previous_close_price: q.close, security_id: r.token };
        }
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
    const tick = p.kind === "spot" ? u.tick : 0.05;
    const wick = Math.abs(close - open) * 0.25 + tick;
    const vol = indexSpot ? 0 : Math.round((800 + 2400 * unit(`${token}:${start}`)) * ((end - start) / 60_000) ** 0.8) * lotMul;
    return {
      time: Math.floor(start / 1000),
      open,
      // Outward onto the symbol's tick and clamped, so high ≥ every sample and low ≤ every sample on any tick grid.
      high: Math.max(...pts, ceilTick(Math.max(...pts) + wick * unit(`${token}:${start}:h`), tick)),
      low: Math.min(...pts, Math.max(tick, floorTick(Math.min(...pts) - wick * unit(`${token}:${start}:l`), tick))),
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
      c.time = Math.floor(istAt(d, 0, 0) / 1000); // daily bars open at IST midnight
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
