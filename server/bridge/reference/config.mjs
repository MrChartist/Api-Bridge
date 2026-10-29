/**
 * The `reference` config section (stream S16, docs/spec/p1-02-reference.md §2.5).
 *
 *   "reference": {
 *     "sources": { "nseArchives": { "enabled": false, "baseUrl": "https://nsearchives.nseindia.com", "gapMs": 2000,
 *                                   "timeoutMs": 15000, "maxBytes": 20971520 } },
 *     "schedule": { "morning": "08:20", "morningRetry": "08:50", "evening": "19:35", "eveningRetry": "21:05" },
 *     "staleAfterTradingDays": 1, "bannerDays": 7, "blockLotsWhenStale": false,
 *     "rate": { "value": null, "asOf": null, "source": null }, "rateStaleDays": 14,
 *     "sessions": { "NFO": { "preOpen": null, "open": null, "close": null }, "BFO": { ... } },
 *     "specialSessions": { "2026-11-08": { "open": "18:00", "close": "19:00", "label": "Muhurat", "exchanges": ["NSE","BSE"] } },
 *     "holidays": { "add": [], "remove": [] },
 *     "freeze": { "NFO:NIFTY": 1800 },
 *     "brokerage": { "kind": "flat", "perOrder": 20 },
 *     "extraordinaryDividendPct": 2,
 *     "retentionDays": 400
 *   }
 *
 * Downloads from the NSE archives are OFF by default: a fresh install calls no third-party site. Choices made on the
 * Market calendar page (settings.json) override this section; this section overrides reference/defaults.mjs.
 */
