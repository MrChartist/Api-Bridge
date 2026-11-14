/**
 * Which files a backup holds, and which archive names are acceptable on restore.
 *
 * A backup is everything in the data folder that cannot be made again (keys store, accounts, state, quotas, source
 * settings, pooling consent, paper books, order records, audit log, hooks) plus bridge.config.json, minus:
 *   - the master key (master.key, or wherever "masterKeyFile" points): NEVER, so a copy of the archive never carries the
 *     key that unlocks secrets.enc;
 *   - secrets.enc unless asked for (--include-secrets), because it is only useful with the original master key;
 *   - things that are only valid for one run (control.token, one-time sign-in codes, lock and temp files);
 *   - caches that are downloaded again (instruments/) and the backups folder itself;
 *   - the BULK data: downloads/ (files saved from the broker's history, datasets) and recordings/ (saved live prices and
 *     option chains). They can be many gigabytes and can be downloaded or recorded again, so a normal backup leaves them
 *     out and says so, with their size. `includeData` (mc-bridge backup --include-data, or backup.includeData) adds them,
 *     streamed rather than read into memory. Only that tier has a file-count limit (backup.maxDataFiles).
 * The same rules apply when an archive is read: an archive that carries one of these files is refused, so a doctored
 * archive cannot plant a control token or a master key.
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { BridgeError } from "../core/errors.mjs";

export const DATA_PREFIX = "data/";
export const CONFIG_ENTRY = "config/bridge.config.json";
export const MANIFEST_ENTRY = "manifest.json";
export const SECRETS_FILE_NAME = "secrets.enc";
export const BACKUPS_DIR = "backups";
/** Top-level folders that hold bulk data, not state. */
export const BULK_DIRS = Object.freeze(["downloads", "recordings"]);
/** How many state files a data folder may hold before it is not a normal Bridge folder. */
export const MAX_STATE_FILES = 500_000;

/** @param {string} p */
const lower = (p) => p.toLowerCase();

/**
 * Whether a file inside the data folder belongs in a backup.
 * @param {string} rel  path inside the data folder, with "/" separators
 * @returns {{ include: true } | { include: false, reason: string, always?: boolean }}
 */
export function classify(rel, { includeSecrets = false, includeData = false } = {}) {
  const parts = rel.split("/");
  const name = lower(parts[parts.length - 1]);
  const top = lower(parts[0]);
  if (/^master\.key/.test(name)) return { include: false, always: true, reason: "the master key is never included" };
  if (top === "control.token") return { include: false, always: true, reason: "valid only while one Bridge runs" };
  if (top === "sign-in-codes.json" || top === ".sign-in-codes.json.lock") return { include: false, always: true, reason: "one-time sign-in codes" };
  if (top === "last-version.json") return { include: false, always: true, reason: "bookkeeping of this computer" };
  if (top === BACKUPS_DIR && parts.length >= 1) return { include: false, always: true, reason: "backups are not copied into backups" };
  if (top === "instruments") return { include: false, always: true, reason: "a cache that is downloaded again" };
  if (!includeData && BULK_DIRS.includes(top)) return { include: false, bulk: true, reason: "downloaded or recorded data: large, and it can be downloaded or recorded again. Add --include-data to include it" };
  if (/^\.(restore-staging|pre-restore)-/.test(top)) return { include: false, always: true, reason: "a restore in progress" };
  if (/\.(tmp|lock|partial|pid)$/.test(name)) return { include: false, always: true, reason: "a temporary file" };
  if (parts.length === 1 && name === SECRETS_FILE_NAME && !includeSecrets) return { include: false, reason: "saved broker logins; add --include-secrets (restoring them needs your original master key)" };
  return { include: true };
}

/**
 * Check an archive entry name and say where it goes. Throws a plain Error (message for people) on anything that could
 * leave the target folder or name a file a backup never holds.
 * @param {string} name
 * @returns {{ area: "data" | "config" | "manifest", rel: string }}
 */
export function checkEntryName(name) {
  const bad = (why) => new Error(`The archive holds a file name that is not allowed (${why}): ${JSON.stringify(String(name).slice(0, 120))}`);
  if (typeof name !== "string" || name === "") throw bad("empty");
  if (name.includes("\0")) throw bad("NUL character");
  if (name.includes("\\")) throw bad("backslash");
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw bad("absolute path");
  const parts = name.split("/");
  for (const p of parts) {
    if (p === "" || p === "." || p === "..") throw bad("relative path parts");
    if (p.includes(":")) throw bad("colon");
    if (/[\u0000-\u001f]/.test(p)) throw bad("control character");
    if (p.length > 200) throw bad("too long");
    if (/[. ]$/.test(p)) throw bad("name ends in a dot or space");
  }
  if (name === MANIFEST_ENTRY) return { area: "manifest", rel: name };
  if (name === CONFIG_ENTRY) return { area: "config", rel: name };
  if (name.startsWith(DATA_PREFIX) && parts.length >= 2) {
    const rel = name.slice(DATA_PREFIX.length);
    const c = classify(rel, { includeSecrets: true, includeData: true });
    if (!c.include) throw bad(c.reason);
    return { area: "data", rel };
  }
  throw bad("outside data/ and config/");
}

