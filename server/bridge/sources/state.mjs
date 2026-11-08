/**
 * Persisted per-source state: <dataDir>/sources/state.json.
 *
 *   { "version": 1, "sources": { "<id>": { "enabled": boolean, "configured": boolean,
 *       "consent": { "acceptedAt": "<ISO>", "noticeVersion": "<string>" } | null,
 *       "disabledAt": "<ISO>" | null } } }
 *
 * `disabledAt` is when the owner last switched the source off; a source switched off for more than 24 hours needs its
 * notice acknowledged again (service.mjs). This file is TRUSTED LOCAL STATE, not tamper-proof: anyone who can write to the
 * data folder can edit it (and the Bridge's other files). The service fails closed on what it can check (an enabled opt-in
 * source with no matching acknowledgement is treated as off and logged at start), but it cannot tell an edit from a click.
 *
 * Holds choices, never secrets: an API key lives in the secrets store under `source:<id>`. Written atomically (temp
 * file, fsync, rename) with mode 0600 like the other stores. A file that cannot be read is moved aside as
 * `state.json.corrupt-<stamp>`, logged, and the Bridge starts clean; it never stops the start.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { quarantine, writeFileAtomic } from "../../lib/jsonl.mjs";

export const STATE_VERSION = 1;
const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

/** @typedef {{ acceptedAt: string, noticeVersion: string }} Consent */
/** @typedef {{ enabled: boolean, configured: boolean, consent: Consent | null, disabledAt: string | null }} SourceState */

const cleanTime = (t) => (typeof t === "string" && Number.isFinite(Date.parse(t)) ? t.slice(0, 40) : null);

const cleanConsent = (c) =>
  c && typeof c === "object" && typeof c.acceptedAt === "string" && typeof c.noticeVersion === "string" && c.noticeVersion
    ? { acceptedAt: c.acceptedAt.slice(0, 40), noticeVersion: c.noticeVersion.slice(0, 64) }
    : null;

/** Keep only what the format allows, so a hand-edited or damaged file cannot smuggle odd values in. */
function sanitise(raw) {
  const out = {};
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  for (const [id, s] of Object.entries(src)) {
    if (!ID_RE.test(id) || !s || typeof s !== "object") continue;
    out[id] = { enabled: s.enabled === true, configured: s.configured === true, consent: cleanConsent(s.consent), disabledAt: cleanTime(s.disabledAt) };
  }
  return out;
}

/**
 * @param {{ dataDir: string, logger?: object, clock?: { now(): number } }} opts
 */
export function createSourceState({ dataDir, logger, clock }) {
  const file = join(dataDir, "sources", "state.json");
  /** @type {Record<string, SourceState>} */
  let sources = {};
  let loadedFrom = "new";

  function load() {
    if (!existsSync(file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || parsed.version !== STATE_VERSION || !parsed.sources || typeof parsed.sources !== "object") throw new Error("unknown format");
      loadedFrom = "file";
      return sanitise(parsed.sources);
    } catch (err) {
      loadedFrom = "corrupt";
      try {
        const movedTo = quarantine(file, { now: clock?.now() ?? Date.now() });
        logger?.warn?.("sources state could not be read; starting clean", { movedTo, err: err?.message });
      } catch (qErr) {
        logger?.warn?.("sources state could not be read or moved aside; starting clean", { err: qErr?.message });
      }
      return {};
    }
  }
  sources = load();

  function save() {
    try {
      writeFileAtomic(file, `${JSON.stringify({ version: STATE_VERSION, sources }, null, 1)}\n`);
      return true;
    } catch (err) {
      logger?.warn?.("sources state could not be saved", { err: err?.message });
      return false;
    }
  }

  const copy = (s) => (s ? { ...s, consent: s.consent ? { ...s.consent } : null } : null);

  return {
    /** "new" (no file), "file" or "corrupt" (moved aside, started clean). */
    get loadedFrom() {
      return loadedFrom;
    },
    file,
    /** The saved state of a source, or null when nothing was saved. @param {string} id @returns {SourceState | null} */
    get(id) {
      return copy(sources[id]);
    },
    /**
     * Merge a change into a source's state and save. Returns the new state; a failed save is logged and the change
     * stays in memory for this run.
     * @param {string} id @param {Partial<SourceState>} patch @returns {SourceState}
     */
    update(id, patch) {
      if (!ID_RE.test(id)) throw new Error("bad source id");
      const cur = sources[id] ?? { enabled: false, configured: false, consent: null, disabledAt: null };
      const next = { ...cur, ...patch };
      sources[id] = { enabled: next.enabled === true, configured: next.configured === true, consent: cleanConsent(next.consent), disabledAt: cleanTime(next.disabledAt) };
      save();
      return copy(sources[id]);
    },
    /** @returns {Record<string, SourceState>} a copy of everything saved */
    all() {
      return structuredClone(sources);
    },
  };
}
