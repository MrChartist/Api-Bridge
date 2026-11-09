/**
 * Config section `downloads` (zod, strict). Every field has a safe default, so a Bridge with no `downloads` block
 * works. Documented in docs/guides/downloads.md.
 */
import { z } from "zod";

export const DOWNLOADS_CONFIG_SCHEMA = z
  .object({
    /** Switch the whole feature off: every route answers CAPABILITY_UNSUPPORTED and nothing runs. */
    enabled: z.boolean().default(true),
    /** Jobs that run at the same time. They still share ONE budget share per account (maxBudgetShare). */
    maxConcurrentJobs: z.number().int().min(1).max(4).default(1),
    /** Most symbols in one job (the hard limit is 500). */
    maxSymbolsPerJob: z.number().int().min(1).max(500).default(500),
    /** Delete finished jobs (and their files) older than this many days. null keeps them until you delete them. Datasets are never deleted by retention. */
    retentionDays: z.number().int().min(1).max(3650).nullable().default(null),
    /** Stop writing when the downloads folder reaches this size (MB). */
    maxDiskMb: z.number().int().min(1).max(10_000_000).default(5000),
    /**
     * The share of an account's spare budget (per-second and per-day windows) that downloads may use. Never more than
     * 0.5 and never more than the scheduler says is spare; a live read, an order check or another key always goes first.
     */
    maxBudgetShare: z.number().min(0.01).max(0.5).default(0.3),
    /** Run only outside market hours (NSE session plus pre-open). A job started in market hours waits. */
    afterHoursOnly: z.boolean().default(false),
    /** Serve ranges already stored in a dataset of this Bridge from disk, and fetch only the missing parts. */
    localFirst: z.boolean().default(true),
    /** How many times one broker call is tried again after a temporary error before the item fails. */
    retries: z.number().int().min(0).max(10).default(4),
    /** How often a running job reports download.progress on the event bus (ms). */
    progressThrottleMs: z.number().int().min(100).max(60_000).default(1000),
  })
  .strict();

/** Parse (and default) a raw `downloads` section; services call it so they also work with a partial config in tests. */
export function parseDownloadsConfig(raw) {
  return DOWNLOADS_CONFIG_SCHEMA.parse(raw ?? {});
}
