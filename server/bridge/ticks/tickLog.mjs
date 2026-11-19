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
 * Layout: <root>/<YYYY-MM-DD>.ticks.jsonl (IST day of `receivedAt`), files 0600 in folders 0700. One line per tick, keys
 * shortened because tick logs are large (codec below). Nothing here reads the wall clock: the day comes from the tick.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
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

/** One tick -> one JSON line (with newline). The account id is never written: a tick log may be shared for research. */
export function encodeTick(tick, seq) {
  const o = {};
  for (const [field, key] of CODEC) {
    const v = field === "seq" ? seq : tick[field];
    if (v === null || v === undefined) continue;
    if (NUMERIC.has(field) && !(typeof v === "number" && Number.isFinite(v))) continue;
    o[key] = v;
  }
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
  return t;
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
 * @param {{ root: string, maxBufferedTicks?: number, maxBufferedBytes?: number, flushEveryMs?: number,
 *   symbols?: (symbol: string) => boolean, onLoss?: (info: { date: string, fromSeq: number, toSeq: number, count: number, error: string }) => void,
 *   append?: (path: string, data: string) => void, timers?: { setInterval: Function, clearInterval: Function } }} opts
 *   symbols: which symbols to keep (default all). append: injectable for tests (default appendFileSync, mode 0600).
 */
export function createTickLog({
  root,
  maxBufferedTicks = 5000,
  maxBufferedBytes = 4 * 1024 * 1024,
  flushEveryMs = 250,
  symbols = () => true,
  onLoss = () => {},
  append = (path, data) => appendFileSync(path, data, { mode: FILE_MODE }),
  timers = { setInterval, clearInterval },
}) {
  if (!root) throw new Error("createTickLog needs a root folder");
  const maxTicks = Math.max(1, Math.floor(maxBufferedTicks));
  const maxBytes = Math.max(1024, Math.floor(maxBufferedBytes));
  /** @type {{ date: string, path: string, seq: number, checked: boolean } | null} */
  let day = null;
  /** @type {Array<{ line: string, seq: number }>} */
  let buf = [];
  let bufBytes = 0;
  let timer = null;
  let closed = false;
  const counters = { written: 0, flushes: 0, lost: 0, writeErrors: 0, lastError: null, maxBuffered: 0 };

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
      append(day.path, data);
      counters.written += buf.length;
      counters.flushes += 1;
      buf = [];
      bufBytes = 0;
      return true;
    } catch (err) {
      counters.writeErrors += 1;
      counters.lastError = err?.code ?? "WRITE_FAILED";
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
    const line = encodeTick(tick, day.seq);
    buf.push({ line, seq: day.seq });
    bufBytes += line.length;
    if (buf.length > counters.maxBuffered) counters.maxBuffered = buf.length;
    if (buf.length >= maxTicks || bufBytes >= maxBytes) flush();
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
      return { ...counters, buffered: buf.length, bufferedBytes: bufBytes, day: day?.date ?? null, seq: day?.seq ?? 0 };
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
