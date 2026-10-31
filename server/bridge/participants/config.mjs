/**
 * The `participants` config section (stream S26, docs/spec/p1-12-guard-participants.md §2.6). All optional.
 *
 *   "participants": {
 *     "enabled": true,
 *     "fetchAt": "19:10", "retryEveryMinutes": 30, "retryUntil": "22:10", "morningCatchUp": "08:40",
 *     "urls": ["{base}/content/nsccl/fao_participant_oi_{DDMMYYYY}.csv"],
 *     "backfill": { "enabled": true, "days": 500, "gapSeconds": 6, "maxPerRun": 120, "notDuring": { "from": "09:00", "to": "15:45" } },
 *     "retentionDays": 1100
 *   }
 *
 * {base} is reference.sources.nseArchives.baseUrl: every download goes through the reference module's polite archive
 * client and obeys its switch (off on a fresh install). URLs and the publication time NEED VERIFICATION (V1).
 */
import { z } from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM in IST, for example 19:10");
/** Only paths on the archives host: "{base}/..." with the date placeholder, nothing else. */
const urlTemplate = z
  .string()
  .max(200)
  .regex(/^\{base\}\/(?!.*\.\.)[A-Za-z0-9_./{}-]+$/, 'use "{base}/path/with_{DDMMYYYY}.csv" (a path on the NSE archives host)')
  .refine((s) => /\{(DDMMYYYY|YYYYMMDD|DD-MMM-YYYY|DDMMMYYYY)\}/.test(s), "the template needs a date placeholder such as {DDMMYYYY}");

export const PARTICIPANTS_CONFIG_SCHEMA = z
  .object({
    enabled: z.boolean().default(true),
    fetchAt: hhmm.default("19:10"),
    retryEveryMinutes: z.number().int().min(5).max(180).default(30),
    retryUntil: hhmm.default("22:10"),
    morningCatchUp: hhmm.default("08:40"),
    urls: z.array(urlTemplate).min(1).max(4).default(["{base}/content/nsccl/fao_participant_oi_{DDMMYYYY}.csv"]),
    backfill: z
      .object({
        enabled: z.boolean().default(true),
        days: z.number().int().min(0).max(750).default(500),
        gapSeconds: z.number().int().min(2).max(120).default(6),
        maxPerRun: z.number().int().min(1).max(500).default(120),
        notDuring: z.object({ from: hhmm.default("09:00"), to: hhmm.default("15:45") }).strict().prefault({}),
      })
      .strict()
      .prefault({}),
    retentionDays: z.number().int().min(30).max(3000).default(1100),
  })
  .strict()
  .refine((c) => c.fetchAt < c.retryUntil, { message: "fetchAt must be before retryUntil", path: ["retryUntil"] });

export const parseParticipantsConfig = (raw) => PARTICIPANTS_CONFIG_SCHEMA.parse(raw ?? {});

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** "{base}/content/nsccl/fao_participant_oi_{DDMMYYYY}.csv" → "/content/nsccl/fao_participant_oi_28102026.csv". */
export function pathFor(template, date) {
  const [y, m, d] = date.split("-");
  return template
    .replace(/^\{base\}/, "")
    .replace("{DDMMYYYY}", `${d}${m}${y}`)
    .replace("{YYYYMMDD}", `${y}${m}${d}`)
    .replace("{DD-MMM-YYYY}", `${d}-${MONTHS[Number(m) - 1]}-${y}`)
    .replace("{DDMMMYYYY}", `${d}${MONTHS[Number(m) - 1]}${y}`);
}
