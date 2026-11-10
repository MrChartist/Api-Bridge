/**
 * The `recorder` config section. All optional; zod `.strict()`. Recordings and auto-record rules made through the API
 * or the dashboard live in the data folder (recordings/), not here: this section holds limits and switches, plus an
 * optional list of rules for people who keep their setup in the config file.
 *
 *   "recorder": {
 *     "enabled": true,
 *     "maxRecordings": 10,            // running + paused + waiting recordings at one time (rules count too)
 *     "maxDiskMb": 5000,              // all recordings together; writing stops at the limit, never beyond
 *     "retentionDays": null,          // delete day files older than this many days (null = keep everything)
 *     "compressFinished": false,      // gzip day files of finished days (.csv.gz / .jsonl.gz)
 *     "minFreeDiskMb": 500,           // stop writing when the disk has less than this free
 *     "maxBudgetShare": 0.3,          // share of an account's spare API budget a recording may use (0.05 to 0.8; the default, changed live by PATCH /v1/recordings/settings)
 *     "maxSymbolsPerRecording": 1000,
 *     "maxStreamSymbols": 400,        // how many symbols one recording asks the live feed for
 *     "gapAfterSec": null,            // silence longer than this inside a session is a gap (null = 3 x everySec, at least 30)
 *     "reResolveMinutes": 30,         // re-resolve a moving universe (ATM window) this often inside the session; 0 = once a day
 *     "autoRecord": { "enabled": false, "rules": [] }
 *   }
 *
 * Auto-record is off until a person turns it on (dashboard, `mc-bridge record auto on` or PUT /v1/recordings/auto).
 */
import { z } from "zod";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const hhmm = z.string().regex(HHMM, 'a time as HH:MM (IST, 24-hour)');
export const DAYS = Object.freeze(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export const FORMATS = Object.freeze(["csv", "jsonl"]);
export const KINDS = Object.freeze(["quotes", "chain"]);
/** The range of the background budget share (also the range of PATCH /v1/recordings/settings). */
export const SHARE_MIN = 0.05;
export const SHARE_MAX = 0.8;

const symbolList = z.array(z.string().trim().min(3).max(80)).min(1).max(2000);
const name = z.string().trim().min(1).max(60);

/** Option-universe rule (the same words the library of collections uses). */
export const universeSchema = z
  .object({
    expiries: z.union([z.enum(["current-weekly", "next-weekly", "current-monthly", "all-weekly"]), z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(12)]).default("current-weekly"),
    strikes: z
      .union([
        z.object({ around: z.literal("atm").default("atm"), count: z.number().int().min(0).max(100).default(10) }).strict(),
        z.object({ from: z.number().positive(), to: z.number().positive() }).strict(),
      ])
      .default({ around: "atm", count: 10 }),
    sides: z.array(z.enum(["CE", "PE"])).min(1).max(2).default(["CE", "PE"]),
    includeUnderlying: z.boolean().default(true),
    includeFuture: z.boolean().default(false),
  })
  .strict();

export const scheduleSchema = z.union([
  z.literal("market-hours"),
  z
    .object({ days: z.array(z.enum(DAYS)).min(1).max(7).default(["mon", "tue", "wed", "thu", "fri"]), start: hhmm, end: hhmm })
    .strict()
    .refine((s) => s.start < s.end, { message: "start must be earlier than end (IST, same day)" }),
]);

/** The fields a rule and a manual recording share. */
const targetFields = {
  symbols: symbolList.optional(),
  collection: z.string().trim().min(1).max(80).optional(),
  underlying: z.union([z.string().trim().min(1).max(30), z.array(z.string().trim().min(1).max(30)).min(1).max(10)]).optional(),
  universe: universeSchema.optional(),
};

/** Exactly one way to say what to record, and the minimum interval for the kind. */
export function checkTarget(v, ctx) {
  const ways = [v.symbols, v.collection, v.underlying].filter((x) => x !== undefined).length;
  if (ways !== 1) ctx.addIssue({ code: "custom", message: "give exactly one of symbols, collection or underlying" });
  if (v.universe && v.underlying === undefined) ctx.addIssue({ code: "custom", path: ["universe"], message: "universe goes with underlying" });
  if (v.kind === "chain" && v.everySec !== undefined && v.everySec < 15) ctx.addIssue({ code: "custom", path: ["everySec"], message: "a chain snapshot needs at least 15 seconds between snapshots" });
}

export const ruleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).optional(),
    name,
    enabled: z.boolean().default(true),
    kind: z.enum(KINDS),
    ...targetFields,
    everySec: z.number().int().min(1).max(86_400),
    schedule: scheduleSchema.default("market-hours"),
    keepDays: z.number().int().min(1).max(3650).nullable().optional(),
    maxDiskMb: z.number().int().min(1).max(1_000_000).nullable().optional(),
    compress: z.boolean().optional(),
    format: z.enum(FORMATS).default("csv"),
  })
  .strict()
  .superRefine(checkTarget);

