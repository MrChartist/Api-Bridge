/**
 * Source health: how well each source (a broker account or a data source) has been answering lately, and whether it
 * should be left alone for a while. Pure and deterministic: all time comes from the injected clock and all jitter from
 * the injected random, so tests drive it with a fake clock. No I/O.
 *
 * What is tracked per id:
 *  - latency: a time-decayed average that is peak-sensitive (a slow call registers at once, then fades with a
 *    half-life of 30 s);
 *  - error rate: a time-decayed average of hard failures versus successes (half-life 60 s, with one pseudo-success of
 *    prior weight, so a single early failure does not read as a 100% failure rate). With no new calls it fades to 0;
 *  - an ejection breaker: opens after 3 hard failures in a row, or when at least half of at least 6 calls in the last
 *    60 s failed. It stays open for a cooldown of 15 s that doubles with each ejection up to 5 min, with +-20% jitter,
 *    then goes half-open: exactly one probe call may go through, and its outcome closes or re-opens the breaker.
 *    Ejection counts fade by one per 10 clean minutes.
 *
 * What counts as an outcome (the `kind` of a recorded call):
 *   "ok"          counts as a success
 *   "hard"        timeout, network error, 5xx, unreadable answer: counts as a failure and can trip the breaker
 *   "rate-limit"  429: never trips the breaker (the source is fine, it is just busy), not counted in the error rate
 *   "auth"        login or key problem: never trips it (the account state machine owns this)
 *   "not-found"   the source answered, it just does not know the symbol: never trips it
 * Neutral kinds (everything but ok and hard) only update `lastError`; in half-open state they release the probe so
 * another call may try.
 */

/** Outcome kinds `record()` understands. */
export const OUTCOME_KINDS = Object.freeze(["ok", "hard", "rate-limit", "auth", "not-found"]);
const KINDS = new Set(OUTCOME_KINDS);

export const HEALTH_DEFAULTS = Object.freeze({
  latencyHalfLifeMs: 30_000,
  errorHalfLifeMs: 60_000,
  /** Weight of the pseudo-success every error rate starts with. */
  errorPrior: 1,
  consecutiveHardToOpen: 3,
  windowMs: 60_000,
  windowMinCalls: 6,
  windowFailRate: 0.5,
  baseCooldownMs: 15_000,
  maxCooldownMs: 300_000,
  jitter: 0.2,
  /** One ejection is forgotten per this much time without a failure. */
  ejectionDecayMs: 600_000,
  /** A half-open probe that never reports back frees its slot after this long. */
  probeTimeoutMs: 10_000,
  /** Latency samples older than this are ignored by p50Ms. */
  sampleMaxAgeMs: 300_000,
  /** errorRate at or above this reads as "degraded". */
  degradedErrorRate: 0.2,
});

const RING = 64;
const SAMPLES = 32;

/**
 * Map a thrown error to an outcome kind for `record()`. Returns null for errors that say nothing about the source
 * (the caller went away): do not record those.
 * @param {any} err
 * @returns {"hard"|"rate-limit"|"auth"|"not-found"|null}
 */
export function outcomeKindOf(err) {
  if (!err) return "hard";
  if (err.name === "AbortError") return null;
  switch (err.code) {
    case "UPSTREAM_RATE_LIMITED":
    case "RATE_LIMITED":
    case "ORDER_RATE_LIMITED":
    case "SUBSCRIPTION_LIMIT":
    case "RATE_LIMIT":
      return "rate-limit";
    case "SESSION_EXPIRED":
    case "UPSTREAM_AUTH":
    case "AUTH":
    case "UNAUTHENTICATED":
      return "auth";
    case "SYMBOL_NOT_FOUND":
    case "NOT_FOUND":
    case "CAPABILITY_UNSUPPORTED":
    case "UNSUPPORTED":
    case "NOT_IMPLEMENTED":
      return "not-found";
    case "CANCELLED":
      return null;
    default:
      return "hard";
  }
}

/** Format an epoch ms as HH:MM in Indian time, for human reasons. */
export function istClock(ms) {
  if (!Number.isFinite(ms)) return "";
  return `${new Date(ms + 19_800_000).toISOString().slice(11, 16)} IST`;
}

/**
 * @param {{ clock?: { now(): number }, random?: () => number, config?: Partial<typeof HEALTH_DEFAULTS> }} [opts]
 */
