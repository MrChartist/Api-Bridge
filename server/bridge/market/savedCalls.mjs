/**
 * Calls saved today: broker calls this Bridge did not have to make because the data was already on disk (a dataset, a
 * recording) or was shared. One small counter per IST day, kept in memory (it starts again at 0 after a restart; the
 * data files themselves are what persists).
 *
 *   import { record, snapshot } from "../market/savedCalls.mjs";
 *   record(12, "dataset-incremental");   // 12 history calls a full download would have made
 *   snapshot()                           // { day: "2026-11-09", total: 12, byReason: { "dataset-incremental": 12 } }
 *
 * The counts the scheduler keeps (stream, cache, coalesced, batched) stay in its own report; GET /v1/limits?explain=1
 * shows both side by side (ratelimit/routes.mjs).
 */
import { istDate } from "./time.mjs";

/** Reasons are short labels, never anything private. */
const REASON_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * @param {{ now?: () => number }} [opts]
 */
export function createSavedCalls({ now = () => Date.now() } = {}) {
  let day = istDate(now());
  /** @type {Map<string, number>} */
  let byReason = new Map();
  const roll = () => {
    const d = istDate(now());
    if (d !== day) {
      day = d;
      byReason = new Map();
    }
  };
  return {
    /**
     * Count `n` avoided broker calls. Ignores anything that is not a positive whole number.
     * @param {number} n
     * @param {string} reason a short label such as "local-dataset"
     */
    record(n, reason = "other") {
      const c = Math.floor(Number(n));
      if (!Number.isFinite(c) || c < 1) return;
      roll();
      const r = REASON_RE.test(String(reason)) ? String(reason) : "other";
      byReason.set(r, (byReason.get(r) ?? 0) + c);
    },
    /** @returns {{ day: string, total: number, byReason: Record<string, number> }} */
    snapshot() {
      roll();
      let total = 0;
      for (const v of byReason.values()) total += v;
      return { day, total, byReason: Object.fromEntries([...byReason].sort(([a], [b]) => a.localeCompare(b))) };
    },
    /** Tests only. */
    reset() {
      byReason = new Map();
      day = istDate(now());
    },
  };
}

/** The counter every module shares. */
const shared = createSavedCalls();
export const record = (n, reason) => shared.record(n, reason);
export const snapshot = () => shared.snapshot();
export const resetSavedCalls = () => shared.reset();
