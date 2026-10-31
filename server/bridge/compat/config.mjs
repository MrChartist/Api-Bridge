/**
 * The `compat` config section (stream S14): a compatibility REST API on the Bridge's own port in the widely used
 * Indian-algo style (POST JSON to /api/v1/<endpoint> with `apikey` in the body, { status } replies), so SDKs and
 * add-ins written for that style work unchanged: point them at http://127.0.0.1:4300 with a Bridge API key as `apikey`.
 *
 *   "compat": {
 *     "enabled": true,
 *     "account": "dhan-main",      // the account compat calls act on (default: the first account the key may use)
 *     "analyzer": true             // start in analyzer (paper) mode; /api/v1/analyzer/toggle switches per key
 *   }
 *
 * Analyzer mode = Bridge paper mode. Leaving it only asks for live orders: the Bridge's own live gates (config
 * safety.liveTrading, the account's live.enabled, a "live" key, source "rest" allowed) still decide.
 */
import { z } from "zod";

export const COMPAT_CONFIG_SCHEMA = z
  .object({
    enabled: z.boolean().default(true),
    account: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/).optional(),
    analyzer: z.boolean().default(true),
  })
  .strict();

export const parseCompatConfig = (raw) => COMPAT_CONFIG_SCHEMA.parse(raw ?? {});
