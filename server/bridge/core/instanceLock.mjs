/**
 * One Bridge per data folder.
 *
 * Two Bridges on the same folder lose each other's changes (the last writer wins on every file), hand out the same
 * paper order ids, count the daily limits twice, and leave `mc-bridge kill` talking to only one of them. So the
 * Bridge takes <dataDir>/bridge.lock when it starts and refuses to start when another live Bridge holds it:
 *
 *   "Another Bridge (process 4312, port 4300, started 2026-11-10 09:12) is using this data folder (...). Stop it, or
 *    start this one with another data folder."
 *
 * The lock is a small JSON file created with the "exclusive" flag (only one creator wins, also on Windows), holding
 * the process id, the port, the start time, a random token and the process's own start time where the system can say
 * it. The holder touches the file every 10 seconds. A lock is STALE, and taken over, when
 *   - its process id no longer exists, or
 *   - the system says that process id now belongs to a process that started at another time (the id was reused), or
 *   - the system cannot say (macOS, Windows), nobody has touched the file for `staleMs` (default 2 minutes) AND it is
 *     still untouched after a further wait (`graceMs`, longer than two heartbeats).
 * A laptop that slept for an hour keeps its lock when it wakes: on Linux the process start time proves it is the same
 * process; where the system cannot say, the old heartbeat only makes the lock "quiet", and the starter looks again after
 * the grace wait. A sleeping Bridge touches the file within seconds of waking (its heartbeat, and at once on
 * system.resumed), so a live holder is never replaced; a process that is alive but frozen for minutes is. A crashed Bridge
 * never blocks the next start. Release removes the file only if it still holds this run's token.
 *
 * Paths use node:path, so Windows folders with drive letters and backslashes work. Everything that touches the
 * system is injectable for tests (pid, liveness, process start time, clock, timers).
 */
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeSync } from "node:fs";
import { join } from "node:path";
import { BridgeError } from "./errors.mjs";

export const LOCK_FILE = "bridge.lock";
export const HEARTBEAT_MS = 10_000;
export const STALE_MS = 120_000;
/** How long a starter watches a quiet lock (live process, old heartbeat, start time unknown) before taking it over: two heartbeats and a margin. */
export const QUIET_GRACE_MS = 2 * HEARTBEAT_MS + 5_000;

/** Block this thread for `ms` (used once, only when a live holder's lock looks quiet). */
function sleepSyncDefault(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin: no Atomics.wait available */
    }
  }
}

/** @param {string} dataDir */
export const lockPath = (dataDir) => join(dataDir, LOCK_FILE);

/** Whether a process with this id exists (signal 0 only checks). EPERM means it exists but is not ours. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * The start time of a process in a unit that is stable for that process (Linux: clock ticks since boot from
 * /proc/<pid>/stat), or null where the system does not say (macOS, Windows). Used only to tell a reused process id
 * from the original process.
 */
