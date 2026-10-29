/**
 * Synthetic back-fill for DEMO MODE ONLY (stream S17, docs/spec/p1-01-recorder.md §8). Runs once per IST day when the
 * demo recorder starts, so the OI windows (5m … 1h, since open), the daily rows and the Data recorder page have data
 * within seconds instead of after a day of recording:
 *
 *  1. today's slots from the day start up to the current minute for the NEAREST expiry of each planned index (NIFTY
 *     first), at the demo clock's cadence (1 minute 09:15–15:30 IST, 5 minutes outside);
 *  2. the previous `backfillDays` weekdays at 5-minute slots (09:15 … 15:25) for every planned chain;
 *  3. the rest of today's planned chains are left to the live loop.
 *
 * Every value comes from the demo adapter's pure functions at the slot time (demoChainAt / quoteOf), so a back-filled
 * minute equals what the live demo would have shown then. It stops early when the recorder stops. Records are `source: "backfill"`, `quality:
 * "demo-backfill"`. The work is chunked with setImmediate so the event loop never stalls; it never runs outside demo
 * mode and never touches the real recorder folder (the store it is given is the demo one).
 */
import { DEMO_UNDERLYINGS, demoChainAt, quoteOf } from "../demo/demoAdapter.mjs";
import { dayPlan, isDue, istMidnight, slotFloor, MINUTE_MS } from "./calendar.mjs";
import { buildSnapshot } from "./snapshot.mjs";

const DAY_MS = 86_400_000;
const CHUNK = 8;
const turn = () => new Promise((r) => setImmediate(r));
const BY_SYMBOL = new Map(DEMO_UNDERLYINGS.map((u) => [u.symbol, u]));

/** The n previous weekdays before `date` (YYYY-MM-DD), newest first. */
export function previousWeekdays(date, n) {
  const out = [];
  let t = Date.parse(`${date}T00:00:00Z`);
  while (out.length < n) {
    t -= DAY_MS;
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Calendar days from the n-th previous weekday to `date` (the demo keeps today and n previous weekdays). */
export function demoKeepDays(date, n) {
  const oldest = previousWeekdays(date, n).at(-1) ?? date;
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${oldest}T00:00:00Z`)) / DAY_MS);
}

/** One back-filled snapshot of a demo chain at `slot`. */
export function demoSnapshotAt(c, slot, { clock, rate }) {
  const ch = demoChainAt(c.underlying, c.expiry, slot, c.strikesEachSide);
  if (!ch) return null;
  const rows = ch.rows.map((r) => ({ strike: r.strike, ce: r.ce ? { ...r.ce, at: slot } : null, pe: r.pe ? { ...r.pe, at: slot } : null }));
  return buildSnapshot(
    { u: c.underlying, x: c.expiry, ex: c.exchange, slot, ts: slot, source: "backfill", accountId: "demo", broker: "demo", accounts: null, quality: "demo-backfill", oiUnitVerified: true, lot: ch.lotSize, spot: ch.underlyingLtp, rows, plannedLegs: 2 * (2 * c.strikesEachSide + 1) },
    { clock, rate },
  );
}

/** The underlying line (spot and futures) of a demo underlying at `slot`. */
export function demoUndAt(c, slot) {
  const u = BY_SYMBOL.get(c.underlying);
  if (!u) return null;
  const spot = quoteOf(`DM-${c.underlying}`, u.exchange, slot)?.ltp ?? null;
  const fut = (c.futures ?? [])
    .map((x) => {
      const q = quoteOf(`DM-${c.underlying}-${x}-FUT`, u.deriv, slot);
      return q ? { x, ltp: q.ltp, bid: q.bid, ask: q.ask, oi: q.oi, vol: q.volume } : null;
    })
    .filter(Boolean);
  return { v: 1, kind: "und", u: c.underlying, slot, spot, fut };
}

/**
 * @param {{ store: object, chains: object[], day: { date: string, plan: object }, now: number, backfillDays: number,
 *   state: object, clockFor: (c: object) => object, logger?: any, writeMany: (recs: object[]) => Promise<number>,
 *   onDone?: (date: string) => void, stopped?: () => boolean }} p
 *   writeMany: writes one chain's records of one day in a single append and returns how many were written.
 * @returns {Promise<{ snapshots: number }>}
 */
export async function runDemoBackfill({ store, chains, day, now, backfillDays, state, clockFor, logger, writeMany, onDone, stopped = () => false }) {
  if (state?.demoBackfilledFor === day.date) return { snapshots: 0 };
  let n = 0;
  /** Build one chain's snapshots for the given slots (yielding every few) and write them in one append. */
  const fill = async (c, slots) => {
    const ctx = clockFor(c);
    const rate = ctx.rate?.value ?? 0;
    const recs = [];
    for (const slot of slots) {
      if (stopped()) return;
      const s = demoSnapshotAt(c, slot, { clock: ctx, rate });
      if (s) recs.push(s);
      if (recs.length % CHUNK === 0) await turn();
    }
    n += await writeMany(recs);
  };
  const current = slotFloor(now);
  const nearest = new Map();
  for (const c of chains) {
    if (c.kind !== "index") continue;
    const prev = nearest.get(c.underlying);
    if (!prev || c.expiry < prev.expiry) nearest.set(c.underlying, c);
  }
  const ordered = [...nearest.values()].sort((a, b) => (a.underlying === "NIFTY" ? -1 : b.underlying === "NIFTY" ? 1 : 0));

  // 1. Today, nearest expiry of each index, up to the minute before now (NIFTY first).
  for (const c of ordered) {
    const slots = [];
    for (let s = day.plan.startMs; s < current; s += MINUTE_MS) if (isDue(day.plan, s, "index")) slots.push(s);
    await fill(c, slots);
    if (stopped()) return { snapshots: n };
    const und = demoUndAt(c, current - MINUTE_MS);
    if (und) await store.appendUnd(und);
  }

  // 2. Previous weekdays at 5-minute slots for every planned chain whose expiry was listed then.
  for (const date of previousWeekdays(day.date, backfillDays)) {
    const plan = dayPlan({ date, open: "09:15", close: "15:30" });
    for (const c of chains) {
      if (c.expiry < date) continue;
      const slots = [];
      for (let s = plan.startMs; s < plan.endMs; s += 5 * MINUTE_MS) slots.push(s);
      await fill(c, slots);
      if (stopped()) return { snapshots: n };
      const und = demoUndAt(c, plan.endMs - 5 * MINUTE_MS);
      if (und) await store.appendUnd(und);
    }
  }
  onDone?.(day.date);
  logger?.info?.("demo back-fill written", { snapshots: n, date: day.date, since: new Date(istMidnight(day.date)).toISOString() });
  return { snapshots: n };
}
