/**
 * Today's safety counters and runtime-tightened limits, per account and per mode (stream S9), persisted in
 * <dataDir>/safety/counters.json so a restart during the day keeps them.
 *
 * The file holds ONE IST day. The first access after IST midnight starts a new day: counters go back to zero and
 * runtime tightenings are dropped (they are "for today"; permanent changes go in bridge.config.json).
 *
 * Shape: { version: 1, day: "YYYY-MM-DD",
 *          accounts: { [accountId]: { live: Counters, paper: Counters } },
 *          tightened: { global: Partial<Limits>, accounts: { [accountId]: Partial<Limits> } } }
 *   Counters = { orders, modifies, cancels, realisedPnl, refused }
 *
 * A file that cannot be read is reported through `loadedFrom: "corrupt"`; the guard engages the kill switch in
 * that case (it cannot know how many orders were already sent today). The next write replaces it; a copy is kept
 * as counters.json.corrupt for inspection.
 */
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonState, writeJsonState } from "./stateFile.mjs";
import { istDay } from "./time.mjs";

export const COUNTERS_FILE = "counters.json";
export const MODES = Object.freeze(["live", "paper"]);

/** @typedef {{ orders: number, modifies: number, cancels: number, realisedPnl: number, refused: number }} Counters */

const zero = () => ({ orders: 0, modifies: 0, cancels: 0, realisedPnl: 0, refused: 0 });
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function cleanCounters(c) {
  const z = zero();
  if (!c || typeof c !== "object") return z;
  for (const k of Object.keys(z)) z[k] = num(c[k]);
  return z;
}

function cleanLimits(o) {
  const out = {};
  if (!o || typeof o !== "object") return out;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
    else if (k === "marketOrders" && v === "reject") out[k] = v;
  }
  return out;
}

/**
 * @param {{ dir: string, now: () => number, logger?: any }} opts
 */
export function createDailyCounters({ dir, now, logger }) {
  const path = join(dir, COUNTERS_FILE);
  const empty = (day) => ({ version: 1, day, accounts: {}, tightened: { global: {}, accounts: {} } });
  let state = empty(istDay(now()));
  const loaded = readJsonState(path);
  let loadedFrom = loaded.status;
  if (loaded.status === "ok") {
    const v = loaded.value;
    if (typeof v.day === "string") {
      state = empty(v.day);
      for (const [id, modes] of Object.entries(v.accounts ?? {})) state.accounts[id] = { live: cleanCounters(modes?.live), paper: cleanCounters(modes?.paper) };
      state.tightened.global = cleanLimits(v.tightened?.global);
      for (const [id, lim] of Object.entries(v.tightened?.accounts ?? {})) state.tightened.accounts[id] = cleanLimits(lim);
    } else {
      loadedFrom = "corrupt";
    }
  }
  if (loadedFrom === "corrupt") {
    logger?.error("safety counters file unreadable", { path });
    try {
      copyFileSync(path, `${path}.corrupt`);
    } catch {
      // best effort
    }
  }

  const save = () => {
    try {
      writeJsonState(path, state);
      return true;
    } catch (err) {
      logger?.error("safety counters could not be saved", { code: err?.code });
      return false;
    }
  };

  /** Start a new IST day when the date has changed. Returns true when it rolled. */
  const roll = () => {
    const today = istDay(now());
    if (state.day === today) return false;
    // Never roll backwards (a clock that jumps back must not hand out a fresh day's budget).
    if (today < state.day) return false;
    state = empty(today);
    save();
    return true;
  };

  const entry = (accountId) => {
    roll();
    if (!state.accounts[accountId]) state.accounts[accountId] = { live: zero(), paper: zero() };
    return state.accounts[accountId];
  };

  return {
    path,
    /** "missing" | "ok" | "corrupt" — how the file looked at start. */
    loadedFrom,
    /** IST day the counters belong to. */
    day() {
      roll();
      return state.day;
    },
    /**
     * @param {string} accountId
     * @param {"live"|"paper"} mode
     * @returns {Counters} a copy
     */
    get(accountId, mode) {
      roll();
      const e = state.accounts[accountId];
      return e ? { ...e[mode] } : zero();
    },
    /**
     * Record an order action. realisedPnl is the P&L this event realised (negative = loss), added to today's total.
     * @param {string} accountId
     * @param {"live"|"paper"} mode
     * @param {{ action: "place"|"modify"|"cancel"|"refused", realisedPnl?: number }} ev
     * @returns {{ before: Counters, after: Counters, persisted: boolean }}
     */
    record(accountId, mode, { action, realisedPnl }) {
      const e = entry(accountId)[mode];
      const before = { ...e };
      if (action === "place") e.orders += 1;
      else if (action === "modify") e.modifies += 1;
      else if (action === "cancel") e.cancels += 1;
      else if (action === "refused") e.refused += 1;
      if (typeof realisedPnl === "number" && Number.isFinite(realisedPnl)) e.realisedPnl = Math.round((e.realisedPnl + realisedPnl) * 100) / 100;
      const persisted = save();
      return { before, after: { ...e }, persisted };
    },
    /** Runtime-tightened limits for today: { global, account }. */
    tightened(accountId) {
      roll();
      return { global: { ...state.tightened.global }, account: { ...(state.tightened.accounts[accountId] ?? {}) } };
    },
    /**
     * Store tightened values (the caller has already checked they are tighter).
     * @param {string | null} accountId  null = every account
     * @param {object} values
     */
    setTightened(accountId, values) {
      roll();
      if (accountId === null) state.tightened.global = { ...state.tightened.global, ...values };
      else state.tightened.accounts[accountId] = { ...(state.tightened.accounts[accountId] ?? {}), ...values };
      return save();
    },
    /** Account ids with counters today. */
    accountIds() {
      roll();
      return Object.keys(state.accounts);
    },
  };
}
