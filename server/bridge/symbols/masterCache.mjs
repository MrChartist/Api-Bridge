/**
 * On-disk cache of normalised instrument masters: <dataDir>/instruments/<broker>-<YYYY-MM-DD>.json, one file per
 * broker per IST day. The file holds contract Instrument rows (public exchange data: tokens, symbols, lot sizes),
 * never credentials. Writes are atomic (temp file + rename) with 0600 permissions; older days are pruned.
 *
 * File format: { "version": 1, "broker": "dhan", "day": "2026-10-18", "fetchedAt": <epoch ms>, "rows": [...] }
 */
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const CACHE_VERSION = 1;
const BROKER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkIds(broker, day) {
  if (!BROKER_ID_RE.test(String(broker))) throw new Error(`Bad broker id for the instrument cache: ${broker}`);
  if (day !== undefined && !DAY_RE.test(String(day))) throw new Error(`Bad day for the instrument cache: ${day}`);
}

/**
 * @param {{ dir: string, logger?: { warn: Function } }} opts  dir = <dataDir>/instruments
 */
export function createMasterCache({ dir, logger }) {
  const fileFor = (broker, day) => join(dir, `${broker}-${day}.json`);

  return {
    dir,
    /**
     * Read a cached master. Missing, unreadable or malformed files return null (and are logged, never thrown).
     * @returns {Promise<{ rows: object[], fetchedAt: number } | null>}
     */
    async read(broker, day) {
      checkIds(broker, day);
      let text;
      try {
        text = await readFile(fileFor(broker, day), "utf8");
      } catch (err) {
        if (err?.code !== "ENOENT") logger?.warn("instrument cache unreadable", { broker, day, code: err?.code });
        return null;
      }
      try {
        const doc = JSON.parse(text);
        if (doc?.version !== CACHE_VERSION || doc.broker !== broker || doc.day !== day || !Array.isArray(doc.rows) || !Number.isFinite(doc.fetchedAt)) {
          logger?.warn("instrument cache ignored (unexpected format)", { broker, day });
          return null;
        }
        return { rows: doc.rows, fetchedAt: doc.fetchedAt };
      } catch {
        logger?.warn("instrument cache ignored (not valid JSON)", { broker, day });
        return null;
      }
    },
    /** Atomically write a master for (broker, day). */
    async write(broker, day, { rows, fetchedAt }) {
      checkIds(broker, day);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const target = fileFor(broker, day);
      const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      const body = JSON.stringify({ version: CACHE_VERSION, broker, day, fetchedAt, rows });
      try {
        await writeFile(tmp, body, { mode: 0o600 });
        await rename(tmp, target);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
    },
    /** Delete this broker's files for every day except `keepDay`. Returns the number removed. */
    async prune(broker, keepDay) {
      checkIds(broker, keepDay);
      let names;
      try {
        names = await readdir(dir);
      } catch {
        return 0;
      }
      const re = new RegExp(`^${broker.replace(/[-]/g, "\\-")}-(\\d{4}-\\d{2}-\\d{2})\\.json(?:\\..+\\.tmp)?$`);
      let removed = 0;
      for (const name of names) {
        const m = re.exec(name);
        if (!m || (m[1] === keepDay && !name.endsWith(".tmp"))) continue;
        try {
          await unlink(join(dir, name));
          removed++;
        } catch {
          // another process may have removed it
        }
      }
      return removed;
    },
  };
}
