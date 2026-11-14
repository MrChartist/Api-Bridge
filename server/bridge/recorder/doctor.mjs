/**
 * Doctor lines for recordings, read from the files (the Bridge need not be running): how many recordings, the folder size
 * against recorder.maxDiskMb, recordings whose settings file was damaged, whether auto-record is on, and a recording
 * that should be writing but has been silent for a while. Creates nothing.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const MB = 1024 * 1024;

function sizeOf(dir, budget = { left: 200_000 }) {
  let total = 0;
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of ents) {
    if (budget.left-- <= 0) return total;
    const p = join(dir, e.name);
    try {
      if (e.isDirectory()) total += sizeOf(p, budget);
      else if (e.isFile()) total += statSync(p).size;
    } catch {
      /* gone */
    }
  }
  return total;
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/**
 * @param {{ config: any, now?: number }} o
 * @returns {Array<{ level: "ok"|"warn", check: string, message: string, blocking?: boolean }>}
 */
export function recorderDoctorChecks({ config, now = Date.now() }) {
  const out = [];
  const root = join(config.dataDir, "recordings");
  const rc = config.recorder ?? {};
  if (!existsSync(root) || rc.enabled === false) return out;
  const maxDiskMb = Number.isFinite(rc.maxDiskMb) ? rc.maxDiskMb : 5000;
  const ids = readdirSync(root).filter((n) => /^(rec_[a-z0-9]{4,20}|rule-[a-z0-9-]{2,41})$/.test(n));
  let active = 0;
  const damaged = [];
  const silent = [];
  for (const id of ids) {
    const def = readJson(join(root, id, "recording.json"));
    if (!def) continue; // not yet set aside: the Bridge handles it at start
    if (def.damaged) {
      damaged.push(id);
      continue;
    }
    if (def.status === "active") {
      active += 1;
      const st = readJson(join(root, id, "state.json"));
      const last = Number(st?.lastWriteMs);
      const every = Number(def.everySec) || 60;
      // A recording that writes every N seconds and has not written for 10x that (at least 15 minutes), while the Bridge ran.
      if (Number.isFinite(last) && now - last > Math.max(15 * 60_000, every * 10_000) && st?.phase === "recording") silent.push(id);
    }
  }
  const bytes = sizeOf(root);
  const pct = Math.round((bytes / (maxDiskMb * MB)) * 100);
  out.push({ level: pct >= 90 ? "warn" : "ok", check: "recordings", message: `${ids.length} recording${ids.length === 1 ? "" : "s"} (${active} active); ${Math.round(bytes / MB)} MB of the ${maxDiskMb} MB limit (${pct}%)${pct >= 90 ? ". Delete old recordings or set a retention (recorder.retentionDays) before writing stops" : ""}` });
  // The switch the person set (Data page, preset, CLI) is stored in recordings/settings.json and wins over the config value,
  // exactly as the service reads it (service.mjs: autoOn). Rules are the config's plus the ones saved in recordings/rules.json.
  const stored = readJson(join(root, "settings.json"))?.autoRecord?.enabled;
  const autoOn = typeof stored === "boolean" ? stored : Boolean(rc.autoRecord?.enabled);
  const savedRules = (readJson(join(root, "rules.json"))?.rules ?? []).filter((r) => r && typeof r.id === "string").length;
  const ruleCount = (rc.autoRecord?.rules ?? []).length + savedRules;
  out.push({ level: "ok", check: "auto-record", message: autoOn ? `Auto-record is on (${ruleCount} rule${ruleCount === 1 ? "" : "s"})` : "Auto-record is off (turn it on from the Data page when you want recording to happen by itself)" });
  if (damaged.length) out.push({ level: "warn", check: "recordings", message: `${damaged.length} recording${damaged.length === 1 ? "" : "s"} lost ${damaged.length === 1 ? "its" : "their"} settings file (${damaged.slice(0, 3).join(", ")}). The saved files are kept; delete ${damaged.length === 1 ? "it" : "them"} on the Data page to free the space.`, blocking: true });
  if (silent.length) out.push({ level: "warn", check: "recordings", message: `${silent.length} recording${silent.length === 1 ? " has" : "s have"} written nothing for a long while (${silent.slice(0, 3).join(", ")}). Check the broker login and the feed.` });
  return out;
}
