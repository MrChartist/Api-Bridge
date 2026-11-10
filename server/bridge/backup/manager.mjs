/**
 * Backups in <dataDir>/backups: making them (by hand, before an upgrade, on a schedule), keeping the newest few,
 * and the small status file the dashboard, /v1/health and doctor read.
 *
 * Nothing here may stop the Bridge: every automatic path catches its own errors, logs a plain warning and carries on.
 *
 *   backups/mc-bridge-backup-<date>-<time>-<kind>.tar.gz     kind: manual | upgrade | scheduled | safety
 *   backups/status.json                                       last success, last failure, last scheduled day
 *   last-version.json                                         the Bridge version that last ran on this data folder
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../../lib/jsonl.mjs";
import { backupSettings } from "./config.mjs";
import { backupFileName, parseBackupName, writeBackup } from "./archive.mjs";
import { BACKUPS_DIR, collectDataFiles } from "./paths.mjs";

export const STATUS_FILE = "status.json";
export const LAST_VERSION_FILE = "last-version.json";
/** Always leave this much free after the copy, so a snapshot never takes the last space on the disk. */
export const FREE_MARGIN_BYTES = 50 * 1024 * 1024;
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

/** The master key file this setup uses (never included in a backup), for excluding it by name or path. */
export function masterKeyPath({ config, dataDir, env = process.env }) {
  return resolve(env.MCB_MASTER_KEY_FILE || config?.masterKeyFile || join(dataDir, "master.key"));
}

