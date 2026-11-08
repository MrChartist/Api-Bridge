/**
 * The `paper` config section (owned by the paper module; validated by core with this schema).
 *
 *   "paper": {
 *     "startingCapital": 1000000,          // ₹10,00,000 for a new or reset paper account
 *     "slippageBps": 5,                    // MARKET fills without depth: LTP ± 5 basis points
 *     "useDepth": true,                    // MARKET fills at the opposite best price when depth is available
 *     "pollIntervalMs": 2000,              // pending orders are re-priced at least this often without ticks
 *     "squareOff": { "enabled": true, "time": "15:20", "times": {} },   // times: per-exchange HH:MM overrides
 *     "sessionEnd": { "time": null, "times": {} },   // null: the reference session close (reference module)
 *     "margin": { "model": "portfolio", "intradayEquityPct": 20, "futuresPct": 15, "optionSellPct": 15 },
 *     "brokerage": { "perOrder": 0, "pct": 0, "maxPerOrder": null },
 *     "historyLimit": 1000
 *   }
 *
 * Everything is optional; `{}` gives the defaults. Margin and brokerage figures are deliberately simple
 * approximations for practice trading, not a broker's SPAN/exposure or statutory charges. The MCX and CDS square-off
 * and session-end defaults need verification against each broker's current timings; NSE/BSE cash and F&O follow the
 * common 15:20 IST intraday square-off.
 */
import { z } from "zod";

export const PAPER_DEFAULTS = Object.freeze({
  startingCapital: 1_000_000,
  slippageBps: 5,
  pollIntervalMs: 2000,
  squareOffTime: "15:20",
  /** null: the reference session close for the exchange (deps.reference, else reference/defaults.mjs). */
  sessionEndTime: null,
});

/**
 * Built-in per-exchange times, applied under any `times` the config gives. MCX and CDS values need verification
 * (commodity and currency sessions close later than equities).
 */
export const EXCHANGE_SQUARE_OFF = Object.freeze({ MCX: "23:00", CDS: "16:45" });
export const EXCHANGE_SESSION_END = Object.freeze({ MCX: "23:30", CDS: "17:00" });

/**
 * Demo mode's starting capital when the config leaves the default: ₹25 lakh, so the sample positions leave most of it
 * free and a new user can trade at once (with ₹10 lakh the seeded book used about 85 % under the old per-leg margin).
 */
export const DEMO_STARTING_CAPITAL = 2_500_000;

/** Starting capital bounds (same as the reset route in docs/openapi.yaml). */
export const CAPITAL_MIN = 10_000;
export const CAPITAL_MAX = 1_000_000_000;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM in IST, for example 15:20");
const exchange = z.enum(["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"]);
const pct = z.number().min(0).max(100);

export const PAPER_CONFIG_SCHEMA = z
  .object({
    startingCapital: z.number().finite().min(CAPITAL_MIN).max(CAPITAL_MAX).default(PAPER_DEFAULTS.startingCapital),
    slippageBps: z.number().min(0).max(500).default(PAPER_DEFAULTS.slippageBps),
    useDepth: z.boolean().default(true),
    pollIntervalMs: z.number().int().min(250).max(60_000).default(PAPER_DEFAULTS.pollIntervalMs),
    squareOff: z
      .object({
        enabled: z.boolean().default(true),
        time: hhmm.default(PAPER_DEFAULTS.squareOffTime),
        /** Per-exchange overrides. Defaults for MCX and CDS need verification. */
        times: z.partialRecord(exchange, hhmm).default({}),
      })
      .strict()
      .prefault({}),
    sessionEnd: z
      .object({
        /**
         * Pending DAY orders expire at this IST time (and any left over from an earlier day expire at once). null (the
         * default) means the reference session close for the order's exchange.
         */
        time: hhmm.nullable().default(PAPER_DEFAULTS.sessionEndTime),
        times: z.partialRecord(exchange, hhmm).default({}),
      })
      .strict()
      .prefault({}),
    margin: z
      .object({
        /**
         * "portfolio" (default): F&O legs are margined together per underlying with the approximate SPAN-like scan in
         * dashboard/span-margin.js, so hedges get their benefit. "simple": every leg on its own with the percentages
         * below (the model before October 2026). Equity always uses the percentages.
         */
        model: z.enum(["portfolio", "simple"]).default("portfolio"),
        /** INTRADAY equity: this percentage of order value is blocked (approximate). */
        intradayEquityPct: pct.default(20),
        /** Futures (any product), simple model or no underlying price: this percentage of contract value is blocked. */
        futuresPct: pct.default(15),
        /** Option writing, simple model or no underlying price: this percentage of strike × quantity. Buys block the premium. */
        optionSellPct: pct.default(15),
      })
      .strict()
      .prefault({}),
    brokerage: z
      .object({
        /** Flat charge per filled order in rupees. */
        perOrder: z.number().min(0).max(1000).default(0),
        /** Percentage of turnover per filled order. */
        pct: z.number().min(0).max(5).default(0),
        /** Cap per filled order in rupees (null = no cap). */
        maxPerOrder: z.number().min(0).nullable().default(null),
      })
      .strict()
      .prefault({}),
    /** Finished orders and trades kept per account (pending orders are always kept). */
    historyLimit: z.number().int().min(50).max(100_000).default(1000),
  })
  .strict();

/** Fully defaulted paper config (for tests and the fake). */
export function paperConfig(input = {}) {
  return PAPER_CONFIG_SCHEMA.parse(input);
}
