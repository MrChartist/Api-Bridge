/**
 * The files of recordings on disk: appends, a listing with row counts, byte accounting, retention (delete old days,
 * optional gzip of finished days) and reading one file back. Layout (see format.mjs and docs/guides/recording.md):
 *
 *   <dataDir>/recordings/<id>/recording.json     what the recording is (written by the service)
 *   <dataDir>/recordings/<id>/state.json         counters kept across a restart
 *   <dataDir>/recordings/<id>/gaps.jsonl         one line per stretch with no data (feed silent, login missing ...)
 *   <dataDir>/recordings/<id>/index.json         rows and bytes per data file (a cache; rebuilt when a file changed)
 *   <dataDir>/recordings/<id>/<YYYY-MM-DD>__<SYMBOL>.csv|jsonl[.gz]     the data: one file per symbol per IST day
 *
 * Files are created 0600 in folders 0700. Nothing here reads the clock; callers pass dates.
 */
import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, statfsSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { writeFileAtomic } from "../../lib/jsonl.mjs";
import { loadJsonOrQuarantine } from "../../lib/safeStore.mjs";
import { csvHeader, countRows, fileNameFor, parseFileName } from "./format.mjs";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
export const RECORDING_ID_RE = /^rec_[a-z0-9]{4,20}$/;