/**
 * Files of the data folder that a backup holds. Links and other non-regular files are skipped (never followed).
 * audit/head.json comes before the log files so a log that grows while copying is never older than its head record.
 * `includeData` adds the bulk folders (each file is marked `bulk: true`); more than `maxDataFiles` of them is refused with a
 * plain message (the state files have their own, much higher, limit).
 * @returns {{ files: Array<{ rel: string, abs: string, size: number, bulk?: boolean }>, excluded: Array<{ path: string, reason: string, bulk?: boolean }> }}
 */
export function collectDataFiles(dataDir, { includeSecrets = false, includeData = false, masterKeyFile = null, maxDepth = 8, maxFiles = MAX_STATE_FILES, maxDataFiles = 50_000 } = {}) {
  let stateCount = 0;
  let dataCount = 0;
  const files = [];
  const excluded = [];
  let masterReal = null;
  try {
    if (masterKeyFile) masterReal = realpathSync(masterKeyFile);
  } catch {
    masterReal = masterKeyFile ? resolve(masterKeyFile) : null;
  }
  const root = resolve(dataDir);
  const walk = (dirAbs, relDir, depth) => {
    let names;
    try {
      names = readdirSync(dirAbs, { withFileTypes: true });
    } catch (err) {
      if (err?.code === "ENOENT") return;
      throw err;
    }
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of names) {
      const rel = relDir ? `${relDir}/${d.name}` : d.name;
      const abs = join(dirAbs, d.name);
      const c = classify(d.isDirectory() ? `${rel}/` : rel, { includeSecrets, includeData });
      if (!c.include) {
        // Temp and lock files deep in a folder are noise; everything named at the top, and any master key, is listed.
        if (relDir === "" || !c.always || /^master\.key/i.test(d.name)) excluded.push({ path: rel, reason: c.reason, ...(c.bulk ? { bulk: true } : {}) });
        continue;
      }
      let st;
      try {
        st = lstatSync(abs);
      } catch (err) {
        if (err?.code === "ENOENT") continue;
        throw err;
      }
      if (st.isSymbolicLink()) {
        excluded.push({ path: rel, reason: "a link (links are never followed)" });
        continue;
      }
      if (st.isDirectory()) {
        if (depth >= maxDepth) {
          excluded.push({ path: rel, reason: "nested too deeply" });
          continue;
        }
        walk(abs, rel, depth + 1);
        continue;
      }
      if (!st.isFile()) {
        excluded.push({ path: rel, reason: "not a regular file" });
        continue;
      }
      if (masterReal) {
        let real = abs;
        try {
          real = realpathSync(abs);
        } catch {
          /* gone: skipped when read */
        }
        if (real === masterReal || resolve(abs) === resolve(masterKeyFile)) {
          excluded.push({ path: rel, reason: "the master key is never included" });
          continue;
        }
      }
      const bulk = BULK_DIRS.includes(rel.split("/")[0]);
      files.push({ rel, abs, size: st.size, ...(bulk ? { bulk: true } : {}) });
      if (bulk) {
        if (++dataCount > maxDataFiles) throw new BridgeError("VALIDATION_FAILED", `The downloads and recordings hold more than ${maxDataFiles} files, more than a backup carries (backup.maxDataFiles). Make the backup without --include-data and copy the downloads and recordings folders yourself, or raise the limit.`);
      } else if (++stateCount > maxFiles) {
        throw new BridgeError("VALIDATION_FAILED", `The data folder has more than ${maxFiles} files outside downloads and recordings; that is not a normal Bridge folder, so nothing was backed up.`);
      }
    }
  };
  walk(root, "", 0);
  const first = (f) => (f.rel === "audit/head.json" ? 0 : 1);
  files.sort((a, b) => first(a) - first(b) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, excluded };
}

/** Inside `root`? (after resolving; used before writing any extracted file) */
export function isInside(root, target) {
  const r = resolve(root);
  const t = resolve(target);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * How much the bulk folders hold, for the lines "downloads: 22 MB, 32 jobs; recordings: 1.6 MB" (the backup, restore and
 * doctor texts). Reads folder names and sizes only; stops counting after `maxEntries` files and says so (`partial`).
 * @returns {Array<{ name: string, bytes: number, files: number, items: number, partial: boolean }>} only folders that exist and hold something
 */
export function measureBulk(dataDir, { maxEntries = 200_000 } = {}) {
  const out = [];
  let budget = maxEntries;
  for (const name of BULK_DIRS) {
    const root = join(dataDir, name);
    let bytes = 0;
    let files = 0;
    let partial = false;
    const walk = (dir, depth) => {
      let ents;
      try {
        ents = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        if (budget <= 0) {
          partial = true;
          return;
        }
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 8) walk(p, depth + 1);
        } else if (e.isFile()) {
          budget -= 1;
          files += 1;
          try {
            bytes += lstatSync(p).size;
          } catch {
            /* gone */
          }
        }
      }
    };
    walk(root, 0);
    if (!files && !partial) continue;
    // Jobs (downloads/jobs/<id>) and recordings (recordings/<id>) are what a person counts.
    let items = 0;
    try {
      items = readdirSync(name === "downloads" ? join(root, "jobs") : root, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
    } catch {
      items = 0;
    }
    out.push({ name, bytes, files, items, partial });
  }
  return out;
}

/** "downloads: 22 MB, 32 jobs; recordings: 1.6 MB, 3 recordings" */
export function describeBulk(rows) {
  const mb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  return rows
    .map((r) => `${r.name}: ${r.partial ? "at least " : ""}${mb(r.bytes)}, ${r.items} ${r.name === "downloads" ? "job" : "recording"}${r.items === 1 ? "" : "s"}`)
    .join("; ");
}
