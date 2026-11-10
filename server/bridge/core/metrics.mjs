/**
 * GET /v1/metrics: the Bridge's own numbers as Prometheus text (it also reads fine as plain text).
 *
 * Counters and gauges only. No symbol, API key, account id or file name is ever a label or a value: the only labels are
 * fixed words (status class, a subscription's own id is NOT used either). Admin scope, this computer only.
 *
 * Parts register what they know with addMetrics(deps, fn); fn() returns rows
 * { name, help?, type?: "gauge" | "counter", value, labels? }. A part that throws is left out of the answer.
 */
import { readdirSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { quarantined, writeFailureStatus } from "../../lib/storageHealth.mjs";
import { backupHealth } from "../backup/health.mjs";
import { storageMonitorOf } from "../storage/registry.mjs";

/** deps -> Array<() => Row[]> */
const providers = new WeakMap();

/** Register a metrics provider for an app. @param {object} deps @param {() => Array<object>} fn */
export function addMetrics(deps, fn) {
  if (!providers.has(deps)) providers.set(deps, []);
  providers.get(deps).push(fn);
}

/** Open file handles of this process (Linux and macOS: /proc or /dev/fd), or null. */
export function openFds() {
  for (const dir of ["/proc/self/fd", "/dev/fd"]) {
    try {
      return readdirSync(dir).length;
    } catch {
      /* try the next */
    }
  }
  return null;
}

/** An event-loop delay histogram (p99 in seconds) for the life of the app. */
export function createLoopLag() {
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  return { p99Seconds: () => (h.count ? h.percentile(99) / 1e9 : 0), stop: () => h.disable() };
}

const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/** Prometheus text for rows, grouped so each name has one HELP and TYPE line. */
export function toPrometheus(rows) {
  const byName = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.value)) continue;
    if (!byName.has(r.name)) byName.set(r.name, { help: r.help, type: r.type ?? "gauge", rows: [] });
    byName.get(r.name).rows.push(r);
  }
  const out = [];
  for (const [name, g] of byName) {
    if (g.help) out.push(`# HELP ${name} ${g.help}`);
    out.push(`# TYPE ${name} ${g.type}`);
    for (const r of g.rows) {
      const labels = r.labels && Object.keys(r.labels).length ? `{${Object.entries(r.labels).map(([k, v]) => `${k}="${esc(v)}"`).join(",")}}` : "";
      out.push(`${name}${labels} ${r.value}`);
    }
  }
  return `${out.join("\n")}\n`;
}

/**
 * @param {object} deps
 * @param {{ startedAt: number, http: Map<string, number>, loopLag: { p99Seconds(): number }, config: any, now?: () => number }} o
 */
export function renderMetrics(deps, { startedAt, http, loopLag, config, now = () => Date.now() }) {
  const rows = [];
  const add = (name, value, help, type = "gauge", labels) => rows.push({ name, value, help, type, ...(labels ? { labels } : {}) });
  add("bridge_uptime_seconds", Math.round((now() - startedAt) / 1000), "Seconds since the Bridge started.");
  const mem = process.memoryUsage();
  add("process_resident_memory_bytes", mem.rss, "Resident memory of the Bridge process.");
  add("nodejs_heap_used_bytes", mem.heapUsed, "JavaScript heap in use.");
  const fds = openFds();
  if (fds !== null) add("process_open_fds", fds, "Open file handles.");
  add("nodejs_eventloop_lag_p99_seconds", loopLag.p99Seconds(), "99th percentile delay of the event loop.");
  for (const [cls, n] of http) add("bridge_http_requests_total", n, "Requests answered, by status class.", "counter", { status_class: cls });
  const st = storageMonitorOf(deps)?.status();
  if (st) {
    if (st.freeMb !== null) add("bridge_storage_free_bytes", st.freeMb * 1024 * 1024, "Free space on the disk holding the data folder.");
    add("bridge_storage_write_errors_total", st.writeErrors.total, "Writes of state files that failed since the Bridge started.", "counter");
    add("bridge_storage_write_errors_open", st.writeErrors.open, "Files that could not be written and have not been written since.");
  }
  add("bridge_write_failures_open", writeFailureStatus({ under: config.dataDir }).openCount, "Same as bridge_storage_write_errors_open, from the shared write counter.");
  add("bridge_quarantined_files", quarantined({ under: config.dataDir }).length, "Damaged files moved aside since the Bridge started.");
  try {
    const b = backupHealth({ config, dataDir: config.dataDir });
    if (b?.lastBackupAt) add("bridge_backup_last_success_age_seconds", Math.max(0, Math.round((now() - Date.parse(b.lastBackupAt)) / 1000)), "Seconds since the last backup was written.");
  } catch {
    /* no backup status */
  }
  for (const fn of providers.get(deps) ?? []) {
    try {
      for (const r of fn()) rows.push(r);
    } catch {
      /* a part that cannot answer is left out */
    }
  }
  return toPrometheus(rows);
}
