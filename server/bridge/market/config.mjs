/**
 * The `market` config section — stream S5 (owned by the market module; validated by core with this schema).
 *
 *   "market": {
 *     "freshness": { "ltpMs": 1000, "quoteMs": 2000, "depthMs": 1000, "chainMs": 3000, "expiriesMs": 300000, "historyMs": 60000 },
 *     "stale":     { "enabled": true, "maxStaleMs": 60000, "waitMs": 250 },
 *     "batch":     { "windowMs": 25, "maxSymbols": 1000 },
 *     "streamFirst": true,
 *     "history":   { "maxChunks": 40, "maxSpanDays": { "intraday": 60, "daily": 2000 }, "brokers": { "dhan": { "intraday": 90 } } },
 *     "chain":     { "source": "auto", "ivModelDefault": "legacy-bs-spot" },   // riskFreeRate: deprecated override of reference.rate
 *     "cache":     { "maxEntries": 20000 }
 *   }
 *
 * Freshness targets are the default "oldest acceptable" age for each kind of read when the caller gives no maxAgeMs.
 * They may be tightened freely and loosened only up to FRESHNESS_MAX (documented maximums: beyond these a value is
 * too old to call current). Depth is never served stale past DEPTH_STALE_CAP_MS whatever the config says.
 * Everything is optional; `{}` gives the defaults.
 */
import { z } from "zod";

/** Default freshness targets (docs/ARCHITECTURE.md §6). */
export const FRESHNESS_DEFAULTS = Object.freeze({ ltpMs: 1000, quoteMs: 2000, depthMs: 1000, chainMs: 3000, expiriesMs: 300_000, historyMs: 60_000 });

/** The loosest a freshness target may be set in config. */
export const FRESHNESS_MAX = Object.freeze({ ltpMs: 5000, quoteMs: 10_000, depthMs: 5000, chainMs: 30_000, expiriesMs: 3_600_000, historyMs: 600_000 });

/** Depth older than this is never served, stale or not. */
export const DEPTH_STALE_CAP_MS = 5000;

/** Default history chunk spans (match brokers/brokerProxyRoutes.mjs HISTORICAL_MAX_SPAN_DAYS). */
export const HISTORY_SPAN_DEFAULTS = Object.freeze({ intraday: 60, daily: 2000 });

/** Hard upper bounds for history spans per call; a broker override above these is refused. */
export const HISTORY_SPAN_MAX = Object.freeze({ intraday: 365, daily: 7300 });

const target = (key) => z.number().int().min(0).max(FRESHNESS_MAX[key]).default(FRESHNESS_DEFAULTS[key]);

const spanSchema = z
  .object({
    intraday: z.number().int().min(1).max(HISTORY_SPAN_MAX.intraday).optional(),
    daily: z.number().int().min(1).max(HISTORY_SPAN_MAX.daily).optional(),
  })
  .strict();

export const MARKET_CONFIG_SCHEMA = z
  .object({
    freshness: z
      .object({
        ltpMs: target("ltpMs"),
        quoteMs: target("quoteMs"),
        depthMs: target("depthMs"),
        chainMs: target("chainMs"),
        expiriesMs: target("expiriesMs"),
        historyMs: target("historyMs"),
      })
      .strict()
      .prefault({}),
    stale: z
      .object({
        /** Serve a cached value labelled stale:true when the broker budget is exhausted, rather than queue past the deadline. */
        enabled: z.boolean().default(true),
        /** Oldest cached value that may be served stale (depth is capped at 5 s regardless). */
        maxStaleMs: z.number().int().min(0).max(600_000).default(60_000),
        /** How long a read with a stale fallback waits for broker budget before falling back. */
        waitMs: z.number().int().min(0).max(10_000).default(250),
      })
      .strict()
      .prefault({}),
    batch: z
      .object({
        /** Requests for quotes/LTP arriving within this window are merged into one broker call per account. */
        windowMs: z.number().int().min(0).max(200).default(25),
        /** A batch flushes early when it reaches this many symbols. */
        maxSymbols: z.number().int().min(1).max(5000).default(1000),
      })
      .strict()
      .prefault({}),
    /** Serve LTP and quotes from a live StreamHub subscription when there is one (zero REST calls). */
    streamFirst: z.boolean().default(true),
    history: z
      .object({
        /** Most broker calls one history request may make; longer ranges return the newest part with partial:true. */
        maxChunks: z.number().int().min(1).max(200).default(40),
        maxSpanDays: z
          .object({
            intraday: z.number().int().min(1).max(HISTORY_SPAN_MAX.intraday).default(HISTORY_SPAN_DEFAULTS.intraday),
            daily: z.number().int().min(1).max(HISTORY_SPAN_MAX.daily).default(HISTORY_SPAN_DEFAULTS.daily),
          })
          .strict()
          .prefault({}),
        /** Per-broker span per call (days). Use only figures from the broker's own documentation. */
        brokers: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), spanSchema).default({}),
      })
      .strict()
      .prefault({}),
    chain: z
      .object({
        /** auto: the broker's chain where the account declares one, else built from the master plus quotes. */
        source: z.enum(["auto", "broker", "built"]).default("auto"),
        /**
         * DEPRECATED (use reference.rate or the Market calendar page): risk-free rate for computed Greeks (annual,
         * decimal). When set it overrides the reference rate and a warning is logged once. No default: unset means
         * "use deps.reference.rate()" (docs/spec/p1-02-reference.md §10).
         */
        riskFreeRate: z.number().min(0).max(0.25).optional(),
        /**
         * The chain IV model when a request names none (docs/spec/p1-03-pricing-vol.md §10): legacy-bs-spot until the
         * deprecation date (1 May 2027), then b76-forward. Owners can switch early.
         */
        ivModelDefault: z.enum(["legacy-bs-spot", "b76-forward"]).default("legacy-bs-spot"),
        /** Most option instruments a built chain will quote. */
        maxBuiltLegs: z.number().int().min(2).max(2000).default(400),
      })
      .strict()
      .prefault({}),
    cache: z
      .object({
        maxEntries: z.number().int().min(100).max(1_000_000).default(20_000),
      })
      .strict()
      .prefault({}),
  })
  .strict();

/**
 * Parse (and default) a raw `market` section. Core has normally done this already; services call it again so they
 * also work when built directly in tests with a partial config.
 * @param {unknown} raw
 */
export function parseMarketConfig(raw) {
  return MARKET_CONFIG_SCHEMA.parse(raw ?? {});
}
