/**
 * Reads recorded rows back for one symbol and a time range, from the files in <dataDir>/recordings/ (layout in
 * files.mjs and docs/guides/recording.md). Used by the local-first readers (history, downloads, datasets) so data the
 * Bridge already saved is not fetched again. It reads files only: no service, no network.
 *
 * Honesty: every row says `class` (always realtime: a recording never writes anything else) and `source`; the answer lists
 * the gaps the recorder logged inside the range, so the caller can send only the gaps and the missing tail to the broker.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { istDateOf, addDays } from "../reference/calendar.mjs";
import { decodeRows, parseFileName } from "./format.mjs";

/**
 * @param {{ dataDir: string, symbol: string, fromMs: number, toMs: number, recordingId?: string }} q
 * @returns {{ symbol: string, rows: object[], recordings: Array<{ id: string, kind: string, everySec: number, files: string[] }>,
 *   gaps: Array<{ recordingId: string, from: string, to: string | null, reason: string }>, dataClass: "realtime", source: "recorded" }}
 */
export function readRecorded({ dataDir, symbol, fromMs, toMs, recordingId }) {
  const root = join(dataDir, "recordings");
  const out = { symbol, rows: [], recordings: [], gaps: [], dataClass: "realtime", source: "recorded" };
  if (!existsSync(root)) return out;
  const fromDate = istDateOf(fromMs);
  const toDate = istDateOf(toMs);
  const ids = recordingId ? [recordingId] : readdirSync(root).filter((n) => /^(rec_[a-z0-9]{4,20}|rule-[a-z0-9-]{2,41})$/.test(n));
  for (const id of ids) {
    const dir = join(root, id);
    if (!existsSync(join(dir, "recording.json"))) continue;
    let def = {};
    try {
      def = JSON.parse(readFileSync(join(dir, "recording.json"), "utf8"));
    } catch {
      continue;
    }
    const files = [];
    for (const name of readdirSync(dir)) {
      const p = parseFileName(name);
      if (!p || p.symbol !== symbol || p.date < fromDate || p.date > toDate) continue;
      files.push({ name, ...p });
    }
    if (!files.length) continue;
    files.sort((a, b) => a.date.localeCompare(b.date));
    for (const f of files) {
      let raw = readFileSync(join(dir, f.name));
      if (f.compressed) raw = gunzipSync(raw);
      for (const row of decodeRows(raw.toString("utf8"), f.format)) {
        const t = Date.parse(row.time);
        if (Number.isFinite(t) && t >= fromMs && t <= toMs) out.rows.push({ ...row, recordingId: id });
      }
    }
    out.recordings.push({ id, kind: def.kind ?? "quotes", everySec: def.everySec ?? 0, files: files.map((f) => f.name) });
    const gapFile = join(dir, "gaps.jsonl");
    if (existsSync(gapFile)) {
      const byId = new Map();
      for (const line of readFileSync(gapFile, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const g = JSON.parse(line);
          byId.set(g.id, g);
        } catch {
          /* a torn line */
        }
      }
      for (const g of byId.values()) {
        const gFrom = Date.parse(g.from);
        const gTo = g.to ? Date.parse(g.to) : Infinity;
        if (gTo >= fromMs && gFrom <= toMs) out.gaps.push({ recordingId: id, from: g.from, to: g.to ?? null, reason: g.reason });
      }
    }
  }
  out.rows.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  return out;
}

/** The IST dates from `fromMs` to `toMs`, inclusive (for callers that list days). */
export function daysBetween(fromMs, toMs) {
  const days = [];
  for (let d = istDateOf(fromMs); d <= istDateOf(toMs); d = addDays(d, 1)) days.push(d);
  return days;
}
