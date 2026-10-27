/**
 * The `notify` config section (stream S15): send Bridge events to you somewhere else, so a saved scan, a fill or the
 * kill switch reaches your phone while you are away from the screen.
 *
 *   "notify": {
 *     "targets": [
 *       { "id": "phone",  "kind": "telegram", "chatId": "123456789", "tokenEnv": "MCB_TELEGRAM_BOT_TOKEN", "events": ["scan.alert", "safety.kill_switch"] },
 *       { "id": "n8n",    "kind": "webhook",  "url": "https://n8n.example.com/webhook/bridge", "secretEnv": "MCB_NOTIFY_SECRET", "events": ["scan.alert", "order.updated"] },
 *       { "id": "team",   "kind": "discord",  "urlEnv": "MCB_DISCORD_WEBHOOK_URL", "events": ["scan.alert"] }
 *     ]
 *   }
 *
 * Secrets never go in this file: a bot token, a Discord/Slack webhook URL (the URL itself is the secret) and the HMAC
 * secret for generic webhooks are read from environment variables named here. Generic webhook bodies are signed with
 * the same `X-MCB-Signature: t=...,v1=HMAC-SHA256(secret, "t.body")` the Bridge accepts on its own inbound hooks.
 */
import { z } from "zod";

export const NOTIFY_EVENTS = Object.freeze(["scan.alert", "scan.completed", "order.updated", "safety.kill_switch", "account.status", "limits.throttled"]);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, "an environment variable name such as MCB_TELEGRAM_BOT_TOKEN");
const url = z
  .string()
  .max(2000)
  .refine((u) => /^https:\/\/[^\s/]+/i.test(u) || /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(u), "use https://, or http:// only to this computer");

const common = {
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/),
  enabled: z.boolean().default(true),
  events: z.array(z.enum(NOTIFY_EVENTS)).min(1).default(["scan.alert", "safety.kill_switch"]),
  /** order.updated only: these modes (default live only, so paper practice does not flood your phone). */
  orderModes: z.array(z.enum(["paper", "live"])).min(1).default(["live"]),
  /** order.updated only: these statuses (default the final ones). */
  orderStatuses: z
    .array(z.enum(["pending", "open", "trigger_pending", "partially_filled", "filled", "cancelled", "rejected", "expired", "outcome_unknown"]))
    .min(1)
    .default(["filled", "rejected", "outcome_unknown"]),
  /** At most one message per this many ms to this target (Telegram allows about one a second per chat). */
  minIntervalMs: z.number().int().min(0).max(60_000).optional(),
};

const target = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("telegram"), chatId: z.string().regex(/^-?\d{1,20}$|^@[A-Za-z0-9_]{5,32}$/), tokenEnv: envName.default("MCB_TELEGRAM_BOT_TOKEN") }).strict(),
  z.object({ ...common, kind: z.literal("discord"), urlEnv: envName }).strict(),
  z.object({ ...common, kind: z.literal("slack"), urlEnv: envName }).strict(),
  z
    .object({ ...common, kind: z.literal("webhook"), url: url.optional(), urlEnv: envName.optional(), secretEnv: envName.optional() })
    .strict()
    .refine((t) => Boolean(t.url) !== Boolean(t.urlEnv), { message: "give url or urlEnv (not both)" }),
]);

export const NOTIFY_CONFIG_SCHEMA = z
  .object({
    targets: z.array(target).max(20).default([]),
    timeoutMs: z.number().int().min(1000).max(30_000).default(5000),
    maxRetries: z.number().int().min(0).max(10).default(3),
    queueSize: z.number().int().min(1).max(5000).default(200),
  })
  .strict()
  .refine((c) => new Set(c.targets.map((t) => t.id)).size === c.targets.length, { message: "target ids must be unique", path: ["targets"] });

export const parseNotifyConfig = (raw) => NOTIFY_CONFIG_SCHEMA.parse(raw ?? {});
