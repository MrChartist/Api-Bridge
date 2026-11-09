/**
 * Restore a backup into the data folder.
 *
 * Order, and why:
 *   1. inspectArchive: read the whole archive without writing anything; every name, size and checksum must match its
 *      manifest, and the Bridge version and format must be compatible. A damaged or doctored archive stops here.
 *   2. plan: compare with what is on disk now (new, replaced, same, removed).
 *   3. (dry run stops here.)
 *   4. safety backup of the current data (backups/, kind "safety"), so a wrong restore can be undone.
 *   5. unpack into a staging folder inside the data folder (same disk), checking the checksums again.
 *   6. swap: each top-level item is moved to a holding folder and its restored version moved in; any failure moves
 *      everything back. Files a backup never holds (the master key, backups/, instruments/, secrets.enc when the
 *      archive has none) are not touched.
 *
 * The caller checks that no Bridge is running before calling this.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { BridgeError } from "../core/errors.mjs";
import { checkCompatibility, extractArchive, freeBytes, inspectArchive } from "./archive.mjs";
import { CONFIG_ENTRY, DATA_PREFIX, SECRETS_FILE_NAME, collectDataFiles } from "./paths.mjs";
import { createBackupManager } from "./manager.mjs";

const sha256File = (p) => {
  try {
    return createHash("sha256").update(readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
};

/**
 * What a restore would do, from the manifest and the current folder. Pure apart from reading files.
 * @returns {{ add: string[], replace: string[], same: string[], remove: string[], config: "add" | "replace" | "same" | "none", secrets: "restored" | "kept" | "none", bytes: number }}
 */
export function planRestore({ manifest, dataDir, configFile, masterKeyFile, applyConfig = true }) {
  const plan = { add: [], replace: [], same: [], remove: [], config: "none", secrets: "none", bytes: 0 };
  const incoming = new Set();
  for (const f of manifest.files) {
    plan.bytes += f.size;
    if (f.path === CONFIG_ENTRY) {
      if (!applyConfig || !configFile) continue;
      const cur = sha256File(configFile);
      plan.config = cur === null ? "add" : cur === f.sha256 ? "same" : "replace";
      continue;
    }
    const rel = f.path.slice(DATA_PREFIX.length);
    incoming.add(rel);
    const cur = sha256File(join(dataDir, rel));
    (cur === null ? plan.add : cur === f.sha256 ? plan.same : plan.replace).push(rel);
  }
  const hasSecrets = incoming.has(SECRETS_FILE_NAME);
  plan.secrets = hasSecrets ? "restored" : existsSync(join(dataDir, SECRETS_FILE_NAME)) ? "kept" : "none";
  if (existsSync(dataDir)) {
    const { files } = collectDataFiles(dataDir, { includeSecrets: hasSecrets, masterKeyFile });
    for (const f of files) if (!incoming.has(f.rel)) plan.remove.push(f.rel);
  }
  return plan;
}

/** First path segment. */
const top = (rel) => rel.split("/")[0];

/**
 * @param {{ archive: string, dataDir: string, configFile?: string | null, bridgeVersion: string, dryRun?: boolean, applyConfig?: boolean,
 *   masterKeyFile?: string | null, config?: any, env?: NodeJS.ProcessEnv, logger?: any, freeBytesFn?: (dir: string) => number | null, now?: () => number }} o
 */
