/**
 * `mc-bridge download ...`: start and follow history downloads from the terminal. It talks to the RUNNING Bridge over
 * loopback (the same routes as everyone else), on this computer without a key (the local control token), or with --key.
 *
 *   mc-bridge download NSE:NIFTY NSE:RELIANCE --interval 5m --from 2024-01-01 [--to 2024-12-31] [--format csv|jsonl|amibroker]
 *                      [--layout per-symbol|combined] [--dataset nifty-5m] [--collection my-list] [--account id] [--backup]
 *                      [--name text] [--tags a,b] [--after-hours] [--allow-expired] [--dry-run] [--watch] [--json]
 *   mc-bridge download list [--status running] | show <id> | pause <id> | resume <id> | cancel <id> | delete <id>
 *   mc-bridge download files <id> [--out <folder>]       list the files; with --out, save them and check each hash
 *   mc-bridge download datasets                           list datasets;   download update <dataset>   fetch what is new
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BridgeError } from "../core/errors.mjs";

const FINISHED = new Set(["done", "failed", "cancelled"]);

/** 1536 -> "1.5 KB". */
export function formatBytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** 4000 -> "1h 07m". null -> "unknown". */
export function formatDuration(sec) {
  if (!Number.isFinite(sec)) return "unknown";
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, "0")} min`;
  return `${Math.round(h / 24)} days`;
}

/** The estimate as plain lines. */
export function formatEstimate(e) {
  const lines = [
    `${e.symbols} symbol${e.symbols === 1 ? "" : "s"} x ${e.intervals} interval${e.intervals === 1 ? "" : "s"}: about ${e.rows.toLocaleString("en-US")} rows, ${formatBytes(e.bytes)} on disk.`,
    `Broker calls: ${e.brokerCalls}${e.callsSaved ? ` (${e.callsSaved} saved because that part is already on this computer)` : ""}. Time at your ${Math.round(e.budgetShare * 100)}% share of the budget: ${formatDuration(e.etaSec)}.`,
  ];
  if (e.disk?.wouldExceed) lines.push(`This would pass the disk limit (${formatBytes(e.disk.maxBytes)}; ${formatBytes(e.disk.usedBytes)} used).`);
  for (const n of e.notes ?? []) lines.push(`Note: ${n}`);
  return lines.join("\n");
}

/** One progress line. */
export function formatProgress(j) {
  const p = j.progress;
  const bits = [`${j.id}  ${j.status}`, `${p.done}/${p.total} done${p.failed ? `, ${p.failed} failed` : ""}`, `${p.rows.toLocaleString("en-US")} rows`, formatBytes(p.bytes)];
  if (p.current) bits.push(`${p.current.symbol} ${p.current.interval}`);
  if (p.etaSec !== null && p.etaSec !== undefined && j.status === "running") bits.push(`about ${formatDuration(p.etaSec)} left`);
  if (p.waiting) bits.push(`waiting: ${p.waiting.reason}`);
  if (j.status === "paused" && j.message) bits.push(j.message);
  return bits.join("  |  ");
}

/** The job list as a table. */
export function formatJobs(jobs) {
  if (!jobs.length) return "No download jobs yet.";
  const rows = [["ID", "STATUS", "NAME", "DONE", "ROWS", "CLASS"], ...jobs.map((j) => [j.id, j.status, j.name.slice(0, 28), `${j.progress.done}/${j.progress.total}`, j.progress.rows.toLocaleString("en-US"), j.dataClass])];
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => String(c).padEnd(w[i])).join("  ").trimEnd()).join("\n");
}

/** One job in detail. */
export function formatJob(j) {
  const lines = [formatProgress(j), `Name: ${j.name}${j.dataset ? `   Dataset: ${j.dataset}` : ""}`, `Data: ${j.dataClass}${j.source ? ` from ${j.source}` : ""}${j.delaySec ? `, delayed by about ${j.delaySec} s` : ""}${j.official === false ? ", unofficial" : ""}.`];
  if (j.callsSaved) lines.push(`Broker calls saved: ${j.callsSaved}.`);
  if (j.failure) {
    const f = j.failure;
    lines.push(`Why it failed: ${f.message} (${f.code})`, `Fix: ${f.fix}`);
    if (f.failedItems > 1) lines.push(`${f.failedItems} items failed; the first is ${f.symbol} ${f.interval}.`);
  } else if (j.message) lines.push(`Message: ${j.message}`);
  const bad = (j.items ?? []).filter((i) => i.status === "failed");
  for (const i of bad.slice(0, 10)) lines.push(`  failed: ${i.symbol} ${i.interval}: ${i.error?.message ?? i.error?.code}${i.error?.code && i.error?.message ? ` (${i.error.code})` : ""}`);
  for (const n of (j.notes ?? []).slice(0, 12)) lines.push(`  note: ${n}`);
  return lines.join("\n");
}

/** Build the request body from the command line. */
export function requestFromFlags(symbols, flags) {
  const body = {};
  const list = (v) => String(v).split(",").map((s) => s.trim()).filter(Boolean);
  const syms = symbols.flatMap((s) => list(s));
  if (syms.length) body.symbols = syms;
  if (typeof flags.collection === "string") body.collection = flags.collection;
  if (typeof flags.interval === "string") body.intervals = list(flags.interval);
  if (typeof flags.from === "string") body.from = flags.from;
  if (typeof flags.to === "string") body.to = flags.to;
  if (typeof flags.format === "string") body.format = flags.format;
  if (typeof flags.layout === "string") body.layout = flags.layout;
  if (typeof flags.dataset === "string") body.dataset = flags.dataset;
  if (typeof flags.account === "string") body.account = flags.account;
  if (typeof flags.name === "string") body.name = flags.name;
  if (typeof flags.tags === "string") body.tags = list(flags.tags);
  if (flags.backup === true) body.backup = true;
  if (flags["after-hours"] === true) body.afterHoursOnly = true;
  if (flags["allow-expired"] === true) body.allowExpired = true;
  return body;
}

/**
 * @param {string[]} args after "download"
 * @param {Record<string, string | boolean | undefined>} flags
 * @param {{ out(s: string): void, err(s: string): void, sleep?: (ms: number) => Promise<void> }} io
 * @param {{ connect: () => Promise<{ call: (method: string, path: string, body?: any) => Promise<any>, raw?: (path: string) => Promise<Buffer> }>, cli: string }} helpers
 */
export async function downloadCommand(args, flags, io, helpers) {
  const cli = helpers.cli;
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const [first, second] = args;
  const needId = () => {
    if (!second) throw new BridgeError("VALIDATION_FAILED", `download ${first} needs a job id. List them with: ${cli} download list`);
    return encodeURIComponent(second);
  };

  if (first === "list") {
    const { call } = await helpers.connect();
    const q = typeof flags.status === "string" ? `?status=${encodeURIComponent(flags.status)}` : "";
    const { data } = await call("GET", `/v1/downloads${q}`);
    io.out(flags.json ? JSON.stringify(data, null, 2) : formatJobs(data));
    return 0;
  }
  if (first === "show") {
    const { call } = await helpers.connect();
    const { data } = await call("GET", `/v1/downloads/${needId()}`);
    io.out(flags.json ? JSON.stringify(data, null, 2) : formatJob(data));
    return 0;
  }
  if (first === "pause" || first === "resume" || first === "cancel") {
    const { call } = await helpers.connect();
    const { data } = await call("POST", `/v1/downloads/${needId()}/${first}`, {});
    io.out(flags.json ? JSON.stringify(data, null, 2) : formatProgress(data));
    return 0;
  }
  if (first === "delete") {
    const { call } = await helpers.connect();
    await call("DELETE", `/v1/downloads/${needId()}`);
    io.out(`Deleted ${second} and its files.`);
    return 0;
  }
  if (first === "files") {
    const { call, raw } = await helpers.connect();
    const id = needId();
    const { data } = await call("GET", `/v1/downloads/${id}/files`);
    if (typeof flags.out === "string") {
      if (!raw) throw new BridgeError("VALIDATION_FAILED", "Saving files needs a running Bridge connection.");
      const dir = resolve(io.cwd ?? process.cwd(), flags.out);
      mkdirSync(dir, { recursive: true });
      for (const f of [...data, { name: "manifest.json", sha256: null }]) {
        // A name the server sent is only ever a plain file name: never a path, so it cannot write outside the folder.
        if (typeof f.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(f.name)) throw new BridgeError("UPSTREAM_ERROR", `The Bridge sent a file name that is not a plain file name (${JSON.stringify(String(f.name).slice(0, 60))}). Nothing more was saved.`);
        const target = join(dir, f.name);
        if (existsSync(target) && flags.force !== true) throw new BridgeError("STATE_CONFLICT", `${target} already exists. Choose another folder, or add --force to replace it.`);
        const bytes = await raw(`/v1/downloads/${id}/files/${encodeURIComponent(f.name)}`);
        if (f.sha256 && createHash("sha256").update(bytes).digest("hex") !== f.sha256) throw new BridgeError("UPSTREAM_ERROR", `${f.name} did not match its checksum. Download it again.`);
        // written as a .part file and renamed, so an interrupted save never leaves a half file under the real name
        writeFileSync(`${target}.part`, bytes);
        renameSync(`${target}.part`, target);
        io.out(`Saved ${target}${f.sha256 ? " (checksum matches)" : ""}`);
      }
      return 0;
    }
    if (flags.json) io.out(JSON.stringify(data, null, 2));
    else if (!data.length) io.out("This job has no files (yet).");
    else for (const f of data) io.out(`${f.name}  ${f.rows.toLocaleString("en-US")} rows  ${formatBytes(f.bytes)}  ${f.firstBar ?? "-"} to ${f.lastBar ?? "-"}  sha256 ${f.sha256 ?? "-"}`);
    return 0;
  }
  if (first === "datasets") {
    const { call } = await helpers.connect();
    const { data } = await call("GET", "/v1/datasets");
    if (flags.json) io.out(JSON.stringify(data, null, 2));
    else if (!data.length) io.out(`No datasets yet. Start one with: ${cli} download NSE:NIFTY --interval 5m --from 2024-01-01 --dataset nifty-5m`);
    else for (const d of data) io.out(`${d.name}  ${d.series} file${d.series === 1 ? "" : "s"}  ${d.rows.toLocaleString("en-US")} rows  ${formatBytes(d.bytes)}  ${d.dataClass}${d.gaps ? `  ${d.gaps} gap${d.gaps === 1 ? "" : "s"}` : ""}${d.tags.length ? `  [${d.tags.join(", ")}]` : ""}`);
    return 0;
  }
  if (first === "update") {
    if (!second) throw new BridgeError("VALIDATION_FAILED", `download update needs a dataset name. List them with: ${cli} download datasets`);
    const { call } = await helpers.connect();
    const { data } = await call("POST", `/v1/datasets/${encodeURIComponent(second)}/update`, {});
    io.out(`Started ${data.id} to fetch what is new for ${second}.`);
    return flags.watch ? watch(call, data.id, io, flags, sleep) : 0;
  }

  // download <symbols...> --interval ... --from ...: start a job
  const body = requestFromFlags(args, flags);
  if (!body.symbols && !body.collection) {
    io.err(`Give at least one symbol (for example NSE:NIFTY) or --collection <name>.\nExample: ${cli} download NSE:NIFTY --interval 5m --from 2024-01-01\nOther commands: ${cli} download list | show <id> | pause <id> | resume <id> | cancel <id> | files <id> | datasets | update <dataset>`);
    return 1;
  }
  if (!body.intervals || !body.from) {
    io.err(`A download needs --interval (for example 5m, or 5m,15m) and --from (for example 2024-01-01).`);
    return 1;
  }
  const { call } = await helpers.connect();
  if (flags["dry-run"]) {
    const { data } = await call("POST", "/v1/downloads?dryRun=1", body);
    io.out(flags.json ? JSON.stringify(data, null, 2) : `${formatEstimate(data)}\nThis was a dry run: nothing was started.`);
    return data.disk?.wouldExceed ? 1 : 0;
  }
  const est = await call("POST", "/v1/downloads?dryRun=1", body).then((r) => r.data, () => null);
  const { data: job } = await call("POST", "/v1/downloads", body);
  if (flags.json && !flags.watch) {
    io.out(JSON.stringify(job, null, 2));
    return 0;
  }
  if (est && !flags.json) io.out(formatEstimate(est));
  io.out(`Started ${job.id}. Follow it with: ${cli} download show ${job.id}${flags.watch ? "" : "   (or add --watch)"}`);
  return flags.watch ? watch(call, job.id, io, flags, sleep) : 0;
}

/** Print progress until the job ends. Exit 0 for done, 1 for anything else. */
async function watch(call, id, io, flags, sleep) {
  let last = "";
  for (;;) {
    const { data } = await call("GET", `/v1/downloads/${encodeURIComponent(id)}`);
    const line = formatProgress(data);
    if (line !== last) io.out(line);
    last = line;
    if (FINISHED.has(data.status)) {
      if (!flags.json) io.out(formatJob(data));
      else io.out(JSON.stringify(data, null, 2));
      return data.status === "done" ? 0 : 1;
    }
    await sleep(1000);
  }
}
