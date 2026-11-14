/**
 * Write failures, counted in one place. Every durable write in the Bridge goes through server/lib/jsonl.mjs
 * (writeFileAtomic, appendLine*) or a store built on it; each failed write is noted here and each good write to the
 * same path clears the note. The storage monitor (bridge/storage) reads this to say "the Bridge cannot save" in
 * /v1/health, and a caller can ask whether an error means the disk is full (isDiskFull).
 *
 * Process-wide on purpose (file paths are the key), so a store needs no wiring. Tests that want a clean slate call
 * resetWriteFailures().
 */

const DISK_FULL_CODES = new Set(["ENOSPC", "EDQUOT"]);
const MAX_TRACKED = 200;

/** @type {Map<string, { path: string, at: number, code: string, message: string }>} */
const failing = new Map();
let total = 0;
let lastFailure = null;
/** @type {Set<(f: { path: string, at: number, code: string, diskFull: boolean }) => void>} */
const listeners = new Set();
let clock = () => Date.now();

/** Whether an error means the disk (or the user's quota) is full. */
export const isDiskFull = (err) => DISK_FULL_CODES.has(err?.code);

/** @param {string} path @param {any} err */
export function noteWriteFailure(path, err) {
  total += 1;
  const at = clock();
  const entry = { path: String(path), at, code: String(err?.code ?? "ERROR"), message: String(err?.message ?? err).slice(0, 200) };
  failing.delete(entry.path);
  failing.set(entry.path, entry);
  if (failing.size > MAX_TRACKED) failing.delete(failing.keys().next().value);
  lastFailure = entry;
  for (const fn of listeners) {
    try {
      fn({ ...entry, diskFull: isDiskFull(err) });
    } catch {
      /* a listener must not break a write path */
    }
  }
}

/** A good write to `path` clears its failure. @param {string} path */
export function noteWriteOk(path) {
  if (failing.size) failing.delete(String(path));
}

/**
 * Write problems that are still open, optionally only under a folder.
 * @param {{ under?: string }} [opts]
 */
export function writeFailureStatus({ under } = {}) {
  const norm = (p) => String(p).replace(/\\/g, "/");
  const base = under ? norm(under).replace(/\/+$/, "") : null;
  const open = [...failing.values()].filter((f) => !base || norm(f.path) === base || norm(f.path).startsWith(`${base}/`));
  return { open, openCount: open.length, total, last: lastFailure };
}

/** Subscribe to failures. Returns the unsubscribe function. @param {(f: object) => void} fn */
export function onWriteFailure(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Tests only. */
export function resetWriteFailures({ now } = {}) {
  failing.clear();
  total = 0;
  lastFailure = null;
  if (typeof now === "function") clock = now;
}

// ── Files set aside as damaged (see safeStore.mjs) ──

const MAX_QUARANTINED = 200;
/** @type {Array<{ file: string, movedTo: string | null, at: number, what: string, reason: string }>} */
const quarantinedEntries = [];
/** @type {Set<(e: object) => void>} */
const quarantineListeners = new Set();
const norm = (p) => String(p).replace(/\\/g, "/");

/** Remember that a file was set aside. Called by quarantine() and by stores that move files themselves. */
export function registerQuarantine({ file, movedTo = null, what, reason = "was damaged", at = clock() }) {
  const entry = { file: String(file), movedTo, at, what: String(what ?? file), reason };
  quarantinedEntries.push(entry);
  if (quarantinedEntries.length > MAX_QUARANTINED) quarantinedEntries.splice(0, quarantinedEntries.length - MAX_QUARANTINED);
  for (const fn of quarantineListeners) {
    try {
      fn({ ...entry });
    } catch {
      /* a listener must not break loading */
    }
  }
  return entry;
}

/** Files set aside during this run, oldest first, optionally only under a data folder. @param {{ under?: string }} [opts] */
export function quarantined({ under } = {}) {
  const base = under ? norm(under).replace(/\/+$/, "") : null;
  return quarantinedEntries.filter((e) => !base || norm(e.file).startsWith(`${base}/`)).map((e) => ({ ...e }));
}

/** Subscribe to quarantine events. Returns the unsubscribe function. @param {(e: object) => void} fn */
export function onQuarantine(fn) {
  quarantineListeners.add(fn);
  return () => quarantineListeners.delete(fn);
}

/** Tests only. */
export function resetQuarantined() {
  quarantinedEntries.length = 0;
}
