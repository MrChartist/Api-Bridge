/**
 * Paper state persistence — stream S8. One JSON file per account in <dataDir>/paper/<accountId>.json, plus
 * <dataDir>/paper/_ids.json for the order-id sequence. Every write is atomic (temp file in the same directory, fsync,
 * rename), so a crash leaves either the old file or the new one. Files are created 0600 in a 0700 directory.
 *
 * A file that cannot be parsed or has the wrong shape is never silently overwritten: it is renamed to
 * "<name>.corrupt-<epoch ms>" and load() reports it, so the engine can start a fresh book and log a warning while the
 * user keeps the evidence.
 *
 * The memory store has the same interface for the fake engine and for tests.
 */
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../lib/jsonl.mjs";

/** Account ids are validated by core config; re-checked here because they become file names. */
export const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

export const STATE_VERSION = 1;

/**
 * @typedef {{ load(accountId: string): { state: object | null, corrupt?: string },
 *   save(accountId: string, state: object): void,
 *   loadIds(): { day: string, seq: number } | null,
 *   saveIds(ids: { day: string, seq: number }): void }} PaperStore
 */

/** Write `data` atomically with mode 0600: the one server implementation (server/lib/jsonl.mjs), re-exported. */
export { writeFileAtomic };

function assertId(accountId) {
  if (typeof accountId !== "string" || !ACCOUNT_ID_RE.test(accountId)) throw new Error(`Bad paper account id ${String(accountId)}`);
}

/** Minimal shape check for a stored account state. */
export function isValidState(s, accountId) {
  return Boolean(
    s &&
      typeof s === "object" &&
      s.v === STATE_VERSION &&
      s.accountId === accountId &&
      Number.isFinite(s.startingCapital) &&
      Array.isArray(s.orders) &&
      Array.isArray(s.trades) &&
      s.positions &&
      typeof s.positions === "object" &&
      Number.isFinite(s.realisedTotal) &&
      Number.isFinite(s.charges),
  );
}

/**
 * File-backed store.
 * @param {string} dir  usually <dataDir>/paper
 * @param {{ now?: () => number }} [opts]
 * @returns {PaperStore}
 */
export function createFileStore(dir, { now = () => Date.now() } = {}) {
  const fileFor = (id) => join(dir, `${id}.json`);
  const quarantine = (path) => {
    const to = `${path}.corrupt-${now()}`;
    try {
      renameSync(path, to);
    } catch {
      /* ignore: nothing more we can do */
    }
    return to;
  };
  return {
    load(accountId) {
      assertId(accountId);
      const path = fileFor(accountId);
      if (!existsSync(path)) return { state: null };
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return { state: null, corrupt: quarantine(path) };
      }
      if (!isValidState(parsed, accountId)) return { state: null, corrupt: quarantine(path) };
      return { state: parsed };
    },
    save(accountId, state) {
      assertId(accountId);
      writeFileAtomic(fileFor(accountId), JSON.stringify(state));
    },
    loadIds() {
      const path = join(dir, "_ids.json");
      if (!existsSync(path)) return null;
      try {
        const o = JSON.parse(readFileSync(path, "utf8"));
        return typeof o?.day === "string" && Number.isInteger(o?.seq) ? { day: o.day, seq: o.seq } : null;
      } catch {
        return null;
      }
    },
    saveIds(ids) {
      writeFileAtomic(join(dir, "_ids.json"), JSON.stringify(ids));
    }
  };
}

/**
 * In-memory store (fake engine, tests). Values are deep-copied on the way in and out, like a real file.
 * @returns {PaperStore & { files: Map<string, string> }}
 */
export function createMemoryStore() {
  const files = new Map();
  let ids = null;
  return {
    files,
    load(accountId) {
      assertId(accountId);
      const raw = files.get(accountId);
      if (raw === undefined) return { state: null };
      const parsed = JSON.parse(raw);
      return isValidState(parsed, accountId) ? { state: parsed } : { state: null, corrupt: "memory" };
    },
    save(accountId, state) {
      assertId(accountId);
      files.set(accountId, JSON.stringify(state));
    },
    loadIds() {
      return ids ? { ...ids } : null;
    },
    saveIds(next) {
      ids = { ...next };
    }
  };
}
