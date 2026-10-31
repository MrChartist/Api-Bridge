/**
 * Parsers for the NSE ban list and the combined open-interest (MWPL) file (stream S16, docs/spec/p1-02-reference.md
 * §6.7). Pure. Layouts NEED VERIFICATION against real downloads before the parsers are marked done.
 *
 *   fo_secban_DDMMYYYY.csv   "Securities in Ban For Trade Date 30-OCT-2026:" then "1,ABC" rows (or ": NIL")
 *   combineoi_DDMMYYYY.zip   one CSV (newer zips add an XML copy): Date,ISIN,Scrip Name,NSE Symbol,MWPL,Open Interest,
 *                            Future Equivalent Open Interest (newer files),Limit for Next Day
 *
 * mwplPct = 100 × combined OI / MWPL (both in shares), using the future-equivalent OI when the file has it: the
 * measure the limit is applied to (the plain OI counts every option contract in full). Band: "ban" when the symbol is on the ban list for the date (the
 * list is the authority, not our %), else "high" at 80 % or more (a neutral display band, not an exchange status),
 * else "normal".
 */
import { listZipEntries, readZipEntry } from "../../lib/safeArchive.mjs";
import { csvLines, splitCsvLine } from "./lots.mjs";

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

/** "30-OCT-2026" / "30-Oct-2026" / "30102026" -> "2026-10-30"; null otherwise. */
export function parseNseDate(s) {
  const t = String(s ?? "").trim();
  let m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(t);
  if (m && MONTHS[m[2].toUpperCase()]) return `${m[3]}-${String(MONTHS[m[2].toUpperCase()]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = /^(\d{2})(\d{2})(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

/** "2026-10-30" -> "30102026" (the date in NSE archive file names). */
export const nseFileDate = (date) => `${date.slice(8, 10)}${date.slice(5, 7)}${date.slice(0, 4)}`;

/**
 * @param {string} text
 * @returns {{ forDate: string | null, symbols: string[] }}
 */
export function parseSecBan(text) {
  const lines = csvLines(text);
  if (!lines.length) throw new Error("fo_secban: empty file");
  const head = /Trade\s+Date\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i.exec(lines[0]);
  if (!head) throw new Error("fo_secban: no 'Securities in Ban For Trade Date' header");
  const forDate = parseNseDate(head[1]);
  const symbols = [];
  if (!/:\s*NIL\b/i.test(lines[0])) {
    for (const line of lines.slice(1)) {
      if (/^NIL$/i.test(line.replace(/,/g, "").trim())) break;
      const cells = splitCsvLine(line).filter((c) => c !== "");
      const sym = (cells.length > 1 ? cells[1] : cells[0] ?? "").toUpperCase();
      if (/^[A-Z0-9&-]{1,30}$/.test(sym) && !/^\d+$/.test(sym)) symbols.push(sym);
    }
  }
  return { forDate, symbols: [...new Set(symbols)].sort() };
}

const num = (s) => {
  const v = Number(String(s ?? "").replace(/,/g, "").trim());
  return Number.isFinite(v) ? v : null;
};

/**
 * @param {string} text  the CSV inside combineoi_DDMMYYYY.zip
 * @returns {{ forDate: string | null, rows: Array<{ symbol: string, isin: string|null, mwpl: number, oi: number, limitNextDay: number|null }> }}
 */
export function parseCombineOi(text) {
  const lines = csvLines(text);
  const headerAt = lines.findIndex((l) => /symbol/i.test(l) && /mwpl/i.test(l));
  if (headerAt < 0) throw new Error("combineoi: no header with Symbol and MWPL");
  const header = splitCsvLine(lines[headerAt]).map((h) => h.toLowerCase());
  const col = (re) => header.findIndex((h) => re.test(h));
  const iDate = col(/^date$/);
  const iIsin = col(/isin/);
  const iSym = col(/symbol/);
  const iMwpl = col(/^mwpl$/);
  const iFeq = col(/future equivalent/);
  const iOi = header.findIndex((h, i) => i !== iFeq && /open interest/.test(h));
  const iLimit = col(/limit/);
  if (iSym < 0 || iMwpl < 0 || iOi < 0) throw new Error("combineoi: missing Symbol, MWPL or Open Interest column");
  let forDate = null;
  const rows = [];
  for (const line of lines.slice(headerAt + 1)) {
    const c = splitCsvLine(line);
    const symbol = (c[iSym] ?? "").toUpperCase();
    const mwpl = num(c[iMwpl]);
    const rawOi = num(c[iOi]);
    const feq = iFeq >= 0 ? num(c[iFeq]) : null;
    const oi = feq !== null && feq >= 0 ? feq : rawOi;
    if (!/^[A-Z0-9&-]{1,30}$/.test(symbol) || !(mwpl > 0) || oi === null || oi < 0) continue;
    if (!forDate && iDate >= 0) forDate = parseNseDate(c[iDate]);
    rows.push({ symbol, isin: iIsin >= 0 ? c[iIsin] || null : null, mwpl, oi, rawOi, limitNextDay: iLimit >= 0 ? num(c[iLimit]) : null });
  }
  if (!rows.length) throw new Error("combineoi: no rows");
  return { forDate, rows };
}

/**
 * The CSV inside the combined-OI zip, through safeArchive's caps: exactly one plain .csv entry (other entries, such as
 * the XML copy NSE now adds, are ignored).
 * @param {Buffer} buf
 * @param {{ maxBytes: number }} o
 */
export function readCombineOiZip(buf, { maxBytes }) {
  const label = "NSE combined OI";
  const entries = listZipEntries(buf, { label });
  const csvs = entries.filter((e) => /\.csv$/i.test(e.name) && !e.name.includes("/") && !e.name.includes("\\"));
  if (csvs.length !== 1) throw new Error(`${label}: expected one plain .csv file in the zip, found ${csvs.length}`);
  return readZipEntry(buf, csvs[0], { maxBytes, label }).toString("utf8");
}

/** mwplPct rounded to 0.1 and the display band. */
export function mwplBand({ oi, mwpl }, inBan) {
  const mwplPct = mwpl > 0 ? Math.round((1000 * oi) / mwpl) / 10 : null;
  const band = inBan ? "ban" : mwplPct === null ? null : mwplPct >= 80 ? "high" : "normal";
  return { mwplPct, band };
}

/** MWPL rows with % and band, given the ban list for the same date. */
export function mwplRows(parsed, banSymbols = []) {
  const ban = new Set(banSymbols);
  return parsed.rows.map((r) => ({ symbol: r.symbol, mwpl: r.mwpl, oi: r.oi, limitNextDay: r.limitNextDay, ...mwplBand(r, ban.has(r.symbol)) })).sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
}
