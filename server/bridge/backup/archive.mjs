/**
 * Write, inspect and unpack a backup archive (a .tar.gz made with Node's own zlib and the small tar code in tar.mjs).
 *
 * Layout: data/<path inside the data folder>, config/bridge.config.json, and manifest.json as the LAST entry (it lists
 * every file with its size and SHA-256, plus the Bridge version, the time and whether secrets.enc is inside). Writing
 * hashes each file as it copies it, then re-reads the finished archive and compares every checksum; reading checks
 * every name, size and checksum before anything is placed on disk.
 *
 * The checksums catch damage and accidental edits. They are not a signature: someone who can rewrite the whole archive
 * can rewrite the manifest too, so the archive stays private (mode 600) like the data it holds.
 */
import { createHash } from "node:crypto";
import { chmodSync, closeSync, createReadStream, createWriteStream, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, statfsSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { BridgeError } from "../core/errors.mjs";
import { CONFIG_ENTRY, DATA_PREFIX, MANIFEST_ENTRY, SECRETS_FILE_NAME, checkEntryName, collectDataFiles, isInside } from "./paths.mjs";
import { TarError, createTarWriter, readTar } from "./tar.mjs";

export const FORMAT = "mc-bridge-backup";
export const FORMAT_VERSION = 1;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** "2.0.1" -> [2, 0, 1] (a pre-release suffix is ignored); null when it is not a version. */
export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Can this archive be restored by this Bridge? Archives from an older (or the same) Bridge are fine, because the stores
 * upgrade their own files; an archive from a NEWER Bridge, or a newer archive format, is refused.
 * @returns {{ ok: boolean, message?: string, warnings: string[] }}
 */
export function checkCompatibility(manifest, { bridgeVersion }) {
  const warnings = [];
  if (manifest?.format !== FORMAT) return { ok: false, warnings, message: "This file is not a Bridge backup (its manifest does not say so)." };
  if (!Number.isInteger(manifest.formatVersion) || manifest.formatVersion > FORMAT_VERSION) {
    return { ok: false, warnings, message: `This backup uses a newer backup format (${manifest.formatVersion}) than this Bridge understands (${FORMAT_VERSION}). Update the Bridge, then restore again.` };
  }
  const have = parseVersion(bridgeVersion);
  const made = parseVersion(manifest.bridgeVersion);
  if (!made) return { ok: false, warnings, message: "This backup does not say which Bridge version made it, so it cannot be checked." };
  if (have) {
    const newer = made[0] > have[0] || (made[0] === have[0] && (made[1] > have[1] || (made[1] === have[1] && made[2] > have[2])));
    if (newer) return { ok: false, warnings, message: `This backup was made by Bridge ${manifest.bridgeVersion}, which is newer than this one (${bridgeVersion}). Older programs can misread newer data. Install Bridge ${manifest.bridgeVersion} or newer, then restore.` };
    if (made[0] < have[0]) warnings.push(`This backup was made by Bridge ${manifest.bridgeVersion} (an older major version). The stores upgrade their files on the next start; keep the safety backup this restore makes.`);
  }
  return { ok: true, warnings };
}

/** Free bytes on the disk holding `dir` (nearest existing parent), or null when the platform cannot say. */
export function freeBytes(dir) {
  try {
    let d = dir;
    while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
    const s = statfsSync(d);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** `mc-bridge-backup-20261109-021500-upgrade.tar.gz` */
export function backupFileName(kind, at = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `mc-bridge-backup-${stamp}-${kind}.tar.gz`;
}

/** @returns {{ kind: string, stamp: string } | null} */
export function parseBackupName(name) {
  const m = /^mc-bridge-backup-(\d{8}-\d{6})-([a-z]+)\.tar\.gz$/.exec(name);
  return m ? { stamp: m[1], kind: m[2] } : null;
}

/** Read a file whole, retrying if it changed while being read. Stores replace files atomically, so one read is a whole version. */
function readStable(abs) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = statSync(abs);
    const data = readFileSync(abs);
    const after = statSync(abs);
    last = data;
    if (before.size === after.size && before.mtimeMs === after.mtimeMs) return { data, mtime: after.mtimeMs / 1000 };
  }
  return { data: last, mtime: Date.now() / 1000 };
}

/**
 * Write a backup archive.
 * State files are read whole (small, replaced atomically). With `includeData` the bulk folders (downloads/, recordings/) are
 * added too, streamed in chunks and hashed on the way, so memory stays small however large they are. `maxBytes` limits the
 * state files only; the bulk tier is limited by `maxDataFiles` and by the free space.
 * @param {{ dataDir: string, configFile?: string | null, out: string, kind?: string, includeSecrets?: boolean, includeData?: boolean, masterKeyFile?: string | null,
 *   bridgeVersion: string, now?: Date, maxBytes?: number, maxDataFiles?: number, minFreeBytes?: number, freeBytesFn?: (dir: string) => number | null }} o
 * @returns {Promise<{ path: string, bytes: number, files: number, includesSecrets: boolean, excluded: Array<{ path: string, reason: string }>, manifest: object }>}
 */
export async function writeBackup(o) {
  const { dataDir, configFile = null, out, kind = "manual", includeSecrets = false, includeData = false, masterKeyFile = null, bridgeVersion, now = new Date(), maxBytes = Infinity } = o;
  if (existsSync(out)) throw new BridgeError("VALIDATION_FAILED", `${out} already exists. A backup never overwrites a file; choose another name with --out.`);
  const { files, excluded } = collectDataFiles(dataDir, { includeSecrets, includeData, masterKeyFile, ...(o.maxDataFiles ? { maxDataFiles: o.maxDataFiles } : {}) });
  const configPresent = Boolean(configFile && existsSync(configFile) && statSync(configFile).isFile());
  const stateBytes = files.reduce((n, f) => (f.bulk ? n : n + f.size), 0) + (configPresent ? statSync(configFile).size : 0);
  const total = stateBytes + files.reduce((n, f) => (f.bulk ? n + f.size : n), 0);
  if (stateBytes > maxBytes) {
    throw new BridgeError("VALIDATION_FAILED", `The data folder holds ${(stateBytes / 1048576).toFixed(0)} MB of settings and state (downloads and recordings are not counted), more than the ${(maxBytes / 1048576).toFixed(0)} MB limit for a backup (backup.maxSizeMb in the settings).`);
  }
  const free = (o.freeBytesFn ?? freeBytes)(dirname(out));
  const need = total + (o.minFreeBytes ?? 0);
  if (free !== null && free < need) {
    const e = new BridgeError("VALIDATION_FAILED", `Not enough free disk space for a backup: about ${(need / 1048576).toFixed(0)} MB needed, ${(free / 1048576).toFixed(0)} MB free in ${dirname(out)}.`);
    e.lowSpace = true;
    throw e;
  }
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  const partial = `${out}.${process.pid}.partial`;
  const gz = createGzip({ level: 6 });
  const fileStream = createWriteStream(partial, { flags: "wx", mode: 0o600 });
  const done = pipeline(gz, fileStream);
  done.catch(() => {});
  const tar = createTarWriter(gz);
  const manifestFiles = [];
  try {
    for (const f of files) {
      if (f.bulk) {
        // A large file: streamed (and cut at the size seen now, because a recording may still be growing).
        let st;
        try {
          st = statSync(f.abs);
        } catch (err) {
          if (err?.code === "ENOENT") continue;
          throw err;
        }
        const hash = createHash("sha256");
        try {
          await tar.addStream(DATA_PREFIX + f.rel, st.size, createReadStream(f.abs, { start: 0, end: Math.max(0, st.size - 1) }), { mtime: st.mtimeMs / 1000, onChunk: (c) => hash.update(c) });
        } catch (err) {
          if (err?.code === "ENOENT") throw new Error(`${f.rel} was removed while it was being copied; try again`);
          throw err;
        }
        manifestFiles.push({ path: DATA_PREFIX + f.rel, size: st.size, sha256: hash.digest("hex") });
        continue;
      }
      let read;
      try {
        read = readStable(f.abs);
      } catch (err) {
        if (err?.code === "ENOENT") continue; // removed while we were copying (a temp file that just finished)
        throw err;
      }
      await tar.add(DATA_PREFIX + f.rel, read.data, { mtime: read.mtime });
      manifestFiles.push({ path: DATA_PREFIX + f.rel, size: read.data.length, sha256: sha256(read.data) });
    }
    if (configPresent) {
      const { data, mtime } = readStable(configFile);
      await tar.add(CONFIG_ENTRY, data, { mtime });
      manifestFiles.push({ path: CONFIG_ENTRY, size: data.length, sha256: sha256(data) });
    }
    const manifest = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      bridgeVersion,
      createdAt: now.toISOString(),
      kind,
      includesSecrets: manifestFiles.some((f) => f.path === DATA_PREFIX + SECRETS_FILE_NAME),
      includesConfig: configPresent,
      includesData: files.some((f) => f.bulk),
      platform: process.platform,
      note: "The master key is never part of a backup. Restoring secrets.enc needs the original master key.",
      files: manifestFiles,
      excluded,
    };
    await tar.add(MANIFEST_ENTRY, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), { mtime: now.getTime() / 1000 });
    await tar.end();
    await done;
    chmodSync(partial, 0o600);
    // Read the finished archive back: every name, size and checksum must match what was copied.
    const check = await inspectArchive(partial);
    if (check.manifest.files.length !== manifestFiles.length) throw new Error("the finished backup does not list the files it was given");
    publish(partial, out);
    return { path: out, bytes: statSync(out).size, files: manifestFiles.length, includesSecrets: manifest.includesSecrets, includesData: manifest.includesData, excluded, manifest };
  } catch (err) {
    gz.destroy();
    await done.catch(() => {});
    try {
      unlinkSync(partial);
    } catch {
      /* not created, or already gone */
    }
    throw err;
  }
}

