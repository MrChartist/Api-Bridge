/**
 * The `sources` config section (owned by the sources module; validated by core with this schema).
 *
 *   "sources": {
 *     "autoFallback": false,                       // reads no broker can answer may fall back to an enabled source
 *     "timeoutMs": 5000,                           // per call to a source (100 to 15000)
 *     "providers": { "<source id>": { "enabled": false } },   // false keeps a source off whatever the dashboard says
 *     "plugins": [{ "path": "plugins/x", "sha256": "<64 hex>", "granted": true, "config": { } }]   // config: the plugin's own settings
 *   }
 *
 * Entries under providers and plugins keep unknown keys, so a provider or plugin can read its own settings.
 * Everything is optional; `{}` gives the safe defaults (no fallback, no plugins, a 5 s timeout). Keys, consent and
 * on/off choices made in the dashboard are not config: they live in the data folder (state.mjs, secrets store).
 */
import { z } from "zod";

export const DEFAULT_TIMEOUT_MS = 5000;
export const MAX_TIMEOUT_MS = 15_000;
export const MIN_TIMEOUT_MS = 100;

const sourceId = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, "a source id is lowercase letters, digits and dashes");

export const sourcesConfigSchema = z
  .object({
    autoFallback: z.boolean().default(false),
    timeoutMs: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
    providers: z.record(sourceId, z.object({ enabled: z.boolean().optional() }).passthrough()).default({}),
    plugins: z
      .array(
        z
          .object({
            path: z.string().min(1).max(512),
            sha256: z.string().regex(/^[0-9a-f]{64}$/, "sha256 is 64 lowercase hex characters"),
            granted: z.boolean().default(false),
            // The plugin's own settings; the plugin's manifest says which keys it takes (never a secret: keys go in the secrets store).
            config: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough(),
      )
      .max(20)
      .default([]),
  })
  .strict();
