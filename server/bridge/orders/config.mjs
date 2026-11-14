/**
 * The `orders` config section (owned by the orders module; validated by core with this schema).
 *
 *   "orders": {
 *     "ticketTtlMs": 60000,              // how long a ticket waits for a human to confirm it
 *     "confirmTokenTtlMs": 60000,        // how long a confirmed ticket's token may be used
 *     "confirmPaperFromMcp": true,       // AI-prepared PAPER orders also need a human confirmation
 *     "liveCallTimeoutMs": 15000,        // a live adapter write slower than this becomes outcome_unknown
 *     "reconcileIntervalMs": 3000,       // how often outcome_unknown orders are looked up in the broker order book
 *     "reconcileGiveUpMs": 600000,       // stop looking after this long (the order stays outcome_unknown)
 *     "sliceAboveFreeze": false,         // split orders above the exchange freeze quantity into legs (else refuse)
 *     "maxSlices": 10,
 *     "orderRetentionDays": 7,           // live order records kept on disk
 *     "maxOrderLookups": 2000,           // paper orders read per account for one listing
 *     "drift": {                         // read-only compare of the Bridge's live orders with the broker's order book
 *       "enabled": true,
 *       "intervalMinutes": 5,            // never checked more often than this (1 to 240)
 *       "marketHoursOnly": true          // only while the market is open (or pre-open); false: any time a live account is logged in
 *     }
 *   }
 *
 * Everything is optional; `{}` gives the defaults. Nothing here can switch live trading on: that stays in the core
 * `safety` section and each account's `live` block (config file only).
 */
import { z } from "zod";

export const ORDERS_DEFAULTS = Object.freeze({
  ticketTtlMs: 60_000,
  confirmTokenTtlMs: 60_000,
  confirmPaperFromMcp: true,
  liveCallTimeoutMs: 15_000,
  reconcileIntervalMs: 3000,
  reconcileGiveUpMs: 600_000,
  sliceAboveFreeze: false,
  maxSlices: 10,
  orderRetentionDays: 7,
  maxOrderLookups: 2000,
  drift: Object.freeze({ enabled: true, intervalMinutes: 5, marketHoursOnly: true }),
});

export const DRIFT_CONFIG_SCHEMA = z
  .object({
    enabled: z.boolean().default(ORDERS_DEFAULTS.drift.enabled),
    intervalMinutes: z.number().int().min(1).max(240).default(ORDERS_DEFAULTS.drift.intervalMinutes),
    marketHoursOnly: z.boolean().default(ORDERS_DEFAULTS.drift.marketHoursOnly),
  })
  .strict();

export const ORDERS_CONFIG_SCHEMA = z
  .object({
    ticketTtlMs: z.number().int().min(10_000).max(300_000).default(ORDERS_DEFAULTS.ticketTtlMs),
    confirmTokenTtlMs: z.number().int().min(10_000).max(300_000).default(ORDERS_DEFAULTS.confirmTokenTtlMs),
    confirmPaperFromMcp: z.boolean().default(ORDERS_DEFAULTS.confirmPaperFromMcp),
    liveCallTimeoutMs: z.number().int().min(1000).max(60_000).default(ORDERS_DEFAULTS.liveCallTimeoutMs),
    reconcileIntervalMs: z.number().int().min(500).max(60_000).default(ORDERS_DEFAULTS.reconcileIntervalMs),
    reconcileGiveUpMs: z.number().int().min(10_000).max(86_400_000).default(ORDERS_DEFAULTS.reconcileGiveUpMs),
    sliceAboveFreeze: z.boolean().default(ORDERS_DEFAULTS.sliceAboveFreeze),
    maxSlices: z.number().int().min(1).max(40).default(ORDERS_DEFAULTS.maxSlices),
    orderRetentionDays: z.number().int().min(1).max(90).default(ORDERS_DEFAULTS.orderRetentionDays),
    maxOrderLookups: z.number().int().min(100).max(20_000).default(ORDERS_DEFAULTS.maxOrderLookups),
    drift: DRIFT_CONFIG_SCHEMA.prefault({}),
  })
  .strict();

/**
 * The effective orders config: the parsed section when core applied it, else the defaults (factories built
 * directly in tests may receive a config without the section).
 * @param {any} config
 * @returns {typeof ORDERS_DEFAULTS}
 */
export function ordersConfig(config) {
  const raw = config?.orders;
  if (!raw) return { ...ORDERS_DEFAULTS };
  const parsed = ORDERS_CONFIG_SCHEMA.safeParse(raw);
  return parsed.success ? parsed.data : { ...ORDERS_DEFAULTS, ...raw, drift: { ...ORDERS_DEFAULTS.drift, ...(raw.drift ?? {}) } };
}
