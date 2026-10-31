/**
 * Small JSON state file with atomic writes (temp file + rename), owner-only permissions. Used by the order service
 * for <dataDir>/orders/state.json (idempotency records, clientOrderId map and live order records). Holds no secrets.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

export const STATE_VERSION = 1;

/**
 * @param {string} path
 * @param {{ logger?: { warn(msg: string, f?: object): void, error(msg: string, f?: object): void } }} [opts]
 */
export function createStateFile(path, { logger } = {}) {
  let seq = 0;
  return {
    path,
    /** @returns {object | null} the saved object, or null when there is none or it cannot be read */
    read() {
      if (!existsSync(path)) return null;
      try {
        const obj = JSON.parse(readFileSync(path, "utf8"));
        if (!obj || obj.version !== STATE_VERSION) {
          logger?.warn("orders state file has an unknown version; starting empty", { path });
          return null;
        }
        return obj;
      } catch (err) {
        logger?.error("orders state file could not be read; starting empty", { path, err: String(err?.message ?? err) });
        return null;
      }
    },
    /** Write atomically. Never throws (a failed write is logged). @returns {boolean} */
    write(data) {
      const tmp = `${path}.${process.pid}.${(seq += 1)}.tmp`;
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(tmp, JSON.stringify({ version: STATE_VERSION, ...data }), { mode: 0o600 });
        renameSync(tmp, path);
        return true;
      } catch (err) {
        logger?.error("orders state file could not be written", { path, err: String(err?.message ?? err) });
        try {
          if (existsSync(tmp)) unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        return false;
      }
    },
  };
}
