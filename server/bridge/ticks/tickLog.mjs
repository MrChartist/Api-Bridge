/**
 * Tick log: writes EVERY tick the live feed delivers, in arrival order, to append-only files. It sits next to the sampling
 * recorder (../recorder/), which keeps one snapshot every `everySec`; the tick log keeps all of them, so a signal can be run
 * again later on exactly the stream it saw live (see docs/guides/tick-research.md).
 *
 * Guarantees
 *  - Bounded memory. At most `maxBufferedTicks` lines or `maxBufferedBytes` bytes wait in memory. Reaching either flushes
 *    synchronously before the next tick is accepted: under load the event loop slows down, it never grows without bound.
 *  - Nothing dropped silently. Each tick gets a `seq` that rises by one per tick per IST day, and is kept across restarts.
 *    If the disk refuses writes, lines stay buffered (up to twice the limit); past that the oldest are given up, counted
 *    in `stats().lost`, reported through `onLoss`, and the missing seq numbers show as a hole that `auditTickLog` finds.
 *  - Arrival order is the order. `seq` is the order the Bridge received ticks across all symbols, which is the order the
 *    live signal saw them. Wall-clock time can step backwards (NTP); seq cannot.
 *  - Crash-safe lines. A crash can leave a torn last line; the next write starts on a fresh line and readers skip it.
 *
 *  - Disk limits. With `maxBytes` (all days together) or `minFreeBytes` (free space on the disk), a write that would pass
 *    a limit is refused like a failing disk: held, then given up and counted with the reason DISK_LIMIT or DISK_LOW.
 *
 * Layout: <root>/<YYYY-MM-DD>.ticks.jsonl (IST day of `receivedAt`), finished days optionally gzipped to .ticks.jsonl.gz
 * (compressDay), files 0600 in folders 0700. One line per tick, keys shortened because tick logs are large (codec
 * below). Nothing here reads the wall clock: the day comes from the tick.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, statfsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { writeFileAtomic } from "../../lib/jsonl.mjs";
import { istDateOf } from "../reference/calendar.mjs";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
export const TICK_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.ticks\.jsonl(\.gz)?$/;
export const tickFileName = (date) => `${date}.ticks.jsonl`;

/** Tick field <-> short key on disk. `seq` and the two times are always written; other fields only when known. */
const CODEC = Object.freeze([
  ["seq", "q"],
  ["receivedAt", "t"],
  ["exchangeTs", "x"],
  ["symbol", "s"],
  ["ltp", "p"],
  ["bid", "b"],
  ["ask", "a"],
  ["bidQty", "bq"],
  ["askQty", "aq"],
  ["volume", "v"],
  ["oi", "oi"],
  ["open", "o"],
  ["high", "h"],
  ["low", "l"],
  ["close", "c"],
  ["broker", "k"],
]);
const NUMERIC = new Set(["seq", "receivedAt", "exchangeTs", "ltp", "bid", "ask", "bidQty", "askQty", "volume", "oi", "open", "high", "low", "close"]);

const fin = (v) => typeof v === "number" && Number.isFinite(v);
/** Depth levels on disk: [price, qty, orders] with null for an unknown value. */
const packLevels = (levels, n) => (Array.isArray(levels) ? levels.slice(0, n).map((l) => [fin(l?.price) ? l.price : null, fin(l?.qty) ? l.qty : null, fin(l?.orders) ? l.orders : null]) : []);
const unpackLevels = (rows) => (Array.isArray(rows) ? rows.map((r) => ({ price: r?.[0] ?? null, qty: r?.[1] ?? null, orders: r?.[2] ?? null })) : []);

/**
 * One tick -> one JSON line (with newline). The account id is never written: a tick log may be shared for research.
 * With depthLevels > 0 the first that many bid and ask levels are kept under `d` ([bids, asks], each level
 * [price, qty, orders]).
 */
export function encodeTick(tick, seq, depthLevels = 0) {
  const o = {};
  for (const [field, key] of CODEC) {
    const v = field === "seq" ? seq : tick[field];
    if (v === null || v === undefined) continue;
    if (NUMERIC.has(field) && !fin(v)) continue;
    o[key] = v;
  }
  if (depthLevels > 0 && tick.depth && (tick.depth.bids?.length || tick.depth.asks?.length)) o.d = [packLevels(tick.depth.bids, depthLevels), packLevels(tick.depth.asks, depthLevels)];
  return `${JSON.stringify(o)}\n`;
}

