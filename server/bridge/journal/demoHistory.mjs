/**
 * Demo mode only: about six weeks of sample journal history for the demo paper account, so the Journal tab, its P&L
 * calendar and its stats show something realistic on first open. Deterministic (a seeded generator): the same
 * history every time for a given day. Every fill is marked `sample: true`; the page labels those trades "Sample".
 *
 * Trades: NIFTY and SENSEX weeklies and BANKNIFTY monthlies; short strangles, iron condors, short straddles, bull call
 * spreads and long straddles; opened in the morning, closed one to four sessions later. About 60 % close in profit.
 */
import { buildTrades } from "../dashboard/journal-core.js";
import { DEMO_INDEX_LOT } from "../reference/demoTables.mjs";

const DAY_MS = 86_400_000;
const IST = 19_800_000;
const UNDERLYINGS = [
  { u: "NIFTY", ex: "NFO", spot: 25_900, step: 50, perLot: DEMO_INDEX_LOT.NIFTY, expiryDow: 2 },
  { u: "BANKNIFTY", ex: "NFO", spot: 57_800, step: 100, perLot: DEMO_INDEX_LOT.BANKNIFTY, expiryDow: 2, monthly: true },
  { u: "SENSEX", ex: "BFO", spot: 84_600, step: 100, perLot: DEMO_INDEX_LOT.SENSEX, expiryDow: 4 },
];
const STRUCTURES = [
  { name: "strangle", legs: [["SELL", "CE", 0.02, 0.0035], ["SELL", "PE", -0.02, 0.004]] },
  { name: "condor", legs: [["BUY", "CE", 0.03, 0.0014], ["BUY", "PE", -0.03, 0.0016], ["SELL", "CE", 0.015, 0.0046], ["SELL", "PE", -0.015, 0.005]] },
  { name: "straddle", legs: [["SELL", "CE", 0, 0.0095], ["SELL", "PE", 0, 0.0098]] },
  { name: "bullcall", legs: [["BUY", "CE", 0, 0.0095], ["SELL", "CE", 0.02, 0.0035]] },
  { name: "longstraddle", legs: [["BUY", "CE", 0, 0.0095], ["BUY", "PE", 0, 0.0098]] },
];
const TAGS = [["weekly"], ["weekly", "range"], ["event"], ["trend"], ["weekly", "adjusted"], ["range"], []];
const SETUPS = ["IV rank above 60", "Range day after expiry", "Breakout above the call wall", "Event IV crush", "Post-gap fade", ""];
const NOTES = ["Took profit at half the credit.", "Held through RBI policy; IV fell as expected.", "Stopped at 2x credit when spot broke the put wall.", "Rolled the tested side once.", "", "Exited before the US CPI print."];

