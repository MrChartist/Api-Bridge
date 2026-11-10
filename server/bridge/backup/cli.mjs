/**
 * `mc-bridge backup` and `mc-bridge restore`. The command line in core/cli.mjs delegates here with a small context
 * (the loaded config, the Bridge probe it already uses to detect a running Bridge) so this file has no import cycle.
 *
 *   mc-bridge backup [--out FILE] [--include-secrets] [--include-data]   write one archive; never overwrites; never holds the master key;
 *                                                        downloads and recordings only with --include-data
 *   mc-bridge backup list                                the copies in <data>/backups and the last backup
 *   mc-bridge backup verify FILE                         check an archive without restoring it
 *   mc-bridge restore FILE [--dry-run] [--yes] [--skip-config]
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { BridgeError } from "../core/errors.mjs";
import { checkCompatibility, inspectArchive, backupFileName } from "./archive.mjs";
import { createBackupManager, masterKeyPath, readBackupStatus } from "./manager.mjs";
import { describeBulk, measureBulk } from "./paths.mjs";
import { restoreBackup } from "./restore.mjs";

const mb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const WHAT = "settings, API keys, accounts, safety and quota state, source settings, pooling consent, paper books, order records and the audit log";

/**
 * @param {string[]} args  words after "backup" ("list", "verify", FILE ...)
 * @param {Record<string, any>} flags
 * @param {{ out(s: string): void, err(s: string): void, env: NodeJS.ProcessEnv, cwd: string }} io
 * @param {{ config: any, configFile: string | null, bridgeVersion: string, cli: string }} ctx
 */
export async function backupCommand(args, flags, io, ctx) {
  const [sub, arg] = args;
  const { config, configFile, bridgeVersion } = ctx;
  const dataDir = config.dataDir;
  const mgr = createBackupManager({ dataDir, configFile, config, bridgeVersion, env: io.env });
  if (sub === "list") {
    const rows = mgr.list();
    const st = readBackupStatus(dataDir);
    if (flags.json) {
      io.out(JSON.stringify({ folder: mgr.folder, items: rows, lastOk: st.lastOk, lastFailure: st.lastFailure }, null, 2));
      return 0;
    }
    io.out(`Backups in ${mgr.folder}`);
    if (!rows.length) io.out(`  none yet. Make one with: ${ctx.cli} backup`);
    for (const r of rows) io.out(`  ${r.at.slice(0, 19).replace("T", " ")}  ${r.kind.padEnd(10)} ${mb(r.bytes).padStart(9)}  ${r.name}`);
    if (st.lastFailure) io.out(`Last failed backup: ${st.lastFailure.at} (${st.lastFailure.kind}): ${st.lastFailure.message}`);
    return 0;
  }
  if (sub === "verify") {
    if (!arg) throw new BridgeError("VALIDATION_FAILED", `backup verify needs a file: ${ctx.cli} backup verify <file>`);
    const file = isAbsolute(arg) ? arg : resolve(io.cwd, arg);
    if (!existsSync(file)) throw new BridgeError("VALIDATION_FAILED", `There is no backup file at ${file}.`);
    const { manifest, entries } = await inspectArchive(file);
    const compat = checkCompatibility(manifest, { bridgeVersion });
    io.out(`OK: ${file}`);
    io.out(`Made by Bridge ${manifest.bridgeVersion} at ${manifest.createdAt}: ${entries.length} files, every checksum matches.`);
    io.out(manifest.includesData ? "Includes the downloads and recordings folders." : "Does not include downloads and recordings (saved data; download or record it again, or copy those folders yourself).");
    io.out(manifest.includesSecrets ? "Includes secrets.enc (needs the original master key to be of any use)." : "Does not include secrets.enc.");
    if (!compat.ok) io.out(`Cannot be restored by this Bridge: ${compat.message}`);
    return compat.ok ? 0 : 1;
  }
  if (sub !== undefined) throw new BridgeError("VALIDATION_FAILED", `Unknown backup command "${sub}". Use: backup, backup list, backup verify <file>.`);

  let out;
  if (typeof flags.out === "string" && flags.out) {
    out = isAbsolute(flags.out) ? flags.out : resolve(io.cwd, flags.out);
    if (existsSync(out) && statSync(out).isDirectory()) out = join(out, backupFileName("manual"));
  } else if (flags.out === true) {
    throw new BridgeError("VALIDATION_FAILED", "--out needs a file name, for example: --out my-backup.tar.gz");
  }
  const includeSecrets = flags["include-secrets"] === true;
  // Downloads and recordings are left out unless asked for (--include-data, or backup.includeData in the settings).
  const includeData = flags["include-data"] === true ? true : flags["no-data"] === true ? false : undefined;
  const res = await mgr.run({ kind: "manual", includeSecrets, ...(includeData === undefined ? {} : { includeData }), ...(out ? { out } : {}), quiet: true });
  const leftOut = res.includesData ? [] : measureBulk(dataDir);
  if (flags.json) {
    io.out(JSON.stringify({ path: res.path, bytes: res.bytes, files: res.files, includesSecrets: res.includesSecrets, includesData: res.includesData === true, notIncluded: leftOut, masterKeyIncluded: false }, null, 2));
    return 0;
  }
  io.out(`Backup written: ${res.path}`);
  io.out(`${res.files} files, ${mb(res.bytes)}. Every file was read back and matched its checksum.`);
  io.out(`Included: ${WHAT}${res.includesData ? ", and the downloads and recordings folders" : ""}.`);
  if (!res.includesData) {
    if (leftOut.length) io.out(`NOT included: ${describeBulk(leftOut)}. They can be downloaded or recorded again, or copy those folders yourself. Add --include-data to put them in the backup (large; may take a while).`);
    else io.out("NOT included: downloads and recordings (none yet). They can be downloaded or recorded again; --include-data would add them.");
  }
  io.out(`NOT included: the master key (${masterKeyPath({ config, dataDir, env: io.env })}). It is never copied into a backup, so the archive alone cannot unlock anything.`);
  if (res.includesSecrets) io.out("secrets.enc IS included (saved broker logins). Restoring them needs your ORIGINAL master key; keep a copy of that key somewhere safe, separate from this file.");
  else io.out(`secrets.enc (saved broker logins) is not included. Without it you log in to your brokers again after a restore. Add --include-secrets to include it (it is of use only together with your master key).`);
  io.out("The file is private to your user (mode 600) and holds your API key records and audit log: copy it to another disk or computer, not to a shared or public place.");
  io.out(`Restore it with the Bridge stopped:  ${ctx.cli} restore "${res.path}"`);
  return 0;
}

