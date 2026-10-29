/**
 * Small file helpers shared by SecretStore and KeyStore: atomic private writes, change detection and permission
 * checks. POSIX permission checks are skipped on Windows, where file modes do not describe access (NTFS ACLs);
 * protecting the data directory there is left to the user profile's default ACL (needs verification per setup).
 */
import { statSync } from "node:fs";

export const IS_POSIX = process.platform !== "win32";

/**
 * Write `data` to `path` atomically with mode 0600 (temp file, fsync, rename, fsync folder). One implementation for
 * the whole server lives in server/lib/jsonl.mjs; it is re-exported here so SecretStore and KeyStore keep this import.
 */
export { writeFileAtomic } from "../../lib/jsonl.mjs";

/**
 * A cheap fingerprint of a file's identity and content version, or null when the file does not exist. Used to
 * notice edits made by another process (the CLI) without a file watcher, which is unreliable across platforms.
 * @param {string} path
 * @returns {string | null}
 */
export function fileSignature(path) {
  try {
    const s = statSync(path, { bigint: true });
    return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Why a key file must not be used, or null when it is fine: not a regular file, readable or writable by group or
 * others, or owned by a different user. Always null on Windows.
 * @param {import("node:fs").Stats} st
 * @returns {string | null}
 */
export function unsafeKeyFileReason(st) {
  if (!st.isFile()) return "is not a regular file";
  if (!IS_POSIX) return null;
  if ((st.mode & 0o077) !== 0) return `is accessible by other users (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 <file>`;
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return "is owned by a different user";
  return null;
}
