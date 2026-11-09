/**
 * Recorded files: names, columns and row encoding. One file per symbol per trading day (IST day) in the folder of the
 * recording, `recordings/<id>/<YYYY-MM-DD>__<SYMBOL>.<csv|jsonl>[.gz]`, where SYMBOL is the canonical symbol with ":"
 * written as "_" (NFO:NIFTY-2026-11-12-24000-CE is saved as NFO_NIFTY-2026-11-12-24000-CE). The layout is documented in
 * docs/guides/recording.md so any reader (the local-first history reader included) can find a day of a symbol.
 *
 * Every row says what it is: `source` (stream | broker | cache) and `class` (always "realtime": a recording never writes
 * delayed or end-of-day data), and `tickAt`, the time of the price itself (the sample time is `time`).
 */
import { toIstIso } from "../market/time.mjs";

/** Column order of every recorded file, quotes and chain legs alike. Columns that do not apply stay empty. */
export const COLUMNS = Object.freeze([
  "time",
  "symbol",
  "ltp",
  "bid",
  "ask",
  "bidQty",
  "askQty",
  "volume",
  "oi",
  "oiChange",
  "open",
  "high",
  "low",
  "close",
  "iv",
  "delta",
  "gamma",
  "theta",
  "vega",
  "spot",
  "tickAt",
  "source",
  "class",
]);

const FILE_RE = /^(\d{4}-\d{2}-\d{2})__([A-Z]+_[A-Za-z0-9&._-]{1,70})\.(csv|jsonl)(\.gz)?$/;

/** Canonical symbol -> the file-name part. */
export const safeSymbol = (symbol) => String(symbol).replace(":", "_");
/** File-name part -> canonical symbol. */
export const symbolOfSafe = (safe) => String(safe).replace("_", ":");

/** `<date>__<SYMBOL>.<ext>` */
export const fileNameFor = (date, symbol, format) => `${date}__${safeSymbol(symbol)}.${format}`;

/** Parse a recorded file name: { date, symbol, format, compressed } or null when it is not one of ours. */
export function parseFileName(name) {
  const m = FILE_RE.exec(String(name));
  if (!m) return null;
  return { date: m[1], symbol: symbolOfSafe(m[2]), format: m[3], compressed: Boolean(m[4]) };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v) => (typeof v === "string" && v ? v : null);

/**
 * One row as an object with every column (null where the value is not there).
 * @param {object} r { ms, symbol, ltp, ..., tickAtMs, source }
 */
export function rowOf(r) {
  return {
    time: toIstIso(r.ms),
    symbol: r.symbol,
    ltp: num(r.ltp),
    bid: num(r.bid),
    ask: num(r.ask),
    bidQty: num(r.bidQty),
    askQty: num(r.askQty),
    volume: num(r.volume),
    oi: num(r.oi),
    oiChange: num(r.oiChange),
    open: num(r.open),
    high: num(r.high),
    low: num(r.low),
    close: num(r.close),
    iv: num(r.iv),
    delta: num(r.delta),
    gamma: num(r.gamma),
    theta: num(r.theta),
    vega: num(r.vega),
    spot: num(r.spot),
    tickAt: Number.isFinite(r.tickAtMs) ? toIstIso(r.tickAtMs) : null,
    source: text(r.source) ?? "stream",
    class: "realtime",
  };
}

const csvCell = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The header line of a CSV file (with its newline). */
export const csvHeader = () => `${COLUMNS.join(",")}\n`;

/** One row as a line (with its newline) in the given format. Symbols and numbers never need quoting; text is escaped anyway. */
export function encodeRow(row, format) {
  if (format === "jsonl") return `${JSON.stringify(row)}\n`;
  return `${COLUMNS.map((c) => csvCell(row[c])).join(",")}\n`;
}

/**
 * Parse the text of a recorded file back into row objects (numbers restored). Skips a torn last line.
 * @param {string} body
 * @param {"csv"|"jsonl"} format
 */
export function decodeRows(body, format) {
  const out = [];
  const lines = String(body).split("\n");
  const complete = lines.slice(0, -1); // the piece after the last newline is empty, or a torn line
  for (const line of complete) {
    if (!line) continue;
    if (format === "jsonl") {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip a bad line */
      }
      continue;
    }
    if (line.startsWith("time,")) continue;
    const cells = splitCsvLine(line);
    const row = {};
    COLUMNS.forEach((c, i) => {
      const v = cells[i] ?? "";
      row[c] = v === "" ? null : ["symbol", "time", "tickAt", "source", "class"].includes(c) ? v : Number(v);
    });
    out.push(row);
  }
  return out;
}

function splitCsvLine(line) {
  const cells = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

/** Count the rows of a file body (lines minus the CSV header). */
export function countRows(body, format) {
  let n = 0;
  for (const line of String(body).split("\n")) if (line) n += 1;
  return Math.max(0, format === "csv" ? n - 1 : n);
}
