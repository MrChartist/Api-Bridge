/**
 * The `recorder` config section (stream S17, docs/spec/p1-01-recorder.md §3.5). Every key is optional; `{}` gives the
 * defaults (index chains recorded by default; opt out with `"recorder": { "enabled": false }`). Unknown keys are
 * errors. Holidays and session times are NOT recorder config: they come from the `reference` section (P1-2).
 *
 *   "recorder": {
 *     "enabled": true, "account": null,
 *     "indices": ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"], "indexExpiries": 3, "indexStrikes": 40,
 *     "stocks": [], "stockExpiries": 1, "stockStrikes": 15, "stockEveryMinutes": 5,
 *     "sources": { "stream": true, "rest": true, "nseBackup": false },
 *     "budgetShare": 0.5, "streamShare": 0.6, "strikeBuffer": 2, "allowSingleTokenRest": false,
 *     "retentionDays": 365, "maxDiskMb": 10240, "recordSpecialSessions": true, "dailyAt": "15:31",
 *     "slotOffsetMs": 2000, "restSpreadMs": 40000,
 *     "demo": { "alwaysOpen": true, "backfillDays": 2 }
 *   }
 */
import { z } from "zod";

const underlying = z.string().regex(/^[A-Z0-9&-]{1,30}$/, "use an exchange symbol such as NIFTY");

export const DEFAULT_INDICES = Object.freeze(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"]);
/** Background work never gets more than half of any REST window (BRD §7.2). */
export const MAX_BUDGET_SHARE = 0.5;

const unique = (list) => new Set(list).size === list.length;

export const RECORDER_CONFIG_SCHEMA = z
  .object({
    enabled: z.boolean().default(true),
    /** null = "auto": the first connected account that serves option chains (config order). One account only. */
    account: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i, "use an account id from the accounts list").nullable().default(null),
    /** Order = priority when capacity runs out. */
    indices: z.array(underlying).max(12).refine(unique, "list each index once").default([...DEFAULT_INDICES]),
    indexExpiries: z.number().int().min(1).max(4).default(3),
    indexStrikes: z.number().int().min(1).max(60).default(40),
    stocks: z.array(underlying).max(200).refine(unique, "list each stock once").default([]),
    stockExpiries: z.number().int().min(1).max(2).default(1),
    stockStrikes: z.number().int().min(1).max(30).default(15),
    stockEveryMinutes: z.union([z.literal(5), z.literal(10), z.literal(15)]).default(5),
    sources: z
      .object({ stream: z.boolean().default(true), rest: z.boolean().default(true), nseBackup: z.boolean().default(false) })
      .strict()
      .prefault({}),
    budgetShare: z.number().min(0.05).max(MAX_BUDGET_SHARE).default(0.5),
    streamShare: z.number().min(0.1).max(0.9).default(0.6),
    strikeBuffer: z.number().int().min(0).max(10).default(2),
    allowSingleTokenRest: z.boolean().default(false),
    retentionDays: z.number().int().min(7).max(3650).default(365),
    maxDiskMb: z.number().int().min(100).default(10240),
    recordSpecialSessions: z.boolean().default(true),
    dailyAt: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM (IST)")
      .default("15:31"),
    slotOffsetMs: z.number().int().min(0).max(30_000).default(2000),
    restSpreadMs: z.number().int().min(0).max(55_000).default(40_000),
    demo: z
      .object({ alwaysOpen: z.boolean().default(true), backfillDays: z.number().int().min(0).max(5).default(2) })
      .strict()
      .prefault({}),
  })
  .strict();

/** Parse (and default) a raw `recorder` section. Throws a zod error on bad input. */
export function parseRecorderConfig(raw) {
  return RECORDER_CONFIG_SCHEMA.parse(raw ?? {});
}

/** The recorder settings from the whole Bridge config (already parsed by core), or the defaults. */
export function recorderSettings(config) {
  const raw = config?.recorder;
  const parsed = RECORDER_CONFIG_SCHEMA.safeParse(raw ?? {});
  return parsed.success ? parsed.data : RECORDER_CONFIG_SCHEMA.parse({});
}
