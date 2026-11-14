/**
 * Bars on disk: the three writers (CSV, JSONL, AmiBroker ASCII), the readers that parse them back, and the rules for
 * which bars may be stored.
 *
 *  - CSV is the history CSV of GET /v1/history?format=csv (market/history.mjs historyCsvRows: IST times, a header row);
 *    the combined layout adds a leading `symbol` column.
 *  - AmiBroker is the layout of GET /xl/history?layout=amibroker (integrations/xl.mjs): the same columns, so the shipped
 *    import formats read these files too.
 *  - JSONL is one object per line: { symbol, interval, time (ISO with +05:30), open, high, low, close, volume, oi }.
 *
 * Bars are normalised before they are written: daily and longer bars are stamped at IST midnight of their date (the
 * files carry only the date, so the stamp must survive a round trip), and the bar still forming is never stored: a
 * file only ever holds finished bars, which is what makes "continue from the last stored bar" safe.
 */
import { createReadStream } from "node:fs";
import { open, stat, truncate } from "node:fs/promises";
import { createInterface } from "node:readline";
import { toCsv } from "../core/http.mjs";
import { amibrokerRows, amibrokerTicker, AMIBROKER_EOD_COLUMNS, AMIBROKER_INTRADAY_COLUMNS } from "../integrations/xl.mjs";
import { INTRADAY_MINUTES, SESSION_OPEN_MIN, historyCsvRows, isIntraday, sessionMinutes } from "../market/history.mjs";
import { DAY_MS, istMidnight, istMonthStart, istParts, istWeekStart, parseTimeInput, toIstIso } from "../market/time.mjs";

export const FORMATS = Object.freeze(["csv", "jsonl", "amibroker"]);
export const LAYOUTS = Object.freeze(["per-symbol", "combined"]);
/** File extension per format. */
export const EXTENSIONS = Object.freeze({ csv: "csv", jsonl: "jsonl", amibroker: "csv" });
export const CONTENT_TYPES = Object.freeze({ csv: "text/csv; charset=utf-8", jsonl: "application/x-ndjson; charset=utf-8", amibroker: "text/csv; charset=utf-8" });

const CSV_COLUMNS = Object.freeze(["time", "open", "high", "low", "close", "volume", "oi"]);

/** Seconds one bar of this interval spans (a month is counted as 30 days; used only for estimates). */
export function stepSeconds(interval) {
  if (isIntraday(interval)) return INTRADAY_MINUTES[interval] * 60;
  if (interval === "1d") return 86_400;
  if (interval === "1w") return 7 * 86_400;
  return 30 * 86_400;
}

/** Exchange code of a canonical symbol ("NSE:NIFTY" -> "NSE"). */
export const exchangeOf = (symbol) => String(symbol).split(":")[0];

/**
 * One candle in the stored form: whole-second time (daily and longer: IST midnight of the bar's date), numbers only.
 * Returns null for a candle that cannot be stored.
 */
export function normaliseBar(c, interval) {
  if (!c || !Number.isFinite(c.time) || ![c.open, c.high, c.low, c.close].every(Number.isFinite)) return null;
  const sec = Math.floor(c.time);
  const time = isIntraday(interval) ? sec : Math.floor(istMidnight(sec * 1000) / 1000);
  const bar = { time, open: c.open, high: c.high, low: c.low, close: c.close, volume: Number.isFinite(c.volume) ? c.volume : 0 };
  if (Number.isFinite(c.oi)) bar.oi = c.oi;
  return bar;
}

/**
 * Start (epoch ms) of the earliest bar that is not finished at `nowMs`. Every bar that starts before it is finished.
 * Daily bars count as finished half an hour after the session close; weekly and monthly bars when their period is over.
 */
export function openBoundaryMs(nowMs, interval, exchange) {
  if (isIntraday(interval)) {
    const size = INTRADAY_MINUTES[interval] * 60_000;
    const open = istMidnight(nowMs) + (SESSION_OPEN_MIN[exchange] ?? SESSION_OPEN_MIN.NSE) * 60_000;
    return open + Math.floor((nowMs - open) / size) * size;
  }
  const midnight = istMidnight(nowMs);
  if (interval === "1d") {
    const p = istParts(nowMs);
    const closeMin = (SESSION_OPEN_MIN[exchange] ?? SESSION_OPEN_MIN.NSE) + sessionMinutes(exchange, nowMs);
    return p.hour * 60 + p.minute >= closeMin + 30 ? midnight + DAY_MS : midnight;
  }
  return interval === "1w" ? istWeekStart(nowMs) : istMonthStart(nowMs);
}

