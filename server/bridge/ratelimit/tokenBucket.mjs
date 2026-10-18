/**
 * Multi-window rate limiter for one (account, endpoint class) or (account, group) budget — stream S3.
 *
 * The contract calls these "token buckets"; the implementation is deliberately stricter than a classic refilling
 * bucket so that no broker window can ever be exceeded, whatever way the broker aligns its own windows:
 *
 *  - Sub-day windows (per second, per minute, per hour ...) are SLIDING-WINDOW LOGS. Every unit taken is stamped
 *    with a time; a unit may be taken at time t only if fewer than `limit` stamps s satisfy t - s < W + pad.
 *    A sliding log bounds the count in EVERY interval of length W, so it also bounds the broker's fixed windows.
 *    `pad` (windowPaddingMs) widens each window a little to absorb network jitter between us and the broker.
 *  - The daily window is a counter per IST calendar day (brokers reset daily caps at midnight IST; India has no DST).
 *
 * A request may cost several units (an adapter call that makes several upstream HTTP requests). Units that fit now
 * are stamped now; units beyond a window's capacity are stamped in the FUTURE at the earliest time each window
 * allows (a reservation), so later requests wait while the adapter paces its own sub-calls. A request is runnable
 * when its first min(cost, smallest capacity) units fit now.
 *
 * Time is whatever the caller passes (`now`, epoch ms); nothing here reads the clock, so tests use a fake clock.
 */

export const IST_OFFSET_MS = 19_800_000; // +05:30
export const DAY_MS = 86_400_000;

/** IST calendar day number for an epoch-ms time. */
export function istDay(nowMs) {
  return Math.floor((nowMs + IST_OFFSET_MS) / DAY_MS);
}

/** Epoch ms of the next IST midnight after `nowMs`. */
export function nextIstMidnight(nowMs) {
  return (istDay(nowMs) + 1) * DAY_MS - IST_OFFSET_MS;
}

/** ISO-8601 with +05:30 for an epoch-ms time (for reports). */
export function toIstIso(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.toISOString().replace("Z", "+05:30");
}

/**
 * @typedef {{ name: string, windowMs: number, limit: number } | { name: "day", istDay: true, limit: number }} WindowSpec
 * windowMs > 0 and limit >= 1. `name` is for reports ("1s", "1m", "1h", "day").
 */

/** Human label for a window length. */
export function windowName(windowMs) {
  if (windowMs % 3_600_000 === 0) return `${windowMs / 3_600_000}h`;
  if (windowMs % 60_000 === 0) return `${windowMs / 60_000}m`;
  if (windowMs % 1000 === 0) return `${windowMs / 1000}s`;
  return `${windowMs}ms`;
}

/**
 * Convert a LimitSpec ({ perSecond, perMinute, perDay, extraWindows? }) to window specs. Non-positive or missing
 * values are skipped. Fractional limits are floored (never rounded up), with a floor of 1.
 * @param {{ perSecond?: number, perMinute?: number, perDay?: number, extraWindows?: Array<{ windowMs: number, limit: number }> }} spec
 * @returns {WindowSpec[]}
 */
export function windowsFromSpec(spec) {
  const out = [];
  const lim = (n) => Math.max(1, Math.floor(n));
  if (spec?.perSecond > 0) out.push({ name: "1s", windowMs: 1000, limit: lim(spec.perSecond) });
  if (spec?.perMinute > 0) out.push({ name: "1m", windowMs: 60_000, limit: lim(spec.perMinute) });
  for (const w of spec?.extraWindows ?? []) {
    if (w?.windowMs > 0 && w?.limit > 0) out.push({ name: windowName(w.windowMs), windowMs: w.windowMs, limit: lim(w.limit) });
  }
  if (spec?.perDay > 0) out.push({ name: "day", istDay: true, limit: lim(spec.perDay) });
  return out;
}

/** One sliding-window log: sorted stamps (ascending) with a moving head index. */
class SlidingLog {
  constructor(name, windowMs, limit, padMs) {
    this.name = name;
    this.windowMs = windowMs;
    this.limit = limit;
    this.span = windowMs + padMs;
    /** @type {number[]} */
    this.stamps = [];
    this.head = 0;
  }

  prune(now) {
    const cutoff = now - this.span;
    const s = this.stamps;
    while (this.head < s.length && s[this.head] <= cutoff) this.head += 1;
    if (this.head > 1024 && this.head * 2 > s.length) {
      this.stamps = s.slice(this.head);
      this.head = 0;
    }
  }

  /** Units stamped in (now - span, +inf): used now plus future reservations. */
  used(now) {
    this.prune(now);
    return this.stamps.length - this.head;
  }

  /** Units stamped in (now - span, now]: what the broker has (or will have) seen as of now. */
  usedUpTo(now) {
    this.prune(now);
    let n = 0;
    for (let i = this.head; i < this.stamps.length && this.stamps[i] <= now; i++) n += 1;
    return n;
  }

  /** Earliest time >= t at which one more unit may be stamped, given the current log. */
  earliest(t) {
    const live = this.stamps.length - this.head;
    if (live < this.limit) return t;
    // The `limit`-th most recent stamp must have left the window. A stamp s is live at t while t - s < span.
    const blocker = this.stamps[this.stamps.length - this.limit];
    return Math.max(t, blocker + this.span);
  }

  /**
   * Insert a stamp keeping the log sorted. A bucket shared by several classes (a group) can hold future reservations
   * from one class while another class stamps "now", so a plain push is not enough. Counting every stamp after
   * (t - span), future ones included, keeps earliest() conservative: no interval of length W ever exceeds `limit`.
   */
  push(t) {
    const s = this.stamps;
    let i = s.length;
    while (i > this.head && s[i - 1] > t) i -= 1;
    if (i === s.length) s.push(t);
    else s.splice(i, 0, t);
  }

