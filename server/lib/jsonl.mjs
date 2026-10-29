/**
 * Append-only JSON-lines (NDJSON) files: the one storage helper every Phase 1 store uses (recorder, vol, exposure,
 * alerts, guards, participants, fno, margin calibration, readiness, strategy). docs/spec/README.md §3.1 (F0), BRD §7.7.
 *
 *  - appendLine / appendLineSync: one JSON value per line, written with a single append. If the file does not end in
 *    "\n" (a crash cut the last write short) a newline is written first, so the next record never fuses with a torn one.
 *    appendLines writes several records in one append, with the same repair.
 *  - readLines / readLinesSync: parse every line; a torn LAST line (no final newline and not valid JSON) is skipped
 *    and reported as `tornTail`; any other line that does not parse is skipped and counted in `corrupt`. A missing
 *    file reads as empty (`missing: true`). Reading never throws for bad content, only for I/O errors.
 *  - lastWinsIndex: the newest record per key (rule stores keep edits as appended versions).
 *  - compact: rewrite a file from records through writeFileAtomic (temp file, fsync, rename): readers see the old file
 *    or the new one, never a mix.
 *  - quarantine: move a file that cannot be used aside as `<name>.corrupt-<UTC stamp>` so the store can start clean
 *    and a person can still inspect it.
 *  - pruneDated: dated-file retention: delete entries named with an older YYYY-MM-DD day (or a YYYY-MM month that
 *    ended before the cutoff).
 *
 * Files are created with mode 0600 and directories 0700, like every other file in the data directory. Nothing here
 * reads the clock except where a caller passes `now`.
 */
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const IST_OFFSET_MS = 330 * 60_000;

/** Serialise one record. Strings are taken as already-serialised JSON and must not hold a newline. */
function toLine(value) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof s !== "string") throw new TypeError("appendLine: value is not serialisable to JSON");
  if (s.includes("\n") || s.includes("\r")) throw new TypeError("appendLine: a record must not contain a newline");
  return s;
}

/** Whether a non-empty file's last byte is not "\n" (sync). */
function needsNewlineSync(file) {
  let fd;
  try {
    fd = openSync(file, "r");
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
  try {
    const { size } = statSync(file);
    if (size === 0) return false;
    const b = Buffer.alloc(1);
    readSync(fd, b, 0, 1, size - 1);
    return b[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

async function needsNewline(file) {
  let fh;
  try {
    fh = await open(file, "r");
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
  try {
    const { size } = await fh.stat();
    if (size === 0) return false;
    const b = Buffer.alloc(1);
    await fh.read(b, 0, 1, size - 1);
    return b[0] !== 0x0a;
  } finally {
    await fh.close();
  }
}

/**
 * Append one record as a line. Repairs a missing final newline first (one write either way).
 * @param {string} file
 * @param {unknown} value  object (JSON-serialised) or an already-serialised JSON string
 * @returns {Promise<{ bytes: number, repaired: boolean }>}
 */
export async function appendLine(file, value) {
  const line = toLine(value);
  await mkdir(dirname(file), { recursive: true, mode: DIR_MODE });
  const repaired = await needsNewline(file);
  const data = `${repaired ? "\n" : ""}${line}\n`;
  await appendFile(file, data, { encoding: "utf8", mode: FILE_MODE });
  return { bytes: Buffer.byteLength(data), repaired };
}

/**
 * Append several records, one line each, in ONE write (bulk loads such as the demo recorder's back-fill). Same newline
 * repair as appendLine.
 * @param {string} file
 * @param {unknown[]} values
 * @returns {Promise<{ bytes: number, repaired: boolean, lines: number }>}
 */
export async function appendLines(file, values) {
  const lines = values.map(toLine);
  if (!lines.length) return { bytes: 0, repaired: false, lines: 0 };
  await mkdir(dirname(file), { recursive: true, mode: DIR_MODE });
  const repaired = await needsNewline(file);
  const data = `${repaired ? "\n" : ""}${lines.join("\n")}\n`;
  await appendFile(file, data, { encoding: "utf8", mode: FILE_MODE });
  return { bytes: Buffer.byteLength(data), repaired, lines: lines.length };
}

/** Synchronous appendLine (for stores that already write synchronously). */
export function appendLineSync(file, value) {
  const line = toLine(value);
  mkdirSync(dirname(file), { recursive: true, mode: DIR_MODE });
  const repaired = needsNewlineSync(file);
  const data = `${repaired ? "\n" : ""}${line}\n`;
  const fd = openSync(file, "a", FILE_MODE);
  try {
    const buf = Buffer.from(data, "utf8");
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  } finally {
    closeSync(fd);
  }
  return { bytes: Buffer.byteLength(data), repaired };
}

/**
 * Parse NDJSON text. Exported for stores that read gzipped or in-memory content.
 * @template T
 * @param {string} text
 * @param {{ parse?: (line: string) => T }} [opts]  parse may throw to reject a line (it is then counted as corrupt)
 * @returns {{ items: T[], corrupt: number, tornTail: boolean }}
 */
export function parseLines(text, { parse = JSON.parse } = {}) {
  const items = [];
  let corrupt = 0;
  let tornTail = false;
  if (!text) return { items, corrupt, tornTail };
  const endsClean = text.endsWith("\n");
  const lines = text.split("\n");
  if (endsClean) lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
    if (raw.trim() === "") continue;
    try {
      items.push(parse(raw));
    } catch {
      if (i === lines.length - 1 && !endsClean) tornTail = true;
      else corrupt += 1;
    }
  }
  return { items, corrupt, tornTail };
}

/**
 * Read every record of a file.
 * @template T
 * @param {string} file
 * @param {{ parse?: (line: string) => T }} [opts]
 * @returns {Promise<{ items: T[], corrupt: number, tornTail: boolean, missing: boolean }>}
 */
export async function readLines(file, opts = {}) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { items: [], corrupt: 0, tornTail: false, missing: true };
    throw err;
  }
  return { ...parseLines(text, opts), missing: false };
}

/** Synchronous readLines. */
export function readLinesSync(file, opts = {}) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { items: [], corrupt: 0, tornTail: false, missing: true };
    throw err;
  }
  return { ...parseLines(text, opts), missing: false };
}

