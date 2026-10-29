/**
 * Deterministic demo reference datasets (stream S16, docs/spec/p1-02-reference.md §4). Demo mode never touches the
 * network: the reference service installs these instead of the store-backed datasets. Every value has
 * source "demo", quality "demo" and verified true, and is fixed for a given IST date (hash32 seeded by date + symbol),
 * so screenshots repeat:
 *
 *  - lots: NIFTY 65, BANKNIFTY 30 (35 after the next monthly expiry: the rolling revision), SENSEX 20, stocks from
 *    DEMO_STOCK_LOT; masters (the demo adapter) use the same table, so they agree;
 *  - universe: the three indices and the NIFTY 50 demo stocks, two stocks added 20 and 45 days ago, DEMOEXIT removed
 *    30 days ago, knownSince = today − 120 days;
 *  - ban list and MWPL: 2–3 stocks in ban (95.2–99.0 %), 3 "high" (80–95 %), the rest 15–79 %, rotating daily;
 *  - corporate actions: a rolling 1:1 bonus 4 trading days ahead (so a banner is always there), a past split
 *    (FV 10 -> 2) 60 days ago, and one inferred non-standard contract (lot 1,875 vs 375) on the split stock.
 * The rate is not a demo dataset: demo mode shows the same "6.50 % default, not sourced" as a fresh install
 * (docs/spec/README.md step 1 acceptance), and the demo adapter prices with it.
 */
import { DEMO_UNDERLYINGS, expiriesFor, hash32, spotAt } from "../demo/demoAdapter.mjs";
import { addDays, calendarDaysBetween, istDateOf } from "./calendar.mjs";
import { DEMO_STOCK_LOT, demoCalendar, demoLotFor } from "./demoTables.mjs";

export { DEMO_INDEX_LOT, DEMO_STOCK_LOT, demoLotFor } from "./demoTables.mjs";

export const DEMO_SOURCE = "demo";
/** Demo-only symbol that left the universe 30 days ago (never listed in the demo masters). */
export const DEMO_EXIT_SYMBOL = "DEMOEXIT";
/** Split-stock candidates whose standard demo lot is 375 (the §4 inferred example: 1,875 vs 375). */
const SPLIT_CANDIDATES = Object.freeze(["BHARTIARTL", "BAJAJFINSV"]);

const unit = (s) => hash32(s) / 4294967296;
const round1 = (x) => Math.round(x * 10) / 10;

/** Demo stocks in a fixed order. */
export const DEMO_STOCKS = Object.freeze(Object.keys(DEMO_STOCK_LOT).sort());
/** Demo index underlyings with derivatives: symbol -> exchange. */
export const DEMO_INDEX_EXCHANGE = Object.freeze(Object.fromEntries(DEMO_UNDERLYINGS.filter((u) => u.deriv && u.kind === "INDEX").map((u) => [u.symbol, u.deriv])));

const weekStartOf = (date) => {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((wd + 6) % 7));
};

/** The trading day on or after `date`. */
const onOrAfter = (cal, date) => (cal.isTradingDay(date) ? date : cal.nextTradingDay(date));

const memo = new Map();

/**
 * Every demo dataset for the IST date of `tMs` (memoised per date).
 * @param {number} tMs
 */
