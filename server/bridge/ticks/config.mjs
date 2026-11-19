/**
 * The `ticks` config section (the ticks module). All optional; zod `.strict()`. Off until `record` is true.
 *
 *   "ticks": {
 *     "record": false,              write every live tick to <dataDir>/ticks/<YYYY-MM-DD>.ticks.jsonl
 *     "symbols": null,              null: every symbol the live feed carries; or a list the module also subscribes itself
 *     "maxBufferedTicks": 5000,     ticks held in memory at most before a write (bounded memory)
 *     "flushEveryMs": 250,          write at least this often
 *     "keepDays": null,             delete day files older than this many days (today included); null keeps them
 *     "depthLevels": 0,             order-book levels per side to keep with each tick (0: none)
 *     "compressFinished": false,    gzip each finished day
 *     "maxDiskMb": null,            all tick log days together at most this; past it ticks are given up, counted
 *     "minFreeDiskMb": 500          keep at least this much free on the disk, the same way
 *   }
 */
import { z } from "zod";

export const TICKS_CONFIG_SCHEMA = z
  .object({
    record: z.boolean().default(false),
    symbols: z.array(z.string().min(3).max(80)).max(2000).nullable().default(null),
    maxBufferedTicks: z.number().int().min(100).max(1_000_000).default(5000),
    flushEveryMs: z.number().int().min(10).max(10_000).default(250),
    keepDays: z.number().int().min(1).max(3650).nullable().default(null),
    depthLevels: z.number().int().min(0).max(20).default(0),
    compressFinished: z.boolean().default(false),
    maxDiskMb: z.number().int().min(10).max(10_000_000).nullable().default(null),
    minFreeDiskMb: z.number().int().min(0).max(1_000_000).default(500),
  })
  .strict();

/** The section with defaults filled in. */
export const ticksSettings = (config) => {
  const r = TICKS_CONFIG_SCHEMA.safeParse(config?.ticks ?? {});
  return r.success ? r.data : TICKS_CONFIG_SCHEMA.parse({});
};