/** One JSON line -> a tick with every Tick field (null when not known), or null for a line that is not a tick. */
export function decodeTick(line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || !Number.isInteger(o.q) || !Number.isFinite(o.t) || typeof o.s !== "string") return null;
  const t = {};
  for (const [field, key] of CODEC) t[field] = o[key] ?? null;
  if (Array.isArray(o.d)) t.depth = { bids: unpackLevels(o.d[0]), asks: unpackLevels(o.d[1]) };
  return t;
}

/** Free bytes on the disk that holds `dir`, or null when the platform cannot say. */
export function freeBytesOf(dir) {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** The day files of a tick log folder: [{ date, name, gz, bytes }], oldest first. */
export function listTickDays(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const m = TICK_FILE_RE.exec(name);
    if (!m) continue;
    let bytes = 0;
    try {
      bytes = statSync(join(root, name)).size;
    } catch {
      continue;
    }
    out.push({ date: m[1], name, gz: Boolean(m[2]), bytes });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || Number(a.gz) - Number(b.gz));
}

/**
 * Gzip one finished day: write <day>.ticks.jsonl.gz next to it (atomically, synced to disk before the rename), then
 * remove the plain file. A crash in between leaves both, and readers prefer the plain one. Returns the bytes saved, or 0 when
 * there was nothing to do. Never call it on today's file while the log is writing to it.
 */
export function compressDay(root, date) {
  const plain = join(root, tickFileName(date));
  if (!existsSync(plain)) return 0;
  const before = statSync(plain).size;
  const body = gzipSync(readFileSync(plain));
  writeFileAtomic(`${plain}.gz`, body);
  unlinkSync(plain);
  return before - body.length;
}

