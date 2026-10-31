/**
 * Config section `symbols` (owned by stream S4). Every field is optional; the defaults are the documented behaviour.
 *
 *   "symbols": {
 *     "refreshAfterIst": "08:30",   // a master fetched before this IST time is fetched again once it has passed
 *     "diskCache": true,            // keep <dataDir>/instruments/<broker>-<day>.json so a restart costs no download
 *     "failureBackoffMs": 60000,    // after a failed download, wait this long before trying that broker again
 *     "warmOnStart": true           // load connected brokers' masters in the background when the Bridge starts
 *   }
 */
import { z } from "zod";

export const SYMBOLS_CONFIG_SCHEMA = z
  .object({
    refreshAfterIst: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM in IST, for example 08:30.")
      .default("08:30"),
    diskCache: z.boolean().default(true),
    failureBackoffMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
    warmOnStart: z.boolean().default(true),
  })
  .strict();

/** Defaults, for callers that build the service without the module (tests, the fake). */
export const SYMBOLS_CONFIG_DEFAULTS = Object.freeze(SYMBOLS_CONFIG_SCHEMA.parse({}));
