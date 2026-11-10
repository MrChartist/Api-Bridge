/**
 * The storage monitor: free space on the data folder's disk, and whether the Bridge can still save.
 *
 *   every `checkIntervalSec` (default 30):  statfs on the data folder
 *     below `minFreeMb`  (default 1024)  level "low":      health says "degraded", event storage.status
 *     below `hardFreeMb` (default 200)   level "critical": downloads pause (reason disk_low), no new download starts,
 *                                                          readiness (GET /v1/ready) says not ready
 *   plus the write failures recorded by lib/jsonl.mjs (lib/storageHealth.mjs): any state file that could not be written
 *   and has not been written since is a problem, and one caused by a full disk makes the level "critical" at once.
 *
 * It only measures and tells (bus topic storage.status on every change of level, with the free space in MB). What to do
 * about it is up to each part: downloads pause, the recorder has its own floor (recorder.minFreeDiskMb), and a paper
 * order is never accepted unless it could be saved (paper/paperEngine.mjs).
 */
import { statfsSync } from "node:fs";
import { writeFailureStatus } from "../../lib/storageHealth.mjs";

const MB = 1024 * 1024;

/** Free and total bytes of the disk holding `dir`, or null when the platform cannot say. */
export function diskSpace(dir, statfs = statfsSync) {
  try {
    const s = statfs(dir);
    return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return null;
  }
}

/**
 * @param {{ dataDir: string, cfg: { minFreeMb: number, hardFreeMb: number, checkIntervalSec: number }, bus?: any, logger?: any,
 *   now?: () => number, statfs?: (dir: string) => any, setInterval?: typeof setInterval, clearInterval?: typeof clearInterval }} o
 */
export function createStorageMonitor({ dataDir, cfg, bus, logger, now = () => Date.now(), statfs, setInterval: setTimer = setInterval, clearInterval: clearTimer = clearInterval }) {
  let timer = null;
  let level = "ok";
  let space = null;
  let checkedAt = null;

  function evaluate() {
    space = diskSpace(dataDir, statfs);
    checkedAt = now();
    const failures = writeFailureStatus({ under: dataDir });
    const diskFullWrite = failures.open.some((f) => f.code === "ENOSPC" || f.code === "EDQUOT");
    const freeMb = space ? space.freeBytes / MB : null;
    let next = "ok";
    if (freeMb !== null && freeMb < cfg.hardFreeMb) next = "critical";
    else if (diskFullWrite) next = "critical";
    else if (freeMb !== null && freeMb < cfg.minFreeMb) next = "low";
    if (next !== level) {
      const prev = level;
      level = next;
      const payload = { level, previous: prev, freeMb: freeMb === null ? null : Math.floor(freeMb), minFreeMb: cfg.minFreeMb, hardFreeMb: cfg.hardFreeMb, writeFailures: failures.openCount, message: messageFor(level, freeMb, failures.openCount) };
      (level === "ok" ? logger?.info : logger?.warn)?.call(logger, payload.message, { level });
      try {
        bus?.emit("storage.status", payload);
      } catch (err) {
        logger?.warn?.("storage.status could not be emitted", { err: String(err?.message ?? err) });
      }
    }
    return level;
  }

  const messageFor = (lvl, freeMb, writeFailures) => {
    const free = freeMb === null ? "unknown" : `${Math.floor(freeMb)} MB`;
    if (lvl === "critical") return `The disk holding the Bridge's data is almost full (${free} free)${writeFailures ? " and some files could not be saved" : ""}. Downloads are paused. Free space (delete old downloads and recordings on the Data page).`;
    if (lvl === "low") return `Free space on the disk holding the Bridge's data is low (${free}). Delete old downloads and recordings before it runs out.`;
    return `Free space on the disk holding the Bridge's data is back to normal (${free}).`;
  };

  return {
    /** Measure now. @returns {"ok" | "low" | "critical"} */
    check: evaluate,
    level: () => level,
    start() {
      if (timer) return;
      evaluate();
      timer = setTimer(evaluate, Math.max(1, cfg.checkIntervalSec) * 1000);
      timer?.unref?.();
    },
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
    },
    /** The numbers for health, doctor and metrics. */
    status() {
      const failures = writeFailureStatus({ under: dataDir });
      return {
        level,
        freeMb: space ? Math.floor(space.freeBytes / MB) : null,
        totalMb: space ? Math.floor(space.totalBytes / MB) : null,
        minFreeMb: cfg.minFreeMb,
        hardFreeMb: cfg.hardFreeMb,
        checkedAt: checkedAt === null ? null : new Date(checkedAt).toISOString(),
        writeErrors: {
          open: failures.openCount,
          total: failures.total,
          last: failures.last ? { file: String(failures.last.path).split(/[\\/]/).pop(), code: failures.last.code, at: new Date(failures.last.at).toISOString() } : null,
        },
      };
    },
    /** Problems for GET /v1/health. @returns {Array<{ code: string, message: string }>} */
    problems() {
      const out = [];
      const st = this.status();
      if (st.level !== "ok") out.push({ code: st.level === "critical" ? "storage_critical" : "storage_low", message: messageFor(st.level, st.freeMb, st.writeErrors.open) });
      if (st.writeErrors.open) out.push({ code: "write_errors", message: `${st.writeErrors.open} file${st.writeErrors.open === 1 ? "" : "s"} could not be saved (last: ${st.writeErrors.last?.file ?? "unknown"}, ${st.writeErrors.last?.code ?? "error"}). Changes since then may be lost on a restart.` });
      return out;
    },
  };
}