export function demoDatasets(tMs) {
  const today = istDateOf(tMs);
  if (memo.has(today)) return memo.get(today);
  const cal = demoCalendar();
  const knownSince = addDays(today, -120);
  const asOfIso = `${today}T08:20:00.000+05:30`;

  // ── lots (history rows in the lots.json shape) ──
  const lots = [];
  const months = [];
  for (let i = -3; i <= 3; i += 1) {
    const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + i);
    months.push(d.toISOString().slice(0, 7));
  }
  const nextMonthly = {};
  for (const [sym, exch] of Object.entries(DEMO_INDEX_EXCHANGE)) {
    const mon = expiriesFor(sym, tMs).filter((e, i, all) => i === all.length - 1 || all[i + 1].slice(0, 7) !== e.slice(0, 7));
    nextMonthly[sym] = mon[0] ?? null;
    for (const m of months) lots.push({ exchange: exch, underlying: sym, kind: "index", expiryMonth: m, lot: demoLotFor(sym, `${m}-28`, nextMonthly[sym]), firstSeen: knownSince, lastSeen: today, source: DEMO_SOURCE });
  }
  for (const sym of DEMO_STOCKS) {
    for (const m of months.slice(3, 6)) lots.push({ exchange: "NFO", underlying: sym, kind: "stock", expiryMonth: m, lot: DEMO_STOCK_LOT[sym], firstSeen: knownSince, lastSeen: today, source: DEMO_SOURCE });
  }

  // ── universe ──
  const byHash = (salt) => [...DEMO_STOCKS].sort((a, b) => hash32(`${salt}:${a}`) - hash32(`${salt}:${b}`));
  const added = byHash("demo-added").slice(0, 2);
  const addedOn = [onOrAfter(cal, addDays(today, -20)), onOrAfter(cal, addDays(today, -45))];
  const removedOn = onOrAfter(cal, addDays(today, -30));
  const intervals = [
    ...Object.entries(DEMO_INDEX_EXCHANGE).map(([s, e]) => ({ symbol: s, kind: "index", exchange: e, from: knownSince, to: null, fromIsFirstFetch: true })),
    ...DEMO_STOCKS.map((s) => {
      const i = added.indexOf(s);
      return i >= 0 ? { symbol: s, kind: "stock", exchange: "NFO", from: addedOn[i], to: null, fromIsFirstFetch: false } : { symbol: s, kind: "stock", exchange: "NFO", from: knownSince, to: null, fromIsFirstFetch: true };
    }),
    { symbol: DEMO_EXIT_SYMBOL, kind: "stock", exchange: "NFO", from: knownSince, to: cal.prevTradingDay(removedOn), fromIsFirstFetch: true },
  ];
  const universe = { version: 1, knownSince, intervals };

  // ── ban list and MWPL (for the trading day on or after today) ──
  const forDate = onOrAfter(cal, today);
  const order = byHash(`ban:${forDate}`);
  const nBan = 2 + (hash32(`bancount:${forDate}`) % 2);
  const mwpl = order.map((s, i) => {
    const u = unit(`mwpl:${forDate}:${s}`);
    const pct = i < nBan ? 95.2 + 3.8 * u : i < nBan + 3 ? 80 + 14.9 * u : 15 + 64 * u;
    const limit = DEMO_STOCK_LOT[s] * 200_000;
    const oi = Math.round((limit * round1(pct)) / 100);
    return { symbol: s, mwpl: limit, oi, limitNextDay: i < nBan ? null : Math.max(0, Math.round(limit * 0.95) - oi), mwplPct: round1(pct), band: i < nBan ? "ban" : pct >= 80 ? "high" : "normal" };
  });
  const ban = { forDate, symbols: order.slice(0, nBan).sort() };

  // ── corporate actions ──
  const bonusSym = DEMO_STOCKS[hash32(weekStartOf(today)) % DEMO_STOCKS.length];
  let ex = today;
  for (let i = 0; i < 4; i += 1) ex = cal.nextTradingDay(ex);
  // Keep it inside the 7-day banner window even across a holiday week.
  while (calendarDaysBetween(today, ex) > 7) ex = cal.prevTradingDay(ex);
  const splitSym = SPLIT_CANDIDATES.find((s) => s !== bonusSym);
  const splitEx = onOrAfter(cal, addDays(today, -60));
  const actions = [
    { id: `ca_${bonusSym}_${ex}_bonus`, symbol: bonusSym, exchange: "NSE", type: "bonus", ratio: { new: 1, held: 1 }, exDate: ex, subscriptionPrice: null, cumPrice: null, dividend: null, fv: null, factor: 2, lotRule: "round", strikeTick: 0.05, source: DEMO_SOURCE, verified: true, origin: "shipped", quality: "demo" },
    { id: `ca_${splitSym}_${splitEx}_split`, symbol: splitSym, exchange: "NSE", type: "split", ratio: null, exDate: splitEx, subscriptionPrice: null, cumPrice: null, dividend: null, fv: { from: 10, to: 2 }, factor: 5, lotRule: "round", strikeTick: 0.05, source: DEMO_SOURCE, verified: true, origin: "shipped", quality: "demo" },
  ];
  const inferredExpiry = nextMonthly.BANKNIFTY ?? addDays(today, 28);
  const inferred = [
    {
      id: `inf_${splitSym}_${inferredExpiry}`,
      symbol: splitSym,
      exchange: "NSE",
      type: "other",
      ratio: null,
      exDate: null,
      factor: null,
      source: DEMO_SOURCE,
      verified: false,
      origin: "inferred",
      quality: "inferred",
      nonStandard: true,
      text: "Probably adjusted for a corporate action",
      contract: { canonical: `NFO:${splitSym}-${inferredExpiry}-FUT`, expiry: inferredExpiry, strike: null, lot: DEMO_STOCK_LOT[splitSym] * 5, standardLot: DEMO_STOCK_LOT[splitSym], lotMismatch: true, offGrid: false },
    },
  ];

  const out = Object.freeze({ today, knownSince, asOfIso, lots, universe, ban, mwpl: { forDate, rows: mwpl }, actions, inferred, nextMonthly });
  memo.set(today, out);
  if (memo.size > 8) memo.delete(memo.keys().next().value);
  return out;
}

/** A demo reference price for example strikes (the demo spot), or null. */
export function demoPrice(symbol, tMs) {
  return spotAt(symbol, tMs);
}