/** Move the finished file into place without ever replacing an existing one. */
function publish(partial, out) {
  try {
    linkSync(partial, out);
    unlinkSync(partial);
  } catch (err) {
    if (err?.code === "EEXIST") {
      unlinkSync(partial);
      throw new BridgeError("VALIDATION_FAILED", `${out} already exists. A backup never overwrites a file; choose another name with --out.`);
    }
    // File systems without hard links: a plain rename after the check above.
    if (existsSync(out)) {
      unlinkSync(partial);
      throw new BridgeError("VALIDATION_FAILED", `${out} already exists. A backup never overwrites a file; choose another name with --out.`);
    }
    renameSync(partial, out);
  }
}

async function* gunzipped(file) {
  const rs = createReadStream(file);
  const gunzip = createGunzip();
  rs.on("error", (e) => gunzip.destroy(e));
  rs.pipe(gunzip);
  try {
    yield* gunzip;
  } finally {
    rs.destroy();
    gunzip.destroy();
  }
}

/** Turn low-level read errors into one message people can act on. */
function explain(err) {
  if (err instanceof TarError) return new BridgeError("VALIDATION_FAILED", `This backup is damaged or not a backup: ${err.message}.`);
  if (err instanceof BridgeError) return err;
  if (err?.code === "ENOENT") return new BridgeError("VALIDATION_FAILED", `The file ${err.path ?? ""} does not exist.`.replace("  ", " "));
  if (typeof err?.code === "string" && err.code.startsWith("Z_")) return new BridgeError("VALIDATION_FAILED", "This file is damaged or is not a backup made by the Bridge (it cannot be unpacked; a download may have been cut short).");
  if (err?.message?.startsWith?.("The archive holds a file name")) return new BridgeError("VALIDATION_FAILED", `${err.message} Nothing was written.`);
  return err;
}

