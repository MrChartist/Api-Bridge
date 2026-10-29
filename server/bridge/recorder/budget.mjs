/**
 * The recorder's own REST budget (stream S17, docs/spec/p1-01-recorder.md §5.1 rules 3, 4 and 7). Pure apart from the
 * clock it is given.
 *
 * For the endpoint class the recorder uses ("chain" for broker chains, "quote" for chains built from quotes) it keeps,
 * for EVERY window that covers the class (the class's per-second, per-minute, per-day and extra windows, and those of
 * each group bucket that lists the class), a sliding-window cap of floor(share × limit). So the recorder alone can
 * never use more than half of any window, whatever else is running. This sits ON TOP of the shared
 * ratelimit/backgroundGate.mjs check and the scheduler's dispatch floor (docs/spec/README.md C12): the gate looks at
 * everyone's use, this limiter at the recorder's own.
 *
 * Rule 4, "never take the last token": REST is allowed on a class only when every per-second window covering it has a
 * limit of at least 2, so after the recorder's floor(L/2) calls in a second at least ceil(L/2) ≥ 1 token is free for a
 * user. Otherwise REST is off for that class unless the user opted in to `allowSingleTokenRest` (user calls may then
 * wait up to 1 s).
 *
 * Rule 7: after an upstream throttle the caps are halved for 10 minutes.
 */

const SECOND_MS = 1000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Windows up to this long count toward the sustained per-minute rate; a daily cap is a quota, not a pace. */
const PACE_WINDOW_MAX_MS = 3_600_000;
export const THROTTLE_HOLD_MS = 10 * MINUTE_MS;

/** "1/s", "20/min", "2,000/30 min" style label for a window. */
export function windowLabel(windowMs, limit) {
  const n = Number(limit).toLocaleString("en-IN");
  if (windowMs === SECOND_MS) return `${n}/s`;
  if (windowMs === MINUTE_MS) return `${n}/min`;
  if (windowMs === DAY_MS) return `${n}/day`;
  if (windowMs % MINUTE_MS === 0) return `${n}/${windowMs / MINUTE_MS} min`;
  return `${n}/${windowMs} ms`;
}

/**
 * Every window that covers a class in an effective policy (ratelimit/policy.mjs resolvePolicy output).
 * @param {object} policy  effective policy
 * @param {string} endpointClass
 * @returns {Array<{ bucket: string, windowMs: number, limit: number, verified: boolean }>}
 */
export function windowsFor(policy, endpointClass) {
  const out = [];
  const add = (bucket, spec) => {
    if (!spec) return;
    const verified = spec.verified === true;
    if (spec.perSecond > 0) out.push({ bucket, windowMs: SECOND_MS, limit: spec.perSecond, verified });
    if (spec.perMinute > 0) out.push({ bucket, windowMs: MINUTE_MS, limit: spec.perMinute, verified });
    if (spec.perDay > 0) out.push({ bucket, windowMs: DAY_MS, limit: spec.perDay, verified });
    for (const w of spec.extraWindows ?? []) if (w?.windowMs > 0 && w?.limit > 0) out.push({ bucket, windowMs: w.windowMs, limit: w.limit, verified });
  };
  if (policy?.unlimited) return out;
  add(`class:${endpointClass}`, policy?.limits?.[endpointClass]);
  for (const [name, g] of Object.entries(policy?.groups ?? {})) if ((g.classes ?? []).includes(endpointClass)) add(`group:${name}`, g);
  return out;
}

/**
 * Rule 4 for a class: is REST allowed for the recorder?
 * @returns {{ allowed: boolean, singleToken: boolean, why: string | null, perSecond: number | null }}
 */
export function restRule(policy, endpointClass, { allowSingleTokenRest = false } = {}) {
  const ws = windowsFor(policy, endpointClass);
  if (policy?.unlimited) return { allowed: false, singleToken: false, why: "Paper accounts have no market data.", perSecond: null };
  if (!ws.length) return { allowed: false, singleToken: false, why: "No rate limits are known for this class.", perSecond: null };
  const perSecond = ws.filter((w) => w.windowMs === SECOND_MS).reduce((m, w) => Math.min(m, w.limit), Infinity);
  const ps = Number.isFinite(perSecond) ? perSecond : null;
  const singleToken = ps !== null && ps < 2;
  if (singleToken && !allowSingleTokenRest) return { allowed: false, singleToken, why: `${ps} request/s: recording on it could delay your own requests by up to 1 s.`, perSecond: ps };
  return { allowed: true, singleToken, why: singleToken ? `${ps} request/s: your own requests may wait up to 1 s while the recorder uses it.` : null, perSecond: ps };
}

