/**
 * "Seen recently" map for alert-level dedupe and replay protection.
 *
 * Keys are SHA-256 hashes of hook id + alert identity (never the alert itself), so the file holds no alert content
 * and no secrets. It is bounded (`max` live entries; when full the receiver refuses new alerts instead of forgetting
 * one that could then be sent twice) and, when given a `file`, it survives a restart: a small JSON file written
 * atomically (temp file + rename, mode 0600) a moment after a change, and again on close().
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const FILE_VERSION = 1;
/** How long a change waits before it is written (a burst of alerts is one write). */
const FLUSH_MS = 1500;

/**
 * @param {{ max?: number, now: () => number, file?: string | null, logger?: { warn(m: string, f?: object): void } }} opts
 */
export function createDedupeMap({ max = 20_000, now, file = null, logger }) {
  /** @type {Map<string, { signalId: string, expiresAt: number }>} */
  const m = new Map();
  let timer = null;
  let dirty = false;

  const persist = () => {
    if (!file) return;
    dirty = false;
    try {
      const t = now();
      const entries = [];
      for (const [k, e] of m) if (e.expiresAt > t) entries.push([k, e.signalId, e.expiresAt]);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, entries }), { mode: 0o600 });
      renameSync(tmp, file);
      try {
        chmodSync(file, 0o600);
      } catch {
        /* best effort on platforms without POSIX modes */
      }
    } catch (err) {
      dirty = true;
      logger?.warn("hook dedupe file could not be saved", { message: err?.message });
    }
  };

  const touch = () => {
    if (!file) return;
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (dirty) persist();
    }, FLUSH_MS);
    timer.unref?.();
  };

  if (file && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      const t = now();
      if (parsed?.version === FILE_VERSION && Array.isArray(parsed.entries)) {
        for (const e of parsed.entries) {
          if (!Array.isArray(e) || typeof e[0] !== "string" || typeof e[1] !== "string" || typeof e[2] !== "number" || e[2] <= t) continue;
          if (m.size >= max) break;
          m.set(e[0], { signalId: e[1], expiresAt: e[2] });
        }
      }
    } catch (err) {
      // A damaged file must not stop the hooks: start empty (the order service still refuses a second order for the same alert id).
      logger?.warn("hook dedupe file could not be read; starting empty", { message: err?.message });
    }
  }

  return {
    get(key) {
      const e = m.get(key);
      if (!e) return null;
      if (e.expiresAt <= now()) {
        m.delete(key);
        return null;
      }
      return e;
    },
    set(key, signalId, ttlMs) {
      if (m.size >= max) {
        const t = now();
        for (const [k, e] of m) if (e.expiresAt <= t) m.delete(k);
        // The receiver refuses new alerts while full (full()); this is only a backstop.
        while (m.size >= max) m.delete(m.keys().next().value);
      }
      m.set(key, { signalId, expiresAt: now() + ttlMs });
      touch();
    },
    size: () => m.size,
    /** Full of unexpired entries (after dropping expired ones). */
    full() {
      if (m.size < max) return false;
      const t = now();
      for (const [k, e] of m) if (e.expiresAt <= t) m.delete(k);
      return m.size >= max;
    },
    /** Write pending changes now. */
    flush() {
      if (timer) clearTimeout(timer);
      timer = null;
      if (dirty) persist();
    },
    close() {
      this.flush();
    },
  };
}
