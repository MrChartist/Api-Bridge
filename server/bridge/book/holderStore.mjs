/**
 * Holder tags on disk (stream S27): `<dataDir>/book/holders.json` (demo: `book-demo/holders.json`, never mixed).
 *
 *   { "version": 1, "holders": { "spouse": { "relationship": "spouse", "label": "Asha" } }, "updatedAt": "…", "updatedBy": "local" }
 *
 * loadHolderTags(paths) is a synchronous read cached by the file's signature (P1-11 alert actions import it and call it
 * per decision). A file that does not parse is renamed `holders.json.corrupt-<ts>` and read as empty, so every holder
 * except the untagged one falls outside the family until it is tagged again (never wrongly inside it).
 * Writes are atomic (temp file + rename), mode 0600, folder 0700. No secrets, PANs or broker client codes are stored.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileSignature } from "../auth/fsUtil.mjs";
import { quarantine, writeFileAtomic } from "../../lib/jsonl.mjs";
import { toIstIso } from "../symbols/ist.mjs";
import { HOLDER_RE, RELATIONSHIPS } from "./config.mjs";

/** The holders file for a data folder. */
export const holdersFile = (paths, { demo = false } = {}) => join(paths?.dataDir ?? ".", demo ? "book-demo" : "book", "holders.json");

const EMPTY = Object.freeze({ version: 1, holders: Object.freeze({}), updatedAt: null, updatedBy: null });
const cache = new Map(); // file -> { sig, doc }

/** Keep only well-formed tags (a hand-edited file may carry anything). */
function clean(doc) {
  const holders = {};
  const src = doc && typeof doc === "object" && doc.holders && typeof doc.holders === "object" ? doc.holders : {};
  for (const [h, t] of Object.entries(src)) {
    if (!HOLDER_RE.test(h) || !t || typeof t !== "object" || !RELATIONSHIPS.includes(t.relationship)) continue;
    holders[h] = typeof t.label === "string" && t.label.trim() ? { relationship: t.relationship, label: t.label.trim().slice(0, 40) } : { relationship: t.relationship };
  }
  return { version: 1, holders, updatedAt: typeof doc?.updatedAt === "string" ? doc.updatedAt : null, updatedBy: typeof doc?.updatedBy === "string" ? doc.updatedBy : null };
}

/**
 * The holder tags document (sync, cached by file signature).
 * @param {{ dataDir: string }} paths @param {{ demo?: boolean, logger?: object }} [opts]
 * @returns {{ version: 1, holders: Record<string, { relationship: string, label?: string }>, updatedAt: string|null, updatedBy: string|null }}
 */
export function loadHolderDoc(paths, { demo = false, logger } = {}) {
  const file = holdersFile(paths, { demo });
  let sig;
  try {
    sig = fileSignature(file);
  } catch {
    sig = null;
  }
  if (sig === null) {
    cache.delete(file);
    return EMPTY;
  }
  const hit = cache.get(file);
  if (hit && hit.sig === sig) return hit.doc;
  let doc;
  try {
    doc = clean(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    const moved = (() => {
      try {
        return quarantine(file);
      } catch {
        return null;
      }
    })();
    logger?.warn?.("holder tags could not be read; starting empty", { file, movedTo: moved, error: err?.message });
    cache.delete(file);
    return EMPTY;
  }
  cache.set(file, { sig, doc });
  return doc;
}

/** Just the tags: holder -> { relationship, label? } (what family.mjs takes). */
export const loadHolderTags = (paths, opts) => loadHolderDoc(paths, opts).holders;

/**
 * Read/write access for the routes.
 * @param {{ paths: { dataDir: string }, demo?: boolean, clock?: { now(): number }, logger?: object }} deps
 */
export function createHolderStore({ paths, demo = false, clock = { now: () => Date.now() }, logger } = {}) {
  const file = holdersFile(paths, { demo });
  return {
    file,
    read: () => loadHolderDoc(paths, { demo, logger }),
    tags: () => loadHolderDoc(paths, { demo, logger }).holders,
    /**
     * Set (or, with `tag` null, remove) one holder's tag. Returns the new document.
     * @param {string} holder @param {{ relationship: string, label?: string } | null} tag @param {string} by
     */
    set(holder, tag, by = "local") {
      const cur = loadHolderDoc(paths, { demo, logger });
      const holders = { ...cur.holders };
      if (tag) holders[holder] = tag.label ? { relationship: tag.relationship, label: tag.label } : { relationship: tag.relationship };
      else delete holders[holder];
      const doc = { version: 1, holders, updatedAt: toIstIso(clock.now()), updatedBy: by };
      writeFileAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
      cache.delete(file);
      return clean(doc);
    },
  };
}