function writeJsonAtomic(file, obj) {
  writeFileAtomic(file, `${JSON.stringify(obj, null, 2)}\n`);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export const readLastVersion = (dataDir) => {
  const v = readJson(join(dataDir, LAST_VERSION_FILE))?.version;
  return typeof v === "string" ? v : null;
};

export function writeLastVersion(dataDir, version, now = new Date()) {
  try {
    writeJsonAtomic(join(dataDir, LAST_VERSION_FILE), { version, at: now.toISOString() });
  } catch {
    /* the marker is bookkeeping: a failure must never stop the Bridge */
  }
}

/** What /v1/health and doctor show; reads one small file. @returns {object} */
export function readBackupStatus(dataDir) {
  const s = readJson(join(dataDir, BACKUPS_DIR, STATUS_FILE)) ?? {};
  return { lastOk: s.lastOk ?? null, lastFailure: s.lastFailure ?? null, lastSkipped: s.lastSkipped ?? null, lastScheduledDay: s.lastScheduledDay ?? null, lastScheduledAttemptAt: s.lastScheduledAttemptAt ?? null };
}

const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * @param {{ dataDir: string, configFile?: string | null, config?: any, bridgeVersion: string, logger?: any, bus?: any,
 *   clock?: { now(): number }, env?: NodeJS.ProcessEnv, freeBytesFn?: (dir: string) => number | null }} o
 */
export function createBackupManager(o) {
  const { dataDir, configFile = null, config, bridgeVersion, logger, bus, clock = { now: () => Date.now() }, env = process.env, freeBytesFn } = o;
  const settings = () => backupSettings(config);
  const folder = join(dataDir, BACKUPS_DIR);
  const statusFile = join(folder, STATUS_FILE);
  const masterKeyFile = masterKeyPath({ config, dataDir, env });
  let chain = Promise.resolve();
  let timer = null;
  let first = null;

  const status = () => readBackupStatus(dataDir);
  const saveStatus = (patch) => {
    try {
      writeJsonAtomic(statusFile, { ...status(), ...patch });
    } catch (err) {
      logger?.warn?.("could not save the backup status", { err: String(err?.message ?? err) });
    }
  };

  /** Delete the oldest files of `kind` beyond `keep`. Only files with the Bridge's own backup name are touched. */
  function prune(kind, keep) {
    try {
      const mine = list().filter((f) => f.kind === kind);
      for (const f of mine.slice(keep)) unlinkSync(f.path);
    } catch (err) {
      logger?.warn?.("could not remove old backups", { err: String(err?.message ?? err) });
    }
  }

  /** @returns {Array<{ name: string, path: string, bytes: number, at: string, kind: string }>} newest first */
  function list() {
    let names;
    try {
      names = readdirSync(folder);
    } catch {
      return [];
    }
    const rows = [];
    for (const name of names) {
      const p = parseBackupName(name);
      if (!p) continue;
      try {
        const st = statSync(join(folder, name));
        if (st.isFile()) rows.push({ name, path: join(folder, name), bytes: st.size, at: new Date(st.mtimeMs).toISOString(), kind: p.kind, stamp: p.stamp });
      } catch {
        /* removed while listing */
      }
    }
    rows.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : a.name < b.name ? 1 : -1));
    return rows.map(({ stamp: _s, ...r }) => r);
  }

  const keepFor = (kind) => (kind === "scheduled" ? settings().schedule.keep : kind === "manual" ? settings().manualKeep : settings().keep);

  /**
   * Make a backup now. Serialised: two at once wait for each other.
   * `includeData`: also downloads/ and recordings/ (default: the backup.includeData setting for manual and daily backups;
   * never for the copy before an upgrade or a restore, which must stay small and fast).
   * @param {{ kind?: string, includeSecrets?: boolean, includeData?: boolean, out?: string, quiet?: boolean }} [opts]
   */
  function run({ kind = "manual", includeSecrets = false, includeData, out, quiet = false } = {}) {
    const withData = kind === "manual" || kind === "scheduled" ? (includeData ?? settings().includeData) : false;
    const job = chain.then(async () => {
      let now = new Date(clock.now());
      let target = out ?? join(folder, backupFileName(kind, now));
      // Two backups in the same second get different names (the later one is named one second on).
      for (let i = 0; !out && existsSync(target) && i < 120; i++) {
        now = new Date(now.getTime() + 1000);
        target = join(folder, backupFileName(kind, now));
      }
      try {
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        const res = await writeBackup({
          dataDir,
          configFile,
          out: target,
          kind,
          includeSecrets,
          includeData: withData,
          maxDataFiles: settings().maxDataFiles,
          masterKeyFile,
          bridgeVersion,
          now,
          maxBytes: kind === "manual" ? undefined : settings().maxSizeMb * 1024 * 1024,
          minFreeBytes: FREE_MARGIN_BYTES,
          freeBytesFn,
        });
        const row = { at: now.toISOString(), name: res.path.split(/[\\/]/).pop(), path: res.path, bytes: res.bytes, files: res.files, kind, includesSecrets: res.includesSecrets, includesData: res.includesData === true };
        // A success clears a failure of the same kind only (a manual backup does not hide a failing schedule).
        const prior = status().lastFailure;
        saveStatus({ lastOk: row, lastFailure: prior && prior.kind !== kind ? prior : null });
        if (!out || resolve(out).startsWith(resolve(folder))) prune(kind, keepFor(kind));
        if (!quiet) bus?.emit?.("backup.completed", { kind, at: row.at, path: row.path, bytes: row.bytes, files: row.files, includesSecrets: row.includesSecrets });
        return { ...res, kind, at: row.at };
      } catch (err) {
        const message = String(err?.detail ?? err?.message ?? err);
        // "Already exists" is the caller's mistake, not a failed backup: it does not count against health.
        if (!/already exists/.test(message)) {
          saveStatus({ lastFailure: { at: now.toISOString(), kind, message } });
          if (!quiet) bus?.emit?.("backup.failed", { kind, at: now.toISOString(), message });
        }
        throw err;
      }
    });
    chain = job.catch(() => {});
    return job;
  }

  /**
   * Before `start` loads anything: when the Bridge version differs from the one that last ran on this folder, copy the
   * data to backups/ first. Never throws; says in one line what happened (or why nothing was copied).
   * @returns {Promise<{ took: boolean, message: string | null, path?: string, from?: string | null }>}
   */
  async function snapshotBeforeStart() {
    try {
      const previous = readLastVersion(dataDir);
      if (previous === bridgeVersion) return { took: false, message: null };
      const hasData = existsSync(dataDir) && collectDataFiles(dataDir, { includeSecrets: true, masterKeyFile }).files.length > 0;
      if (!hasData) {
        writeLastVersion(dataDir, bridgeVersion, new Date(clock.now()));
        return { took: false, message: null };
      }
      let result;
      try {
        // Stays next to the secrets it copies, so it includes them: a rollback should not cost a re-login.
        const res = await run({ kind: "upgrade", includeSecrets: true, quiet: true });
        result = { took: true, path: res.path, from: previous, message: `Saved a copy of your data before this version runs${previous ? ` (${previous} to ${bridgeVersion})` : ""}: ${res.path}. Restore it with: mc-bridge restore "${res.path}"` };
      } catch (err) {
        const why = String(err?.detail ?? err?.message ?? err);
        saveStatus({ lastSkipped: { at: new Date(clock.now()).toISOString(), reason: why } });
        logger?.warn?.("no snapshot before the upgrade", { reason: why });
        result = { took: false, from: previous, message: `Warning: no copy of your data was made before this version runs (${why}) Start continues. Run "mc-bridge backup --out <file>" to make one yourself.` };
      }
      writeLastVersion(dataDir, bridgeVersion, new Date(clock.now()));
      return result;
    } catch (err) {
      logger?.warn?.("the pre-upgrade snapshot check failed", { err: String(err?.message ?? err) });
      return { took: false, message: null };
    }
  }

  /** One check of the schedule; exported through the manager for tests. */
  async function scheduleTick(now = new Date(clock.now())) {
    const sch = settings().schedule;
    if (!sch.enabled) return null;
    const s = status();
    const today = dayOf(now);
    if (s.lastScheduledDay === today) return null;
    const [h, m] = sch.time.split(":").map(Number);
    if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return null;
    if (s.lastFailure?.kind === "scheduled" && s.lastScheduledAttemptAt && now.getTime() - Date.parse(s.lastScheduledAttemptAt) < RETRY_AFTER_FAILURE_MS) return null;
    saveStatus({ lastScheduledAttemptAt: now.toISOString() });
    try {
      const res = await run({ kind: "scheduled", includeSecrets: sch.includeSecrets });
      saveStatus({ lastScheduledDay: today });
      logger?.info?.("scheduled backup written", { path: res.path, bytes: res.bytes });
      return res;
    } catch (err) {
      logger?.warn?.("the scheduled backup failed", { err: String(err?.detail ?? err?.message ?? err) });
      return null;
    }
  }

  function start() {
    if (!settings().schedule.enabled || timer) return;
    // Catch up a run missed while the computer was off, shortly after start (not while the Bridge is still loading).
    first = setTimeout(() => void scheduleTick(), 30_000);
    first.unref?.();
    timer = setInterval(() => void scheduleTick(), 60_000);
    timer.unref?.();
  }
  function stop() {
    if (timer) clearInterval(timer);
    if (first) clearTimeout(first);
    timer = null;
    first = null;
  }

  return {
    folder,
    run,
    list,
    status,
    prune,
    snapshotBeforeStart,
    scheduleTick,
    start,
    stop,
    settings,
    /** For the dashboard and /v1/health: plain facts, no paths outside the data folder. */
    summary() {
      const s = status();
      const sch = settings().schedule;
      const newest = list()[0] ?? null;
      return {
        lastBackupAt: s.lastOk?.at ?? newest?.at ?? null,
        lastBackupBytes: s.lastOk?.bytes ?? newest?.bytes ?? null,
        lastBackupKind: s.lastOk?.kind ?? newest?.kind ?? null,
        lastError: s.lastFailure ? { at: s.lastFailure.at, kind: s.lastFailure.kind, message: s.lastFailure.message } : null,
        schedule: { enabled: sch.enabled, time: sch.time, keep: sch.keep },
        keep: settings().keep,
      };
    },
  };
}
