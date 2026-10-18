/**
 * The `ratelimit` config section — stream S3 (owned by the ratelimit module; validated by core with this schema).
 *
 *   "ratelimit": {
 *     "client":  { "perSecond": 50, "burst": 50, "keys": { "<keyId>": { "perSecond": 5 } } },
 *     "brokers": { "zerodha": { "limits": { "quote": { "perSecond": 1 } }, "groups": { ... }, "maxQuoteBatch": 200 } },
 *     "accounts": { "zerodha-main": { "limits": { "history": { "perMinute": 60 } } } },
 *     "queue":   { "maxQueuedPerAccount": 5000, "ageingMs": 2000,
 *                  "maxWaitMs": { "order": 5000, "live": 15000, "interactive": 10000, "background": 300000 } },
 *     "maxInFlightPerAccount": 8,
 *     "windowPaddingMs": 100,
 *     "backoff": { "initialMs": 1000, "maxMs": 60000 }
 *   }
 *
 * `brokers` and `accounts` overrides may only LOWER limits. A broker override above the policy table is a config
 * error (so a typo cannot quietly do nothing); account overrides are clamped at runtime because the account's broker
 * is in another section. Everything is optional; `{}` gives the safe defaults.
 */
import { z } from "zod";
import { ENDPOINT_CLASSES } from "../core/contracts.mjs";
import { overrideProblems } from "./policy.mjs";

export const DEFAULT_CLIENT_PER_SECOND = 50;

const positive = z.number().finite().positive();

/** Windows a user may set. Same names as LimitSpec. */
export const windowsSchema = z
  .object({
    perSecond: positive.max(1000).optional(),
    perMinute: positive.max(60_000).optional(),
    perDay: positive.max(10_000_000).optional(),
    extraWindows: z
      .array(z.object({ windowMs: z.number().int().min(1000).max(86_400_000), limit: positive }).strict())
      .max(4)
      .optional(),
  })
  .strict();

const endpointClass = z.enum(ENDPOINT_CLASSES);

const overrideSchema = z
  .object({
    limits: z.partialRecord(endpointClass, windowsSchema).optional(),
    groups: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,31}$/), windowsSchema).optional(),
    maxQuoteBatch: z.number().int().positive().max(10_000).optional(),
  })
  .strict();

const clientSchema = z
  .object({
    /** Requests per second each API key may make to the Bridge. */
    perSecond: positive.max(10_000).default(DEFAULT_CLIENT_PER_SECOND),
    /** Bucket size (short bursts). Defaults to perSecond. */
    burst: z.number().int().positive().max(100_000).optional(),
    /** Per-key budgets by key id (the 10-character id in mcb_<keyId>_...). */
    keys: z
      .record(z.string().regex(/^[a-z0-9]{4,32}$/), z.object({ perSecond: positive.max(10_000), burst: z.number().int().positive().max(100_000).optional() }).strict())
      .default({}),
  })
  .strict();

const PRIORITY_WAIT_DEFAULTS = Object.freeze({ order: 5_000, live: 15_000, interactive: 10_000, background: 300_000 });

const waitMs = (d) => z.number().int().min(0).max(3_600_000).default(d);

export const ratelimitConfigSchema = z
  .object({
    client: clientSchema.prefault({}),
    brokers: z.record(z.string().regex(/^[a-z0-9]{2,20}$/), overrideSchema).default({}),
    accounts: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/), overrideSchema).default({}),
    queue: z
      .object({
        /** Requests waiting per account, all classes together; more are refused with UPSTREAM_RATE_LIMITED. */
        maxQueuedPerAccount: z.number().int().positive().max(100_000).default(5_000),
        /** Every ageingMs a waiting non-order request moves up one priority level (never above "live"). */
        ageingMs: z.number().int().positive().max(600_000).default(2_000),
        /** How long a request may wait for budget before it is refused (callers may pass a shorter maxWaitMs). */
        maxWaitMs: z
          .object({
            order: waitMs(PRIORITY_WAIT_DEFAULTS.order),
            live: waitMs(PRIORITY_WAIT_DEFAULTS.live),
            interactive: waitMs(PRIORITY_WAIT_DEFAULTS.interactive),
            background: waitMs(PRIORITY_WAIT_DEFAULTS.background),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    /** Concurrent non-order broker calls per account. Orders are never held back by this. */
    maxInFlightPerAccount: z.number().int().positive().max(64).default(8),
    /** Extra width added to every sliding window to absorb network jitter (ms). */
    windowPaddingMs: z.number().int().min(0).max(1000).default(100),
    backoff: z
      .object({
        initialMs: z.number().int().min(100).max(60_000).default(1_000),
        maxMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    for (const [brokerId, ov] of Object.entries(cfg.brokers ?? {})) {
      for (const p of overrideProblems(brokerId, ov)) ctx.addIssue({ code: "custom", path: ["brokers", brokerId, ...p.path], message: p.message });
    }
  });

/**
 * Parse a raw `ratelimit` section (or undefined) into the defaulted config. Throws a ZodError when invalid.
 * @param {unknown} raw
 */
export function parseRatelimitConfig(raw) {
  return ratelimitConfigSchema.parse(raw ?? {});
}
