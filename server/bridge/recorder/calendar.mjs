/**
 * Recorder slot calendar (stream S17, docs/spec/p1-01-recorder.md §3.2, §6.1, §6.13). Pure.
 *
 * Trading days and session times are NOT decided here: they come from the reference service (P1-2,
 * `reference.session()` / `reference.calendar()`), which knows holidays and special sessions. This file only turns a
 * day's window into minute slots and keeps the "holiday suspected" detector, the safety net for a holiday the shipped
 * list missed.
 *
 * A slot is the epoch ms of the start of an IST minute. Index chains are due every slot of the session; stock chains
 * every `stockEveryMinutes` from the session start (09:15, 09:20 … 15:25). A full NSE day is 375 index slots
 * (09:15–15:29) and 75 stock slots at 5 minutes.
 *
 * Demo "always open" (§8): every day is a trading day; 1-minute slots 09:15–15:30 IST and 5-minute slots outside it, so
 * the recorder visibly works at any hour.
 */
import { isStub } from "../core/contracts.mjs";
import { defaultSessionFor } from "../reference/defaults.mjs";

export const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * MINUTE_MS;
const HM_RE = /^(\d{2}):(\d{2})$/;
/** Demo cadence outside the 09:15–15:30 window. */
export const DEMO_OUTSIDE_EVERY = 5;