/** A small seeded generator (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const istDay = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
const istDow = (ms) => new Date(ms + IST).getUTCDay();
const atIst = (day, hh, mm) => Date.parse(`${day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+05:30`);
const iso = (ms) => new Date(ms + IST).toISOString().replace("Z", "+05:30");
const r05 = (v) => Math.max(0.05, Math.round(v * 20) / 20);

/** The next weekday on or after `day` with day-of-week `dow` (for BANKNIFTY, the last such day of that month). */
function expiryOn(day, dow, monthly) {
  let ms = Date.parse(`${day}T00:00:00Z`);
  while (new Date(ms).getUTCDay() !== dow) ms += DAY_MS;
  if (!monthly) return new Date(ms).toISOString().slice(0, 10);
  const month = new Date(ms).getUTCMonth();
  while (new Date(ms + 7 * DAY_MS).getUTCMonth() === month) ms += 7 * DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * @param {{ nowMs: number, account: string, weeks?: number }} o
 * @returns {{ account: string, fills: object[], daily: object[], notes: Record<string, object>, madeAt: string }}
 */
export function demoJournalHistory({ nowMs, account, weeks = 6 }) {
  const rand = rng(Math.floor(nowMs / DAY_MS));
  const today = istDay(nowMs);
  // Trading days (Monday to Friday) from `weeks` weeks ago to yesterday.
  const days = [];
  for (let ms = nowMs - weeks * 7 * DAY_MS; istDay(ms) < today; ms += DAY_MS) if (istDow(ms) >= 1 && istDow(ms) <= 5) days.push(istDay(ms));
  const fills = [];
  const closes = new Map(); // day → closed P&L
  const mtm = new Map(); // day → mark-to-market noise of open trades
  const trades = [];
  for (const U of UNDERLYINGS) {
    let i = Math.floor(rand() * 3);
    let spot = U.spot * (0.98 + rand() * 0.04);
    while (i < days.length - 1) {
      const hold = 1 + Math.floor(rand() * 3);
      const j = Math.min(days.length - 1, i + hold);
      const openDay = days[i];
      const closeDay = days[j];
      const S = STRUCTURES[Math.floor(rand() * STRUCTURES.length)];
      const expiry = expiryOn(closeDay, U.expiryDow, U.monthly);
      const win = rand() < 0.6;
      const lots = 1 + (rand() < 0.25 ? 1 : 0);
      const units = lots * U.perLot; // the current demo lot (reference/demoTables.mjs), so sample trades are whole lots
      const seller = S.legs.filter((l) => l[0] === "SELL").length > S.legs.filter((l) => l[0] === "BUY").length;
      const target = (win ? 1 : -1) * (seller ? (win ? 1500 + rand() * 6500 : 2500 + rand() * 9500) : win ? 3000 + rand() * 9000 : 1500 + rand() * 5000) * lots;
      const tOpen = atIst(openDay, 9, 20 + Math.floor(rand() * 35));
      const tClose = atIst(closeDay, 13 + Math.floor(rand() * 2), Math.floor(rand() * 59));
      const legs = S.legs.map(([side, right, off, prem]) => {
        const strike = Math.round((spot * (1 + off)) / U.step) * U.step;
        const entry = r05(spot * prem * (0.85 + rand() * 0.3));
        return { side, right, strike, entry, exit: r05(entry * (win === (side === "SELL") ? 0.45 : 1.6)) };
      });
      // Adjust the first leg so the trade's gross P&L is the target (the others keep their rough exits).
      const pnlOf = () => legs.reduce((a, l) => a + (l.side === "SELL" ? l.entry - l.exit : l.exit - l.entry) * units, 0);
      const first = legs[0];
      const need = target - (pnlOf() - (first.side === "SELL" ? first.entry - first.exit : first.exit - first.entry) * units);
      first.exit = r05(first.side === "SELL" ? first.entry - need / units : first.entry + need / units);
      const sym = (l) => `${U.ex}:${U.u}-${expiry}-${l.strike}-${l.right}`;
      const charge = (px) => Math.round((20 + px * units * 0.0006) * 100) / 100;
      // Buys first on the way in; shorts bought back first on the way out.
      const inOrder = [...legs].sort((a, b) => (a.side === b.side ? 0 : a.side === "BUY" ? -1 : 1));
      inOrder.forEach((l, k) => fills.push({ accountId: account, mode: "paper", sample: true, symbol: sym(l), side: l.side, qty: units, price: l.entry, charges: charge(l.entry), tradedAt: iso(tOpen + k * 4000), tag: "mcbstrat" }));
      const outOrder = [...legs].sort((a, b) => (a.side === b.side ? 0 : a.side === "SELL" ? -1 : 1));
      outOrder.forEach((l, k) => fills.push({ accountId: account, mode: "paper", sample: true, symbol: sym(l), side: l.side === "SELL" ? "BUY" : "SELL", qty: units, price: l.exit, charges: charge(l.exit), tradedAt: iso(tClose + k * 4000), tag: "mcbstrat" }));
      const chargesAll = inOrder.reduce((a, l) => a + charge(l.entry) + charge(l.exit), 0);
      const net = pnlOf() - chargesAll;
      closes.set(closeDay, (closes.get(closeDay) ?? 0) + net);
      // Open days carry mark-to-market swings that unwind on the close day.
      let carried = 0;
      for (let k = i; k < j; k++) {
        const m = (rand() - 0.5) * 3000 * lots;
        mtm.set(days[k], (mtm.get(days[k]) ?? 0) + m);
        carried += m;
      }
      mtm.set(closeDay, (mtm.get(closeDay) ?? 0) - carried);
      trades.push({ openDay, underlying: U.u });
      spot *= 1 + (rand() - 0.5) * 0.02;
      i = j + 1 + Math.floor(rand() * 2);
    }
  }
  // Daily rows: closed P&L plus the swings of what was open, on 25 lakh.
  const daily = [];
  let equity = 2_500_000;
  for (const day of days) {
    const pnl = Math.round(((closes.get(day) ?? 0) + (mtm.get(day) ?? 0)) * 100) / 100;
    if (!pnl && !closes.has(day) && !mtm.has(day)) continue;
    equity += pnl;
    daily.push({ day, at: `${day}T15:30:00.000+05:30`, source: "eod", equity: Math.round(equity * 100) / 100, pnl, sample: true });
  }
  // Tags, setups and notes on most of the sample trades.
  const notes = {};
  buildTrades(fills).forEach((t, k) => {
    const tags = TAGS[k % TAGS.length];
    const setup = SETUPS[k % SETUPS.length];
    const note = NOTES[k % NOTES.length];
    if (tags.length || setup || note) notes[t.id] = { tags, setup, notes: note, updatedAt: new Date(nowMs).toISOString() };
  });
  return { account, fills, daily, notes, madeAt: new Date(nowMs).toISOString() };
}
