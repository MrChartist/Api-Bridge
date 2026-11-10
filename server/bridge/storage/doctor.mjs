/**
 * Doctor lines for the data folder itself, and the one place that gathers the lines of the newer parts (downloads,
 * recordings, webhooks, collections). Everything is read from files (the Bridge need not be running) and nothing is
 * created.
 *
 *   data-folder lock   who holds bridge.lock (process id, port), or a left-over lock that the next start takes over
 *   disk               free space against storage.minFreeMb and hardFreeMb
 *   set-aside files    every *.corrupt-* file in the data folder (a damaged file moved aside), with what to do
 *   order records      the damage marker: live orders refused until acknowledged
 *   temp files         cut-off writes left behind
 *   audit              size of the audit log
 *
 * Lines marked `blocking` fail `mc-bridge doctor --strict`: a disk below the hard floor, files set aside, damaged
 * recordings or jobs, damaged order records.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findCorruptFiles } from "../../lib/safeStore.mjs";
import { downloadsDoctorChecks } from "../downloads/doctor.mjs";
import { eventsDoctorChecks } from "../events/doctor.mjs";
import { libraryDoctorChecks } from "../library/doctor.mjs";
import { recorderDoctorChecks } from "../recorder/doctor.mjs";
import { cliCommand } from "../core/cliName.mjs";
import { inspectLock } from "../core/instanceLock.mjs";
import { storageSettings } from "./config.mjs";
import { diskSpace } from "./monitor.mjs";

const MB = 1024 * 1024;

/**
 * @param {{ config: any, env?: NodeJS.ProcessEnv, now?: number, statfs?: (dir: string) => any }} o
 * @returns {Array<{ level: "ok"|"warn"|"fail", check: string, message: string, fix?: string, blocking?: boolean }>}
 */
export function storageDoctorChecks({ config, env = process.env, now = Date.now(), statfs }) {
  const out = [];
  const dir = config.dataDir;
  if (!existsSync(dir)) return out;
  const cli = cliCommand(env);
  try {
    const lock = inspectLock(dir, { now: () => now });
    if (lock.held && lock.owner && lock.owner.pid !== process.pid) out.push({ level: "ok", check: "instance", message: `A Bridge is running on this data folder (process ${lock.owner.pid}${lock.owner.port ? `, port ${lock.owner.port}` : ""}, started ${lock.owner.startedAt.replace("T", " ").slice(0, 16)}). A second one would be refused.` });
    else if (lock.stale) out.push({ level: "ok", check: "instance", message: `A left-over lock file from a Bridge that stopped (${lock.reason}). The next start takes it over.` });
    else if (!lock.held) out.push({ level: "ok", check: "instance", message: "No Bridge is using this data folder right now" });
  } catch {
    /* unreadable: the data-dir check reports it */
  }

  const cfg = storageSettings(config);
  const space = diskSpace(dir, statfs);
  if (space) {
    const freeMb = Math.floor(space.freeBytes / MB);
    const level = freeMb < cfg.hardFreeMb ? "critical" : freeMb < cfg.minFreeMb ? "low" : "ok";
    out.push({
      level: level === "ok" ? "ok" : "warn",
      check: "disk",
      message: `${freeMb} MB free where the data folder is${level === "ok" ? "" : level === "low" ? ` (below ${cfg.minFreeMb} MB: delete old downloads and recordings)` : ` (below ${cfg.hardFreeMb} MB: downloads pause, and changes may fail to save)`}`,
      ...(level === "critical" ? { blocking: true } : {}),
    });
  }

  const aside = findCorruptFiles(dir);
  if (aside.length) {
    out.push({
      level: "warn",
      check: "set-aside-files",
      message: `${aside.length} damaged file${aside.length === 1 ? " was" : "s were"} set aside by an earlier start (${aside.slice(0, 3).map((f) => f.file.slice(dir.length + 1)).join(", ")}${aside.length > 3 ? ", ..." : ""}). The Bridge started without ${aside.length === 1 ? "it" : "them"}.`,
      fix: "Look at what was lost (the copy is kept next to the new file), recreate it if needed, then delete the *.corrupt-* copies.",
      blocking: true,
    });
  }

  if (existsSync(join(dir, "orders", "state-damaged.json"))) {
    out.push({ level: "warn", check: "order-records", message: "The record of sent orders was damaged and set aside. Paper orders work; LIVE orders are refused until you have checked your broker's order book.", fix: `${cli} orders acknowledge-state`, blocking: true });
  }

  try {
    let temps = 0;
    const walk = (d, depth) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (depth < 2 && !["backups", "downloads", "recordings"].includes(e.name)) walk(join(d, e.name), depth + 1);
        } else if (e.name.endsWith(".tmp")) {
          try {
            if (now - statSync(join(d, e.name)).mtimeMs > 3_600_000) temps += 1;
          } catch {
            /* gone */
          }
        }
      }
    };
    walk(dir, 0);
    if (temps) out.push({ level: "warn", check: "temp-files", message: `${temps} temp file${temps === 1 ? "" : "s"} from a cut-off write ${temps === 1 ? "is" : "are"} left in the data folder. The Bridge removes ${temps === 1 ? "it" : "them"} at the next start.` });
  } catch {
    /* unreadable */
  }

  try {
    const auditDir = join(dir, "audit");
    if (existsSync(auditDir)) {
      let bytes = 0;
      for (const n of readdirSync(auditDir)) bytes += statSync(join(auditDir, n)).size;
      out.push({ level: bytes > 500 * MB ? "warn" : "ok", check: "audit-log", message: `The audit log is ${Math.round(bytes / MB)} MB${bytes > 500 * MB ? " (a looping script can fill it with refused orders; find the client that keeps retrying)" : ""}` });
    }
  } catch {
    /* unreadable */
  }
  return out;
}

/** Everything the newer parts add to `doctor`. @returns {Array<{ level: "ok"|"warn"|"fail", check: string, message: string, fix?: string, blocking?: boolean }>} */
export function opsDoctorChecks({ config, env = process.env, now = Date.now() }) {
  const parts = [storageDoctorChecks({ config, env, now }), downloadsDoctorChecks({ config, now }), recorderDoctorChecks({ config, now }), eventsDoctorChecks({ config, now }), libraryDoctorChecks({ config })];
  return parts.flat();
}
