/**
 * The `backup` entry of GET /v1/health (shown to callers on this computer only): when the last backup was made, whether
 * the last one failed and whether the daily schedule is on. One small file read; never throws.
 */
import { backupSettings } from "./config.mjs";
import { readBackupStatus } from "./manager.mjs";

/** @param {{ config: any, dataDir: string }} o */
export function backupHealth({ config, dataDir }) {
  try {
    const st = readBackupStatus(dataDir);
    const sch = backupSettings(config).schedule;
    return {
      lastBackupAt: st.lastOk?.at ?? null,
      lastBackupBytes: st.lastOk?.bytes ?? null,
      lastError: st.lastFailure ? { at: st.lastFailure.at, kind: st.lastFailure.kind, message: st.lastFailure.message } : null,
      schedule: { enabled: sch.enabled, time: sch.time },
    };
  } catch {
    return undefined;
  }
}
