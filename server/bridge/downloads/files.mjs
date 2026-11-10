/**
 * Small file helpers for the downloads folder: atomic JSON writes, safe file names, sizes, hashes and the folder walk
 * that measures disk use. Every path under the downloads folder is built from names the Bridge made itself (job ids,
 * dataset names checked against a pattern, file names from `safeFileName`); a client never supplies one.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../../lib/jsonl.mjs";

export const JOB_ID_RE = /^dl_[0-9a-f]{12}$/;

/**
 * Write JSON atomically and durably: the one shared helper (temp file, fsync, rename with a retry for Windows, fsync of
 * the folder). A failed write leaves no temp file behind. The files are small, so the synchronous write is brief.
 */
export async function writeJsonAtomic(file, value) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** "NSE:M&M" -> "NSE_M_M": letters, digits, dot, dash and underscore only, never empty, at most 80 characters. */
export function safeFileName(text) {
  const s = String(text)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 80);
  return s || "file";
}

/** A name not in `taken`: `base`, else base_2, base_3 ... (keeps the extension last). */
export function uniqueName(base, ext, taken) {
  let name = `${base}.${ext}`;
  for (let i = 2; taken.has(name.toLowerCase()); i += 1) name = `${base}_${i}.${ext}`;
  taken.add(name.toLowerCase());
  return name;
}

/** sha256 (hex) of a file, streamed. */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(file);
    s.on("data", (c) => h.update(c));
    s.on("error", reject);
    s.on("end", () => resolve(h.digest("hex")));
  });
}

/** Size of a file in bytes, 0 when it does not exist. */
export async function sizeOf(file) {
  try {
    return (await stat(file)).size;
  } catch (err) {
    if (err?.code === "ENOENT") return 0;
    throw err;
  }
}

/** Total size of every file under a folder (0 when missing). */
export async function folderBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return 0;
    throw err;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await folderBytes(p);
    else if (e.isFile()) total += await sizeOf(p);
  }
  return total;
}

/** Remove a file or folder, ignoring "not there". */
export const removeQuiet = (p) => rm(p, { recursive: true, force: true });
