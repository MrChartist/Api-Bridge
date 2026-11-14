/**
 * Doctor lines for backups: is there a recent copy, did a backup fail, is the schedule on.
 * Reads one small file (backups/status.json); creates nothing.
 */
import { existsSync } from "node:fs";
import { cliCommand } from "../core/cliName.mjs";
import { backupSettings } from "./config.mjs";
import { readBackupStatus } from "./manager.mjs";
import { collectDataFiles } from "./paths.mjs";

const DAY = 86_400_000;

/**
 * @param {{ config: any, env?: NodeJS.ProcessEnv, now?: number }} o
 * @returns {Array<{ level: "ok"|"warn", check: string, message: string }>}
 */
export function backupDoctorChecks({ config, env = process.env, now = Date.now() }) {
  const out = [];
  const cli = cliCommand(env);
  const dataDir = config.dataDir;
  if (!existsSync(dataDir)) return out;
  const st = readBackupStatus(dataDir);
  const sch = backupSettings(config).schedule;
  if (st.lastFailure) {
    out.push({ level: "warn", check: "backup", message: `The last ${st.lastFailure.kind} backup failed (${st.lastFailure.at}): ${st.lastFailure.message}` });
  }
  if (st.lastOk) {
    const days = Math.floor((now - Date.parse(st.lastOk.at)) / DAY);
    const old = sch.enabled ? days >= 3 : days >= 30;
    const when = days <= 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`;
    out.push({ level: old ? "warn" : "ok", check: "backup", message: `Last backup ${st.lastOk.at.slice(0, 16).replace("T", " ")} (${when}, ${st.lastOk.kind}).${old ? ` Make a fresh one: ${cli} backup` : ""}` });
  } else {
    let hasData = false;
    try {
      hasData = collectDataFiles(dataDir, { includeSecrets: true }).files.length > 0;
    } catch {
      /* unreadable folder: the data-dir check reports it */
    }
    if (hasData) out.push({ level: "warn", check: "backup", message: `No backup of your data yet. Make one now: ${cli} backup --out <file> (then copy it to another disk).` });
  }
  out.push({ level: "ok", check: "backup-schedule", message: sch.enabled ? `Daily backup at ${sch.time}, keeping the newest ${sch.keep}` : "Daily backup is off (turn it on with backup.schedule.enabled in bridge.config.json)" });
  return out;
}
