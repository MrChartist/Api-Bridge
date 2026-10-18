/**
 * Small JSON state files for stream S9 (kill switch, daily counters). Writes are atomic (temp file in the same
 * directory, fsync, rename) and owner-only (0600 file, 0700 directory), so a crash mid-write leaves either the old
 * or the new state, never half a file.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Read a JSON file.
 * @param {string} path
 * @returns {{ status: "missing" } | { status: "ok", value: any } | { status: "corrupt", error: string }}
 */
export function readJsonState(path) {
  if (!existsSync(path)) return { status: "missing" };
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "corrupt", error: "not a JSON object" };
    return { status: "ok", value };
  } catch (err) {
    return { status: "corrupt", error: String(err?.message ?? err).slice(0, 200) };
  }
}

/**
 * Atomically replace `path` with `value` as JSON.
 * @param {string} path
 * @param {unknown} value
 */
export function writeJsonState(path, value) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const body = JSON.stringify(value, null, 2) + "\n";
  let fd;
  try {
    fd = openSync(tmp, "w", 0o600);
    writeSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
    throw err;
  }
}