/** Free bytes on the disk that holds `dir`, or null when the platform cannot say. */
export function freeBytesOf(dir) {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** Whether a non-empty file ends without a newline (a crash cut the last write short). */
function endsMidLine(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    if (size === 0) return false;
    const b = Buffer.alloc(1);
    readSync(fd, b, 0, 1, size - 1);
    return b[0] !== 0x0a;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * @param {{ root: string, statfs?: (dir: string) => number | null }} opts  root = <dataDir>/recordings
 */
export function createFileStore({ root, statfs = freeBytesOf }) {
  const dirOf = (id) => {
    if (!RECORDING_ID_RE.test(id) && !/^rule-[a-z0-9-]{2,41}$/.test(id)) throw new Error(`bad recording id ${id}`);
    return join(root, id);
  };
  /** id -> { files: Map<name, { rows, bytes }>, dirty } */
  const indexes = new Map();
  const readJson = (file, fallback) => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return fallback;
    }
  };

  const indexOf = (id) => {
    let ix = indexes.get(id);
    if (!ix) {
      const saved = readJson(join(dirOf(id), "index.json"), {});
      ix = { files: new Map(Object.entries(saved.files ?? {})), dirty: false };
      indexes.set(id, ix);
    }
    return ix;
  };

  /**
   * The data files of a recording, kept in memory: one directory scan the first time a recording is touched, then updated as
   * files are appended, compressed and deleted. A recording of a big collection holds a file per symbol per day (100,000 files
   * after a few months), and listing and stat-ing all of them on every save blocked the event loop for most of a second.
   * @type {Map<string, { files: Map<string, { name: string, date: string, symbol: string, format: string, compressed: boolean, bytes: number }>, bytes: number }>}
   */
  const catalogs = new Map();

  function catalogOf(id) {
    let c = catalogs.get(id);
    if (c) return c;
    c = { files: new Map(), bytes: 0 };
    const dir = dirOf(id);
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        const p = parseFileName(name);
        if (!p) continue;
        let size = 0;
        try {
          size = statSync(join(dir, name)).size;
        } catch {
          continue;
        }
        c.files.set(name, { name, ...p, bytes: size });
        c.bytes += size;
      }
    }
    catalogs.set(id, c);
    return c;
  }

  /** Record that a data file now has `bytes` bytes (or is gone, when bytes is null). */
  function noteFile(id, name, bytes) {
    const c = catalogOf(id);
    const old = c.files.get(name);
    if (old) c.bytes -= old.bytes;
    if (bytes === null) {
      c.files.delete(name);
      return;
    }
    const p = old ?? parseFileName(name);
    if (!p) return;
    c.files.set(name, { name, date: p.date, symbol: p.symbol, format: p.format, compressed: p.compressed, bytes });
    c.bytes += bytes;
  }

  function dataFiles(id) {
    return [...catalogOf(id).files.values()].sort((a, b) => (a.date === b.date ? a.symbol.localeCompare(b.symbol) : a.date.localeCompare(b.date)));
  }

  /** Rows of a data file: from the index when its byte count still matches, else counted from the file. */
  function rowsOf(id, f) {
    const ix = indexOf(id);
    const hit = ix.files.get(f.name);
    if (hit && hit.bytes === f.bytes) return hit.rows;
    let rows = 0;
    try {
      const raw = readFileSync(join(dirOf(id), f.name));
      rows = countRows((f.compressed ? gunzipSync(raw) : raw).toString("utf8"), f.format);
    } catch {
      rows = 0;
    }
    ix.files.set(f.name, { rows, bytes: f.bytes });
    ix.dirty = true;
    return rows;
  }

  return {
    root,
    dirOf,
    ensure(id) {
      mkdirSync(dirOf(id), { recursive: true, mode: DIR_MODE });
    },
    exists: (id) => existsSync(join(dirOf(id), "recording.json")),
    /** Recording ids that have a folder with a recording.json. */
    ids() {
      if (!existsSync(root)) return [];
      return readdirSync(root).filter((n) => (RECORDING_ID_RE.test(n) || /^rule-[a-z0-9-]{2,41}$/.test(n)) && existsSync(join(root, n, "recording.json")));
    },
    readJson: (id, name, fallback) => readJson(join(dirOf(id), name), fallback),
    /**
     * The recording's definition (recording.json). A file that is empty, cut off or has no usable shape is moved aside
     * and replaced by a stub marked `damaged` (stopped, same id), so the recording stays listed and deletable.
     */
    loadDef(id, { log, now = Date.now() } = {}) {
      const file = join(dirOf(id), "recording.json");
      const r = loadJsonOrQuarantine(file, {
        what: `recording ${id} settings`,
        log,
        now,
        validate: (v) => (v && typeof v === "object" && v.id === id && typeof v.kind === "string") || "has an unknown format",
      });
      if (r.value) return r.value;
      if (r.missing) return null;
      let createdAt;
      try {
        createdAt = new Date(statSync(dirOf(id)).mtimeMs).toISOString();
      } catch {
        createdAt = new Date(now).toISOString();
      }
      const stub = { id, name: `Damaged recording ${id}`, kind: "quotes", source: "manual", status: "stopped", statusReason: "damaged", damaged: true, everySec: 60, sessionOnly: true, format: "csv", target: {}, createdAt };
      try {
        writeFileAtomic(file, JSON.stringify(stub));
      } catch {
        /* the stub still serves this run */
      }
      return stub;
    },
    writeJson(id, name, value) {
      this.ensure(id);
      writeFileAtomic(join(dirOf(id), name), JSON.stringify(value));
    },
    /** Top-level files of the recordings folder (rules.json, settings.json). */
    /**
     * A damaged file (empty, cut off, not an object) is moved aside as `<name>.corrupt-<stamp>`, warned about and reported
     * (data.quarantined); the fallback is used for this run. It is never silently replaced.
     */
    readRoot(name, fallback, { log, now = Date.now() } = {}) {
      const r = loadJsonOrQuarantine(join(root, name), {
        what: `recorder ${name}`,
        log,
        now,
        validate: (v) => (v && typeof v === "object" && !Array.isArray(v)) || "has an unknown format",
      });
      return r.value ?? fallback;
    },
    writeRoot(name, value) {
      mkdirSync(root, { recursive: true, mode: DIR_MODE });
      writeFileAtomic(join(root, name), JSON.stringify(value));
    },
    free: () => {
      mkdirSync(root, { recursive: true, mode: DIR_MODE });
      return statfs(root);
    },

    /**
     * Append rows (already-encoded lines) to the day file of a symbol. Writes the CSV header when the file is new.
     * @returns {{ bytes: number, rows: number, file: string }}
     */
    append(id, date, symbol, format, lines) {
      if (!lines.length) return { bytes: 0, rows: 0, file: fileNameFor(date, symbol, format) };
      this.ensure(id);
      const name = fileNameFor(date, symbol, format);
      const path = join(dirOf(id), name);
      const fresh = !existsSync(path);
      const lead = fresh || !endsMidLine(path) ? "" : "\n";
      const text = lead + (fresh && format === "csv" ? csvHeader() : "") + lines.join("");
      if (fresh) {
        const fd = openSync(path, "a", FILE_MODE);
        try {
          writeSync(fd, text);
        } finally {
          closeSync(fd);
        }
      } else {
        // A crash can leave the last line without its newline: start on a fresh line so rows never fuse.
        appendFileSync(path, text, { mode: FILE_MODE });
      }
      const bytes = Buffer.byteLength(text);
      const ix = indexOf(id);
      const prev = ix.files.get(name);
      const size = statSync(path).size;
      let rows;
      if (fresh) rows = lines.length;
      else if (prev && prev.bytes + bytes === size) rows = prev.rows + lines.length;
      else rows = countRows(readFileSync(path, "utf8"), format); // the file changed under us: count it
      ix.files.set(name, { rows, bytes: size });
      ix.dirty = true;
      noteFile(id, name, size);
      return { bytes, rows: lines.length, file: name };
    },

    /** Data files with rows and sizes. */
    list(id) {
      catalogs.delete(id); // a person asked: look at the folder again, so files changed outside the Bridge show up
      return dataFiles(id).map((f) => ({ name: f.name, date: f.date, symbol: f.symbol, format: f.format, compressed: f.compressed, bytes: f.bytes, rows: rowsOf(id, f) }));
    },
    /** Total bytes of the data files of a recording. */
    usedBytes: (id) => catalogOf(id).bytes,
    /** Save the row-count cache (call now and then, and on stop). */
    flushIndex(id) {
      const ix = indexes.get(id);
      if (!ix?.dirty || !existsSync(dirOf(id))) return;
      const live = catalogOf(id).files;
      const files = {};
      for (const [k, v] of ix.files) if (live.has(k)) files[k] = v;
      ix.files = new Map(Object.entries(files));
      writeFileAtomic(join(dirOf(id), "index.json"), JSON.stringify({ files }));
      ix.dirty = false;
    },
    /** A listed data file by name (never a path): { path, size, compressed, format } or null. */
    open(id, name) {
      const p = parseFileName(name);
      if (!p) return null;
      const path = join(dirOf(id), name);
      try {
        const st = statSync(path);
        return st.isFile() ? { path, size: st.size, compressed: p.compressed, format: p.format, date: p.date, symbol: p.symbol } : null;
      } catch {
        return null;
      }
    },
    /** `size`: stop after that many bytes (what Content-Length promised), so a day file that is still being written cannot overrun the answer. */
    stream: (path, size) => (size === undefined ? createReadStream(path) : size <= 0 ? Readable.from([]) : createReadStream(path, { start: 0, end: size - 1 })),

    /**
     * Retention for one recording: delete day files older than keepDays (IST dates, `today` is not counted) and gzip the
     * finished days when `compress`. A day is finished when it is before `today`.
     * @returns {{ deleted: number, compressed: number, freedBytes: number }}
     */
    sweep(id, { keepDays = null, compress = false, today, cutoff }) {
      const out = { deleted: 0, compressed: 0, freedBytes: 0 };
      catalogs.delete(id); // retention is rare: start from what the folder really holds
      const limit = keepDays ? cutoff(today, keepDays) : null;
      const ix = indexOf(id);
      for (const f of dataFiles(id)) {
        const path = join(dirOf(id), f.name);
        if (limit && f.date < limit) {
          try {
            unlinkSync(path);
            out.deleted += 1;
            out.freedBytes += f.bytes;
            noteFile(id, f.name, null);
            ix.files.delete(f.name);
            ix.dirty = true;
          } catch {
            /* in use or already gone: the next sweep tries again */
          }
          continue;
        }
        if (compress && !f.compressed && f.date < today) {
          try {
            const raw = readFileSync(path);
            const gz = gzipSync(raw);
            const rows = countRows(raw.toString("utf8"), f.format);
            writeFileAtomic(`${path}.gz`, gz);
            unlinkSync(path);
            out.compressed += 1;
            out.freedBytes += Math.max(0, f.bytes - gz.length);
            noteFile(id, f.name, null);
            noteFile(id, `${f.name}.gz`, gz.length);
            ix.files.delete(f.name);
            ix.files.set(`${f.name}.gz`, { rows, bytes: gz.length });
            ix.dirty = true;
          } catch {
            /* leave the plain file */
          }
        }
      }
      return out;
    },
    /** Delete a recording's folder and everything in it. */
    removeAll(id) {
      indexes.delete(id);
      catalogs.delete(id);
      rmSync(dirOf(id), { recursive: true, force: true });
    },
    dropIndex: (id) => {
      catalogs.delete(id);
      return indexes.delete(id);
    },
  };
}
