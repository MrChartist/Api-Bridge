/**
 * Persisted kill-switch state for stream S9 (<dataDir>/safety/kill-switch.json).
 *
 * Fail-safe rules:
 *  - a missing file means "not engaged" (first run);
 *  - an unreadable or malformed file means "engaged", with a reason that says why, so a damaged disk can never
 *    silently switch the kill switch off;
 *  - engage() keeps the switch on in memory even if the file cannot be written (and reports persisted: false);
 *  - release() writes the file first and only then switches off in memory, so a failed write leaves it on.
 *
 * Policy (who may engage or release, auditing, events) lives in safetyGuard.mjs; this file only stores state.
 */
import { join } from "node:path";
import { readJsonState, writeJsonState } from "./stateFile.mjs";

export const KILL_SWITCH_FILE = "kill-switch.json";

/**
 * @typedef {import("../core/contracts.mjs").KillSwitchState} KillSwitchState
 */

/**
 * @param {{ dir: string, logger?: any }} opts
 * @returns {{ state(): KillSwitchState, loadedFrom: "missing"|"ok"|"corrupt", path: string,
 *   engage(s: { reason: string, by: string, at: string }): { state: KillSwitchState, persisted: boolean, changed: boolean },
 *   release(): KillSwitchState }}
 */
export function createKillSwitchStore({ dir, logger }) {
  const path = join(dir, KILL_SWITCH_FILE);
  /** @type {KillSwitchState} */
  let state = { engaged: false, reason: null, by: null, at: null };
  const loaded = readJsonState(path);
  if (loaded.status === "ok") {
    const v = loaded.value;
    if (typeof v.engaged === "boolean") {
      state = {
        engaged: v.engaged,
        reason: typeof v.reason === "string" ? v.reason : null,
        by: typeof v.by === "string" ? v.by : null,
        at: typeof v.at === "string" ? v.at : null,
      };
    } else {
      state = { engaged: true, reason: "The kill switch file was not in the expected format, so the kill switch was engaged to be safe.", by: "system:startup", at: null };
      logger?.error("kill switch file malformed; engaged", { path });
    }
  } else if (loaded.status === "corrupt") {
    state = { engaged: true, reason: "The kill switch file could not be read, so the kill switch was engaged to be safe.", by: "system:startup", at: null };
    logger?.error("kill switch file unreadable; engaged", { path });
  }

  const snapshot = () => ({ ...state });

  return {
    path,
    loadedFrom: loaded.status === "ok" && typeof loaded.value.engaged === "boolean" ? "ok" : loaded.status === "missing" ? "missing" : "corrupt",
    state: snapshot,
    engage({ reason, by, at }) {
      const changed = !state.engaged;
      if (changed) state = { engaged: true, reason, by, at };
      let persisted = true;
      try {
        writeJsonState(path, { ...state, version: 1 });
      } catch (err) {
        persisted = false;
        logger?.error("kill switch state could not be saved; it stays engaged in memory", { code: err?.code });
      }
      return { state: snapshot(), persisted, changed };
    },
    release() {
      const next = { engaged: false, reason: null, by: null, at: null };
      writeJsonState(path, { ...next, version: 1 }); // throws: the switch stays engaged
      state = next;
      return snapshot();
    },
  };
}
