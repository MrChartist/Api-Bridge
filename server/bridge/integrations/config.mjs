/**
 * The `integrations` config section — stream S10 (owned by the integrations module; validated by core with this
 * schema). Everything is optional; `{}` gives the defaults below.
 *
 *   "integrations": {
 *     "xl": {
 *       "chainFormat": "csv",
 *       "historyLayout": "standard",
 *       "defaultCountback": 500
 *     }
 *   }
 */
import { z } from "zod";

export const INTEGRATIONS_CONFIG_SCHEMA = z
  .object({
    xl: z
      .object({
        chainFormat: z.enum(["csv", "json"]).default("csv"),
        historyLayout: z.enum(["standard", "amibroker"]).default("standard"),
        /** Bars returned by /xl/history when the request gives neither from nor countback. */
        defaultCountback: z.number().int().min(1).max(5000).default(500),
      })
      .strict()
      .prefault({}),
  })
  .strict();

/**
 * Parse an `integrations` section (or nothing) into the full defaulted config.
 * @param {unknown} [raw]
 * @returns {z.infer<typeof INTEGRATIONS_CONFIG_SCHEMA>}
 */
export function parseIntegrationsConfig(raw) {
  return INTEGRATIONS_CONFIG_SCHEMA.parse(raw ?? {});
}
