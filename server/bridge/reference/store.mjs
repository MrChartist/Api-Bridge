/**
 * JSON stores for reference data under dataDir/reference/ (stream S16, docs/spec/p1-02-reference.md §2.3). Every
 * write is atomic (temp file + rename, 0600). Every file has `{ "version": 1, ... }`. A file that fails to parse is
 * renamed to `<name>.corrupt-<ts>` and the dataset restarts empty with one logged warning: a corrupted file must not
 * stop the next day (BRD §7.7).
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pruneDated, quarantine, writeFileAtomic } from "../../lib/jsonl.mjs";

export const STORE_FILES = Object.freeze(["state.json", "settings.json", "lots.json", "universe.json", "ban.json", "mwpl.json", "corporate-actions.json"]);

/**
 * @param {string} dir  dataDir/reference
 * @param {{ now?: () => number, logger?: any }} [o]
 */
export function createReferenceStore(dir, { now = () => Date.now(), logger } = {}) {
  let made = false;
  const ensureDir = () => {
    if (made) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* not POSIX */
    }
    made = true;
  };

  /**
   * Read a store file; `empty()` when missing; quarantined and `empty()` when corrupt or the wrong version.
   * @template T
   * @param {string} name
   * @param {() => T} empty
   * @returns {T}
   */
  function read(name, empty) {
    const file = join(dir, name);
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") return empty();
      throw err;
    }
    try {
      const obj = JSON.parse(text);
      if (!obj || typeof obj !== "object" || obj.version !== 1) throw new Error("not a version 1 file");
      return obj;
    } catch (err) {
      const moved = quarantine(file, { now: now() });
      logger?.warn?.("reference store file was corrupt; moved aside and starting empty", { file: name, movedTo: moved, err: String(err?.message ?? err) });
      return empty();
    }
  }

  /** Write a store file atomically. */
  function write(name, obj) {
    ensureDir();
    writeFileAtomic(join(dir, name), `${JSON.stringify({ ...obj, version: 1 }, null, 1)}\n`);
  }

  /**
   * Keep a raw download for audit: raw/<date>/<name> plus <name>.sha256.
   * @returns {{ path: string, sha256: string }}
   */
  function writeRaw(date, name, buf) {
    ensureDir();
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const folder = join(dir, "raw", date);
    writeFileAtomic(join(folder, name), buf);
    writeFileAtomic(join(folder, `${name}.sha256`), `${sha256}  ${name}\n`);
    return { path: join(folder, name), sha256 };
  }

  /** Remove raw/<date> folders older than keepDays. */
  const pruneRaw = (keepDays, today) => pruneDated(join(dir, "raw"), { keepDays, today });

  return { dir, read, write, writeRaw, pruneRaw };
}
