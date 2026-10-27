/**
 * The `scanner` config section (stream S13).
 *
 *   "scanner": {
 *     "maxSymbols": 1000,            // largest universe one scan may cover
 *     "maxRunning": 2,               // scans running at once (others queue)
 *     "keepJobs": 50,                // finished scans kept in memory for GET /v1/scanner/jobs
 *     "perAccountConcurrency": 4,    // candle requests in flight per account (the rate-limit engine still paces them)
 *     "schedule": true,              // run saved scans that have everyMinutes
 *     "universes": { "MYWATCH": ["NSE:RELIANCE", "NSE:TCS"] }
 *   }
 */
import { z } from "zod";

const symbol = z.string().min(3).max(64);

export const SCANNER_CONFIG_SCHEMA = z
  .object({
    maxSymbols: z.number().int().min(1).max(5000).default(1000),
    maxRunning: z.number().int().min(1).max(10).default(2),
    keepJobs: z.number().int().min(1).max(500).default(50),
    perAccountConcurrency: z.number().int().min(1).max(20).default(4),
    schedule: z.boolean().default(true),
    universes: z
      .record(z.string().regex(/^[A-Z0-9_]{2,32}$/, "universe names are 2-32 capital letters, digits or _"), z.array(symbol).min(1).max(5000))
      .default({}),
  })
  .strict();

export const parseScannerConfig = (raw) => SCANNER_CONFIG_SCHEMA.parse(raw ?? {});
