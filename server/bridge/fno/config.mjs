/**
 * The `fno` config section (stream S19, docs/spec/p1-06-stocks.md §2.5). All optional; zod strict, so unknown keys are
 * errors as for every module.
 *
 *   "fno": {
 *     "universe": { "indices": null, "exchanges": ["NFO"], "maxStocks": 400 },
 *     "sweep": { "budgetShare": 0.5, "accountId": "auto", "maxMinutes": 10, "method": "auto",
 *                "indexExpiries": 2, "indexMonthly": true, "indexStrikes": 30,
 *                "stockExpiries": 1, "nextExpiryWithinDays": 7, "stockStrikes": 15,
 *                "hv": { "source": "auto", "candles": 40 }, "minIntervalSeconds": 120, "leaseSeconds": 180,
 *                "resumeWithinMinutes": 30, "keepJobs": 2 },
 *     "expiry": { "warnFromTradingDays": 4, "closeToMoneyStrikes": 1 },
 *     "ban": { "blockOpening": true },
 *     "retentionDays": 5,
 *     "demo": { "callDelayMs": 250 }
 *   }
 *
 * budgetShare is a ceiling of 0.5 (BRD §7.2: background work never takes more than half of any window).
 * ban.blockOpening false turns FNO_BAN into a warning; it is logged at boot and audited on every order.
 */
import { z } from "zod";

const UNDERLYING = z.string().regex(/^[A-Z0-9&-]{1,30}$/, "an underlying such as NIFTY or RELIANCE");

export const FNO_CONFIG_SCHEMA = z
  .object({
    universe: z
      .object({
        indices: z.array(UNDERLYING).max(20).nullable().default(null),
        exchanges: z.array(z.enum(["NFO"])).min(1).default(["NFO"]),
        maxStocks: z.number().int().min(1).max(1000).default(400),
      })
      .strict()
      .prefault({}),
    sweep: z
      .object({
        budgetShare: z.number().min(0.1).max(0.5).default(0.5),
        accountId: z.string().min(1).max(64).default("auto"),
        maxMinutes: z.number().min(1).max(60).default(10),
        method: z.enum(["auto", "chain", "quotes"]).default("auto"),
        indexExpiries: z.number().int().min(1).max(4).default(2),
        indexMonthly: z.boolean().default(true),
        indexStrikes: z.number().int().min(10).max(60).default(30),
        stockExpiries: z.number().int().min(1).max(2).default(1),
        nextExpiryWithinDays: z.number().int().min(0).max(31).default(7),
        stockStrikes: z.number().int().min(5).max(30).default(15),
        hv: z
          .object({ source: z.enum(["auto", "broker", "backup", "off"]).default("auto"), candles: z.number().int().min(21).max(120).default(40) })
          .strict()
          .prefault({}),
        minIntervalSeconds: z.number().int().min(60).max(86_400).default(120),
        leaseSeconds: z.number().int().min(30).max(3600).default(180),
        resumeWithinMinutes: z.number().int().min(1).max(240).default(30),
        keepJobs: z.number().int().min(1).max(10).default(2),
      })
      .strict()
      .prefault({}),
    expiry: z
      .object({
        warnFromTradingDays: z.number().int().min(1).max(10).default(4),
        closeToMoneyStrikes: z.number().int().min(0).max(5).default(1),
      })
      .strict()
      .prefault({}),
    ban: z.object({ blockOpening: z.boolean().default(true) }).strict().prefault({}),
    retentionDays: z.number().int().min(1).max(30).default(5),
    demo: z.object({ callDelayMs: z.number().int().min(0).max(5000).default(250) }).strict().prefault({}),
  })
  .strict();

/** The parsed (defaulted) section. */
export const parseFnoConfig = (raw) => FNO_CONFIG_SCHEMA.parse(raw ?? {});

/** The section from a config object: already parsed by the module loader, or parsed here (tests). */
export function fnoConfigOf(config) {
  const c = config?.fno;
  return c && c.sweep && c.universe && c.expiry ? c : parseFnoConfig(c);
}