import { z } from "zod";
import { DEFAULT_BROKERAGE, DEFAULT_RATE, DEFAULT_RATE_SOURCE } from "./defaults.mjs";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM in IST, for example 08:20");
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD")
  .refine((s) => {
    const t = Date.parse(`${s}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
  }, "not a real date");
const holidayExchange = z.enum(["NSE", "BSE"]);

const sessionWindow = z
  .object({ preOpen: hhmm.nullable().default(null), open: hhmm.nullable().default(null), close: hhmm.nullable().default(null) })
  .strict()
  .prefault({})
  .refine((w) => !(w.open && w.close) || w.open < w.close, "open must be before close")
  .refine((w) => !(w.preOpen && w.open) || w.preOpen <= w.open, "preOpen must not be after open");

const holidayRow = z
  .object({
    date: isoDate,
    label: z.string().min(1).max(80),
    exchanges: z.array(holidayExchange).min(1).max(2).default(["NSE", "BSE"]),
    verified: z.boolean().default(true),
  })
  .strict();

export const REFERENCE_CONFIG_SCHEMA = z
  .object({
    sources: z
      .object({
        nseArchives: z
          .object({
            enabled: z.boolean().default(false),
            /** Needs verification: the public archives host. */
            baseUrl: z.url({ protocol: /^https$/ }).max(200).default("https://nsearchives.nseindia.com"),
            gapMs: z.number().int().min(2000).max(60_000).default(2000),
            timeoutMs: z.number().int().min(1000).max(120_000).default(15_000),
            maxBytes: z.number().int().min(1024).max(64 * 1024 * 1024).default(20 * 1024 * 1024),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    schedule: z
      .object({
        morning: hhmm.default("08:20"),
        morningRetry: hhmm.default("08:50"),
        evening: hhmm.default("19:35"),
        eveningRetry: hhmm.default("21:05"),
      })
      .strict()
      .prefault({}),
    staleAfterTradingDays: z.number().int().min(0).max(30).default(1),
    bannerDays: z.number().int().min(1).max(30).default(7),
    blockLotsWhenStale: z.boolean().default(false),
    rate: z
      .object({
        value: z.number().min(0).max(0.25).nullable().default(null),
        asOf: isoDate.nullable().default(null),
        source: z.string().min(3).max(120).nullable().default(null),
      })
      .strict()
      .prefault({}),
    rateStaleDays: z.number().int().min(1).max(366).default(14),
    sessions: z.object({ NFO: sessionWindow, BFO: sessionWindow }).strict().prefault({}),
    specialSessions: z
      .record(
        isoDate,
        z
          .object({
            open: hhmm.nullable().default(null),
            close: hhmm.nullable().default(null),
            label: z.string().min(1).max(80).default("Special session"),
            exchanges: z.array(holidayExchange).min(1).max(2).default(["NSE", "BSE"]),
          })
          .strict(),
      )
      .default({}),
    holidays: z
      .object({
        add: z.array(holidayRow).max(200).default([]),
        remove: z.array(isoDate).max(200).default([]),
      })
      .strict()
      .prefault({}),
    freeze: z.record(z.string().regex(/^(NFO|BFO):[A-Z0-9&-]{1,30}$/, 'use "NFO:NIFTY" style keys'), z.number().int().min(1).max(10_000_000)).default({}),
    brokerage: z
      .object({ kind: z.literal("flat").default("flat"), perOrder: z.number().min(0).max(10_000).default(DEFAULT_BROKERAGE.perOrder) })
      .strict()
      .prefault({}),
    /** Dividend adjustments apply above this percentage of the cum price (needs verification). */
    extraordinaryDividendPct: z.number().min(0).max(100).default(2),
    retentionDays: z.number().int().min(30).max(2000).default(400),
  })
  .strict();

/** Parse (and default) the section. Throws a ZodError on bad input. */
export const parseReferenceConfig = (raw) => REFERENCE_CONFIG_SCHEMA.parse(raw ?? {});

/** settings.json shape (choices made in the dashboard). Unknown or broken values are ignored, never fatal. */
const settingsSchema = z
  .object({
    version: z.literal(1).optional(),
    nseArchives: z.object({ enabled: z.boolean(), at: z.string().max(40).nullable().optional(), by: z.string().max(80).nullable().optional() }).optional(),
    rate: z
      .object({ value: z.number().min(0).max(0.25), asOf: isoDate.nullable().optional(), source: z.string().min(3).max(120), at: z.string().max(40).optional(), by: z.string().max(80).optional() })
      .optional(),
  })
  .passthrough();

/**
 * Which archive switch and which rate are in force: settings.json (a dashboard choice, with who and when) over config,
 * config over defaults.
 * @param {ReturnType<typeof parseReferenceConfig>} cfg
 * @param {unknown} settings
 * @returns {{ nseArchives: { enabled: boolean, setBy: "dashboard"|"config"|"default", setAt: string|null, by: string|null },
 *   rate: { value: number, asOf: string|null, source: string, quality: "user"|"config"|"default", setBy: "dashboard"|"config"|"default" } }}
 */
export function effectiveSettings(cfg, settings) {
  const parsed = settingsSchema.safeParse(settings ?? {});
  const s = parsed.success ? parsed.data : {};
  const archives = s.nseArchives
    ? { enabled: s.nseArchives.enabled, setBy: "dashboard", setAt: s.nseArchives.at ?? null, by: s.nseArchives.by ?? null }
    : { enabled: cfg.sources.nseArchives.enabled, setBy: cfg.sources.nseArchives.enabled ? "config" : "default", setAt: null, by: null };
  let rate;
  if (s.rate) rate = { value: s.rate.value, asOf: s.rate.asOf ?? null, source: s.rate.source, quality: "user", setBy: "dashboard" };
  else if (cfg.rate.value !== null) rate = { value: cfg.rate.value, asOf: cfg.rate.asOf, source: cfg.rate.source ?? "config: reference.rate", quality: "config", setBy: "config" };
  else rate = { value: DEFAULT_RATE, asOf: null, source: DEFAULT_RATE_SOURCE, quality: "default", setBy: "default" };
  return { nseArchives: archives, rate };
}
