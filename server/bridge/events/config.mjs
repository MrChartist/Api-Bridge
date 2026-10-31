/**
 * The `events` config section (stream S28, docs/guides/live-events.md).
 *
 *   "events": {
 *     "enabled": true,
 *     "maxSymbols": 600,          // stocks and indices tracked (F&O futures come on top)
 *     "futures": true,            // track the front future of each F&O stock (OI build-up, OI surge)
 *     "budgetShare": 0.25,        // REST fallback and daily context: at most this share of any broker window (≤ 0.5)
 *     "pollSeconds": 15,          // REST fallback round for symbols with no fresh tick
 *     "staleAfterMs": 20000,      // a symbol with no tick for this long is polled ...
 *     "quietMaxMs": 300000,       // ... unless it is held on a feed that is ticking now (no tick = no trade), up to
 *                                 //     this long since its last tick (0: poll every quiet symbol after staleAfterMs)
 *     "restEverySeconds": 10,     // when the share never fits (a broker with 1 quote call a second), one batched call
 *                                 //     at most this often while nobody is using the broker (0: never)
 *     "chainEveryMs": 1000,       // chain-level option detectors at most this often per chain
 *     "foldMs": 2000,             // same-direction level events within this window fold into one row
 *     "keepDays": 30,             // day files kept
 *     "maxEventsPerDay": 20000,   // records kept in memory for the day (the file keeps all)
 *     "cashList": ["NSE:XYZ"],    // the "CASH" universe: a broader cash list when your broker allows the subscriptions
 *     "demoScale": 1              // demo only: multiplies the simulated cash list (perf runs)
 *   }
 */
import { z } from "zod";

export const EVENTS_CONFIG_SCHEMA = z
  .object({
    enabled: z.boolean().default(true),
    maxSymbols: z.number().int().min(1).max(3000).default(600),
    futures: z.boolean().default(true),
    budgetShare: z.number().min(0).max(0.5).default(0.25),
    pollSeconds: z.number().int().min(5).max(600).default(15),
    staleAfterMs: z.number().int().min(2000).max(600_000).default(20_000),
    quietMaxMs: z.number().int().min(0).max(3_600_000).default(300_000),
    restEverySeconds: z.number().int().min(0).max(600).refine((v) => v === 0 || v >= 5, "0 (off) or at least 5 seconds").default(10),
    chainEveryMs: z.number().int().min(100).max(60_000).default(1000),
    foldMs: z.number().int().min(0).max(60_000).default(2000),
    keepDays: z.number().int().min(1).max(365).default(30),
    maxEventsPerDay: z.number().int().min(100).max(200_000).default(20_000),
    cashList: z.array(z.string().min(3).max(64)).max(3000).default([]),
    demoScale: z.number().int().min(1).max(20).default(1),
  })
  .strict();

export const parseEventsConfig = (raw) => EVENTS_CONFIG_SCHEMA.parse(raw ?? {});
