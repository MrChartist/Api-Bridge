/**
 * The fno store on disk (stream S19, docs/spec/p1-06-stocks.md §2.3):
 *
 *   <dataDir>/fno/                   0700
 *     settings.json                  { version, optIn: { stocks, setAt, setBy }, autoRepeat: { background } }
 *     sweep/state.json               the running or last job
 *     sweep/<jobId>.ndjson           one line per finished chain (current + previous job kept: keepJobs)
 *     oi-base/<YYYY-MM-DD>.json      the first OI seen today per contract (quotes-path ΔOI)
 *     hv/<YYYY-MM-DD>.json           HV20 per underlying for that IST day
 *
 * Every JSON file is { "version": 1, ... } and written atomically (server/lib/jsonl.mjs writeFileAtomic). A JSON file
 * that does not parse is moved aside as <name>.corrupt-<stamp> and the store starts empty (BRD §7.7); a torn last
 * line of a job file is skipped. The store holds no secrets: job files name the account id, as freshness does.
 * `memory: true` (demo mode) keeps everything in memory and writes nothing.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { appendLineSync, pruneDated, quarantine, readLinesSync, writeFileAtomic } from "../../lib/jsonl.mjs";

const DIR_MODE = 0o700;
const JOB_FILE = /^(swp_[A-Za-z0-9_-]+)\.ndjson$/;

/**
 * @param {string|null} dir  <dataDir>/fno (null: memory only)
 * @param {{ now?: () => number, logger?: any, memory?: boolean }} [o]
 */
export function createSweepStore(dir, { now = () => Date.now(), logger, memory = false } = {}) {
  const mem = { files: new Map(), lines: new Map() };
  const onDisk = Boolean(dir) && !memory;
  const sweepDir = onDisk ? join(dir, "sweep") : null;
  const baseDir = onDisk ? join(dir, "oi-base") : null;
  const hvDir = onDisk ? join(dir, "hv") : null;
  if (onDisk) for (const d of [dir, sweepDir, baseDir, hvDir]) mkdirSync(d, { recursive: true, mode: DIR_MODE });

  /** Read one JSON document; quarantine it when it does not parse; `empty()` when missing or bad. */
  function readJson(file, empty) {
    if (!onDisk) return mem.files.has(file) ? structuredClone(mem.files.get(file)) : empty();
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") return empty();
      throw err;
    }
    try {
      const v = JSON.parse(text);
      if (!v || typeof v !== "object" || v.version !== 1) throw new Error("not a version 1 document");
      return v;
    } catch {
      const moved = quarantine(file, { now: now() });
      logger?.warn?.("fno: a store file could not be read and was moved aside", { file: moved });
      return empty();
    }
  }
  function writeJson(file, value) {
    if (!onDisk) return void mem.files.set(file, structuredClone(value));
    writeFileAtomic(file, `${JSON.stringify(value)}\n`);
  }
  const path = (d, name) => (onDisk ? join(d, name) : `${d ?? "mem"}/${name}`);

  return {
    persisted: onDisk,
    readSettings: () => readJson(path(dir, "settings.json"), () => ({ version: 1, optIn: { stocks: [], setAt: null, setBy: null }, autoRepeat: { background: false } })),
    writeSettings: (s) => writeJson(path(dir, "settings.json"), { ...s, version: 1 }),
    readState: () => readJson(path(sweepDir, "state.json"), () => ({ version: 1, job: null })),
    writeState: (job) => writeJson(path(sweepDir, "state.json"), { version: 1, job }),
    /** Append one finished chain to a job file. */
    appendChain(jobId, line) {
      if (!onDisk) {
        const l = mem.lines.get(jobId) ?? [];
        l.push(structuredClone(line));
        mem.lines.set(jobId, l);
        return;
      }
      appendLineSync(join(sweepDir, `${jobId}.ndjson`), line);
    },
    /** Every chain line of a job (a torn last line is skipped). */
    readChains(jobId) {
      if (!onDisk) return { items: structuredClone(mem.lines.get(jobId) ?? []), corrupt: 0, tornTail: false };
      const r = readLinesSync(join(sweepDir, `${jobId}.ndjson`));
      if (r.corrupt || r.tornTail) logger?.warn?.("fno: skipped unreadable sweep lines", { jobId, corrupt: r.corrupt, tornTail: r.tornTail });
      return { items: r.items.filter((x) => x && typeof x === "object" && typeof x.key === "string"), corrupt: r.corrupt, tornTail: r.tornTail };
    },
    /** Keep `keep` job files in all (by modification time): `current` always, plus the newest others. */
    pruneJobs(keep, current = null) {
      if (!onDisk) {
        const ids = [...mem.lines.keys()].reverse().filter((id) => id !== current);
        const keepIds = new Set(ids.slice(0, current ? Math.max(0, keep - 1) : keep));
        if (current) keepIds.add(current);
        for (const id of ids) if (!keepIds.has(id)) mem.lines.delete(id);
        return;
      }
      let names = [];
      try {
        names = readdirSync(sweepDir).filter((n) => JOB_FILE.test(n));
      } catch {
        names = [];
      }
      const withTime = names.map((n) => ({ n, id: JOB_FILE.exec(n)[1], t: statSync(join(sweepDir, n)).mtimeMs })).sort((a, b) => b.t - a.t || (a.n < b.n ? 1 : -1));
      // `keep` files in all: the current job's plus the newest keep − 1 others (keepJobs 2 = current + previous).
      const keepIds = new Set(withTime.filter((f) => f.id !== current).slice(0, current ? Math.max(0, keep - 1) : keep).map((f) => f.id));
      if (current) keepIds.add(current);
      for (const f of withTime) if (!keepIds.has(f.id)) rmSync(join(sweepDir, f.n), { force: true });
    },
    readOiBase: (date) => readJson(path(baseDir, `${date}.json`), () => ({ version: 1, date, firstAt: {} })),
    writeOiBase: (doc) => writeJson(path(baseDir, `${doc.date}.json`), { ...doc, version: 1 }),
    readHv: (date) => readJson(path(hvDir, `${date}.json`), () => ({ version: 1, date, hv: {} })),
    writeHv: (doc) => writeJson(path(hvDir, `${doc.date}.json`), { ...doc, version: 1 }),
    /** Dated retention for oi-base and hv. */
    pruneDays({ keepDays, today }) {
      if (!onDisk) {
        for (const k of [...mem.files.keys()]) {
          const d = /(\d{4}-\d{2}-\d{2})\.json$/.exec(k)?.[1];
          if (d && d < minusDays(today, keepDays)) mem.files.delete(k);
        }
        return;
      }
      pruneDated(baseDir, { keepDays, today, match: /\.json$/ });
      pruneDated(hvDir, { keepDays, today, match: /\.json$/ });
    },
  };
}

function minusDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}