/**
 * The recorder's caps for a class: floor(share × limit) per window, and the sustained calls per minute they allow
 * (the smallest over windows up to an hour; a daily cap is reported separately).
 * @returns {{ windows: Array<{ bucket, windowMs, limit, cap, verified, label }>, perMinute: number, perDay: number | null, brokerPerMinute: number | null }}
 */
export function budgetCaps(policy, endpointClass, share) {
  const s = Math.min(Math.max(Number(share) || 0, 0), 0.5);
  const windows = windowsFor(policy, endpointClass).map((w) => ({ ...w, cap: Math.floor(s * w.limit), label: windowLabel(w.windowMs, w.limit) }));
  let perMinute = Infinity;
  let brokerPerMinute = Infinity;
  let perDay = null;
  for (const w of windows) {
    if (w.windowMs <= PACE_WINDOW_MAX_MS) {
      perMinute = Math.min(perMinute, (w.cap * MINUTE_MS) / w.windowMs);
      brokerPerMinute = Math.min(brokerPerMinute, (w.limit * MINUTE_MS) / w.windowMs);
    } else if (w.windowMs >= DAY_MS) perDay = perDay === null ? w.cap : Math.min(perDay, w.cap);
  }
  return {
    windows,
    perMinute: Number.isFinite(perMinute) ? Math.floor(perMinute) : 0,
    perDay,
    brokerPerMinute: Number.isFinite(brokerPerMinute) ? Math.floor(brokerPerMinute) : null,
  };
}

/**
 * The recorder's sliding-window limiter for one (account, class).
 * @param {{ policy: object, endpointClass: string, share: number, clock: { now(): number } }} opts
 */
export function createRecorderBudget({ policy, endpointClass, share, clock }) {
  const caps = budgetCaps(policy, endpointClass, share);
  /** Call times per window index. */
  const logs = caps.windows.map(() => []);
  let halvedUntil = 0;
  const now = () => clock.now();

  const capOf = (i, t) => (t < halvedUntil ? Math.floor(caps.windows[i].cap / 2) : caps.windows[i].cap);
  const prune = (i, t) => {
    const w = caps.windows[i].windowMs;
    const log = logs[i];
    let drop = 0;
    while (drop < log.length && log[drop] <= t - w) drop++;
    if (drop) log.splice(0, drop);
  };

  function canTake(n = 1, t = now()) {
    if (!caps.windows.length) return false;
    for (let i = 0; i < caps.windows.length; i++) {
      prune(i, t);
      if (logs[i].length + n > capOf(i, t)) return false;
    }
    return true;
  }

  return {
    caps,
    canTake,
    /** Take n calls now when every window has room; false (nothing taken) otherwise. */
    tryTake(n = 1, t = now()) {
      if (!canTake(n, t)) return false;
      for (const log of logs) for (let k = 0; k < n; k++) log.push(t);
      return true;
    },
    /** ms until canTake(n) could be true (0 now; Infinity when a cap is 0). */
    waitMs(n = 1, t = now()) {
      let wait = 0;
      for (let i = 0; i < caps.windows.length; i++) {
        prune(i, t);
        const cap = capOf(i, t);
        if (cap < n) return t < halvedUntil ? halvedUntil - t : Infinity;
        const over = logs[i].length + n - cap;
        if (over > 0) wait = Math.max(wait, logs[i][over - 1] + caps.windows[i].windowMs - t);
      }
      return Math.max(0, wait);
    },
    /** Calls made in the last minute. */
    usedLastMinute(t = now()) {
      const i = caps.windows.findIndex((w) => w.windowMs >= MINUTE_MS);
      if (i < 0) return logs[0]?.filter((x) => x > t - MINUTE_MS).length ?? 0;
      return logs[i].filter((x) => x > t - MINUTE_MS).length;
    },
    /** Rule 7: halve every cap for 10 minutes after an upstream throttle. */
    throttle(t = now()) {
      halvedUntil = t + THROTTLE_HOLD_MS;
    },
    /** The current sustained per-minute cap (halved while throttled). */
    perMinute(t = now()) {
      return t < halvedUntil ? Math.floor(caps.perMinute / 2) : caps.perMinute;
    },
    halvedUntil: () => halvedUntil,
    /** Counts per window in the sliding window ending at t (tests and status). */
    counts(t = now()) {
      return caps.windows.map((w, i) => {
        prune(i, t);
        return { bucket: w.bucket, windowMs: w.windowMs, used: logs[i].length, cap: capOf(i, t), limit: w.limit };
      });
    },
  };
}
