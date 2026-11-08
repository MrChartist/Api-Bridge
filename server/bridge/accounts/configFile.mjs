/**
 * Saving account changes made from the dashboard (POST /v1/accounts, DELETE /v1/accounts/{id}) to bridge.config.json.
 *
 * The file is read fresh on every change, so edits made by hand while the Bridge runs are kept; only the `accounts`
 * array is touched and every other section stays as it was. The result is checked against the same schema the Bridge
 * loads with, then written atomically (temp file + rename, mode 0600), so a crash never leaves half a file and the
 * Bridge never writes a file it could not start from. Writes are serialised within this process.
 *
 * When the Bridge started without a config file, the first account creates one at the per-user location loadConfig
 * searches (config.mjs configFileForWrites) holding just the accounts: everything else keeps its safe default.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../auth/fsUtil.mjs";
import { coreSchema } from "../core/config.mjs";
import { BridgeError } from "../core/errors.mjs";

let queue = Promise.resolve();
/** Run `fn` after every earlier config write in this process has finished. */
function serialised(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/** The file as an object ({} when it does not exist yet). A file the Bridge cannot read is never overwritten. */
function readForEdit(path) {
  if (!existsSync(path)) return {};
  let obj;
  try {
    obj = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new BridgeError("VALIDATION_FAILED", `Your config file ${path} could not be read (it may have a typing mistake). Nothing was changed; fix the file or restore a backup, then try again.`);
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new BridgeError("VALIDATION_FAILED", `Your config file ${path} is not a JSON object. Nothing was changed.`);
  if (obj.accounts !== undefined && !Array.isArray(obj.accounts)) throw new BridgeError("VALIDATION_FAILED", `"accounts" in ${path} is not a list. Nothing was changed.`);
  return obj;
}

function writeChecked(path, obj) {
  const parsed = coreSchema.safeParse(obj);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new BridgeError("VALIDATION_FAILED", `The config file would not be valid after this change (${first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "unknown problem"}). Nothing was changed.`);
  }
  writeFileAtomic(path, `${JSON.stringify(obj, null, 2)}\n`);
}

/** Account ids in the file now (none when it is missing or unreadable): new ids avoid them too. */
export function configFileAccountIds(path) {
  try {
    const obj = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(obj?.accounts) ? obj.accounts.map((a) => a?.id).filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Append one account entry to the file's `accounts`. Refuses an id the file already uses (also one added by hand
 * since the Bridge started).
 * @param {string} path
 * @param {Record<string, unknown>} entry  as it should appear in the file
 * @param {{ leaveDemo?: boolean }} [opts]  leaveDemo: also delete a top-level "demo": true (demo-mode save, opt-in)
 * @returns {Promise<{ created: boolean, demoWasInFile: boolean, demoTurnedOff: boolean }>}  created: the file did not exist before
 */
export function addAccountToConfigFile(path, entry, { leaveDemo = false } = {}) {
  return serialised(() => {
    const created = !existsSync(path);
    const obj = readForEdit(path);
    const accounts = Array.isArray(obj.accounts) ? obj.accounts : [];
    if (accounts.some((a) => a && a.id === entry.id)) {
      throw new BridgeError("VALIDATION_FAILED", `The account id "${entry.id}" is already in your config file. Choose another id, or restart the Bridge to load it.`);
    }
    obj.accounts = [...accounts, entry];
    // Saved from demo mode: turn demo off in the file too, so the next start loads the account (opt-in, see routes).
    const demoWasInFile = obj.demo === true;
    if (leaveDemo && demoWasInFile) delete obj.demo;
    writeChecked(path, obj);
    return { created, demoWasInFile, demoTurnedOff: leaveDemo && demoWasInFile };
  });
}

/**
 * Remove an account entry from the file. A file without that id (or no file at all) is left unchanged.
 * @param {string} path
 * @param {string} accountId
 * @returns {Promise<{ removed: boolean }>}
 */
export function removeAccountFromConfigFile(path, accountId) {
  return serialised(() => {
    if (!existsSync(path)) return { removed: false };
    const obj = readForEdit(path);
    const accounts = Array.isArray(obj.accounts) ? obj.accounts : [];
    const kept = accounts.filter((a) => !(a && a.id === accountId));
    if (kept.length === accounts.length) return { removed: false };
    obj.accounts = kept;
    writeChecked(path, obj);
    return { removed: true };
  });
}

/**
 * Replace one module-owned section of the file (for example `readiness`). The
 * section is checked with the module's own schema and the whole file with the core schema before an atomic write;
 * every other section stays as it was. Serialised with the account writes.
 * @param {string} path
 * @param {string} key   section name
 * @param {Record<string, unknown>} value  the section as it should appear in the file
 * @param {{ schema?: { safeParse(v: unknown): { success: boolean, error?: any } } }} [opts]
 * @returns {Promise<{ created: boolean }>}
 */
export function setConfigSection(path, key, value, { schema } = {}) {
  if (typeof key !== "string" || !/^[a-z][A-Za-z0-9]{1,40}$/.test(key) || key === "accounts") throw new TypeError("setConfigSection needs a module section name");
  return serialised(() => {
    const created = !existsSync(path);
    const obj = readForEdit(path);
    if (schema) {
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        const first = parsed.error?.issues?.[0];
        throw new BridgeError("VALIDATION_FAILED", `The ${key} settings are not valid (${first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "unknown problem"}). Nothing was changed.`);
      }
    }
    obj[key] = value;
    writeChecked(path, obj);
    return { created };
  });
}
