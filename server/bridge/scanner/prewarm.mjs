/**
 * Scanner pre-warm (docs/perf/README.md): fill the daily-bar cache (liveFacts.prewarm, the cache scans read) for the
 * scanner universes before anyone scans, so the first scan of the day needs no daily-bar calls (a cold 200-symbol scan
 * was ~200 broker calls and minutes of waiting).
 *
 *   when    once after start (a short delay, so the instrument master is loaded), and after the close for the next
 *           trading day (bars complete up to today go into that day's cache file);
 *   how     one symbol at a time, background priority, through the shared background gate (half of every window stays
 *           free), and paused while a person or tool is using the broker (scheduler.userActiveAt within PAUSE_MS);
 *   what    NIFTY50 and FNO (every stock with NSE futures, from the instrument master), deduplicated;
 *   shows   "Preparing scans N/200" in the API budget panel (ratelimit/jobs.mjs) while it runs.
 *
 * Never in demo mode (no live facts) and never without a data account. Calls are credited to "Scanner pre-warm".
 */
import { runAsConsumer } from "../ratelimit/consumer.mjs";
import { endJob, setJob } from "../ratelimit/jobs.mjs";
import { NIFTY50 } from "./universes.mjs";

/** Wait this long after start before the first pre-warm. */
export const START_DELAY_MS = 30_000;
/** A non-background broker request this recent pauses the pre-warm. */
export const PAUSE_MS = 10_000;
/** The after-close pre-warm runs at this IST time on trading weekdays (the close is 15:30). */
export const AFTER_CLOSE_IST = { h: 15, m: 50 };
const IST_MS = 330 * 60_000;
const JOB = "scanner-prewarm";

/** IST date (YYYY-MM-DD) of an epoch ms (pure). */
export const istDate = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);

/** The next weekday after an IST date (pure). Holidays are not known here: a missed day just fetches on demand. */
export function nextWeekday(date) {
  const d = new Date(`${date}T00:00:00Z`);
  do d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

/** Epoch ms of the next after-close run at or after `ms` (pure): today's 15:50 IST if not passed, else the next weekday's. */
export function nextAfterClose(ms) {
  let date = istDate(ms);
  const at = (d) => Date.parse(`${d}T00:00:00Z`) - IST_MS + (AFTER_CLOSE_IST.h * 60 + AFTER_CLOSE_IST.m) * 60_000;
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (wd === 0 || wd === 6 || at(date) <= ms) date = nextWeekday(date);
  return at(date);
}

/**
 * @param {{ liveFacts: { prewarm: Function } | null, universes: { resolve(name: string): Promise<string[]> }, scheduler?: object,
 *   clock: { now(): number, setTimeout?: Function, clearTimeout?: Function }, logger?: object, extraUniverses?: string[] }} deps
 */
export function createPrewarm(deps) {
  const now = () => deps.clock.now();
  const setT = typeof deps.clock.setTimeout === "function" ? deps.clock.setTimeout.bind(deps.clock) : setTimeout;
  const clearT = typeof deps.clock.clearTimeout === "function" ? deps.clock.clearTimeout.bind(deps.clock) : clearTimeout;
  let timer = null;
  let abort = null;
  let running = null;
  const last = { at: null, forDay: null, fetched: 0, cached: 0, errors: 0, total: 0 };

  const paused = () => {
    const at = deps.scheduler?.userActiveAt?.();
    return Number.isFinite(at) && now() - at < PAUSE_MS;
  };

  async function symbolsToWarm() {
    const out = new Set(NIFTY50);
    for (const name of ["FNO", ...(deps.extraUniverses ?? [])]) {
      try {
        for (const s of await deps.universes.resolve(name)) out.add(s);
      } catch {
        // FNO needs a loaded instrument master: NIFTY50 alone then
      }
    }
    return [...out];
  }

  /** Run one pre-warm now (for today, or for `forDay`). Joins a run already going. */
  function run({ forDay } = {}) {
    if (running) return running;
    if (!deps.liveFacts?.prewarm) return Promise.resolve(null);
    abort = new AbortController();
    const signal = abort.signal;
    setJob(JOB, { label: "Preparing scans", done: 0, total: 0 });
    running = (async () => {
      const symbols = await symbolsToWarm();
      setJob(JOB, { label: "Preparing scans", done: 0, total: symbols.length });
      try {
        const r = await runAsConsumer("Scanner pre-warm", () =>
          deps.liveFacts.prewarm(symbols, {
            forDay,
            signal,
            paused: () => {
              const p = paused();
              setJob(JOB, { label: "Preparing scans", done: last.done ?? 0, total: symbols.length, paused: p });
              return p;
            },
            onProgress: (done, total) => {
              last.done = done;
              setJob(JOB, { label: "Preparing scans", done, total, paused: false });
            },
          }),
        );
        Object.assign(last, { at: new Date(now()).toISOString(), forDay: forDay ?? istDate(now()), total: symbols.length, ...(r ?? {}) });
        deps.logger?.info?.("scanner pre-warm done", { forDay: last.forDay, symbols: symbols.length, fetched: last.fetched, cached: last.cached, errors: last.errors });
        return last;
      } catch (err) {
        deps.logger?.warn?.("scanner pre-warm stopped", { err: err?.message });
        return null;
      } finally {
        endJob(JOB);
        running = null;
        abort = null;
      }
    })();
    return running;
  }

  function scheduleAfterClose() {
    const at = nextAfterClose(now());
    timer = setT(() => {
      timer = null;
      run({ forDay: nextWeekday(istDate(now())) }).finally(() => scheduleAfterClose());
    }, Math.max(1000, at - now()));
    timer?.unref?.();
  }

  return {
    run,
    /** Start: one pre-warm after START_DELAY_MS, then after every close. */
    start() {
      if (timer || !deps.liveFacts?.prewarm) return;
      timer = setT(() => {
        timer = null;
        run().finally(() => scheduleAfterClose());
      }, START_DELAY_MS);
      timer?.unref?.();
    },
    stop() {
      if (timer) clearT(timer);
      timer = null;
      abort?.abort();
      endJob(JOB);
    },
    status: () => ({ running: Boolean(running), last: { ...last } }),
  };
}