/** The last complete line's seq in a file (0 when empty or none can be read). Reads only the tail. */
export function lastSeqOf(path) {
  if (!existsSync(path)) return 0;
  let fd;
  try {
    const size = statSync(path).size;
    if (!size) return 0;
    fd = openSync(path, "r");
    for (let span = 64 * 1024; ; span *= 4) {
      const len = Math.min(size, span);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString("utf8").split("\n");
      // Walk back over complete lines (the piece after the last newline is empty or torn).
      for (let i = lines.length - 2; i >= (len === size ? 0 : 1); i -= 1) {
        const t = decodeTick(lines[i]);
        if (t) return t.seq;
      }
      if (len === size) return 0;
    }
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function endsMidLine(path) {
  let fd;
  try {
    const size = statSync(path).size;
    if (!size) return false;
    fd = openSync(path, "r");
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
 * @param {{ root: string, maxBufferedTicks?: number, maxBufferedBytes?: number, flushEveryMs?: number, depthLevels?: number,
 *   maxBytes?: number | null, minFreeBytes?: number, statfs?: (dir: string) => number | null,
 *   symbols?: (symbol: string) => boolean, onLoss?: (info: { date: string, fromSeq: number, toSeq: number, count: number, error: string }) => void,
 *   append?: (path: string, data: string) => void, timers?: { setInterval: Function, clearInterval: Function } }} opts
 *   symbols: which symbols to keep (default all). append: injectable for tests (default appendFileSync, mode 0600).
 *   depthLevels: order-book levels to keep per side (0, the default, keeps none). maxBytes: all day files together.
 *   minFreeBytes: keep at least this much free on the disk (statfs is injectable for tests).
 */
export function createTickLog({
  root,
  maxBufferedTicks = 5000,
  maxBufferedBytes = 4 * 1024 * 1024,
  flushEveryMs = 250,
  symbols = () => true,
  depthLevels = 0,
  maxBytes = null,
  minFreeBytes = 0,
  statfs = freeBytesOf,
  onLoss = () => {},
  append = (path, data) => appendFileSync(path, data, { mode: FILE_MODE }),
  timers = { setInterval, clearInterval },
}) {
  if (!root) throw new Error("createTickLog needs a root folder");
  const maxTicks = Math.max(1, Math.floor(maxBufferedTicks));
  const bufLimitBytes = Math.max(1024, Math.floor(maxBufferedBytes));
  /** @type {{ date: string, path: string, seq: number, checked: boolean } | null} */
  let day = null;
  /** @type {Array<{ line: string, seq: number }>} */
  let buf = [];
  let bufBytes = 0;
  let timer = null;
  let closed = false;
  const counters = { written: 0, flushes: 0, lost: 0, writeErrors: 0, lastError: null, maxBuffered: 0, blocked: null };
  const levels = Math.max(0, Math.min(20, Math.floor(depthLevels)));
  let usedBytes = null; // all day files together; counted on first need, then kept up to date
  const used = () => (usedBytes ??= listTickDays(root).reduce((n, d) => n + d.bytes, 0));

  /** Why a write of `bytes` more may not happen now (DISK_LIMIT, DISK_LOW), or null. */
  const diskProblem = (bytes) => {
    if (maxBytes && used() + bytes > maxBytes) return "DISK_LIMIT";
    if (minFreeBytes > 0) {
      const free = statfs(root);
      if (free !== null && free - bytes < minFreeBytes) return "DISK_LOW";
    }
    return null;
  };

  const openDay = (date) => {
    mkdirSync(root, { recursive: true, mode: DIR_MODE });
    const path = join(root, tickFileName(date));
    day = { date, path, seq: lastSeqOf(path), checked: false };
  };

  /** Write the buffer. On failure keep it (bounded at twice the limit); give up the oldest beyond that, counted. */
  function flush() {
    if (!buf.length || !day) return true;
    let data = buf.map((b) => b.line).join("");
    if (!day.checked) {
      if (existsSync(day.path) && endsMidLine(day.path)) data = `\n${data}`; // a crash cut the last line short
      day.checked = true;
    }
    try {
      const problem = diskProblem(Buffer.byteLength(data));
      if (problem) throw Object.assign(new Error(problem), { code: problem });
      append(day.path, data);
      if (usedBytes !== null) usedBytes += Buffer.byteLength(data);
      counters.blocked = null;
      counters.written += buf.length;
      counters.flushes += 1;
      buf = [];
      bufBytes = 0;
      return true;
    } catch (err) {
      counters.writeErrors += 1;
      counters.lastError = err?.code ?? "WRITE_FAILED";
      counters.blocked = counters.lastError;
      day.checked = false;
      const hard = maxTicks * 2;
      if (buf.length > hard) {
        const lost = buf.splice(0, buf.length - hard);
        bufBytes = buf.reduce((n, b) => n + b.line.length, 0);
        counters.lost += lost.length;
        onLoss({ date: day.date, fromSeq: lost[0].seq, toSeq: lost.at(-1).seq, count: lost.length, error: counters.lastError });
      }
      return false;
    }
  }

  function ensureTimer() {
    if (timer || closed || flushEveryMs <= 0) return;
    timer = timers.setInterval(flush, flushEveryMs);
    timer?.unref?.();
  }

  /**
   * Take one canonical Tick (the StreamHub's "tick" event). Returns the seq given to it, or null when it was not kept
   * (closed, a symbol not wanted, or no usable receivedAt).
   */
  function append1(tick) {
    if (closed || !tick || typeof tick.symbol !== "string" || !symbols(tick.symbol)) return null;
    if (!Number.isFinite(tick.receivedAt)) return null;
    const date = istDateOf(tick.receivedAt);
    if (!day || day.date !== date) {
      flush(); // finish the old day in its own file
      openDay(date);
    }
    day.seq += 1;
    const line = encodeTick(tick, day.seq, levels);
    buf.push({ line, seq: day.seq });
    bufBytes += line.length;
    if (buf.length > counters.maxBuffered) counters.maxBuffered = buf.length;
    if (buf.length >= maxTicks || bufBytes >= bufLimitBytes) flush();
    else ensureTimer();
    return day.seq;
  }

  return {
    append: append1,
    flush,
    /** Listen to the bus "tick" event; returns a function that stops listening. */
    attach(bus) {
      return bus.on("tick", (t) => {
        append1(t);
      });
    },
    stats() {
      return { ...counters, buffered: buf.length, bufferedBytes: bufBytes, day: day?.date ?? null, seq: day?.seq ?? 0, usedBytes: usedBytes ?? used() };
    },
    /** Count the disk use again (after files were deleted or compressed by someone else). */
    rescan() {
      usedBytes = null;
    },
    close() {
      if (closed) return;
      flush();
      closed = true;
      if (timer) timers.clearInterval(timer);
      timer = null;
    },
  };
}