/** True when the bar has finished at `nowMs`. */
export const isClosedBar = (bar, interval, exchange, nowMs) => bar.time * 1000 < openBoundaryMs(nowMs, interval, exchange);

/** The last second that is fully covered by finished bars at `nowMs` (epoch seconds). */
export const coveredUpTo = (nowMs, interval, exchange) => Math.floor(openBoundaryMs(nowMs, interval, exchange) / 1000) - 1;

// ── writers ──

/** Header cells for a file. */
export function headerCells({ format, layout, interval }) {
  if (format === "amibroker") return [...(isIntraday(interval) ? AMIBROKER_INTRADAY_COLUMNS : AMIBROKER_EOD_COLUMNS)];
  return layout === "combined" ? ["symbol", ...CSV_COLUMNS] : [...CSV_COLUMNS];
}

/** The header line for a file ("" for JSONL, which has none), ending with its line break. */
export function headerText({ format, layout, interval }) {
  return format === "jsonl" ? "" : toCsv([headerCells({ format, layout, interval })]);
}

/**
 * The lines for some bars, each ending with its line break, no header.
 * @param {Array<object>} bars  normalised bars
 * @param {{ symbol: string, interval: string, format: string, layout: string }} o
 */
export function encodeBars(bars, { symbol, interval, format, layout }) {
  if (!bars.length) return "";
  if (format === "jsonl") {
    return bars.map((b) => `${JSON.stringify({ symbol, interval, time: toIstIso(b.time * 1000), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, oi: b.oi ?? null })}\n`).join("");
  }
  if (format === "amibroker") return toCsv(amibrokerRows(bars, interval, amibrokerTicker(symbol)));
  const rows = historyCsvRows({ interval, candles: bars }).slice(1);
  return toCsv(layout === "combined" ? rows.map((r) => [symbol, ...r]) : rows);
}

// ── readers ──

