/**
 * The `vol` config section (the vol module). Every key is optional; `{}` gives the
 * defaults. The clock weights are stated assumptions (not measured) and every method note prints them.
 *
 *   "vol": {
 *     "clock": { "mode": "weighted", "nonTradingDayWeight": 0.15, "overnightShare": 0.20, "eventDays": {},
 *                "settlementWindowMinutes": { "index": 30, "stock": 30 }, "yearBasis": null },
 *     "account": null,
 *     "underlyings": ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"],
 *     "stocks": [], "maxStocks": 50,
 *     "expiries": { "maxPerUnderlying": 4, "maxCalendarDays": 100 },
 *     "capture": { "minutesBeforeClose": 5, "retryMinutesAfterClose": 5, "lateUntilMinutesAfterClose": 30,
 *                  "budgetShare": 0.5, "strikesEachSide": 40 },
 *     "snapshotTtlSeconds": 60, "lookbacks": [30, 90, 252], "minRankDays": 20, "sameDteBand": 0.5,
 *     "backfill": { "defaultDays": 400, "maxDays": 1100, "minContracts": { "index": 500, "stock": 50 },
 *                   "maxFilesPerDay": 600, "keepRaw": false, "bse": true },
 *     "vix": { "symbol": "NSE:INDIAVIX" },
 *     "predictions": { "enabled": true, "retentionDays": 1100 },
 *     "retentionDays": 3650
 *   }
 *
 * `market` imports clockSettings() from here (a pure helper) to price chains on the same clock; it never calls the
 * vol service, so there is no dependency cycle.
 */
import { z } from "zod";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD")
  .refine((s) => {
    const t = Date.parse(`${s}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
  }, "not a real date");
const underlying = z.string().regex(/^[A-Z0-9&-]{1,30}$/, "use an exchange symbol such as NIFTY");
const windowMinutes = z.number().int().min(1).max(60);

export const CLOCK_SCHEMA = z
  .object({
    /** One clock for the installation. */
    mode: z.enum(["weighted", "trading", "calendar"]).default("weighted"),
    /** Weekend and holiday days, in trading-day units (assumption). */
    nonTradingDayWeight: z.number().min(0).max(1).default(0.15),
    /** Share of a trading day's variance at the open gap (assumption). */
    overnightShare: z.number().min(0).lt(1).default(0.2),
    /** { "2027-02-01": 1.5 } multiplies that day's weight (0.5–5). */
    eventDays: z.record(isoDate, z.number().min(0.5).max(5)).default({}),
    /** Ends at the reference session close (needs verification). */
    settlementWindowMinutes: z.object({ index: windowMinutes.default(30), stock: windowMinutes.default(30) }).strict().prefault({}),
    /** null = 252 + 113 × nonTradingDayWeight. */
    yearBasis: z.number().min(200).max(400).nullable().default(null),
  })
  .strict()
  .prefault({});

export const VOL_CONFIG_SCHEMA = z
  .object({
    clock: CLOCK_SCHEMA,
    /** Data account for captures; null = the recorder's data account, else the first account with optionChain. */
    account: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i).nullable().default(null),
    underlyings: z.array(underlying).max(20).default(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"]),
    stocks: z.array(underlying).max(200).default([]),
    maxStocks: z.number().int().min(0).max(200).default(50),
    expiries: z
      .object({ maxPerUnderlying: z.number().int().min(1).max(8).default(4), maxCalendarDays: z.number().int().min(7).max(400).default(100) })
      .strict()
      .prefault({}),
    capture: z
      .object({
        minutesBeforeClose: z.number().int().min(1).max(30).default(5),
        retryMinutesAfterClose: z.number().int().min(1).max(30).default(5),
        lateUntilMinutesAfterClose: z.number().int().min(5).max(120).default(30),
        budgetShare: z.number().gt(0).max(0.5).default(0.5),
        strikesEachSide: z.number().int().min(5).max(100).default(40),
      })
      .strict()
      .prefault({}),
    snapshotTtlSeconds: z.number().int().min(10).max(600).default(60),
    lookbacks: z.array(z.number().int().min(5).max(1000)).min(1).max(5).default([30, 90, 252]),
    minRankDays: z.number().int().min(2).max(252).default(20),
    sameDteBand: z.number().gt(0).max(5).default(0.5),
    backfill: z
      .object({
        defaultDays: z.number().int().min(1).max(1100).default(400),
        maxDays: z.number().int().min(1).max(1100).default(1100),
        minContracts: z.object({ index: z.number().int().min(0).default(500), stock: z.number().int().min(0).default(50) }).strict().prefault({}),
        maxFilesPerDay: z.number().int().min(1).max(2000).default(600),
        keepRaw: z.boolean().default(false),
        bse: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    vix: z.object({ symbol: z.string().min(1).max(40).default("NSE:INDIAVIX") }).strict().prefault({}),
    predictions: z.object({ enabled: z.boolean().default(true), retentionDays: z.number().int().min(30).max(3650).default(1100) }).strict().prefault({}),
    retentionDays: z.number().int().min(30).max(10_000).default(3650),
  })
  .strict()
  .refine((c) => c.stocks.length <= c.maxStocks, { message: "more stocks than maxStocks", path: ["stocks"] });

/** Parse (and default) a raw `vol` section. Throws a zod error on bad input. */
export function parseVolConfig(raw) {
  return VOL_CONFIG_SCHEMA.parse(raw ?? {});
}

const DEFAULT_CLOCK = Object.freeze(CLOCK_SCHEMA.parse({}));

/**
 * The installation's clock settings from the whole Bridge config (`config.vol.clock`, already parsed by core when the
 * vol module is loaded), or the defaults when the section is absent or invalid.
 * @returns {{ mode: string, nonTradingDayWeight: number, overnightShare: number, eventDays: Record<string, number>,
 *   settlementWindowMinutes: { index: number, stock: number }, yearBasis: number|null }}
 */
export function clockSettings(config) {
  const raw = config?.vol?.clock;
  if (raw === undefined || raw === null) return DEFAULT_CLOCK;
  const parsed = CLOCK_SCHEMA.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_CLOCK;
}
