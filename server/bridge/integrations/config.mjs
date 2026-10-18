/**
 * The `integrations` config section — stream S10 (owned by the integrations module; validated by core with this
 * schema). Everything is optional; `{}` gives the defaults below.
 *
 *   "integrations": {
 *     "udf": {
 *       "supportedResolutions": ["1", "3", "5", "10", "15", "30", "60", "1D", "1W", "1M"],
 *       "sessions": { "NSE": "0915-1530", "MCX": "0900-2330" },
 *       "searchLimit": 30,
 *       "maxCountback": 5000,
 *       "maxQuoteSymbols": 100,
 *       "nextTimeLookup": true
 *     },
 *     "xl": {
 *       "chainFormat": "csv",
 *       "historyLayout": "standard",
 *       "defaultCountback": 500
 *     }
 *   }
 *
 * Sessions are TradingView session strings in Asia/Kolkata time (`HHMM-HHMM`, optionally `:1234567` weekdays, `,` for
 * several ranges in a day and `|` between alternatives). The NSE/BSE/NFO/BFO default of 09:15–15:30 is the regular
 * session. The MCX default follows the US daylight-saving season (23:30 close during US DST, 23:55 otherwise; agri
 * contracts close earlier), and CDS hours have changed over time (needs verification; set them here to match).
 * Special sessions such as Muhurat trading are not modelled.
 */
import { z } from "zod";
import { usDstInEffect } from "../market/history.mjs";

/** UDF resolution -> Bridge interval (OpenAPI Interval). Minutes are bare numbers, the rest use D / W / M. */
export const UDF_RESOLUTIONS = Object.freeze({
  1: "1m",
  3: "3m",
  5: "5m",
  10: "10m",
  15: "15m",
  30: "30m",
  60: "60m",
  "1D": "1d",
  "1W": "1w",
  "1M": "1M",
});

export const UDF_RESOLUTION_KEYS = Object.freeze(Object.keys(UDF_RESOLUTIONS));

/** MCX regular session string for a date: "0900-2330" during US DST, "0900-2355" otherwise (needs verification). */
export const mcxSessionFor = (ms) => (usDstInEffect(ms) ? "0900-2330" : "0900-2355");

/** Regular sessions per exchange (Asia/Kolkata). MCX and CDS need verification; see the header. */
export const SESSION_DEFAULTS = Object.freeze({
  NSE: "0915-1530",
  BSE: "0915-1530",
  NFO: "0915-1530",
  BFO: "0915-1530",
  MCX: "0900-2330",
  CDS: "0900-1700",
});

const SESSION_RANGE = String.raw`\d{4}-\d{4}(?::[1-7]{1,7})?`;
/** TradingView session string, e.g. "0915-1530", "0900-1700:23456", "0915-1200,1300-1530". */
export const SESSION_RE = new RegExp(`^${SESSION_RANGE}(?:[,|]${SESSION_RANGE})*$`);

const session = (exchange) =>
  z
    .string()
    .regex(SESSION_RE, "Use a TradingView session string such as 0915-1530.")
    // MCX's default follows the US daylight-saving season, decided when the config is read (the Bridge restarts
    // daily in practice); set integrations.udf.sessions.MCX to pin it.
    .default(() => (exchange === "MCX" ? mcxSessionFor(Date.now()) : SESSION_DEFAULTS[exchange]));

export const INTEGRATIONS_CONFIG_SCHEMA = z
  .object({
    udf: z
      .object({
        supportedResolutions: z
          .array(z.enum(UDF_RESOLUTION_KEYS))
          .min(1)
          .refine((a) => new Set(a).size === a.length, "Resolutions must not repeat.")
          .default([...UDF_RESOLUTION_KEYS]),
        sessions: z
          .object({ NSE: session("NSE"), BSE: session("BSE"), NFO: session("NFO"), BFO: session("BFO"), MCX: session("MCX"), CDS: session("CDS") })
          .strict()
          .prefault({}),
        /** Default and maximum number of /udf/search results (the request may ask for fewer, up to 100). */
        searchLimit: z.number().int().min(1).max(100).default(30),
        /** Largest countback a chart may ask for in one /udf/history call. */
        maxCountback: z.number().int().min(1).max(5000).default(5000),
        /** Most symbols in one /udf/quotes call. */
        maxQuoteSymbols: z.number().int().min(1).max(200).default(100),
        /**
         * On an empty range, make one small extra history read (countback 1, through the scheduler like any other) to
         * find the previous bar and answer `no_data` with `nextTime`, so the chart can jump over gaps such as holidays.
         */
        nextTimeLookup: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    xl: z
      .object({
        chainFormat: z.enum(["csv", "json"]).default("csv"),
        historyLayout: z.enum(["standard", "amibroker"]).default("standard"),
        /** Bars returned by /xl/history when the request gives neither from nor countback. */
        defaultCountback: z.number().int().min(1).max(5000).default(500),
      })
      .strict()
      .prefault({}),
  })
  .strict();

/**
 * Parse an `integrations` section (or nothing) into the full defaulted config.
 * @param {unknown} [raw]
 * @returns {z.infer<typeof INTEGRATIONS_CONFIG_SCHEMA>}
 */
export function parseIntegrationsConfig(raw) {
  return INTEGRATIONS_CONFIG_SCHEMA.parse(raw ?? {});
}