export function createHealthTracker({ clock, random = Math.random, config } = {}) {
  const cfg = { ...HEALTH_DEFAULTS, ...(config ?? {}) };
  const now = () => (clock && typeof clock.now === "function" ? clock.now() : Date.now());
  /** @type {Map<string, any>} */
  const rows = new Map();

  const fresh = () => ({
    n: 0,
    lat: NaN,
    latAt: 0,
    errNum: 0,
    errDen: 0,
    errAt: 0,
    consecHard: 0,
    ringT: new Float64Array(RING),
    ringOk: new Uint8Array(RING),
    ringHead: 0,
    ringCount: 0,
    sampleMs: new Float64Array(SAMPLES),
    sampleAt: new Float64Array(SAMPLES),
    sampleHead: 0,
    sampleCount: 0,
    breaker: "closed",
    openUntil: 0,
    ejections: 0,
    lastBadAt: 0,
    probingUntil: 0,
    disabled: false,
    lastError: null,
  });

  const rowOf = (id) => rows.get(id);
  const ensure = (id) => {
    let r = rows.get(id);
    if (!r) {
      r = fresh();
      rows.set(id, r);
    }
    return r;
  };

  const half = (dt, h) => 2 ** (-dt / h);

  /** Move an open breaker whose cooldown has passed to half-open. */
  function sync(r, t) {
    if (r.breaker === "open" && t >= r.openUntil) r.breaker = "half";
  }

  function decayEjections(r, t) {
    if (r.ejections > 0 && r.lastBadAt > 0) {
      const steps = Math.floor((t - r.lastBadAt) / cfg.ejectionDecayMs);
      if (steps > 0) {
        r.ejections = Math.max(0, r.ejections - steps);
        r.lastBadAt += steps * cfg.ejectionDecayMs;
      }
    }
  }

  function openBreaker(r, t) {
    decayEjections(r, t);
    r.ejections += 1;
    const base = Math.min(cfg.maxCooldownMs, cfg.baseCooldownMs * 2 ** Math.min(16, r.ejections - 1));
    const jitter = 1 + (random() * 2 - 1) * cfg.jitter;
    r.openUntil = t + Math.round(base * jitter);
    r.breaker = "open";
    r.probingUntil = 0;
    r.consecHard = 0;
  }

  function closeBreaker(r) {
    r.breaker = "closed";
    r.probingUntil = 0;
    r.consecHard = 0;
    r.ringCount = 0;
    r.ringHead = 0;
  }

  function errorRateOf(r, t) {
    if (r.errDen <= 0 && r.errNum <= 0) return 0;
    const f = half(Math.max(0, t - r.errAt), cfg.errorHalfLifeMs);
    return (r.errNum * f) / (r.errDen * f + cfg.errorPrior);
  }

  function p50Of(r, t) {
    let buf = null;
    let n = 0;
    for (let i = 0; i < r.sampleCount; i += 1) {
      if (t - r.sampleAt[i] <= cfg.sampleMaxAgeMs) {
        buf ??= [];
        buf.push(r.sampleMs[i]);
        n += 1;
      }
    }
    if (!n) return null;
    buf.sort((a, b) => a - b);
    return buf[Math.floor((n - 1) / 2)];
  }

  function recentRate(r, t) {
    let calls = 0;
    let fails = 0;
    for (let i = 0; i < r.ringCount; i += 1) {
      if (t - r.ringT[i] > cfg.windowMs) continue;
      calls += 1;
      if (r.ringOk[i] === 0) fails += 1;
    }
    return { calls, fails };
  }

  /**
   * Record the outcome of one real call.
   * @param {string} id  broker account id or source id
   * @param {{ ok?: boolean, ms?: number, kind?: "ok"|"hard"|"rate-limit"|"auth"|"not-found", message?: string }} outcome
   */
  function record(id, { ok, ms, kind, message } = {}) {
    const t = now();
    const r = ensure(id);
    let k = typeof kind === "string" && KINDS.has(kind) ? kind : ok ? "ok" : "hard";
    if (ok === true) k = "ok";
    else if (k === "ok") k = "hard";
    r.n += 1;
    sync(r, t);

    if (k !== "ok" && k !== "hard") {
      r.lastError = { kind: k, message: message ?? null, at: t };
      if (r.breaker === "half") r.probingUntil = 0; // the probe learned nothing: let another call try
      return;
    }

    // error rate (time-decayed sums)
    const f = r.errDen > 0 || r.errNum > 0 ? half(Math.max(0, t - r.errAt), cfg.errorHalfLifeMs) : 0;
    r.errNum = r.errNum * f + (k === "hard" ? 1 : 0);
    r.errDen = r.errDen * f + 1;
    r.errAt = t;

    // latency (peak-sensitive: a slower call replaces the average at once, a faster one blends in by time)
    if (Number.isFinite(ms) && ms >= 0) {
      if (!Number.isFinite(r.lat)) r.lat = ms;
      else if (ms > r.lat) r.lat = ms;
      else r.lat += (1 - half(Math.max(0, t - r.latAt), cfg.latencyHalfLifeMs)) * (ms - r.lat);
      r.latAt = t;
      if (k === "ok") {
        r.sampleMs[r.sampleHead] = ms;
        r.sampleAt[r.sampleHead] = t;
        r.sampleHead = (r.sampleHead + 1) % SAMPLES;
        if (r.sampleCount < SAMPLES) r.sampleCount += 1;
      }
    }

    // recent-call ring for the failure-rate rule
    r.ringT[r.ringHead] = t;
    r.ringOk[r.ringHead] = k === "ok" ? 1 : 0;
    r.ringHead = (r.ringHead + 1) % RING;
    if (r.ringCount < RING) r.ringCount += 1;

    if (k === "ok") {
      r.consecHard = 0;
      // A success while open is a forced probe (see the router's never-fully-blind rule): it closes the breaker too.
      if (r.breaker === "half" || r.breaker === "open") closeBreaker(r);
      else decayEjections(r, t);
      return;
    }

    // hard failure
    r.lastError = { kind: "hard", message: message ?? null, at: t };
    if (r.breaker === "half") {
      openBreaker(r, t);
      r.lastBadAt = t;
      return;
    }
    if (r.breaker === "open") return; // a call that was already in flight when it opened
    r.consecHard += 1;
    decayEjections(r, t);
    r.lastBadAt = t;
    let trip = r.consecHard >= cfg.consecutiveHardToOpen;
    if (!trip) {
      const { calls, fails } = recentRate(r, t);
      trip = calls >= cfg.windowMinCalls && fails / calls >= cfg.windowFailRate;
    }
    if (trip) openBreaker(r, t);
  }

  /** May a call go to this id right now? Open: no. Half-open: yes only when no probe is in flight. Never throws. */
  function canTry(id) {
    const r = rowOf(id);
    if (!r) return true;
    if (r.disabled) return false;
    const t = now();
    sync(r, t);
    if (r.breaker === "closed") return true;
    if (r.breaker === "open") return false;
    return t >= r.probingUntil;
  }

  /** Mark the half-open probe as in flight (no effect on a closed breaker). Call when a call is about to go out. */
  function claim(id) {
    const r = rowOf(id);
    if (!r) return;
    const t = now();
    sync(r, t);
    if (r.breaker === "half") r.probingUntil = t + cfg.probeTimeoutMs;
  }

  /** The caller went away before the probe answered: free the slot. */
  function release(id) {
    const r = rowOf(id);
    if (r && r.breaker === "half") r.probingUntil = 0;
  }

  /** "closed" | "open" (cooldown pending) | "half" (probe allowed or in flight) | "disabled". No allocation. */
  function phase(id) {
    const r = rowOf(id);
    if (!r) return "closed";
    if (r.disabled) return "disabled";
    sync(r, now());
    return r.breaker === "closed" ? "closed" : r.breaker === "open" ? "open" : "half";
  }

  const latencyMs = (id) => {
    const r = rowOf(id);
    return r && Number.isFinite(r.lat) ? r.lat : NaN;
  };
  const errorRate = (id) => {
    const r = rowOf(id);
    return r ? errorRateOf(r, now()) : 0;
  };
  const samples = (id) => rowOf(id)?.n ?? 0;
  const nextTryAt = (id) => {
    const r = rowOf(id);
    if (!r) return null;
    sync(r, now());
    if (r.breaker === "open") return r.openUntil;
    if (r.breaker === "half" && r.probingUntil > now()) return r.probingUntil;
    return null;
  };

  /**
   * @param {string} id
   * @returns {{ state: "ok"|"degraded"|"open"|"disabled", errorRate: number, p50Ms: number|null, lastError: { kind: string, message: string|null, at: number }|null, nextTryAt: number|null }}
   */
  function state(id) {
    const r = rowOf(id);
    if (!r) return { state: "ok", errorRate: 0, p50Ms: null, lastError: null, nextTryAt: null };
    const t = now();
    sync(r, t);
    const er = errorRateOf(r, t);
    let s = "ok";
    if (r.disabled) s = "disabled";
    else if (r.breaker === "open") s = "open";
    else if (r.breaker === "half" || er >= cfg.degradedErrorRate) s = "degraded";
    return {
      state: s,
      errorRate: Math.round(er * 1000) / 1000,
      p50Ms: p50Of(r, t),
      lastError: r.lastError ? { ...r.lastError } : null,
      nextTryAt: nextTryAt(id),
    };
  }

  /** Every id that has been seen, as `{ [id]: state }`. */
  function snapshot() {
    const out = {};
    for (const id of rows.keys()) out[id] = state(id);
    return out;
  }

  /** Switch an id off (the owner turned the source off): it reads as "disabled" and canTry() is false. */
  function setDisabled(id, disabled = true) {
    const r = ensure(id);
    r.disabled = Boolean(disabled);
  }

  /** Forget everything about an id (a source was removed, or the owner reset it). */
  function reset(id) {
    if (id === undefined) rows.clear();
    else rows.delete(id);
  }

  return { record, state, snapshot, canTry, claim, release, phase, latencyMs, errorRate, samples, nextTryAt, setDisabled, reset };
}