/**
 * Read an archive end to end without writing anything: every entry name must be allowed, sizes and SHA-256 must match
 * the manifest, and the manifest must list exactly the entries that are there.
 * @returns {Promise<{ manifest: any, entries: Array<{ name: string, size: number, sha256: string }> }>}
 */
export async function inspectArchive(file, opts = {}) {
  return scan(file, null, opts);
}

/**
 * Same checks as inspectArchive, and every file is written under `dest` (data/... and config/...), a folder that must
 * not exist yet. Names are checked before a file is opened, and every target is checked to stay inside `dest`.
 */
export async function extractArchive(file, dest, opts = {}) {
  if (existsSync(dest)) throw new Error(`${dest} already exists`);
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  return scan(file, dest, opts);
}

async function scan(file, dest, { maxFileBytes = 2 ** 31, maxTotalBytes = 2 ** 33 } = {}) {
  const entries = [];
  const seen = new Set();
  let manifestBuf = null;
  try {
    await readTar(gunzipped(file), {
      maxFileBytes,
      maxTotalBytes,
      onFile(name, size) {
        const { area } = checkEntryName(name);
        if (seen.has(name)) throw new TarError(`the file ${name} appears twice`);
        seen.add(name);
        const hash = createHash("sha256");
        let seenBytes = 0;
        if (area === "manifest") {
          if (size > MAX_MANIFEST_BYTES) throw new TarError("the manifest is far too large");
          const chunks = [];
          return {
            write: (c) => chunks.push(c),
            finish: () => {
              manifestBuf = Buffer.concat(chunks);
            },
          };
        }
        let fd = null;
        if (dest) {
          const target = join(dest, name);
          if (!isInside(dest, target)) throw new Error("The archive holds a file name that is not allowed (it leaves the target folder). Nothing was written.");
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          fd = openSync(target, "wx", 0o600);
        }
        return {
          write(chunk) {
            hash.update(chunk);
            seenBytes += chunk.length;
            if (fd !== null) writeSync(fd, chunk);
          },
          finish() {
            if (fd !== null) {
              chmodSync(join(dest, name), 0o600);
              closeSync(fd);
              fd = null;
            }
            entries.push({ name, size: seenBytes, sha256: hash.digest("hex") });
          },
        };
      },
    });
  } catch (err) {
    throw explain(err);
  }
  if (!manifestBuf) throw new BridgeError("VALIDATION_FAILED", "This backup has no manifest (it is cut short or is not a backup made by the Bridge).");
  let manifest;
  try {
    manifest = JSON.parse(manifestBuf.toString("utf8"));
  } catch {
    throw new BridgeError("VALIDATION_FAILED", "This backup's manifest cannot be read.");
  }
  if (manifest?.format !== FORMAT || !Array.isArray(manifest.files)) throw new BridgeError("VALIDATION_FAILED", "This file is not a Bridge backup (its manifest does not say so).");
  const listed = new Map();
  for (const f of manifest.files) {
    try {
      checkEntryName(f?.path);
    } catch (err) {
      throw explain(err);
    }
    if (listed.has(f.path)) throw new BridgeError("VALIDATION_FAILED", `The manifest lists ${f.path} twice.`);
    listed.set(f.path, f);
  }
  const problems = [];
  for (const e of entries) {
    const f = listed.get(e.name);
    if (!f) problems.push(`${e.name} is in the archive but not in its manifest`);
    else if (f.size !== e.size || f.sha256 !== e.sha256) problems.push(`${e.name} does not match its checksum (changed or damaged)`);
  }
  const have = new Set(entries.map((e) => e.name));
  for (const p of listed.keys()) if (!have.has(p)) problems.push(`${p} is listed but missing from the archive`);
  if (problems.length) {
    throw new BridgeError("VALIDATION_FAILED", `This backup failed its checksum check, so nothing was restored. ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? `; and ${problems.length - 5} more` : ""}.`, { errors: problems.map((message) => ({ path: "backup", message })) });
  }
  return { manifest, entries };
}
