/**
 * The `stream` config section (owned by the stream module). Every key is optional; defaults are conservative and suit one
 * person running a few tools on their own computer.
 *
 *   "stream": {
 *     "heartbeatMs": 15000,                 // heartbeat message to every client
 *     "maxClients": 50,                     // open WebSocket + SSE connections, all keys together
 *     "maxClientsPerKey": 10,               // open connections for any one API key
 *     "maxSymbolsPerClient": 500,           // per connection; crossing it returns SUBSCRIPTION_LIMIT
 *     "maxSymbolsPerRequest": 200,          // one subscribe op / one SSE URL
 *     "maxSubscriptionsPerUpstream": null,  // extra cap per broker feed; null = broker policy, else FEED_LIMITS
 *     "staleAfterMs": 60000,                // connected feed with no tick for this long reports "stale"
 *     "upstreamIdleMs": 60000,              // close a broker feed this long after its last subscription went away
 *     "unsubscribeLingerMs": 0,             // keep a symbol subscribed upstream this long after the last client left
 *     "adapterGraceMs": 35000,              // let the adapter reconnect by itself before the hub rebuilds the feed
 *     "backoff": { "initialMs": 1000, "maxMs": 30000 },
 *     "maxQueuedMessages": 256,             // non-tick messages waiting for one slow client before it is dropped
 *     "highWaterMarkBytes": 1048576,        // stop writing to a client while this much is still unsent
 *     "maxOpsPerSecond": 20,                // client -> server ops per connection
 *     "candles": { "intervals": ["1m","5m","15m"], "maxBars": 500 }
 *   }
 */
import { z } from "zod";

export const CANDLE_INTERVALS = Object.freeze(["1m", "3m", "5m", "10m", "15m", "30m", "60m", "1d"]);

export const streamConfigSchema = z
  .object({
    heartbeatMs: z.number().int().min(1000).max(120_000).default(15_000),
    maxClients: z.number().int().min(1).max(1000).default(50),
    maxClientsPerKey: z.number().int().min(1).max(1000).default(10),
    maxSymbolsPerClient: z.number().int().min(1).max(10_000).default(500),
    maxSymbolsPerRequest: z.number().int().min(1).max(1000).default(200),
    maxSubscriptionsPerUpstream: z.number().int().positive().nullable().default(null),
    staleAfterMs: z.number().int().min(5000).max(3_600_000).default(60_000),
    upstreamIdleMs: z.number().int().min(0).max(3_600_000).default(60_000),
    unsubscribeLingerMs: z.number().int().min(0).max(600_000).default(0),
    adapterGraceMs: z.number().int().min(0).max(600_000).default(35_000),
    backoff: z
      .object({
        initialMs: z.number().int().min(100).max(60_000).default(1000),
        maxMs: z.number().int().min(1000).max(600_000).default(30_000),
      })
      .strict()
      .prefault({}),
    maxQueuedMessages: z.number().int().min(16).max(100_000).default(256),
    highWaterMarkBytes: z.number().int().min(16_384).max(64 * 1_048_576).default(1_048_576),
    maxOpsPerSecond: z.number().int().min(1).max(1000).default(20),
    candles: z
      .object({
        intervals: z.array(z.enum(CANDLE_INTERVALS)).min(1).default(["1m", "5m", "15m"]),
        maxBars: z.number().int().min(10).max(10_000).default(500),
      })
      .strict()
      .prefault({}),
  })
  .strict();

/**
 * Parse (and default) a raw `stream` section. The app has already validated config.stream when the module is
 * registered; tests and the fake call this with partial objects.
 * @param {unknown} raw
 * @returns {z.infer<typeof streamConfigSchema>}
 */
export function resolveStreamConfig(raw) {
  return streamConfigSchema.parse(raw ?? {});
}