  /** ms until the oldest live stamp leaves the window (0 when empty). */
  resetMs(now) {
    this.prune(now);
    if (this.head >= this.stamps.length) return 0;
    return Math.max(0, this.stamps[this.head] + this.span - now);
  }
}

/** Daily counter on IST calendar days. */
class DayCounter {
  constructor(limit) {
    this.name = "day";
    this.limit = limit;
    this.day = -1;
    this.count = 0;
  }

  roll(now) {
    const d = istDay(now);
    if (d !== this.day) {
      this.day = d;
      this.count = 0;
    }
  }

  used(now) {
    this.roll(now);
    return this.count;
  }

  usedUpTo(now) {
    return this.used(now);
  }

  resetMs(now) {
    return nextIstMidnight(now) - now;
  }
}

/**
 * @typedef {object} RateLimiter
 * @property {(cost: number, now: number) => boolean} canTake   The first min(cost, capacity) units fit now.
 * @property {(cost: number, now: number) => number} waitMs     ms until canTake(cost) becomes true (Infinity if never today).
 * @property {(cost: number, now: number) => number[]} take     Stamp `cost` units (some possibly in the future); returns the stamps.
 * @property {(now: number) => { remaining: number, limit: number, resetMs: number, used: number, window: string }} headroom
 *   The binding window: the one with the fewest units left.
 * @property {(now: number) => Array<{ window: string, used: number, limit: number, resetMs: number }>} windows
 * @property {() => number} capacity   Smallest sub-day limit (units a single request may take at once).
 * @property {(cost: number) => boolean} fitsDay  Whether `cost` can ever fit in one IST day.
 * @property {() => number} unitsPerMs  Sustained rate allowed by the strictest sub-day window.
 * @property {(now: number) => void} fill  Mark every window as full right now (used after an upstream 429).
 * @property {readonly WindowSpec[]} specs
 */

/**
 * @param {WindowSpec[]} specs
 * @param {{ paddingMs?: number }} [opts]
 * @returns {RateLimiter}
 */
export function createRateLimiter(specs, { paddingMs = 0 } = {}) {
  if (!Array.isArray(specs)) throw new TypeError("createRateLimiter needs an array of window specs");
  const logs = [];
  let day = null;
  for (const s of specs) {
    if (!(s.limit >= 1) || !Number.isFinite(s.limit)) throw new RangeError(`window ${s.name}: limit must be a finite number >= 1`);
    if (s.istDay) day = new DayCounter(Math.floor(s.limit));
    else {
      if (!(s.windowMs > 0)) throw new RangeError(`window ${s.name}: windowMs must be > 0`);
      logs.push(new SlidingLog(s.name, s.windowMs, Math.floor(s.limit), Math.max(0, paddingMs)));
    }
  }
  const capacity = logs.length ? Math.min(...logs.map((l) => l.limit)) : Infinity;

  /** Units that must fit now for a request of `cost`. */
  const nowUnits = (cost) => Math.min(cost, capacity);

  function canTake(cost, now) {
    if (day && day.used(now) + cost > day.limit) return false;
    const n = nowUnits(cost);
    for (const l of logs) if (l.used(now) + n > l.limit) return false;
    return true;
  }

  function waitMs(cost, now) {
    if (day && day.used(now) + cost > day.limit) {
      if (cost > day.limit) return Infinity;
      return day.resetMs(now);
    }
    const n = nowUnits(cost);
    let wait = 0;
    for (const l of logs) {
      const live = l.used(now);
      const excess = live + n - l.limit;
      if (excess <= 0) continue;
      // The `excess`-th oldest live stamp has to leave the window.
      const stamp = l.stamps[l.head + excess - 1];
      wait = Math.max(wait, stamp + l.span - now);
    }
    return Math.max(0, wait);
  }

  function take(cost, now) {
    const stamps = [];
    let t = now;
    for (let i = 0; i < cost; i++) {
      for (const l of logs) {
        l.prune(now);
        t = Math.max(t, l.earliest(t));
      }
      for (const l of logs) l.push(t);
      stamps.push(t);
    }
    if (day) {
      day.roll(now);
      day.count += cost;
    }
    return stamps;
  }

  function windows(now) {
    const out = logs.map((l) => ({ window: l.name, used: l.used(now), limit: l.limit, resetMs: l.resetMs(now) }));
    if (day) out.push({ window: "day", used: day.used(now), limit: day.limit, resetMs: day.resetMs(now) });
    return out;
  }

  function headroom(now) {
    const ws = windows(now);
    if (!ws.length) return { remaining: Infinity, limit: Infinity, resetMs: 0, used: 0, window: "none" };
    let best = null;
    for (const w of ws) {
      const remaining = Math.max(0, w.limit - w.used);
      // Binding window = fewest remaining; ties go to the smaller fraction left, then the shorter window.
      if (!best || remaining < best.remaining || (remaining === best.remaining && remaining / w.limit < best.remaining / best.limit)) {
        best = { remaining, limit: w.limit, resetMs: w.resetMs, used: w.used, window: w.window };
      }
    }
    return best;
  }

  function unitsPerMs() {
    if (!logs.length) return Infinity;
    return Math.min(...logs.map((l) => l.limit / l.span));
  }

  function fill(now) {
    for (const l of logs) {
      l.prune(now);
      while (l.used(now) < l.limit) l.push(now);
    }
  }

  return Object.freeze({
    canTake,
    waitMs,
    take,
    headroom,
    windows,
    capacity: () => capacity,
    fitsDay: (cost) => !day || cost <= day.limit,
    unitsPerMs,
    fill,
    specs: Object.freeze(specs.map((s) => Object.freeze({ ...s }))),
  });
}
