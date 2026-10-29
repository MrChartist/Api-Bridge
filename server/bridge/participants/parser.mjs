/**
 * Pure parser for NSE's participant-wise open interest file (stream S26, docs/spec/p1-12-guard-participants.md §7.11).
 *
 * The published layout (NEEDS VERIFICATION against a real download; the fixtures in __fixtures__/ are illustrative):
 *
 *   "Participant wise Open Interest (no. of contracts) in Equity Derivatives as on Oct 28, 2026"
 *   Client Type,Future Index Long,Future Index Short,Future Stock Long,Future Stock Short,Option Index Call Long,...
 *   Client,180600,96330,...
 *   DII,...   FII,...   Pro,...   TOTAL,...
 *
 * Header names are matched by their words (future/option, index/stock, call/put, long/short), so the older and
 * abbreviated headers ("Fut Idx Long", "Opt Stk Put Short") parse too. Numbers may carry Indian or Western commas.
 * Rows are stored as published: totals that do not add up give quality "totals-mismatch"; they are never corrected.
 */

export const PARTICIPANTS = Object.freeze(["CLIENT", "DII", "FII", "PRO"]);
export const PARTICIPANT_ROWS = Object.freeze([...PARTICIPANTS, "TOTAL"]);
export const INSTRUMENTS = Object.freeze(["IDX_FUT", "IDX_CE", "IDX_PE", "STK_FUT", "STK_CE", "STK_PE"]);

/** A file that is not the participant OI layout (an HTML error page, an empty body, a wrong date). */
export class ParticipantParseError extends Error {
  constructor(detail) {
    super(detail);
    this.name = "ParticipantParseError";
    this.code = "PARSE_FAILED";
    this.detail = detail;
  }
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");

/** "Oct 28, 2026", "28-Oct-2026", "28 October 2026", "28/10/2026", "28-10-2026", "2026-10-28" → "2026-10-28" (or null). */
export function parseTitleDate(text) {
  const s = String(text ?? "");
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(s);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[1].slice(0, 3).toLowerCase()])}-${pad(m[2])}`;
  m = /\b(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s-]+(\d{4})\b/.exec(s);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[2].slice(0, 3).toLowerCase()])}-${pad(m[1])}`;
  m = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/.exec(s);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return null;
}

/** RFC 4180-ish line split: quoted cells may hold commas and doubled quotes. */
export function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/**
 * What one header cell means: { instrument, side } | { total: "long"|"short" } | { participant: true } | null.
 * Words, not exact names, so aliases parse.
 */
