/**
 * Demo lot sizes and the demo calendar (stream S16, docs/spec/p1-02-reference.md §4). A leaf module: it imports only
 * pure reference files, so the demo adapter (demo/demoAdapter.mjs) and the demo reference provider
 * (reference/demoReference.mjs, which re-exports DEMO_STOCK_LOT) can both use it without an import cycle. Masters and
 * reference therefore always agree in demo mode.
 */
import { createCalendar } from "./calendar.mjs";
import { shippedHolidayRows, shippedSpecialSessions } from "./shipped.mjs";

/** Current demo index lots (after the Jan 2026 revision). */
export const DEMO_INDEX_LOT = Object.freeze({ NIFTY: 65, BANKNIFTY: 30, SENSEX: 20, FINNIFTY: 60, MIDCPNIFTY: 120 });

/**
 * The rolling demo lot revision: BANKNIFTY moves 30 -> 35 for contracts in the months after the next monthly expiry,
 * so the "lot changes" banner shows in the 7 days before each monthly expiry.
 */
export const DEMO_REVISION = Object.freeze({ underlying: "BANKNIFTY", from: 30, to: 35 });

/** Demo stock lot: round(₹7.5 lakh / base price) to a multiple of 25, at least 25. */
export const demoStockLotFormula = (base) => Math.max(25, Math.round(750000 / base / 25) * 25);

/**
 * THE demo stock lot table (units per lot) for the NIFTY 50 demo stocks: P1-1 (five demo stock underlyings) and P1-6
 * (all 50) import it into the demo adapter. demoReference.test.mjs checks it against demoStockLotFormula and the demo
 * base prices.
 */
export const DEMO_STOCK_LOT = Object.freeze({
  RELIANCE: 525,
  HDFCBANK: 750,
  ICICIBANK: 550,
  INFY: 500,
  TCS: 250,
  SBIN: 850,
  ADANIENT: 300,
  ADANIPORTS: 525,
  APOLLOHOSP: 100,
  ASIANPAINT: 325,
  AXISBANK: 650,
  "BAJAJ-AUTO": 75,
  BAJAJFINSV: 375,
  BAJFINANCE: 750,
  BEL: 1850,
  BHARTIARTL: 375,
  CIPLA: 500,
  COALINDIA: 1925,
  DRREDDY: 600,
  EICHERMOT: 100,
  ETERNAL: 2350,
  GRASIM: 275,
  HCLTECH: 500,
  HDFCLIFE: 975,
  HINDALCO: 1000,
  HINDUNILVR: 300,
  INDIGO: 125,
  ITC: 1850,
  JIOFIN: 2450,
  JSWSTEEL: 650,
  KOTAKBANK: 350,
  LT: 200,
  "M&M": 225,
  MARUTI: 50,
  MAXHEALTH: 650,
  NESTLEIND: 600,
  NTPC: 2200,
  ONGC: 3100,
  POWERGRID: 2600,
  SBILIFE: 400,
  SHRIRAMFIN: 1125,
  SUNPHARMA: 450,
  TATACONSUM: 675,
  TATASTEEL: 4475,
  TECHM: 500,
  TITAN: 200,
  TMPV: 1850,
  TRENT: 150,
  ULTRACEMCO: 50,
  WIPRO: 3050,
});

/**
 * Lot of a demo contract.
 * @param {string} symbol  underlying
 * @param {string} expiry  YYYY-MM-DD
 * @param {string | null} nextMonthlyExpiry  the underlying's next monthly expiry (on or after today)
 * @returns {number | null}
 */
export function demoLotFor(symbol, expiry, nextMonthlyExpiry) {
  if (symbol === DEMO_REVISION.underlying && nextMonthlyExpiry && expiry && expiry.slice(0, 7) > nextMonthlyExpiry.slice(0, 7)) return DEMO_REVISION.to;
  return DEMO_INDEX_LOT[symbol] ?? DEMO_STOCK_LOT[symbol] ?? null;
}

/** Demo special session on the shipped Muhurat date, with demo times. */
export function demoSpecialSessions() {
  return Object.fromEntries(Object.entries(shippedSpecialSessions()).map(([d, s]) => [d, { ...s, open: "18:00", close: "19:00", label: `${s.label} (demo times)`, verified: true, origin: "demo" }]));
}

/**
 * Shipped holidays, treated as verified in demo mode only, except the last holiday of each year (Christmas in the
 * shipped list): it stays unverified so the demo shows the "unverified" label, the calendar's unverified mark and the
 * order check's warning (not a block) for an unverified holiday.
 */
export function demoHolidayRows() {
  const rows = shippedHolidayRows();
  const lastOfYear = new Set(Object.values(Object.groupBy(rows, (h) => h.date.slice(0, 4))).map((ys) => ys.map((h) => h.date).sort().at(-1)));
  return rows.map((h) => ({ ...h, verified: !lastOfYear.has(h.date) }));
}

let cached = null;
/** The demo calendar: shipped holidays (verified in demo), the demo Muhurat session, default session times. */
export function demoCalendar() {
  cached ??= createCalendar({ holidays: demoHolidayRows(), specialSessions: demoSpecialSessions() });
  return cached;
}
