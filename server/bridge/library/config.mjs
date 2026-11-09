/**
 * The `library` config section (the library module). Everything is optional; zod `.strict()`; `{}` gives the defaults.
 *
 *   "library": {
 *     "enabled": true,
 *     "maxCollections": 200,          // how many collections the store holds
 *     "maxSymbols": 5000,             // most symbols one collection may hold or resolve to
 *     "maxWeeklyExpiries": 5,         // what "all-weekly" stops at (the run of weekly expiries counted from the nearest)
 *     "allowStaleAtm": false,         // true: a resolve may use a stale, delayed or end-of-day price when the caller allows it by default
 *     "strikeSteps": { "NIFTY": 50 }  // used only when no listed strikes are known: the step of a generated strike grid
 *   }
 *
 * `strikeSteps` has the usual steps of the index underlyings. A stock's step is never guessed: it depends on the price and
 * changes with corporate actions, so a stock universe always uses the strikes the instrument master lists.
 */
import { z } from "zod";

/** Usual strike step of each index underlying (used only for a generated grid, flagged in the answer). */
export const DEFAULT_STRIKE_STEPS = Object.freeze({ NIFTY: 50, BANKNIFTY: 100, FINNIFTY: 50, MIDCPNIFTY: 25, NIFTYNXT50: 100, SENSEX: 100, BANKEX: 100, SENSEX50: 50 });

export const LIBRARY_CONFIG_SCHEMA = z
  .object({
    enabled: z.boolean().default(true),
    maxCollections: z.number().int().min(1).max(5000).default(200),
    maxSymbols: z.number().int().min(1).max(50_000).default(5000),
    maxWeeklyExpiries: z.number().int().min(1).max(12).default(5),
    allowStaleAtm: z.boolean().default(false),
    strikeSteps: z.record(z.string().regex(/^[A-Z0-9][A-Z0-9&_-]{0,29}$/, "an underlying such as NIFTY"), z.number().positive().max(100_000)).default({}),
  })
  .strict();

/** @param {unknown} [raw] */
export function parseLibraryConfig(raw) {
  const c = LIBRARY_CONFIG_SCHEMA.parse(raw ?? {});
  return { ...c, strikeSteps: { ...DEFAULT_STRIKE_STEPS, ...c.strikeSteps } };
}