export async function restoreBackup(o) {
  const { archive, dataDir, configFile = null, bridgeVersion, dryRun = false, applyConfig = true, masterKeyFile = null, logger } = o;
  if (!existsSync(archive) || !statSync(archive).isFile()) throw new BridgeError("VALIDATION_FAILED", `There is no backup file at ${archive}.`);
  const { manifest } = await inspectArchive(archive);
  const compat = checkCompatibility(manifest, { bridgeVersion });
  if (!compat.ok) throw new BridgeError("VALIDATION_FAILED", compat.message);
  const plan = planRestore({ manifest, dataDir, configFile, masterKeyFile, applyConfig });
  const summary = { manifest, plan, warnings: compat.warnings, dryRun, safetyBackup: null, restored: false };
  if (dryRun) return summary;

  // Room for the unpacked copy plus the safety backup, with the same margin the automatic snapshots keep.
  const free = (o.freeBytesFn ?? freeBytes)(dataDir);
  const need = plan.bytes * 2 + 50 * 1024 * 1024;
  if (free !== null && free < need) {
    throw new BridgeError("VALIDATION_FAILED", `Not enough free disk space to restore: about ${(need / 1048576).toFixed(0)} MB needed, ${(free / 1048576).toFixed(0)} MB free. Nothing was changed.`);
  }

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

  // 4. Safety backup of what is there now (skipped when there is nothing to lose).
  const current = existsSync(dataDir) ? collectDataFiles(dataDir, { includeSecrets: true, masterKeyFile }).files : [];
  const mgr = createBackupManager({ dataDir, configFile, config: o.config, bridgeVersion, logger, env: o.env ?? process.env, freeBytesFn: o.freeBytesFn });
  if (current.length || (configFile && existsSync(configFile))) {
    const res = await mgr.run({ kind: "safety", includeSecrets: true, quiet: true }).catch((err) => {
      throw new BridgeError("VALIDATION_FAILED", `Could not make the safety backup of your current data, so nothing was restored: ${String(err?.detail ?? err?.message ?? err)}`);
    });
    summary.safetyBackup = res.path;
  }

  // 5. Unpack beside the data (same disk), checking every checksum again.
  const staging = join(dataDir, `.restore-staging-${id}`);
  const holding = join(dataDir, `.pre-restore-${id}`);
  try {
    await extractArchive(archive, staging);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }

  // 6. Swap, with a way back.
  const moves = [];
  const move = (from, to) => {
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    renameSync(from, to);
    moves.push([from, to]);
  };
  try {
    mkdirSync(holding, { recursive: true, mode: 0o700 });
    const incomingTop = new Set(manifest.files.filter((f) => f.path.startsWith(DATA_PREFIX)).map((f) => top(f.path.slice(DATA_PREFIX.length))));
    const hasSecrets = manifest.files.some((f) => f.path === DATA_PREFIX + SECRETS_FILE_NAME);
    const currentTop = new Set(collectDataFiles(dataDir, { includeSecrets: hasSecrets, masterKeyFile }).files.map((f) => top(f.rel)));
    for (const name of new Set([...incomingTop, ...currentTop])) {
      const live = join(dataDir, name);
      if (existsSync(live)) move(live, join(holding, name));
      const staged = join(staging, "data", name);
      if (existsSync(staged)) move(staged, live);
    }
    // The config file last: if it fails, the data moves above are undone too.
    if (applyConfig && configFile && manifest.files.some((f) => f.path === CONFIG_ENTRY)) {
      if (existsSync(configFile)) {
        copyFileSync(configFile, join(holding, "bridge.config.json"));
      }
      mkdirSync(dirname(configFile), { recursive: true });
      const tmp = `${configFile}.restore-${id}.tmp`;
      copyFileSync(join(staging, CONFIG_ENTRY), tmp);
      renameSync(tmp, configFile);
    }
  } catch (err) {
    let undone = true;
    for (const [from, to] of moves.reverse()) {
      try {
        renameSync(to, from);
      } catch (undoErr) {
        undone = false;
        logger?.error?.("could not undo part of a failed restore", { from, to, err: String(undoErr?.message ?? undoErr) });
      }
    }
    rmSync(staging, { recursive: true, force: true });
    // Only when everything is back where it was is the holding folder (now empty) removed; otherwise it keeps what could not be moved.
    if (undone) rmSync(holding, { recursive: true, force: true });
    throw new BridgeError("VALIDATION_FAILED", `The restore failed part way and was undone; your data is as it was. (${String(err?.message ?? err)})`);
  }
  rmSync(staging, { recursive: true, force: true });
  rmSync(holding, { recursive: true, force: true });
  summary.restored = true;
  return summary;
}
