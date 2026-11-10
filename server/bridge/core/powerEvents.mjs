/**
 * Sleep, wake and clock changes, noticed from inside the process.
 *
 * A laptop that sleeps stops every timer, and when it wakes the Bridge cannot tell "the broker went quiet" from "this
 * computer was off for an hour". A one-second heartbeat compares two clocks: the wall clock (Date.now) and the
 * monotonic clock (performance.now, which on Linux does not count suspended time).
 *
 *   wall time passed much more than the monotonic clock says, or the heartbeat came much later than it was due
 *      -> `system.resumed { sleptMs, from, to }`      (sleep, a frozen process, a VM that was paused)
 *   the wall clock jumped without the monotonic clock (NTP step, a person changed the time)
 *      -> `system.clock_changed { deltaMs, from, to }`
 *
 * Consumers: the recorder labels the gap `computer-asleep` instead of `feed-silent`, the readiness monitor checks the
 * broker session and IP again, and the webhook queue reschedules its timer (timers that wait on the monotonic clock
 * can be late after a sleep). Everything is injectable for tests.
 */

export const HEARTBEAT_MS = 1000;
/** A difference smaller than this is timer jitter, not a sleep. */
export const THRESHOLD_MS = 10_000;

/**
 * @param {{ bus: { emit(topic: string, payload: object): void }, logger?: any, wall?: () => number, mono?: () => number,
 *   setInterval?: typeof setInterval, clearInterval?: typeof clearInterval, intervalMs?: number, thresholdMs?: number }} o
 * @returns {{ start(): void, stop(): void, beat(): void }}
 */
export function createPowerWatcher({ bus, logger, wall = () => Date.now(), mono = () => performance.now(), setInterval: setTimer = setInterval, clearInterval: clearTimer = clearInterval, intervalMs = HEARTBEAT_MS, thresholdMs = THRESHOLD_MS }) {
  let timer = null;
  let lastWall = wall();
  let lastMono = mono();

  function beat() {
    const w = wall();
    const m = mono();
    const wallD = w - lastWall;
    const monoD = m - lastMono;
    const from = lastWall;
    lastWall = w;
    lastMono = m;
    // Time that passed without the process running: the wall clock moved, the monotonic one did not, or the beat was very late.
    const slept = Math.max(wallD - monoD, wallD - intervalMs);
    if (wallD - monoD > thresholdMs || (monoD - intervalMs > thresholdMs && wallD > 0)) {
      const sleptMs = Math.round(slept);
      logger?.info?.(`the computer was asleep or the Bridge was frozen for about ${Math.round(sleptMs / 1000)} s`, { sleptMs });
      emit("system.resumed", { sleptMs, from: new Date(from).toISOString(), to: new Date(w).toISOString() });
      return;
    }
    if (Math.abs(wallD - monoD) > thresholdMs) {
      const deltaMs = Math.round(wallD - monoD);
      logger?.warn?.(`the computer's clock changed by ${Math.round(deltaMs / 1000)} s`, { deltaMs });
      emit("system.clock_changed", { deltaMs, from: new Date(from).toISOString(), to: new Date(w).toISOString() });
    }
  }

  function emit(topic, payload) {
    try {
      bus.emit(topic, payload);
    } catch (err) {
      logger?.warn?.("a power event could not be emitted", { topic, err: String(err?.message ?? err) });
    }
  }

  return {
    beat,
    start() {
      if (timer) return;
      lastWall = wall();
      lastMono = mono();
      timer = setTimer(beat, intervalMs);
      timer?.unref?.();
    },
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}
