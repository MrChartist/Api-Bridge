/**
 * The `backup` config section (the backup module). All optional; zod `.strict()`.
 *
 *   "backup": {
 *     "keep": 5,                 how many automatic snapshots to keep per kind (before an upgrade, before a restore)
 *     "maxSizeMb": 500,          settings and state larger than this are not snapshotted automatically (downloads and recordings are not counted)
 *     "includeData": false,      also put downloads/ and recordings/ into manual and daily backups (large; streamed). Never in the
 *                                copy before an upgrade or before a restore: those stay small and fast
 *     "maxDataFiles": 50000,     more downloads and recordings files than this and a backup with data is refused with a clear message
 *     "manualKeep": 5,           manual backups kept in the data folder (backups made with --out are never removed)
 *     "schedule": {              OFF by default
 *       "enabled": false,
 *       "time": "02:30",         every day at this time on this computer's clock ("HH:MM", 24-hour)
 *       "keep": 7,               how many scheduled backups to keep
 *       "includeSecrets": false  also copy secrets.enc (useless without the original master key)
 *     }
 *   }
 */
import { z } from "zod";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const BACKUP_CONFIG_SCHEMA = z
  .object({
    keep: z.number().int().min(1).max(100).default(5),
    maxSizeMb: z.number().int().min(10).max(10_240).default(500),
    includeData: z.boolean().default(false),
    maxDataFiles: z.number().int().min(1000).max(5_000_000).default(50_000),
    manualKeep: z.number().int().min(1).max(100).default(5),
    schedule: z
      .object({
        enabled: z.boolean().default(false),
        time: z.string().regex(HHMM, 'a time like "02:30" (this computer\'s clock, 24-hour)').default("02:30"),
        keep: z.number().int().min(1).max(365).default(7),
        includeSecrets: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
  })
  .strict();

/**
 * The section with defaults filled in, for code that may see a config that was not parsed by the module (the command
 * line). A section that is not valid is the module's error at start; here it falls back to the defaults.
 */
export const backupSettings = (config) => {
  const r = BACKUP_CONFIG_SCHEMA.safeParse(config?.backup ?? {});
  return r.success ? r.data : BACKUP_CONFIG_SCHEMA.parse({});
};