export const RECORDER_CONFIG_SCHEMA = z
  .object({
    enabled: z.boolean().default(true),
    maxRecordings: z.number().int().min(1).max(200).default(10),
    maxDiskMb: z.number().int().min(10).max(10_000_000).default(5000),
    retentionDays: z.number().int().min(1).max(3650).nullable().default(null),
    compressFinished: z.boolean().default(false),
    minFreeDiskMb: z.number().int().min(0).max(1_000_000).default(500),
    maxBudgetShare: z.number().min(SHARE_MIN).max(SHARE_MAX).default(0.3),
    maxSymbolsPerRecording: z.number().int().min(1).max(5000).default(1000),
    maxStreamSymbols: z.number().int().min(0).max(5000).default(400),
    gapAfterSec: z.number().int().min(5).max(3600).nullable().default(null),
    reResolveMinutes: z.number().int().min(0).max(480).default(30),
    autoRecord: z
      .object({
        enabled: z.boolean().default(false),
        rules: z.array(ruleSchema).max(50).default([]),
      })
      .strict()
      .prefault({}),
  })
  .strict();

/** The parsed `recorder` section from a (possibly unparsed) config. */
export function recorderConfig(config) {
  const raw = config?.recorder;
  return raw && typeof raw === "object" && "maxRecordings" in raw && "autoRecord" in raw ? raw : RECORDER_CONFIG_SCHEMA.parse(raw ?? {});
}

/** Body of POST /v1/recordings. */
export const createSchema = z
  .object({
    name: name.optional(),
    kind: z.enum(KINDS),
    ...targetFields,
    expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    strikes: z.number().int().min(0).max(100).optional(),
    everySec: z.number().int().min(1).max(86_400),
    sessionOnly: z.boolean().default(true),
    format: z.enum(FORMATS).default("csv"),
    keepDays: z.number().int().min(1).max(3650).nullable().optional(),
    maxDiskMb: z.number().int().min(1).max(1_000_000).nullable().optional(),
    compress: z.boolean().optional(),
    /** Only "realtime" is accepted: a recording never mixes delayed or end-of-day data into its files. */
    dataClass: z.string().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    checkTarget(v, ctx);
    if (v.kind === "quotes" && v.underlying !== undefined && !v.universe && !v.expiry) ctx.addIssue({ code: "custom", path: ["underlying"], message: "quotes of an underlying need an expiry or a universe" });
    if (v.expiry !== undefined && v.underlying === undefined) ctx.addIssue({ code: "custom", path: ["expiry"], message: "expiry goes with underlying" });
  });

/** Body of PATCH /v1/recordings/rules/{id}: any rule field except the id. */
export const rulePatchSchema = z
  .object({
    name: name.optional(),
    enabled: z.boolean().optional(),
    kind: z.enum(KINDS).optional(),
    ...targetFields,
    everySec: z.number().int().min(1).max(86_400).optional(),
    schedule: scheduleSchema.optional(),
    keepDays: z.number().int().min(1).max(3650).nullable().optional(),
    maxDiskMb: z.number().int().min(1).max(1_000_000).nullable().optional(),
    compress: z.boolean().optional(),
    format: z.enum(FORMATS).optional(),
  })
  .strict();
