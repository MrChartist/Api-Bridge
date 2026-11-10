/**
 * A small keyed store that survives a restart: an append-only JSON-lines journal of `put` and `del` records, replayed
 * into memory at start. Every change is one appended line (so a busy outbox never rewrites a whole file), and the file is
 * rewritten atomically (temp file, fsync, rename) once it holds far more lines than live records. A torn last line from a
 * crash is skipped. Files are 0600 (jsonl.mjs).
 *
 * Records are plain JSON objects with a string `id`. Order of `list()` is the order of the latest put of each id.
 */
import { appendLineSync, compact, readLinesSync } from "../../lib/jsonl.mjs";

/**
 * @template {{ id: string }} T
 * @param {{ file: string, logger?: any }} opts
 */
export function createJournal({ file, logger }) {
  /** @type {Map<string, T>} */
  const items = new Map();
  let lines = 0;
  let writeErrors = 0;

  try {
    const { items: rows, corrupt } = readLinesSync(file);
    for (const r of rows) {
      if (r?.op === "put" && r.r && typeof r.r.id === "string") {
        items.delete(r.r.id);
        items.set(r.r.id, r.r);
      } else if (r?.op === "del" && typeof r.id === "string") items.delete(r.id);
    }
    lines = rows.length + corrupt;
  } catch (err) {
    logger?.warn?.("an events file could not be read; starting empty", { code: err?.code ?? "READ" });
  }

  const write = (rec) => {
    try {
      appendLineSync(file, rec);
      lines += 1;
      if (lines > items.size * 2 + 200) {
        compact(file, [...items.values()].map((r) => ({ op: "put", r })));
        lines = items.size;
      }
    } catch (err) {
      writeErrors += 1;
      if (writeErrors === 1 || writeErrors % 100 === 0) logger?.error?.("an events file could not be written", { code: err?.code ?? "WRITE", failures: writeErrors });
    }
  };

  return {
    /** @param {T} record */
    put(record) {
      items.delete(record.id);
      items.set(record.id, record);
      write({ op: "put", r: record });
      return record;
    },
    /** @param {string} id @param {Partial<T>} patch */
    patch(id, patch) {
      const cur = items.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      items.set(id, next); // keeps its place in the order
      write({ op: "put", r: next });
      return next;
    },
    delete(id) {
      if (!items.delete(id)) return false;
      write({ op: "del", id });
      return true;
    },
    get: (id) => items.get(id) ?? null,
    list: () => [...items.values()],
    size: () => items.size,
    writeErrors: () => writeErrors,
  };
}
