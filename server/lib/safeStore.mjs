/**
 * Loading a state file that may be damaged, the same way everywhere.
 *
 * A power cut or a full disk can leave a JSON file empty or cut off. The rule for every store:
 *   1. move the damaged file aside as `<name>.corrupt-<UTC stamp>` (a person can still look at it),
 *   2. log a warning that names the file and what it held,
 *   3. start with an empty store, so the Bridge still starts,
 *   4. remember it (quarantined(), shown in /v1/health and `mc-bridge doctor`) and tell listeners (the bus event
 *      data.quarantined).
 * A store never overwrites a damaged file without keeping it first.
 *
 * Journals (one JSON value per line) are different: one bad line does not make the file unusable, so
 * noteCorruptLines() keeps a copy of the file and reports it while the good lines carry on.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileStamp, quarantine } from "./jsonl.mjs";
import { registerQuarantine } from "./storageHealth.mjs";

export { onQuarantine, quarantined, resetQuarantined } from "./storageHealth.mjs";

/** Log a set-aside file in one plain line (the registry entry is made by quarantine()). */
function logQuarantine(log, { file, movedTo, what, reason }) {
  log?.warn?.(`${what}: ${file} ${reason}${movedTo ? `; moved aside to ${movedTo}` : ""}. Starting with an empty ${what}.`, { file, movedTo, reason });
}

/**
 * Read and parse a JSON file. A missing file is `{ missing: true }`. A file that is empty, not JSON, or that `validate`
 * rejects is moved aside and reported (see the top of this file).
 * @param {string} file
 * @param {{ what: string, log?: any, now?: number, validate?: (value: any) => boolean | string | void }} opts
 *   validate: return false (or a reason string) to say the content is not a usable store
 * @returns {{ value: any, missing: boolean, quarantinedTo: string | null, reason?: string }}
 */
export function loadJsonOrQuarantine(file, { what, log, now = Date.now(), validate } = {}) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { value: null, missing: true, quarantinedTo: null };
    throw err;
  }
  let reason = null;
  let value = null;
  if (text.trim() === "") reason = "is empty";
  else {
    try {
      value = JSON.parse(text);
    } catch (err) {
      reason = `could not be read (${String(err?.message ?? err).slice(0, 100)})`;
    }
  }
  if (reason === null && validate) {
    const verdict = validate(value);
    if (verdict !== true && verdict !== undefined) reason = typeof verdict === "string" ? verdict : "has an unknown format";
  }
  if (reason === null) return { value, missing: false, quarantinedTo: null };
  let movedTo = null;
  try {
    movedTo = quarantine(file, { now, what, reason });
  } catch (err) {
    log?.error?.(`${what}: ${file} is damaged and could not be moved aside`, { file, err: String(err?.message ?? err) });
  }
  logQuarantine(log, { file, movedTo, what, reason });
  return { value: null, missing: false, quarantinedTo: movedTo, reason };
}

const reported = new Map();

/**
 * A journal had lines that could not be read. Keep a copy of the whole file (the good lines carry on) and report it.
 * Reports once per file and count, so a store that reads the same journal twice does not repeat itself.
 * @param {string} file
 * @param {{ what: string, corrupt: number, log?: any, now?: number }} opts
 * @returns {string | null} the copy's path
 */
export function noteCorruptLines(file, { what, corrupt, log, now = Date.now() }) {
  if (!corrupt || !existsSync(file)) return null;
  if (reported.get(file) === corrupt) return null;
  reported.set(file, corrupt);
  let copy = null;
  try {
    copy = `${file}.corrupt-${fileStamp(now)}`;
    copyFileSync(file, copy);
  } catch {
    copy = null;
  }
  const reason = `had ${corrupt} unreadable line${corrupt === 1 ? "" : "s"} (a copy was kept; the other lines are used)`;
  registerQuarantine({ file, movedTo: copy, what, reason, at: now });
  log?.warn?.(`${what}: ${file} ${reason}.`, { file, movedTo: copy, corrupt });
  return copy;
}

/** Tests only: forget which journals were already reported. */
export const resetReportedJournals = () => reported.clear();

/**
 * `*.corrupt-*` files under a folder (for doctor and health after a restart: the registry only knows this run).
 * Bounded: at most `maxFiles` entries and `depth` levels. Skips backups/ (archives, not state).
 * @param {string} dir
 * @param {{ depth?: number, maxFiles?: number }} [opts]
 * @returns {Array<{ file: string, bytes: number, modifiedAt: number }>}
 */
export function findCorruptFiles(dir, { depth = 4, maxFiles = 200 } = {}) {
  const out = [];
  const walk = (d, level) => {
    if (out.length >= maxFiles || level > depth) return;
    let names;
    try {
      names = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of names) {
      if (out.length >= maxFiles) return;
      const p = join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "backups" || ent.name === "instruments") continue;
        walk(p, level + 1);
      } else if (/\.corrupt-/.test(ent.name)) {
        try {
          const st = statSync(p);
          out.push({ file: p, bytes: st.size, modifiedAt: st.mtimeMs });
        } catch {
          /* gone */
        }
      }
    }
  };
  walk(dir, 0);
  return out;
}
