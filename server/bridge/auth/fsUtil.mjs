/**
 * Small file helpers shared by SecretStore and KeyStore: atomic private writes, change detection and permission
 * checks. POSIX permission checks are skipped on Windows, where file modes do not describe access (NTFS ACLs);
 * protecting the data directory there is left to the user profile's default ACL (needs verification per setup).
 */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, basename, join } from "node:path";

export const IS_POSIX = process.platform !== "win32";

/**
 * Write `data` to `path` atomically with mode 0600: write a temp file in the same directory, fsync, rename over the
 * target, then fsync the directory (best effort). Readers see either the old file or the new one, never a mix.
 * @param {string} path
 * @param {string | Buffer} data
 */
export function writeFileAtomic(path, data) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let fd = null;
  try {
    fd = openSync(tmp, "wx", 0o600);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  if (IS_POSIX) {
    try {
      const dfd = openSync(dir, "r");
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      // Some filesystems refuse fsync on a directory; the rename is still atomic.
    }
  }
}

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