const hm = (s) => {
  const m = HM_RE.exec(String(s ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
/** IST date (YYYY-MM-DD) of an instant. */
export const istDateOf = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
/** Epoch ms of IST midnight of `date`. */
export const istMidnight = (date) => Date.parse(`${date}T00:00:00Z`) - IST_OFFSET_MS;
/** IST minute of the day (0–1439) of an instant. */
export const istMinuteOf = (ms) => Math.floor(((ms + IST_OFFSET_MS) % DAY_MS) / MINUTE_MS);
/** The slot (start of the IST minute) an instant falls in. */
export const slotFloor = (ms) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;
/** "HH:MM" of a minute of the day. */
export const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/**
 * One day's recording plan.
 * @param {{ date: string, open: string, close: string, alwaysOpen?: boolean }} p  open/close "HH:MM" IST
 * @returns {{ date: string, open: string, close: string, openMin: number, closeMin: number, alwaysOpen: boolean,
 *   startMs: number, endMs: number }}
 */
export function dayPlan({ date, open, close, alwaysOpen = false }) {
  const openMin = hm(open);
  const closeMin = hm(close);
  if (openMin === null || closeMin === null || !(closeMin > openMin)) throw new RangeError(`Bad session window ${open}–${close}`);
  const mid = istMidnight(date);
  return {
    date,
    open,
    close,
    openMin,
    closeMin,
    alwaysOpen: Boolean(alwaysOpen),
    // In always-open mode the day runs from midnight to midnight; the session window only sets the 1-minute cadence.
    startMs: alwaysOpen ? mid : mid + openMin * MINUTE_MS,
    endMs: alwaysOpen ? mid + DAY_MS : mid + closeMin * MINUTE_MS,
  };
}

/**
 * Whether a chain of `kind` is due at `slot`.
 * @param {ReturnType<typeof dayPlan>} plan
 * @param {number} slot  epoch ms at a minute start
 * @param {"index"|"stock"} kind
 * @param {number} [stockEvery]  5, 10 or 15
 */
export function isDue(plan, slot, kind, stockEvery = 5) {
  if (slot < plan.startMs || slot >= plan.endMs || slot % MINUTE_MS !== 0) return false;
  const m = istMinuteOf(slot);
  const inSession = m >= plan.openMin && m < plan.closeMin;
  if (!inSession) {
    // Only reachable in always-open mode: a slower cadence outside the session window.
    const every = kind === "stock" ? Math.max(DEMO_OUTSIDE_EVERY, stockEvery) : DEMO_OUTSIDE_EVERY;
    return m % every === 0;
  }
  if (kind === "stock") return (m - plan.openMin) % stockEvery === 0;
  return true;
}

/**
 * The minutes one due slot stands for: its cadence at that time (1 for an index in the session, the stock cadence for
 * a stock, 5 or more outside the session in the demo's always-open mode). Coverage counts minutes with this, so a
 * 5-minute chain's 2 slots read as 10 minutes.
 */
export function cadenceAt(plan, slot, kind, stockEvery = 5) {
  const m = istMinuteOf(slot);
  const inSession = m >= plan.openMin && m < plan.closeMin;
  if (!inSession) return kind === "stock" ? Math.max(DEMO_OUTSIDE_EVERY, stockEvery) : DEMO_OUTSIDE_EVERY;
  return kind === "stock" ? stockEvery : 1;
}

/** Minutes of the due slots from `fromSlot` up to `t` (both inclusive, by slot), by each slot's cadence. */
export function expectedMinutesBetween(plan, fromSlot, t, kind, stockEvery = 5) {
  let n = 0;
  const last = Math.min(slotFloor(t), plan.endMs - MINUTE_MS);
  for (let s = Math.max(plan.startMs, fromSlot); s <= last; s += MINUTE_MS) if (isDue(plan, s, kind, stockEvery)) n += cadenceAt(plan, s, kind, stockEvery);
  return n;
}

/**
 * Every due slot of the day for a kind, in order.
 * @returns {number[]}
 */
export function slotsOfDay(plan, kind, stockEvery = 5) {
  const out = [];
  for (let s = plan.startMs; s < plan.endMs; s += MINUTE_MS) if (isDue(plan, s, kind, stockEvery)) out.push(s);
  return out;
}

/** Due slots at or before `t` (§6.1 expected slots by time t). At 10:15:30 IST on a normal day: 61 index slots. */
export function expectedSlotsBy(plan, t, kind, stockEvery = 5) {
  let n = 0;
  const last = Math.min(slotFloor(t), plan.endMs - MINUTE_MS);
  for (let s = plan.startMs; s <= last; s += MINUTE_MS) if (isDue(plan, s, kind, stockEvery)) n += 1;
  return n;
}

/** The first slot strictly after `t` at which anything (an index chain) is due, or null after the day ends. */
export function nextSlotAfter(plan, t) {
  for (let s = Math.max(plan.startMs, slotFloor(t) + MINUTE_MS); s < plan.endMs; s += MINUTE_MS) if (isDue(plan, s, "index")) return s;
  return null;
}

/** The index minute number since the session start (§6.1 slotOf), null outside the session. */
export function slotIndex(plan, t) {
  const m = istMinuteOf(t);
  if (istDateOf(t) !== plan.date || m < plan.openMin || m >= plan.closeMin) return null;
  return m - plan.openMin;
}

const usable = (svc) => Boolean(svc) && !isStub(svc);

/**
 * Today's recording window from the reference service (§3.2, M2).
 *  - demo always-open: every day, 09:15–15:30 cadence window, the rest at 5 minutes;
 *  - a special session with times (Muhurat): its own window, when `recordSpecialSessions` is on;
 *  - a holiday or weekend: not a trading day (no plan);
 *  - otherwise the reference session window.
 * Without a usable reference the weekday rule and the default window apply, labelled "weekdays only".
 * @param {{ reference?: object, exchange?: string, t: number, recordSpecialSessions?: boolean, alwaysOpen?: boolean }} p
 * @returns {{ date: string, tradingDay: boolean, plan: ReturnType<typeof dayPlan> | null, reason: string | null,
 *   special: object | null, holiday: object | null, calendarSource: string }}
 */
export function resolveDay({ reference, exchange = "NFO", t, recordSpecialSessions = true, alwaysOpen = false }) {
  const date = istDateOf(t);
  const fallback = defaultSessionFor(exchange) ?? defaultSessionFor("NFO");
  if (alwaysOpen) {
    return { date, tradingDay: true, plan: dayPlan({ date, open: fallback.open, close: fallback.close, alwaysOpen: true }), reason: null, special: null, holiday: null, calendarSource: "demo-always-open" };
  }
  if (!usable(reference)) {
    const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
    const trading = wd !== 0 && wd !== 6;
    return { date, tradingDay: trading, plan: trading ? dayPlan({ date, open: fallback.open, close: fallback.close }) : null, reason: trading ? null : "weekend", special: null, holiday: null, calendarSource: "weekdays only (reference data not loaded)" };
  }
  let s;
  try {
    s = reference.session(exchange, t);
  } catch {
    s = null;
  }
  if (!s) return resolveDay({ exchange, t, recordSpecialSessions, alwaysOpen });
  const special = s.special && s.special.open && s.special.close ? s.special : null;
  if (special) {
    if (!recordSpecialSessions) return { date, tradingDay: false, plan: null, reason: "special-session-off", special, holiday: s.holiday ?? null, calendarSource: "reference" };
    return { date, tradingDay: true, plan: dayPlan({ date, open: special.open, close: special.close }), reason: null, special, holiday: s.holiday ?? null, calendarSource: "reference" };
  }
  if (!s.tradingDay) return { date, tradingDay: false, plan: null, reason: s.holiday ? "holiday" : "weekend", special: null, holiday: s.holiday ?? null, calendarSource: "reference" };
  return { date, tradingDay: true, plan: dayPlan({ date, open: s.open ?? fallback.open, close: s.close ?? fallback.close }), reason: null, special: null, holiday: null, calendarSource: "reference" };
}

/** Number of identical first snapshots the detector needs (09:15 … 09:20). */
export const HOLIDAY_DETECT_SLOTS = 6;

/**
 * Holiday detector (§6.13): after the 6th slot of a weekday, a day is suspected to be an unlisted holiday when, for
 * EVERY recorded index chain, the spot is identical across the first 6 snapshots AND the chain's total volume is 0 or
 * equal to the previous trading day's final total. Missing data never suspects a holiday.
 * @param {Array<{ spots: Array<number|null>, volume: number|null, prevVolume?: number|null }>} chains
 * @returns {boolean}
 */
export function holidaySuspected(chains) {
  if (!Array.isArray(chains) || chains.length === 0) return false;
  return chains.every((c) => {
    const spots = (c?.spots ?? []).slice(0, HOLIDAY_DETECT_SLOTS);
    if (spots.length < HOLIDAY_DETECT_SLOTS || spots.some((v) => !(typeof v === "number" && Number.isFinite(v)))) return false;
    if (!spots.every((v) => v === spots[0])) return false;
    const vol = c.volume;
    if (vol === 0) return true;
    return typeof vol === "number" && typeof c.prevVolume === "number" && vol === c.prevVolume;
  });
}