/**
 * @param {string[]} args  [FILE]
 * @param {Record<string, any>} flags
 * @param {{ out(s: string): void, err(s: string): void, env: NodeJS.ProcessEnv, cwd: string, prompt?: Function }} io
 * @param {{ config: any, configFile: string | null, bridgeVersion: string, cli: string, probeBridge: Function, localBaseUrl: Function, usesDataDir: (dir: string) => boolean }} ctx
 */
export async function restoreCommand(args, flags, io, ctx) {
  const [arg] = args;
  const { config, configFile, bridgeVersion } = ctx;
  if (!arg) throw new BridgeError("VALIDATION_FAILED", `restore needs the backup file: ${ctx.cli} restore <file> [--dry-run]`);
  const file = isAbsolute(arg) ? arg : resolve(io.cwd, arg);
  const dryRun = flags["dry-run"] === true;
  const dataDir = config.dataDir;

  // A running Bridge keeps its stores in memory and would write them back over the restored files.
  if (config.server.port !== 0) {
    const url = ctx.localBaseUrl(config.server.host, config.server.port);
    if (await ctx.probeBridge(url)) {
      if (!dryRun) throw new BridgeError("VALIDATION_FAILED", `A Bridge is running at ${url}. Stop it first (press Ctrl+C in its window), then run restore again. Nothing was changed.`);
      io.err(`Note: a Bridge is running at ${url}. A real restore needs it stopped; this dry run only reads.`);
    } else if (ctx.usesDataDir(dataDir)) {
      io.err("Note: a leftover control.token is in the data folder. If a Bridge is still running on another port, stop it before restoring.");
    }
  }

  const masterKeyFile = masterKeyPath({ config, dataDir, env: io.env });
  const base = { archive: file, dataDir, configFile, bridgeVersion, masterKeyFile, config, env: io.env, applyConfig: flags["skip-config"] !== true };
  const preview = await restoreBackup({ ...base, dryRun: true });
  const { manifest, plan } = preview;
  const hasData = manifest.includesData === true || manifest.files.some((f) => /^data\/(downloads|recordings)\//.test(f.path));
  io.out(`Backup: ${file}`);
  io.out(`Made by Bridge ${manifest.bridgeVersion} at ${manifest.createdAt} (${manifest.files.length} files, all checksums match).`);
  for (const w of preview.warnings) io.out(`Note: ${w}`);
  io.out(`Into: ${dataDir}${configFile && plan.config !== "none" ? ` and ${configFile}` : ""}`);
  const show = (label, list) => {
    if (!list.length) return;
    io.out(`  ${label} (${list.length}): ${list.slice(0, 8).join(", ")}${list.length > 8 ? `, and ${list.length - 8} more` : ""}`);
  };
  show("new files", plan.add);
  show("replaced with the backup's version", plan.replace);
  show("already the same", plan.same);
  show("removed (made after this backup)", plan.remove);
  if (plan.config !== "none") io.out(`  settings file: ${plan.config === "same" ? "already the same" : plan.config === "add" ? "will be created" : "replaced with the backup's version"}`);
  io.out(
    plan.secrets === "restored"
      ? "  secrets.enc: restored from the backup. It opens only with the master key it was made with."
      : plan.secrets === "kept"
        ? "  secrets.enc: this backup has none; the one on this computer is left as it is."
        : "  secrets.enc: none in the backup and none here; you will log in to your brokers again.",
  );
  io.out("  The master key is not touched.");
  if (hasData) io.out("  downloads and recordings: restored from the backup. The ones here now are kept next to them as downloads.before-restore-... and recordings.before-restore-...; delete them when you have checked.");
  else {
    const here = measureBulk(dataDir);
    io.out(`  downloads and recordings: not part of this backup, so the ones on this computer are left as they are${here.length ? ` (${describeBulk(here)})` : ""}.`);
  }
  if (dryRun) {
    io.out("Dry run only: nothing was changed.");
    return 0;
  }
  if (flags.yes !== true) {
    const ask = typeof io.prompt === "function" ? io.prompt : process.stdin.isTTY ? (await import("../core/cli.mjs")).terminalPrompt : null;
    if (!ask) throw new BridgeError("VALIDATION_FAILED", "Nothing was changed: there is no keyboard to confirm with. Add --yes to restore without asking.");
    const answer = await ask("Type RESTORE to continue, or press Enter to cancel", { hidden: false });
    if (String(answer).trim() !== "RESTORE") {
      io.out("Cancelled. Nothing was changed.");
      return 1;
    }
  }
  const res = await restoreBackup({ ...base, dryRun: false });
  io.out("");
  io.out("Restored.");
  if (res.safetyBackup) io.out(`A copy of what was here before is saved in: ${res.safetyBackup}`);
  if (res.keptBulk?.length) io.out(`The downloads and recordings that were here before were kept: ${res.keptBulk.join(", ")} (inside ${dataDir}). Delete them when you have checked the restored ones.`);
  io.out("Next steps:");
  io.out(`  1. Start the Bridge:  ${ctx.cli} start --open`);
  io.out(`  2. Check it:  ${ctx.cli} doctor`);
  if (plan.secrets === "restored") io.out(`  3. If saved broker logins do not open, the master key is not the one that locked them. Put the original key at ${masterKeyFile} (or set MCB_MASTER_KEY), or log in to each broker again.`);
  else io.out("  3. Log in to each broker again from the dashboard (saved logins are not part of this backup).");
  io.out("  4. Check Safety: orders stay in paper unless you switched live trading on in your settings.");
  try {
    const { webhookSecretsNeeded } = await import("../events/restoreNote.mjs");
    const n = webhookSecretsNeeded(dataDir);
    if (n > 0) io.out(`  5. ${n} webhook subscription${n === 1 ? " needs" : "s need"} its signing secret again (secrets are not in a backup unless --include-secrets and the same master key): ${ctx.cli} subscriptions rotate-secret <id>. Deliveries wait until you do.`);
  } catch {
    /* the note is a courtesy */
  }
  return 0;
}