/**
 * The newest record per key, in first-seen key order. Records without a key are skipped.
 * @template T
 * @param {T[]} items
 * @param {string | ((item: T) => string | number | null | undefined)} key  field name or function
 * @param {{ isDeleted?: (item: T) => boolean }} [opts]  a record for which isDeleted is true removes its key (tombstone)
 * @returns {Map<string | number, T>}
 */
export function lastWinsIndex(items, key, { isDeleted } = {}) {
  const get = typeof key === "function" ? key : (r) => r?.[key];
  const out = new Map();
  for (const r of items) {
    const k = get(r);
    if (k === undefined || k === null || k === "") continue;
    if (isDeleted?.(r)) out.delete(k);
    else {
      out.delete(k); // re-insert so iteration order follows the latest write
      out.set(k, r);
    }
  }
  return out;
}

/**
 * Write `data` to `path` atomically with mode 0600 (temp file in the same folder, fsync, rename, fsync folder).
 * @param {string} path
 * @param {string | Buffer} data
 */
export function writeFileAtomic(path, data) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let fd = null;
  try {
    fd = openSync(tmp, "wx", FILE_MODE);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  if (process.platform !== "win32") {
    try {
      const dfd = openSync(dir, "r");
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      // Some filesystems refuse fsync on a directory; the rename is still atomic.
    }
  }
}

/**
 * Rewrite a file to hold exactly `items` (one line each), atomically.
 * @param {string} file
 * @param {Iterable<unknown>} items
 * @returns {{ lines: number, bytes: number }}
 */
export function compact(file, items) {
  let lines = 0;
  let text = "";
  for (const it of items) {
    text += `${toLine(it)}\n`;
    lines += 1;
  }
  writeFileAtomic(file, text);
  return { lines, bytes: Buffer.byteLength(text) };
}

/** UTC stamp safe in file names on every platform: 20261029T043000123Z. */
export function fileStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(".", "");
}

/**
 * Move a file aside as `<file>.corrupt-<stamp>`. Returns the new path, or null when the file does not exist.
 * @param {string} file
 * @param {{ now?: number }} [opts]
 */
export function quarantine(file, { now = Date.now() } = {}) {
  if (!existsSync(file)) return null;
  let target = `${file}.corrupt-${fileStamp(now)}`;
  for (let i = 1; existsSync(target); i++) target = `${file}.corrupt-${fileStamp(now)}-${i}`;
  renameSync(file, target);
  return target;
}

/** IST calendar date (YYYY-MM-DD) of an epoch-ms instant. */
export function istDate(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD minus `days` (calendar arithmetic on the date only). */
function minusDays(day, days) {
  const t = Date.parse(`${day}T00:00:00Z`) - days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Last day of a YYYY-MM month. */
function monthEnd(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

const DAY_RE = /(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)/;
const MONTH_RE = /(?<!\d)(\d{4}-\d{2})(?![-\d])/;

/**
 * Dated-file retention. Deletes entries (files or folders) of `dir` whose name holds a YYYY-MM-DD day older than
 * `today − keepDays`, or a YYYY-MM month whose last day is older than that cutoff. Undated names (and quarantined
 * `.corrupt-` files) are left alone. A missing folder is fine.
 * @param {string} dir
 * @param {{ keepDays: number, today: string, match?: RegExp }} opts  today: IST date "YYYY-MM-DD" (see istDate)
 *   match: only names matching it are considered (e.g. /\.jsonl(\.gz)?$/)
 * @returns {string[]} names removed
 */
export function pruneDated(dir, { keepDays, today, match }) {
  if (!Number.isInteger(keepDays) || keepDays < 0) throw new RangeError("keepDays must be a whole number ≥ 0");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today ?? "")) throw new RangeError("today must be YYYY-MM-DD");
  const cutoff = minusDays(today, keepDays);
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const removed = [];
  // A /g or /y RegExp keeps lastIndex between test() calls; use a stateless copy so no file is skipped.
  const only = match ? new RegExp(match.source, match.flags.replace(/[gy]/g, "")) : null;
  for (const name of names.sort()) {
    if (name.includes(".corrupt-") || name.startsWith(".")) continue;
    if (only && !only.test(name)) continue;
    const d = DAY_RE.exec(name)?.[1];
    const m = d ? null : MONTH_RE.exec(name)?.[1];
    const last = d ?? (m ? monthEnd(m) : null);
    if (!last || last >= cutoff) continue;
    rmSync(join(dir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