export function processStartTime(pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22 is starttime; the command name (field 2) may contain spaces and parentheses, so count from the last ")".
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const v = Number(rest[19]);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** @returns {{ info: any, mtimeMs: number } | { info: null, mtimeMs: number | null, unreadable: boolean } | null} null: no lock file */
function readLock(file) {
  let mtimeMs = null;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  try {
    const info = JSON.parse(readFileSync(file, "utf8"));
    if (info && typeof info === "object" && Number.isInteger(info.pid)) return { info, mtimeMs };
  } catch (err) {
    if (err?.code === "ENOENT") return null;
  }
  return { info: null, mtimeMs, unreadable: true };
}

/**
 * Describe the lock in a data folder without changing it (doctor, health).
 * @param {string} dataDir
 * @param {{ now?: () => number, isAlive?: (pid: number) => boolean, startTimeOf?: (pid: number) => number | null, staleMs?: number }} [opts]
 * @returns {{ held: boolean, stale: boolean, quiet?: boolean, mtimeMs?: number|null, reason?: string, owner?: { pid: number, port: number | null, startedAt: string, host?: string, version?: string }, ageMs?: number, file: string } }
 *   quiet: the process is alive but its heartbeat is old and the system cannot prove it is the same program (held, not stale:
 *   a starter waits and looks again, see acquireInstanceLock)
 */
export function inspectLock(dataDir, { now = () => Date.now(), isAlive = pidAlive, startTimeOf = processStartTime, staleMs = STALE_MS } = {}) {
  const file = lockPath(dataDir);
  const lock = readLock(file);
  if (!lock) return { held: false, stale: false, file };
  const ageMs = lock.mtimeMs === null ? undefined : Math.max(0, now() - lock.mtimeMs);
  if (!lock.info) {
    // Being written right now, or cut off. Only a file nobody has touched for a while is treated as left behind.
    const old = ageMs !== undefined && ageMs > staleMs;
    return { held: !old, stale: old, reason: old ? "the lock file is unreadable and old" : "the lock file is being written", file, ageMs };
  }
  const owner = { pid: lock.info.pid, port: lock.info.port ?? null, startedAt: String(lock.info.startedAt ?? ""), host: lock.info.host, version: lock.info.version };
  if (!isAlive(owner.pid)) return { held: false, stale: true, reason: `process ${owner.pid} is not running`, owner, ageMs, file };
  const recorded = lock.info.procStart;
  const actual = recorded === undefined || recorded === null ? null : startTimeOf(owner.pid);
  if (actual !== null && actual !== recorded) return { held: false, stale: true, reason: `process ${owner.pid} is a different program now (the id was reused)`, owner, ageMs, file };
  // Same process id, and the system cannot tell the program apart: a recent heartbeat is trusted. An old one is only "quiet":
  // the computer may have slept (the clock jumped, the holder has not had its next heartbeat yet). Never stale on this alone.
  if (actual === null && ageMs !== undefined && ageMs > staleMs) return { held: true, stale: false, quiet: true, mtimeMs: lock.mtimeMs, reason: `process ${owner.pid} exists but has not touched the lock for ${Math.round(ageMs / 1000)} s`, owner, ageMs, file };
  return { held: true, stale: false, owner, ageMs, file };
}

/** The refusal, in plain words, for a start that finds a live lock. */
export function lockMessage(dataDir, owner) {
  const since = owner?.startedAt ? `, started ${owner.startedAt.replace("T", " ").slice(0, 16)}` : "";
  const who = owner ? `Another Bridge (process ${owner.pid}${owner.port ? `, port ${owner.port}` : ""}${since})` : "Another Bridge";
  return `${who} is using this data folder (${dataDir}). Two Bridges on one folder lose each other's changes and repeat order numbers. Stop the other one (or run: mc-bridge kill), or start this one with another folder (MCB_HOME). If you are sure no other Bridge is running, delete ${lockPath(dataDir)}.`;
}

/**
 * Take the lock, or throw a BridgeError that names the holder.
 * @param {{ dataDir: string, port?: number | null, version?: string, now?: () => number, pid?: number, isAlive?: (pid: number) => boolean,
 *   startTimeOf?: (pid: number) => number | null, staleMs?: number, heartbeatMs?: number, graceMs?: number, sleep?: (ms: number) => void, setInterval?: typeof setInterval,
 *   clearInterval?: typeof clearInterval, logger?: any, hostname?: string }} opts
 * @returns {{ path: string, token: string, setPort(port: number): void, touch(): void, release(): void }}
 */
export function acquireInstanceLock({ dataDir, port = null, version, now = () => Date.now(), pid = process.pid, isAlive = pidAlive, startTimeOf = processStartTime, staleMs = STALE_MS, heartbeatMs = HEARTBEAT_MS, graceMs = QUIET_GRACE_MS, sleep = sleepSyncDefault, setInterval: setTimer = setInterval, clearInterval: clearTimer = clearInterval, logger, hostname }) {
  const file = lockPath(dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(12).toString("hex");
  const info = { pid, port, startedAt: new Date(now()).toISOString(), token, version, host: hostname, procStart: startTimeOf(pid) };
  const body = () => `${JSON.stringify(info)}\n`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const fd = openSync(file, "wx", 0o600);
      try {
        writeSync(fd, body());
      } finally {
        closeSync(fd);
      }
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      let state = inspectLock(dataDir, { now, isAlive, startTimeOf, staleMs });
      if (state.held && state.quiet) {
        // A live process with an old heartbeat: asleep, or frozen. Give it the grace wait; a holder that is awake touches the file.
        const seen = state.mtimeMs;
        logger?.warn?.(`the data-folder lock is held by a live process that has been quiet for a while (${state.reason}); waiting ${Math.round(graceMs / 1000)} s to see whether it is still alive`, { owner: state.owner });
        sleep(graceMs);
        const again = inspectLock(dataDir, { now, isAlive, startTimeOf, staleMs });
        state = again.quiet && again.mtimeMs === seen ? { ...again, held: false, stale: true, reason: `${again.reason}, and still nothing after ${Math.round(graceMs / 1000)} s` } : again.quiet ? { ...again, quiet: false } : again;
      }
      if (state.held) throw new BridgeError("VALIDATION_FAILED", lockMessage(dataDir, state.owner), { fields: { owner: state.owner ?? null } });
      if (state.stale) {
        logger?.warn?.(`taking over a stale data-folder lock (${state.reason})`, { owner: state.owner });
        try {
          rmSync(file, { force: true });
        } catch {
          /* another starter may have removed it first: try to create again */
        }
      }
      if (attempt === 4) throw new BridgeError("VALIDATION_FAILED", `The data folder lock ${file} could not be taken. Try again, or delete the file if no Bridge is running.`);
    }
  }
  let timer = null;
  let released = false;
  const holdsIt = () => {
    try {
      return JSON.parse(readFileSync(file, "utf8")).token === token;
    } catch {
      return false;
    }
  };
  const handle = {
    path: file,
    token,
    /** The port is known only after the listener is bound. */
    setPort(p) {
      info.port = p;
      try {
        if (holdsIt()) {
          const fd = openSync(file, "w", 0o600);
          try {
            writeSync(fd, body());
          } finally {
            closeSync(fd);
          }
        }
      } catch (err) {
        logger?.warn?.("the data-folder lock could not be updated with the port", { err: String(err?.message ?? err) });
      }
    },
    touch() {
      if (released) return;
      try {
        const t = new Date(now());
        utimesSync(file, t, t);
      } catch (err) {
        if (err?.code === "ENOENT") {
          // Someone removed the lock (a person, or a cleanup): put it back so a second Bridge is still refused.
          try {
            const fd = openSync(file, "wx", 0o600);
            try {
              writeSync(fd, body());
            } finally {
              closeSync(fd);
            }
          } catch {
            /* a new owner took it: nothing to do here */
          }
        }
      }
    },
    release() {
      if (released) return;
      released = true;
      if (timer) clearTimer(timer);
      timer = null;
      if (holdsIt()) rmSync(file, { force: true });
    },
  };
  timer = setTimer(() => handle.touch(), heartbeatMs);
  timer?.unref?.();
  return handle;
}

/** Remove `*.tmp` files left by a write that was cut off, older than `maxAgeMs`. Shallow plus one level; never fails. */
export function sweepStaleTemps(dataDir, { now = Date.now(), maxAgeMs = 3_600_000, depth = 2 } = {}) {
  const removed = [];
  const walk = (dir, level) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (level < depth && ent.name !== "backups" && ent.name !== "downloads" && ent.name !== "recordings") walk(p, level + 1);
      } else if (ent.name.endsWith(".tmp")) {
        try {
          if (now - statSync(p).mtimeMs > maxAgeMs) {
            rmSync(p, { force: true });
            removed.push(p);
          }
        } catch {
          /* gone already */
        }
      }
    }
  };
  walk(dataDir, 0);
  return removed;
}