export function headerMeaning(cell) {
  const w = String(cell ?? "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
  if (!w) return null;
  if (/^(client type|participant|participant type|category|client)$/.test(w)) return { participant: true };
  const words = new Set(w.split(" "));
  const side = words.has("long") || words.has("buy") ? "long" : words.has("short") || words.has("sell") ? "short" : null;
  if (!side) return null;
  if (words.has("total")) return { total: side };
  const fut = words.has("future") || words.has("futures") || words.has("fut");
  const call = words.has("call") || words.has("calls") || words.has("ce");
  const put = words.has("put") || words.has("puts") || words.has("pe");
  const opt = words.has("option") || words.has("options") || words.has("opt") || call || put;
  const idx = words.has("index") || words.has("idx");
  const stk = words.has("stock") || words.has("stocks") || words.has("stk");
  if (fut === opt || idx === stk) return null;
  const u = idx ? "IDX" : "STK";
  if (fut) return { instrument: `${u}_FUT`, side };
  if (call === put) return null;
  return { instrument: `${u}_${call ? "CE" : "PE"}`, side };
}

/** Row label → participant key, or null. */
export function participantOf(label) {
  const w = String(label ?? "").toLowerCase().replace(/[^a-z]+/g, "");
  if (w === "client" || w === "clients" || w === "retail") return "CLIENT";
  if (w === "dii") return "DII";
  if (w === "fii" || w === "fpi" || w === "fiifpi") return "FII";
  if (w === "pro" || w === "proprietary" || w === "prop") return "PRO";
  if (w === "total" || w === "grandtotal") return "TOTAL";
  return null;
}

/** "1,52,000" / "152,000" / "152000" / " 152000 " → 152000; anything else → NaN. */
export function parseCount(cell) {
  const s = String(cell ?? "").replace(/[,\s]/g, "");
  return /^\d+$/.test(s) ? Number(s) : NaN;
}

/**
 * Validate the published totals (§7.11): for every instrument Σ_p long = TOTAL long, Σ_p short = TOTAL short and
 * TOTAL long = TOTAL short. A missing participant (or TOTAL) row → "partial".
 * @param {Record<string, Record<string, [number, number]>>} rows
 * @returns {{ quality: "ok"|"totals-mismatch"|"partial", mismatches: string[], missing: string[] }}
 */
export function validateTotals(rows) {
  const missing = PARTICIPANT_ROWS.filter((p) => !rows?.[p]);
  const mismatches = [];
  if (!missing.length) {
    for (const x of INSTRUMENTS) {
      let L = 0;
      let S = 0;
      for (const p of PARTICIPANTS) {
        L += rows[p][x]?.[0] ?? 0;
        S += rows[p][x]?.[1] ?? 0;
      }
      const t = rows.TOTAL[x] ?? [0, 0];
      if (L !== t[0] || S !== t[1] || t[0] !== t[1]) mismatches.push(x);
    }
  }
  return { quality: missing.length ? "partial" : mismatches.length ? "totals-mismatch" : "ok", mismatches, missing };
}

/**
 * Parse one file.
 * @param {string} text  the CSV body
 * @param {{ date?: string }} [o]  the requested IST date; when the title line names another date → PARSE_FAILED
 * @returns {{ date: string|null, rows: Record<string, Record<string, [number, number]>>, quality: string,
 *   mismatches: string[], missing: string[], warnings: string[] }}
 */
export function parseParticipantOi(text, { date } = {}) {
  const body = String(text ?? "").replace(/^﻿/, "");
  if (!body.trim()) throw new ParticipantParseError("The file is empty.");
  if (/^\s*</.test(body)) throw new ParticipantParseError("NSE answered with a web page, not the CSV file.");
  const lines = body.split(/\r?\n/).filter((l) => l.replace(/[",\s]/g, "") !== "");
  const warnings = [];
  let titleDate = null;
  let at = 0;
  // The title line (and any other preamble) comes before the header.
  while (at < lines.length) {
    const cells = splitCsvLine(lines[at]);
    if (cells.filter(Boolean).length >= 5 && headerMeaning(cells[0])?.participant) break;
    if (/participant\s*wise/i.test(lines[at]) || /open interest/i.test(lines[at])) titleDate ??= parseTitleDate(lines[at]);
    at += 1;
    if (at > 5) break;
  }
  if (at >= lines.length || !headerMeaning(splitCsvLine(lines[at])[0])?.participant) throw new ParticipantParseError("No participant header row (Client Type, Future Index Long, ...) was found.");
  if (date && titleDate && titleDate !== date) throw new ParticipantParseError(`date mismatch: the file is for ${titleDate}, not ${date}.`);
  const header = splitCsvLine(lines[at]).map(headerMeaning);
  const seen = new Set();
  for (const m of header) if (m?.instrument) seen.add(`${m.instrument}:${m.side}`);
  const lacking = INSTRUMENTS.flatMap((x) => ["long", "short"].map((s) => `${x}:${s}`)).filter((k) => !seen.has(k));
  if (lacking.length) throw new ParticipantParseError(`The header lacks ${lacking.length} of the 12 columns (${lacking.slice(0, 3).join(", ")}...).`);
  const rows = {};
  for (const line of lines.slice(at + 1)) {
    const cells = splitCsvLine(line);
    const p = participantOf(cells[0]);
    if (!p) {
      if (cells[0]) warnings.push(`Skipped a row named "${cells[0].slice(0, 40)}".`);
      continue;
    }
    if (rows[p]) {
      warnings.push(`A second ${p} row was ignored.`);
      continue;
    }
    const r = Object.fromEntries(INSTRUMENTS.map((x) => [x, [0, 0]]));
    header.forEach((m, i) => {
      if (!m?.instrument) return;
      const n = parseCount(cells[i]);
      if (!Number.isFinite(n)) throw new ParticipantParseError(`${p} ${m.instrument} ${m.side}: "${String(cells[i] ?? "").slice(0, 20)}" is not a whole number.`);
      r[m.instrument][m.side === "long" ? 0 : 1] = n;
    });
    rows[p] = r;
  }
  if (!Object.keys(rows).length) throw new ParticipantParseError("The file has a header but no participant rows.");
  const v = validateTotals(rows);
  if (!titleDate) warnings.push("No title line with the date; the requested date was used.");
  return { date: titleDate ?? date ?? null, rows, ...v, warnings };
}
