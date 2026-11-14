/**
 * A guard for "delete what is older than N days": a computer clock that jumps forward (a dead clock battery, a resumed
 * virtual machine, a wrong time zone fix) makes every file look old, and one pass of retention would wipe the history.
 *
 * The guard keeps a small marker file with the last time the Bridge saw its own clock. When the Bridge starts and the clock
 * is more than a day away from that marker (forward or back), or the computer reports `system.clock_changed`, deletion is
 * held for `holdMs` (6 hours by default). A clock that was wrong comes back (or an NTP sync fixes it) well within that; a
 * computer that was really switched off for a week simply deletes a few hours later than it would have.
 *
 * Only deletion by age asks the guard. Nothing here deletes anything.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../../lib/jsonl.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * @param {{ file: string, now: () => number, bus?: { on: (topic: string, fn: Function) => () => void }, holdMs?: number, jumpMs?: number, log?: any }} o
 */
export function createRetentionGuard({ file, now, bus, holdMs = 6 * HOUR, jumpMs = DAY, log }) {
  let holdUntil = 0;
  let lastTouch = 0;
  let marker = null;
  try {
    const n = Number(JSON.parse(readFileSync(file, "utf8")).seenAt);
    if (Number.isFinite(n)) marker = n;
  } catch {
    /* no marker yet: a first start has nothing to compare with */
  }
  const t0 = now();
  if (marker !== null && Math.abs(t0 - marker) > jumpMs) {
    holdUntil = t0 + holdMs;
    log?.warn?.("the computer's clock is more than a day away from when the Bridge last ran: deleting old data by age is on hold for a few hours", { holdHours: holdMs / HOUR });
  }
  const off = bus?.on?.("system.clock_changed", () => {
    holdUntil = Math.max(holdUntil, now() + holdMs);
  });

  return {
    /** Whether deleting by age may run now. */
    allowed: () => now() >= holdUntil,
    /** Remember "the clock said this" (at most once a minute). Call it from a periodic job. */
    touch() {
      const t = now();
      if (t - lastTouch < 60_000 && lastTouch !== 0) return;
      lastTouch = t;
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileAtomic(file, JSON.stringify({ seenAt: t }));
      } catch {
        /* the marker is a safety net, never a reason to fail */
      }
    },
    close: () => off?.(),
  };
}
