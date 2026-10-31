/**
 * Events day store (stream S28): dataDir/events/YYYY-MM-DD.jsonl (dataDir/events-demo/ in demo mode), one line per
 * new record and one per update ({ id, count, lastAt, ..., update: true }), written through server/lib/jsonl.mjs.
 * Writes are buffered and flushed every `flushMs` in one append, so a burst of events costs one write. The user's
 * event selection lives next to the day files in selection.json (written atomically). Old days are pruned after
 * `keepDays`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendLines, istDate, pruneDated, readLines, writeFileAtomic } from "../../lib/jsonl.mjs";

/**
 * @param {{ dir: string | null, clock: { now(): number }, keepDays?: number, flushMs?: number, logger?: object }} o
 */
export function createEventStore({ dir, clock, keepDays = 30, flushMs = 500, logger }) {
  let buffer = [];
  let timer = null;
  let writing = Promise.resolve();
  const fileFor = (date) => (dir ? join(dir, `${date}.jsonl`) : null);

  function flush() {
    timer = null;
    if (!dir || !buffer.length) return writing;
    const byDay = new Map();
    for (const r of buffer) {
      const d = r.date ?? istDate(clock.now());
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    }
    buffer = [];
    writing = writing.then(async () => {
      for (const [d, list] of byDay) {
        try {
          await appendLines(fileFor(d), list);
        } catch (err) {
          logger?.warn?.("could not write events", { err: err?.message });
        }
      }
    });
    return writing;
  }
  const queue = (r) => {
    if (!dir) return;
    buffer.push(r);
    if (!timer) {
      timer = setTimeout(flush, flushMs);
      timer.unref?.();
    }
  };

  return {
    dir,
    append: (rec) => queue(rec),
    appendUpdate: (u) => queue({ ...u, date: istDate(clock.now()) }),
    /** Write what is buffered now (stop, tests). */
    flush,
    /** Every record and update of a day, in write order (missing file: empty). */
    async readDay(date) {
      const f = fileFor(date);
      if (!f) return [];
      await flush();
      const r = await readLines(f);
      return r.items;
    },
    /** The day files on disk (dates), newest first. */
    prune() {
      if (!dir) return [];
      try {
        return pruneDated(dir, { keepDays, today: istDate(clock.now()), match: /(\.jsonl|^context-.*\.json)$/ });
      } catch (err) {
        logger?.warn?.("could not prune event days", { err: err?.message });
        return [];
      }
    },
    loadSelection() {
      if (!dir) return null;
      const f = join(dir, "selection.json");
      if (!existsSync(f)) return null;
      try {
        return JSON.parse(readFileSync(f, "utf8"));
      } catch (err) {
        logger?.warn?.("could not read the event selection; using the defaults", { err: err?.message });
        return null;
      }
    },
    saveSelection(sel) {
      if (!dir) return;
      writeFileAtomic(join(dir, "selection.json"), `${JSON.stringify(sel, null, 2)}\n`);
    },
    loadConditions() {
      if (!dir) return [];
      const f = join(dir, "conditions.json");
      if (!existsSync(f)) return [];
      try {
        const raw = JSON.parse(readFileSync(f, "utf8"));
        return Array.isArray(raw?.conditions) ? raw.conditions : [];
      } catch (err) {
        logger?.warn?.("could not read the custom conditions; starting with none", { err: err?.message });
        return [];
      }
    },
    saveConditions(list) {
      if (!dir) return;
      writeFileAtomic(join(dir, "conditions.json"), `${JSON.stringify({ version: 1, conditions: list }, null, 2)}\n`);
    },
    loadContext(date) {
      if (!dir) return null;
      const f = join(dir, `context-${date}.json`);
      if (!existsSync(f)) return null;
      try {
        return JSON.parse(readFileSync(f, "utf8"));
      } catch {
        return null;
      }
    },
    saveContext(date, map) {
      if (!dir) return;
      try {
        writeFileAtomic(join(dir, `context-${date}.json`), `${JSON.stringify(map)}\n`);
      } catch (err) {
        logger?.warn?.("could not save the previous-day context", { err: err?.message });
      }
    },
  };
}