/** Split one CSV line (RFC 4180 quotes). */
export function splitCsvLine(line) {
  if (!line.includes('"')) return line.split(",");
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const num = (s) => {
  if (s === undefined || s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * One line of a file back into a bar (and the symbol, for a combined CSV or JSONL file). Null for the header line, a
 * blank line or anything that does not parse.
 * @param {string} line
 * @param {{ format: string, layout: string, interval: string }} o
 */
export function decodeLine(line, { format, layout, interval }) {
  const text = line.replace(/\r$/, "");
  if (!text.trim()) return null;
  try {
    if (format === "jsonl") {
      const o = JSON.parse(text);
      const t = Date.parse(o.time);
      if (!Number.isFinite(t)) return null;
      const bar = { time: Math.floor(t / 1000), open: o.open, high: o.high, low: o.low, close: o.close, volume: o.volume ?? 0 };
      if (Number.isFinite(o.oi)) bar.oi = o.oi;
      return { symbol: o.symbol, bar };
    }
    const c = splitCsvLine(text);
    let symbol;
    let i = 0;
    let when;
    if (format === "amibroker") {
      symbol = c[0];
      if (isIntraday(interval)) {
        when = `${c[1]} ${c[2]}`;
        i = 3;
      } else {
        when = c[1];
        i = 2;
      }
    } else {
      if (layout === "combined") {
        symbol = c[0];
        i = 1;
      }
      when = c[i];
      i += 1;
    }
    if (!/^\d{4}-\d{2}-\d{2}/.test(when)) return null; // header
    const [open, high, low, close] = [num(c[i]), num(c[i + 1]), num(c[i + 2]), num(c[i + 3])];
    if ([open, high, low, close].some((v) => v === undefined)) return null;
    const bar = { time: Math.floor(parseTimeInput(when) / 1000), open, high, low, close, volume: num(c[i + 4]) ?? 0 };
    const oi = num(c[i + 5]);
    if (oi !== undefined && !(format === "amibroker" && oi === 0)) bar.oi = oi;
    return { symbol, bar };
  } catch {
    return null;
  }
}

/** Every bar of a file, oldest first. A missing file yields nothing. @param {string} file */
export async function* readBars(file, opts) {
  let stream;
  try {
    stream = createReadStream(file, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      const d = decodeLine(line, opts);
      if (d) yield d;
    }
  } catch (err) {
    if (err?.code === "ENOENT") return;
    throw err;
  } finally {
    stream?.destroy();
  }
}

const SEEK_CHUNK = 8192;
const SEEK_SMALL = 256 * 1024;

/**
 * Bars of a file from the first bar at or after `fromSec`, oldest first. The files are sorted, so the start is found by
 * halving the byte range (a few small reads) instead of parsing every line from the top: a recent hour of a three-year
 * 1-minute file no longer costs a second of CPU. Bars before `fromSec` that share the first block may still be yielded; the
 * caller filters. A small file is simply read from the top.
 * @param {string} file @param {object} opts decodeLine options @param {number} fromSec
 */
export async function* readBarsFrom(file, opts, fromSec) {
  let size;
  try {
    size = (await stat(file)).size;
  } catch (err) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  let lo = 0;
  if (size > SEEK_SMALL) {
    const fh = await open(file, "r");
    try {
      let hi = size;
      const buf = Buffer.alloc(SEEK_CHUNK);
      while (hi - lo > SEEK_CHUNK * 2) {
        const mid = lo + Math.floor((hi - lo) / 2);
        const { bytesRead } = await fh.read(buf, 0, SEEK_CHUNK, mid);
        const chunk = buf.subarray(0, bytesRead);
        const nl = chunk.indexOf(0x0a);
        const nl2 = nl < 0 ? -1 : chunk.indexOf(0x0a, nl + 1);
        // the first whole line after mid: it starts at mid + nl + 1
        const whole = nl >= 0 && (nl2 >= 0 || mid + bytesRead >= size);
        const d = whole ? decodeLine(chunk.subarray(nl + 1, nl2 < 0 ? bytesRead : nl2).toString("utf8"), opts) : null;
        if (!d) {
          hi = mid; // nothing readable there: look earlier (never skip a bar)
        } else if (d.bar.time < fromSec) {
          lo = mid + nl + 1; // this line is still before the wanted start, and it starts a line
        } else {
          hi = mid;
        }
      }
    } finally {
      await fh.close();
    }
  }
  let stream;
  try {
    stream = createReadStream(file, { encoding: "utf8", start: lo });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      const d = decodeLine(line, opts);
      if (d) yield d;
    }
  } finally {
    stream?.destroy();
  }
}

/**
 * Make sure a file ends at a line break: a write that was cut off (a crash, a full disk) leaves half a line, which is
 * cut away here so the next append starts clean. Returns the size afterwards, or 0 for a missing file.
 */
export async function trimPartialTail(file) {
  let size;
  try {
    size = (await stat(file)).size;
  } catch (err) {
    if (err?.code === "ENOENT") return 0;
    throw err;
  }
  if (size === 0) return 0;
  const fh = await open(file, "r");
  try {
    const span = Math.min(size, 1 << 16);
    const buf = Buffer.alloc(span);
    await fh.read(buf, 0, span, size - span);
    if (buf[span - 1] === 0x0a) return size;
    const nl = buf.lastIndexOf(0x0a);
    const keep = nl === -1 ? (span === size ? 0 : size) : size - span + nl + 1;
    await truncate(file, keep);
    return keep;
  } finally {
    await fh.close();
  }
}

/**
 * The last bar of a file (and its symbol) without reading the whole file; null when there is none.
 * @param {string} file
 */
export async function lastBarOf(file, opts) {
  let size;
  try {
    size = (await stat(file)).size;
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  const fh = await open(file, "r");
  try {
    let span = Math.min(size, 1 << 14);
    for (;;) {
      const buf = Buffer.alloc(span);
      await fh.read(buf, 0, span, size - span);
      const lines = buf.toString("utf8").split("\n");
      if (span < size) lines.shift(); // the first piece may be cut in half
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const d = decodeLine(lines[i], opts);
        if (d) return d;
      }
      if (span >= size) return null;
      span = Math.min(size, span * 4);
    }
  } finally {
    await fh.close();
  }
}

/**
 * Where bars are missing between two neighbours (a "hole"): intraday bars missing inside a day, whole trading days with
 * no bar at all, and daily bars missing between two stored days. A hole can also be a stretch in which nothing traded
 * (a thin stock has no 1-minute bar when no trade happened), so a hole is reported, never "fixed" with a made-up bar.
 *
 * @param {Array<{ time: number }>} bars ascending
 * @param {{ interval: string, exchange: string, isTradingDay?: (date: string) => boolean, fromSec?: number, toSec?: number }} o
 *   isTradingDay: the exchange calendar; without it only holes between two stored bars are found.
 * @returns {Array<{ from: number, to: number, missing: number, kind: "missing-bars"|"missing-days" }>}
 *   from/to are the first and last missing bar times (epoch seconds).
 */
export function findHoles(bars, { interval, exchange, isTradingDay, fromSec, toSec }) {
  const holes = [];
  if (!bars.length) return holes;
  const step = stepSeconds(interval);
  const intraday = isIntraday(interval);
  const lo = Math.max(fromSec ?? bars[0].time, bars[0].time);
  const hi = Math.min(toSec ?? bars.at(-1).time, bars.at(-1).time);
  if (hi < lo) return holes;
  const dateOf = (sec) => toIstIso(sec * 1000).slice(0, 10);
  const present = new Set();
  for (const b of bars) present.add(intraday ? b.time : dateOf(b.time));

  if (intraday) {
    const open = SESSION_OPEN_MIN[exchange] ?? SESSION_OPEN_MIN.NSE;
    const sessionBars = Math.floor(sessionMinutes(exchange, lo * 1000) / (step / 60));
    // Walk the trading days between the first and last bar; on each, the expected bar times are open + k * step.
    let run = null;
    const flush = () => {
      if (run) holes.push({ from: run.from, to: run.to, missing: run.n, kind: run.kind });
      run = null;
    };
    for (let day = istMidnight(lo * 1000); day <= istMidnight(hi * 1000); day += DAY_MS) {
      const date = toIstIso(day).slice(0, 10);
      if (isTradingDay && !isTradingDay(date)) {
        flush();
        continue;
      }
      const base = Math.floor(day / 1000) + open * 60;
      let dayHas = false;
      for (let k = 0; k < sessionBars; k += 1) if (present.has(base + k * step)) dayHas = true;
      if (!dayHas) {
        if (!isTradingDay) continue; // without a calendar a day with no bars may be a holiday
        flush();
        holes.push({ from: base, to: base + (sessionBars - 1) * step, missing: sessionBars, kind: "missing-days" });
        continue;
      }
      // only the stretch between the day's first and last stored bar counts: the open and close edges of a thin stock are not holes
      let first = null;
      let last = null;
      for (let k = 0; k < sessionBars; k += 1) {
        if (present.has(base + k * step)) {
          first ??= k;
          last = k;
        }
      }
      for (let k = first; k <= last; k += 1) {
        const t = base + k * step;
        if (t < lo || t > hi) continue;
        if (present.has(t)) flush();
        else if (run) {
          run.to = t;
          run.n += 1;
        } else run = { from: t, to: t, n: 1, kind: "missing-bars" };
      }
      flush();
    }
    flush();
    return holes;
  }

  if (interval === "1d" && isTradingDay) {
    let run = null;
    for (let day = istMidnight(lo * 1000); day <= istMidnight(hi * 1000); day += DAY_MS) {
      const date = toIstIso(day).slice(0, 10);
      if (!isTradingDay(date) || present.has(date)) {
        if (run) holes.push({ from: run.from, to: run.to, missing: run.n, kind: "missing-days" });
        run = null;
        continue;
      }
      const t = Math.floor(day / 1000);
      if (run) {
        run.to = t;
        run.n += 1;
      } else run = { from: t, to: t, n: 1 };
    }
    if (run) holes.push({ from: run.from, to: run.to, missing: run.n, kind: "missing-days" });
  }
  return holes;
}
