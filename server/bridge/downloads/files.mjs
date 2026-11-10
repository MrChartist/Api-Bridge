/**
 * Small file helpers for the downloads folder: atomic JSON writes, safe file names, sizes, hashes and the folder walk
 * that measures disk use. Every path under the downloads folder is built from names the Bridge made itself (job ids,
 * dataset names checked against a pattern, file names from `safeFileName`); a client never supplies one.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const JOB_ID_RE = /^dl_[0-9a-f]{12}$/;

/** Write JSON atomically: a temp file in the same folder, then a rename. `compact` skips the indentation (job state: thousands of items). */
export async function writeJsonAtomic(file, value, { compact = false } = {}) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  await writeFile(tmp, `${compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
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
