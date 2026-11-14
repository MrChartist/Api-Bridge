/**
 * The `events` config section (the events module). All optional; zod `.strict()`.
 *
 *   "events": {
 *     "enabled": true,
 *     "retain": 5000,                      // events kept for replay, in memory and on disk (survives a restart)
 *     "maxEventBytes": 16384,              // one event's data above this is replaced by a short note
 *     "heartbeatMs": 15000,                // SSE comment / WebSocket ping
 *     "maxClients": 50, "maxClientsPerKey": 5,
 *     "maxBufferedBytes": 262144,          // a reader this far behind is closed; it reconnects with its cursor
 *     "webhooks": {
 *       "enabled": true,
 *       "maxSubscriptions": 20,
 *       "allowPrivateTargets": false,      // true: http:// and loopback / private addresses may be targets (cloud
 *                                          //   metadata addresses are refused even then)
 *       "allowedHosts": [],                // when not empty, a target host must match one: "example.com" or "*.example.com"
 *       "timeoutMs": 10000, "maxResponseBytes": 4096,
 *       "concurrency": 16,                 // attempts running at once, all subscriptions together
 *       "perSubscription": 2,              // attempts running at once for ONE subscription: a receiver that never
 *                                          //   answers holds only its own slots
 *       "breakerAfter": 3,                 // failures in a row after which a subscription gets one attempt per backoff period
 *       "replayWindowSec": 300,            // what the docs tell receivers to accept; sent in a header too
 *       "retry": { "maxAttempts": 8, "baseMs": 5000, "maxMs": 3600000, "jitter": 0.2, "maxAgeSec": 86400 },
 *       "maxPendingPerSubscription": 500, "deadLetterMax": 200, "deliveryLogMax": 500
 *     }
 *   }
 *
 * A webhook's URL and secret are never here: they are stored encrypted in the secrets store.
 */
import { z } from "zod";

const hostPattern = z
  .string()
  .min(3)
  .max(253)
  .regex(/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/, 'a lowercase host such as "example.com" or "*.example.com"');

export const EVENTS_CONFIG_SCHEMA = z
  .object({
    enabled: z.boolean().default(true),
    retain: z.number().int().min(100).max(100_000).default(5000),
    maxEventBytes: z.number().int().min(1024).max(262_144).default(16_384),
    heartbeatMs: z.number().int().min(1000).max(120_000).default(15_000),
    maxClients: z.number().int().min(1).max(1000).default(50),
    maxClientsPerKey: z.number().int().min(1).max(1000).default(5),
    maxBufferedBytes: z.number().int().min(16_384).max(16_777_216).default(262_144),
    webhooks: z
      .object({
        enabled: z.boolean().default(true),
        maxSubscriptions: z.number().int().min(1).max(200).default(20),
        allowPrivateTargets: z.boolean().default(false),
        allowedHosts: z.array(hostPattern).max(100).default([]),
        timeoutMs: z.number().int().min(1000).max(60_000).default(10_000),
        maxResponseBytes: z.number().int().min(256).max(65_536).default(4096),
        concurrency: z.number().int().min(1).max(64).default(16),
        perSubscription: z.number().int().min(1).max(8).default(2),
        breakerAfter: z.number().int().min(1).max(20).default(3),
        replayWindowSec: z.number().int().min(30).max(3600).default(300),
        retry: z
          .object({
            maxAttempts: z.number().int().min(1).max(50).default(8),
            baseMs: z.number().int().min(100).max(600_000).default(5000),
            maxMs: z.number().int().min(1000).max(86_400_000).default(3_600_000),
            jitter: z.number().min(0).max(0.5).default(0.2),
            maxAgeSec: z.number().int().min(60).max(604_800).default(86_400),
          })
          .strict()
          .prefault({}),
        maxPendingPerSubscription: z.number().int().min(10).max(10_000).default(500),
        deadLetterMax: z.number().int().min(10).max(5000).default(200),
        deliveryLogMax: z.number().int().min(50).max(5000).default(500),
      })
      .strict()
      .prefault({}),
  })
  .strict();

/** The events config of a loaded Bridge config, with every default filled in. @param {any} config */
export function eventsConfig(config) {
  return EVENTS_CONFIG_SCHEMA.parse(config?.events ?? {});
}
