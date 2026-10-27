/**
 * The `backup` config section: free public data sources the Bridge may fall back to when no broker account can
 * answer a market-data read (none connected, session expired, broker down or out of budget).
 *
 *   "backup": {
 *     "enabled": true,
 *     "autoFallback": true,                       // REST, Excel, compat and scanner reads fall back by themselves
 *     "providers": {
 *       "yahoo": { "enabled": true, "perSecond": 4 },
 *       "nse":   { "enabled": true, "perSecond": 2 }
 *     },
 *     "order": { "equity": ["yahoo", "nse"], "index": ["nse", "yahoo"] },
 *     "cacheMs": 15000,
 *     "timeoutMs": 8000,
 *     "breaker": { "failures": 5, "cooldownMs": 60000 }
 *   }
 *
 * Off by default: a fresh install never calls a third-party site until the user says so (`mc-bridge init` asks).
 * Values from a backup source are always labelled freshness.source "backup" with the provider's name, never passed
 * off as broker data, and they are never used to price, check or place an order.
 */
import { z } from "zod";

export const BACKUP_PROVIDERS = Object.freeze(["yahoo", "nse"]);

const provider = (perSecond) =>
  z
    .object({
      enabled: z.boolean().default(true),
      /** Our own ceiling on calls a second to this site. Kept low: these are free public pages, not APIs we pay for. */
      perSecond: z.number().positive().max(20).default(perSecond),
    })
    .strict()
    .prefault({});

const order = z.array(z.enum(BACKUP_PROVIDERS)).min(1).max(BACKUP_PROVIDERS.length);

export const BACKUP_CONFIG_SCHEMA = z
  .object({
    enabled: z.boolean().default(false),
    /** Fall back automatically on reads that did not opt out (?backup=false). Off: only ?backup=true reads use it. */
    autoFallback: z.boolean().default(true),
    providers: z.object({ yahoo: provider(4), nse: provider(2) }).strict().prefault({}),
    order: z
      .object({ equity: order.default(["yahoo", "nse"]), index: order.default(["nse", "yahoo"]) })
      .strict()
      .prefault({}),
    /** Backup quotes are reused this long (they are delayed anyway; this keeps a big scan from hammering the site). */
    cacheMs: z.number().int().min(0).max(300_000).default(15_000),
    timeoutMs: z.number().int().min(1000).max(30_000).default(8000),
    breaker: z
      .object({
        /** Consecutive failures that pause a provider. */
        failures: z.number().int().min(1).max(100).default(5),
        cooldownMs: z.number().int().min(1000).max(3_600_000).default(60_000),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export function parseBackupConfig(raw) {
  return BACKUP_CONFIG_SCHEMA.parse(raw ?? {});
}
