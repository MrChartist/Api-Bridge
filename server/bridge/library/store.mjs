/**
 * Collections on disk: <dataDir>/collections.json, written atomically (temp file, fsync, rename; the same helper the
 * key store and the readiness state use) with mode 0600. No secret is stored here, the private mode is the data folder's
 * convention. A file that cannot be read is moved aside as collections.json.corrupt-<time> and the store starts empty, so
 * a damaged file never stops the Bridge.
 *
 * Record: { id, name, description, tags, kind, symbols | universe, createdAt, updatedAt, previousNames }
 *   id             stable: "col_" and 10 letters/digits. Survives a rename. get() accepts a name, an id or a previous name.
 *   previousNames  names this collection had before a rename (newest first, at most 5), so a download or recording rule that
 *                  still says the old name keeps working. A new collection that takes such a name wins it.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { quarantine, writeFileAtomic } from "../../lib/jsonl.mjs";
import { BridgeError } from "../core/errors.mjs";
import { canonicalSymbols, universeSchema } from "./schema.mjs";
import { normaliseTags } from "./tags.mjs";

export const FILE_VERSION = 1;
export const FILE_NAME = "collections.json";
const ID_RE = /^col_[a-z0-9]{10}$/;
const B36 = "abcdefghijklmnopqrstuvwxyz0123456789";
const MAX_PREVIOUS = 5;

export function newId() {
  const b = randomBytes(10);
  let s = "";
  for (let i = 0; i < 10; i += 1) s += B36[b[i] % 36];
  return `col_${s}`;
}

/** One stored record, re-checked on load (a hand-edited file must not poison the service). Null when unusable. */
function sanitise(r) {
  if (!r || typeof r !== "object" || typeof r.name !== "string" || !ID_RE.test(String(r.id))) return null;
  try {
    const rec = {
      id: r.id,
      name: r.name,
      description: typeof r.description === "string" ? r.description.slice(0, 500) : "",
      tags: normaliseTags(r.tags),
      kind: r.kind === "option-universe" ? "option-universe" : "static",
      createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date(0).toISOString(),
      updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date(0).toISOString(),
      previousNames: Array.isArray(r.previousNames) ? r.previousNames.filter((n) => typeof n === "string").slice(0, MAX_PREVIOUS) : [],
    };
    if (rec.kind === "static") rec.symbols = canonicalSymbols(Array.isArray(r.symbols) ? r.symbols : [], "symbols");
    else {
      const u = universeSchema.safeParse(r.universe);
      if (!u.success) return null;
      rec.universe = u.data;
    }
    return rec;
  } catch {
    return null;
  }
}

/**
 * @param {{ dataDir: string, logger?: { warn?: Function }, now?: () => number }} opts
 */
export function createCollectionStore({ dataDir, logger, now = () => Date.now() }) {
  const file = join(dataDir, FILE_NAME);
  /** @type {Map<string, any>} id -> record */
  const byId = new Map();
  let loadedFrom = "new";

  function load() {
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || parsed.version !== FILE_VERSION || !Array.isArray(parsed.collections)) throw new Error("unknown format");
      let skipped = 0;
      for (const raw of parsed.collections) {
        const rec = sanitise(raw);
        if (rec && !byId.has(rec.id) && ![...byId.values()].some((x) => x.name.toLowerCase() === rec.name.toLowerCase())) byId.set(rec.id, rec);
        else skipped += 1;
      }
      if (skipped) logger?.warn?.("collections.json: skipped unusable entries", { skipped });
      loadedFrom = "file";
    } catch (err) {
      byId.clear();
      loadedFrom = "corrupt";
      try {
        const to = quarantine(file, { now: now() });
        logger?.warn?.("collections.json could not be read; starting with no collections", { movedTo: to, err: err?.message });
      } catch (qErr) {
        logger?.warn?.("collections.json could not be read or moved aside; starting with no collections", { err: qErr?.message });
      }
    }
  }
  load();

  function persist() {
    const body = JSON.stringify({ version: FILE_VERSION, collections: [...byId.values()] }, null, 2);
    try {
      writeFileAtomic(file, `${body}\n`);
    } catch (err) {
      throw new BridgeError("INTERNAL", `The collections could not be saved (${err?.code ?? err?.message}). Check that the data folder is writable and not full.`);
    }
  }

  const lower = (s) => String(s).toLowerCase();

  return {
    file,
    get loadedFrom() {
      return loadedFrom;
    },
    size: () => byId.size,
    /** All records, ordered by name. */
    list: () => [...byId.values()].sort((a, b) => lower(a.name).localeCompare(lower(b.name))),
    /** By exact (case-insensitive) name, then id, then a previous name. Returns { record, via } or null. */
    find(key) {
      const k = lower(key);
      for (const r of byId.values()) if (lower(r.name) === k) return { record: r, via: "name" };
      const byKey = byId.get(String(key));
      if (byKey) return { record: byKey, via: "id" };
      for (const r of byId.values()) if (r.previousNames.some((n) => lower(n) === k)) return { record: r, via: "previous-name" };
      return null;
    },
    /** True when a CURRENT name is taken (ignoring case), optionally by someone other than `exceptId`. */
    nameTaken(name, exceptId = null) {
      const k = lower(name);
      for (const r of byId.values()) if (r.id !== exceptId && lower(r.name) === k) return true;
      return false;
    },
    /** Add a new record (the caller checked the name and the limits). Returns the stored record. */
    add(fields) {
      const t = new Date(now()).toISOString();
      const rec = { id: newId(), createdAt: t, updatedAt: t, previousNames: [], ...fields };
      // A new collection takes a name that an old one used to have.
      for (const r of byId.values()) r.previousNames = r.previousNames.filter((n) => lower(n) !== lower(rec.name));
      byId.set(rec.id, rec);
      persist();
      return rec;
    },
    /** Change a record. A new name moves the old one to previousNames. Returns { record, renamedFrom }. */
    update(id, fields) {
      const cur = byId.get(id);
      if (!cur) throw new BridgeError("NOT_FOUND", "No such collection.");
      const next = { ...cur, ...fields, id: cur.id, createdAt: cur.createdAt, updatedAt: new Date(now()).toISOString() };
      let renamedFrom = null;
      if (fields.name !== undefined && fields.name !== cur.name) {
        renamedFrom = cur.name;
        next.previousNames = [cur.name, ...cur.previousNames.filter((n) => lower(n) !== lower(cur.name) && lower(n) !== lower(fields.name))].slice(0, MAX_PREVIOUS);
        for (const r of byId.values()) if (r.id !== id) r.previousNames = r.previousNames.filter((n) => lower(n) !== lower(fields.name));
      }
      byId.set(id, next);
      persist();
      return { record: next, renamedFrom };
    },
    remove(id) {
      const cur = byId.get(id);
      if (!cur) return null;
      byId.delete(id);
      persist();
      return cur;
    },
  };
}
