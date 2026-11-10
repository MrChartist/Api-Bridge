/**
 * The `storage` config section (the storage module). All optional; zod `.strict()`.
 *
 *   "storage": {
 *     "minFreeMb": 1024,        free space below this: health says "degraded" and the Bridge warns (event storage.status)
 *     "hardFreeMb": 200,        free space below this: downloads pause and no new download starts, readiness says not ready
 *     "checkIntervalSec": 30    how often the free space is measured
 *   }
 */
import { z } from "zod";

export const STORAGE_CONFIG_SCHEMA = z
  .object({
    minFreeMb: z.number().int().min(10).max(1_000_000).default(1024),
    hardFreeMb: z.number().int().min(1).max(1_000_000).default(200),
    checkIntervalSec: z.number().int().min(5).max(3600).default(30),
  })
  .strict()
  .refine((c) => c.hardFreeMb <= c.minFreeMb, { message: "hardFreeMb must not be more than minFreeMb", path: ["hardFreeMb"] });

/** The section with defaults filled in, for code that may see a config the module did not parse (the command line). */
export const storageSettings = (config) => {
  const r = STORAGE_CONFIG_SCHEMA.safeParse(config?.storage ?? {});
  return r.success ? r.data : STORAGE_CONFIG_SCHEMA.parse({});
};
