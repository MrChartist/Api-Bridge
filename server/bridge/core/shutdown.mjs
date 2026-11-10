/**
 * Stopping the Bridge, and what ends it by accident.
 *
 * `installShutdown` is the one place the running Bridge's process handlers live:
 *   - SIGINT, SIGTERM, SIGHUP (closing a terminal) and SIGBREAK (Windows: closing the console window) all stop it the
 *     same way: log "stopping", close the app (modules stop in reverse order: downloads and recordings write their state,
 *     the webhook queue settles, the control token is removed), log "stopped in N ms", exit 0;
 *   - a deadline (10 s): when the stop is not finished by then it is logged and the process exits 1, so a hung part
 *     cannot keep a Bridge alive that the person already asked to stop;
 *   - a second signal exits at once;
 *   - an uncaught exception or an unhandled rejection is logged (redacted by the logger), a short best-effort close
 *     runs (3 s) so state is written and the lock and token are removed, and the process exits 1.
 *
 * Everything the process touches is injectable (`proc`: on/off/exit, `setTimer`), so the tests drive it with fake signals.
 */

export const STOP_DEADLINE_MS = 10_000;
export const CRASH_CLOSE_MS = 3_000;

/**
 * @param {{ close(): Promise<void> }} app
 * @param {{ logger?: any, proc?: { on: Function, off: Function, exit: (code: number) => void, platform?: string }, deadlineMs?: number, crashCloseMs?: number,
 *   setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout, now?: () => number, onStopped?: (code: number) => void }} [opts]
 * @returns {{ uninstall(): void, stop(signal?: string): Promise<number>, stopping: () => boolean }}
 */
export function installShutdown(app, { logger, proc = process, deadlineMs = STOP_DEADLINE_MS, crashCloseMs = CRASH_CLOSE_MS, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now() } = {}) {
  let stopping = false;
  /** @type {Array<[string, (...a: any[]) => void]>} */
  const handlers = [];

  const exit = (code) => {
    try {
      proc.exit(code);
    } catch {
      /* a test's exit may throw to stop the flow */
    }
  };

  async function closeWithin(ms) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimer(() => resolve("timeout"), ms);
      timer?.unref?.();
    });
    try {
      return await Promise.race([app.close().then(() => "closed", (err) => ({ error: err })), timeout]);
    } finally {
      clearTimer(timer);
    }
  }

  async function stop(signal = "stop") {
    if (stopping) {
      logger?.warn?.("stopping again: exiting now", { signal });
      exit(1);
      return 1;
    }
    stopping = true;
    const t0 = now();
    logger?.info?.("stopping", { signal });
    const result = await closeWithin(deadlineMs);
    const ms = now() - t0;
    if (result === "timeout") {
      logger?.error?.("the Bridge did not stop within the time allowed; exiting anyway", { signal, ms });
      exit(1);
      return 1;
    }
    if (result?.error) {
      logger?.error?.("stopping failed; exiting", { signal, err: result.error });
      exit(1);
      return 1;
    }
    logger?.info?.(`stopped in ${ms} ms`, { signal, ms });
    exit(0);
    return 0;
  }

  async function crash(kind, err) {
    logger?.error?.(`the Bridge hit an unexpected ${kind}; saving what it can and exiting`, { err });
    if (!stopping) {
      stopping = true;
      await closeWithin(crashCloseMs);
    }
    exit(1);
  }

  const on = (event, fn) => {
    proc.on(event, fn);
    handlers.push([event, fn]);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", ...(proc.platform === "win32" || process.platform === "win32" ? ["SIGBREAK"] : [])]) on(sig, () => void stop(sig));
  on("uncaughtException", (err) => void crash("error", err));
  on("unhandledRejection", (err) => void crash("rejection", err));

  return {
    stop,
    stopping: () => stopping,
    uninstall() {
      for (const [event, fn] of handlers.splice(0)) proc.off(event, fn);
    },
  };
}
