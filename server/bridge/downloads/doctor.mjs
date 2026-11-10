/**
 * Doctor lines for downloads, read from the files (the Bridge need not be running): how much room the folder uses against
 * downloads.maxDiskMb, jobs that failed, are paused or have been stuck for a day, job folders nobody can see (no job.json),
 * and damaged jobs. Creates nothing.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseDownloadsConfig } from "./config.mjs";

const DAY = 86_400_000;
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

/**
 * @param {{ config: any, now?: number }} o
 * @returns {Array<{ level: "ok"|"warn", check: string, message: string, blocking?: boolean }>}
 */
export function downloadsDoctorChecks({ config, now = Date.now() }) {
  const out = [];
  const root = join(config.dataDir, "downloads");
  if (!existsSync(root)) return out;
  const cfg = parseDownloadsConfig(config.downloads);
  if (!cfg.enabled) return out;
  const jobsDir = join(root, "jobs");
  const counts = { done: 0, failed: 0, paused: 0, cancelled: 0, active: 0 };
  const stuck = [];
  const damaged = [];
  const orphans = [];
  let names = [];
  try {
    names = readdirSync(jobsDir);
  } catch {
    names = [];
  }
  for (const id of names.filter((n) => /^dl_[0-9a-f]{12}$/.test(n))) {
    const file = join(jobsDir, id, "job.json");
    if (!existsSync(file)) {
      orphans.push(id);
      continue;
    }
    let job;
    try {
      job = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      damaged.push(id);
      continue;
    }
    if (job?.damaged) damaged.push(id);
    const status = job?.status;
    if (status === "done") counts.done += 1;
    else if (status === "failed") counts.failed += 1;
    else if (status === "cancelled") counts.cancelled += 1;
    else if (status === "paused") counts.paused += 1;
    else counts.active += 1;
    const since = Date.parse(job?.startedAt ?? job?.createdAt ?? "");
    if ((status === "queued" || status === "running" || status === "paused") && Number.isFinite(since) && now - since > DAY) stuck.push(id);
  }
  const bytes = sizeOf(root);
  const pct = Math.round((bytes / (cfg.maxDiskMb * MB)) * 100);
  const total = counts.done + counts.failed + counts.paused + counts.cancelled + counts.active;
  out.push({ level: pct >= 90 ? "warn" : "ok", check: "downloads", message: `${total} job${total === 1 ? "" : "s"} (${counts.done} done, ${counts.active} waiting or running, ${counts.paused} paused, ${counts.failed} failed); ${Math.round(bytes / MB)} MB of the ${cfg.maxDiskMb} MB limit (${pct}%)${pct >= 90 ? ". Delete old downloads on the Data page before writing stops" : ""}` });
  if (counts.failed) out.push({ level: "warn", check: "downloads", message: `${counts.failed} download job${counts.failed === 1 ? "" : "s"} failed. Open the Data page to see why, or delete them.` });
  if (stuck.length) out.push({ level: "warn", check: "downloads", message: `${stuck.length} job${stuck.length === 1 ? " has" : "s have"} been waiting, running or paused for more than a day (${stuck.slice(0, 3).join(", ")}). Resume or cancel ${stuck.length === 1 ? "it" : "them"}.` });
  if (damaged.length) out.push({ level: "warn", check: "downloads", message: `${damaged.length} job${damaged.length === 1 ? "" : "s"} could not be read and ${damaged.length === 1 ? "was" : "were"} set aside (${damaged.slice(0, 3).join(", ")}). The files are kept; delete the job${damaged.length === 1 ? "" : "s"} on the Data page to free the space.`, blocking: true });
  if (orphans.length) out.push({ level: "warn", check: "downloads", message: `${orphans.length} folder${orphans.length === 1 ? "" : "s"} under downloads/jobs ha${orphans.length === 1 ? "s" : "ve"} no job.json, so no page lists ${orphans.length === 1 ? "it" : "them"} but ${orphans.length === 1 ? "it counts" : "they count"} towards the limit (${orphans.slice(0, 3).join(", ")}). Delete ${orphans.length === 1 ? "it" : "them"} by hand.` });
  return out;
}
