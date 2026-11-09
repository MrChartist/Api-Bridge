/**
 * The `notify` config section (the notify module). All optional; zod `.strict()`. The bot token and the chat ids are
 * NEVER here: they are typed on this computer (dashboard, or `mc-bridge notify telegram setup`) and kept encrypted in
 * the secrets store. This section only holds behaviour.
 *
 *   "notify": {
 *     "enabled": true,
 *     "events": { "order.placed": true, "hook.stale": false },     // overrides of the defaults in events.mjs
 *     "quietHours": { "enabled": false, "start": "22:00", "end": "07:00" },     // IST
 *     "morning": { "enabled": true, "at": "08:45", "secondAt": "09:10", "endOfDay": { "enabled": false, "at": "15:45" } },
 *     "coalesceSeconds": 20, "dedupeSeconds": 60,
 *     "rateLimitAlert": { "threshold": 20, "windowMinutes": 10 },
 *     "pacing": { "perChatMs": 1100, "perSecond": 20, "groupPerMinute": 18 },
 *     "retry": { "maxAttempts": 6, "baseMs": 2000, "maxMs": 300000, "maxAgeMinutes": 60 },
 *     "queue": { "max": 200 },
 *     "inbound": { "enabled": true, "commandsPerMinute": 10, "pollSeconds": 25 }
 *   }
 *
 * The pacing, retry and polling numbers follow Telegram's Bot API documentation (see docs/guides/telegram.md for the
 * sources); they are settings, not hard-coded, because Telegram may change them.
 */
import { z } from "zod";
import { EVENT_KEYS } from "./events.mjs";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const hhmm = z.string().regex(HHMM, 'a time like "08:45" (IST, 24-hour)');

export const eventFlagsSchema = z
  .record(z.string(), z.boolean())
  .refine((m) => Object.keys(m).every((k) => EVENT_KEYS.includes(k)), { message: `unknown event; use ${EVENT_KEYS.join(", ")}` });

export const quietHoursSchema = z.object({ enabled: z.boolean().default(false), start: hhmm.default("22:00"), end: hhmm.default("07:00") }).strict();

export const morningSchema = z
  .object({
    enabled: z.boolean().default(true),
    at: hhmm.default("08:45"),
    secondAt: hhmm.default("09:10"),
    endOfDay: z.object({ enabled: z.boolean().default(false), at: hhmm.default("15:45") }).strict().prefault({}),
  })
  .strict();

export const NOTIFY_CONFIG_SCHEMA = z
  .object({
    enabled: z.boolean().default(true),
    events: eventFlagsSchema.default({}),
    quietHours: quietHoursSchema.prefault({}),
    morning: morningSchema.prefault({}),
    coalesceSeconds: z.number().int().min(0).max(600).default(20),
    dedupeSeconds: z.number().int().min(0).max(3600).default(60),
    rateLimitAlert: z.object({ threshold: z.number().int().min(1).max(10_000).default(20), windowMinutes: z.number().int().min(1).max(120).default(10) }).strict().prefault({}),
    pacing: z
      .object({
        /** Telegram: "avoid sending more than one message per second" to one chat. */
        perChatMs: z.number().int().min(250).max(60_000).default(1100),
        /** Telegram: about 30 messages per second for a whole bot. Kept well under it. */
        perSecond: z.number().int().min(1).max(30).default(20),
        /** Telegram: a bot cannot "send more than 20 messages per minute" to a group. Kept under it. */
        groupPerMinute: z.number().int().min(1).max(20).default(18),
      })
      .strict()
      .prefault({}),
    retry: z
      .object({
        maxAttempts: z.number().int().min(1).max(20).default(6),
        baseMs: z.number().int().min(100).max(60_000).default(2000),
        maxMs: z.number().int().min(1000).max(3_600_000).default(300_000),
        maxAgeMinutes: z.number().int().min(1).max(1440).default(60),
      })
      .strict()
      .prefault({}),
    queue: z.object({ max: z.number().int().min(10).max(5000).default(200) }).strict().prefault({}),
    inbound: z
      .object({
        enabled: z.boolean().default(true),
        commandsPerMinute: z.number().int().min(1).max(60).default(10),
        /** Long-poll timeout in seconds for getUpdates. */
        pollSeconds: z.number().int().min(0).max(50).default(25),
        /** /kill may ENGAGE the kill switch after a one-time code. Releasing it is never possible from Telegram. */
        allowKill: z.boolean().default(true),
        /** Commands older than this are ignored (a message that waited while the Bridge was off must not run later). */
        maxCommandAgeSeconds: z.number().int().min(10).max(3600).default(120),
      })
      .strict()
      .prefault({}),
  })
  .strict();

/** The parsed `notify` section from a (possibly unparsed) config. */
export function notifyConfig(config) {
  const raw = config?.notify;
  return raw && typeof raw === "object" && "coalesceSeconds" in raw && "pacing" in raw ? raw : NOTIFY_CONFIG_SCHEMA.parse(raw ?? {});
}
