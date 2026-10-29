/**
 * Store S4 on disk (stream S26, docs/spec/p1-12-guard-participants.md §2.4):
 *
 *   <dataDir>/participants/            0700
 *     state.json                       { version, lastFetch, lastSuccessDate, lastError, attempts, backfill: { cursor, done, noFile, failed } }
 *     oi/2026.jsonl                    one line per date (the last line for a date wins)
 *     raw/2026-10-28/<file>.csv        the published file as downloaded, plus <file>.csv.sha256 (kept retentionDays)
 *
 * Writes go through server/lib/jsonl.mjs (append with newline repair, torn last line skipped, atomic state). A
 * state.json that cannot be read is moved aside as state.json.corrupt-<stamp> and the store starts clean; a bad line
 * in a year file is skipped and counted, never fatal (BRD §7.7).
 */
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { appendLineSync, lastWinsIndex, pruneDated, quarantine, readLinesSync, writeFileAtomic } from "../../lib/jsonl.mjs";

const DIR_MODE = 0o700;
const YEAR_FILE = /^(\d{4})\.jsonl$/;

export const emptyState = () => ({ version: 1, lastFetch: null, lastSuccessDate: null, lastError: null, attempts: {}, backfill: { cursor: null, done: false, noFile: [], failed: {} } });

/**
 * @param {string} dir  <dataDir>/participants
 * @param {{ now?: () => number, logger?: any }} [o]
 */
export function createParticipantStore(dir, { now = () => Date.now(), logger } = {}) {
  const oiDir = join(dir, "oi");
  const rawDir = join(dir, "raw");
  const stateFile = join(dir, "state.json");
  mkdirSync(oiDir, { recursive: true, mode: DIR_MODE });
  let corruptLines = 0;

  /** Every stored day (last wins per date), as a Map date → day, sorted oldest first. */
  function loadDays() {
    const all = [];
    let names = [];
    try {
      names = readdirSync(oiDir).filter((n) => YEAR_FILE.test(n)).sort();
    } catch {
      names = [];
    }
    corruptLines = 0;
    for (const n of names) {
      const r = readLinesSync(join(oiDir, n));
      corruptLines += r.corrupt + (r.tornTail ? 1 : 0);
      for (const it of r.items) if (it && typeof it === "object" && typeof it.date === "string" && it.rows && typeof it.rows === "object") all.push(it);
    }
    if (corruptLines) logger?.warn?.("participants: skipped unreadable lines", { lines: corruptLines });
    const idx = lastWinsIndex(all, "date");
    return new Map([...idx.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  }

  function putDay(day) {
    appendLineSync(join(oiDir, `${day.date.slice(0, 4)}.jsonl`), day);
  }

  function readState() {
    let text;
    try {
      text = readFileSync(stateFile, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") return emptyState();
      throw err;
    }
    try {
      const s = JSON.parse(text);
      if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error("not an object");
      const e = emptyState();
      return { ...e, ...s, attempts: s.attempts && typeof s.attempts === "object" ? s.attempts : {}, backfill: { ...e.backfill, ...(s.backfill ?? {}), noFile: Array.isArray(s.backfill?.noFile) ? s.backfill.noFile : [], failed: s.backfill?.failed && typeof s.backfill.failed === "object" ? s.backfill.failed : {} } };
    } catch {
      const moved = quarantine(stateFile, { now: now() });
      logger?.warn?.("participants: state.json could not be read and was moved aside", { moved });
      return emptyState();
    }
  }

  function writeState(state) {
    writeFileAtomic(stateFile, `${JSON.stringify(state, null, 1)}\n`);
  }

  /** Keep the published file as downloaded (and its sha256) for retentionDays. */
  function saveRaw(date, name, buf, sha256) {
    const d = join(rawDir, date);
    const safe = String(name).replace(/[^A-Za-z0-9._-]/g, "_");
    writeFileAtomic(join(d, safe), buf);
    writeFileAtomic(join(d, `${safe}.sha256`), `${sha256}  ${safe}\n`);
  }

  function prune(keepDays, today) {
    try {
      return pruneDated(rawDir, { keepDays, today });
    } catch (err) {
      logger?.warn?.("participants: raw retention failed", { err: String(err?.message ?? err) });
      return [];
    }
  }

  function diskBytes() {
    let total = 0;
    const walk = (p) => {
      let st;
      try {
        st = statSync(p);
      } catch {
        return;
      }
      if (st.isDirectory()) {
        for (const n of readdirSync(p)) walk(join(p, n));
      } else total += st.size;
    };
    walk(dir);
    return total;
  }

  return { dir, loadDays, putDay, readState, writeState, saveRaw, prune, diskBytes, corruptLines: () => corruptLines };
}
