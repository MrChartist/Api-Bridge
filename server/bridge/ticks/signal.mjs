/**
 * Signal code, written once. A signal is a factory of an incremental function `onTick(tick, ctx) -> value | undefined`.
 * The historical run and the live run both call the SAME function, tick by tick, in the same order: there is no second,
 * vectorised version to keep in step. That is what makes "historical equals live" checkable (compare.mjs).
 *
 *   export default defineSignal({
 *     name: "nifty-vs-bank",
 *     symbols: ["NSE:NIFTY", "NSE:BANKNIFTY"],
 *     create() {
 *       const last = asof({ toleranceMs: 2000 });
 *       const flow = windowSum({ spanMs: 60_000 });
 *       return (tick, { time }) => {
 *         last.set(tick.symbol, time, tick.ltp);
 *         if (tick.symbol !== "NSE:NIFTY") return undefined;
 *         const bank = last.get("NSE:BANKNIFTY", time);
 *         if (bank === null) return undefined;
 *         flow.push(time, tick.ltp / bank);
 *         return flow.mean(time);
 *       };
 *     },
 *   });
 *
 * Rules that keep a signal deterministic (the comparison finds any break of them):
 *  - Use `ctx.time` (the tick's event time) for anything time-based. Never Date.now(), timers or Math.random().
 *  - Keep all state inside create(): every run gets a fresh copy.
 *  - Return plain data (numbers, strings, booleans, null, arrays and objects of those).
 */

/**
 * @template V
 * @param {{ name: string, symbols: string[], create: () => (tick: object, ctx: { time: number, n: number }) => V | undefined,
 *   time?: "receivedAt" | "exchangeTs" }} def
 *   time: which tick time drives the signal. "receivedAt" (default) is when the Bridge got the tick, recorded and replayed
 *   exactly. "exchangeTs" is the exchange's time; ticks without it are skipped.
 */
export function defineSignal(def) {
  if (!def || typeof def.name !== "string" || !def.name) throw new Error("a signal needs a name");
  if (!Array.isArray(def.symbols) || !def.symbols.length) throw new Error("a signal needs the symbols it reads");
  if (typeof def.create !== "function") throw new Error("a signal needs create()");
  const time = def.time ?? "receivedAt";
  if (time !== "receivedAt" && time !== "exchangeTs") throw new Error('time must be "receivedAt" or "exchangeTs"');
  return Object.freeze({ name: def.name, symbols: Object.freeze([...def.symbols]), create: def.create, time });
}

// ───────────────────────── exact running sums ─────────────────────────

/**
 * Neumaier-compensated running sum: adding and later removing the same values returns to (almost exactly) zero, so a
 * sliding window does not drift over a long session the way a plain `sum += x; sum -= old` does.
 */
export function compensatedSum() {
  let sum = 0;
  let c = 0;
  const add = (x) => {
    const t = sum + x;
    if (Math.abs(sum) >= Math.abs(x)) c += sum - t + x;
    else c += x - t + sum;
    sum = t;
  };
  return {
    add,
    sub: (x) => add(-x),
    value: () => sum + c,
    reset() {
      sum = 0;
      c = 0;
    },
  };
}

/**
 * Sum, count and mean over the last `spanMs` of event time: the window is (time - spanMs, time]. Values are evicted as
 * time moves on, by push() or by reading with a later time.
 * @param {{ spanMs: number }} opts
 */
export function windowSum({ spanMs }) {
  if (!(spanMs > 0)) throw new Error("windowSum needs spanMs > 0");
  const ts = [];
  const xs = [];
  let head = 0;
  const s = compensatedSum();
  const s2 = compensatedSum();
  const evict = (time) => {
    const edge = time - spanMs;
    while (head < ts.length && ts[head] <= edge) {
      s.sub(xs[head]);
      s2.sub(xs[head] * xs[head]);
      head += 1;
    }
    if (head > 1024 && head * 2 > ts.length) {
      ts.splice(0, head);
      xs.splice(0, head);
      head = 0;
    }
    if (head === ts.length) {
      s.reset(); // empty: drop any rounding left over
      s2.reset();
    }
  };
  return {
    /** Add a value at `time` (times must not go backwards). */
    push(time, x) {
      if (!Number.isFinite(x)) return;
      evict(time);
      ts.push(time);
      xs.push(x);
      s.add(x);
      s2.add(x * x);
    },
    sum(time) {
      if (time !== undefined) evict(time);
      return s.value();
    },
    count(time) {
      if (time !== undefined) evict(time);
      return ts.length - head;
    },
    /** Mean, or null when the window is empty. */
    mean(time) {
      const n = this.count(time);
      return n ? s.value() / n : null;
    },
    /** Population variance, or null when the window is empty. */
    variance(time) {
      const n = this.count(time);
      if (!n) return null;
      const m = s.value() / n;
      return Math.max(0, s2.value() / n - m * m);
    },
  };
}

/**
 * Highest and lowest value over the last `spanMs` (monotonic queues: each value enters and leaves each queue once).
 * @param {{ spanMs: number }} opts
 */
export function windowExtremes({ spanMs }) {
  if (!(spanMs > 0)) throw new Error("windowExtremes needs spanMs > 0");
  const hi = [];
  const lo = [];
  const evict = (q, edge) => {
    while (q.length && q[0][0] <= edge) q.shift();
  };
  return {
    push(time, x) {
      if (!Number.isFinite(x)) return;
      while (hi.length && hi.at(-1)[1] <= x) hi.pop();
      while (lo.length && lo.at(-1)[1] >= x) lo.pop();
      hi.push([time, x]);
      lo.push([time, x]);
      evict(hi, time - spanMs);
      evict(lo, time - spanMs);
    },
    max(time) {
      evict(hi, time - spanMs);
      return hi.length ? hi[0][1] : null;
    },
    min(time) {
      evict(lo, time - spanMs);
      return lo.length ? lo[0][1] : null;
    },
  };
}

/**
 * Exponential moving average in event time: a value `halfLifeMs` old weighs half as much as a new one, however
 * irregular the ticks are.
 * @param {{ halfLifeMs: number }} opts
 */
export function ema({ halfLifeMs }) {
  if (!(halfLifeMs > 0)) throw new Error("ema needs halfLifeMs > 0");
  let value = null;
  let last = null;
  return {
    push(time, x) {
      if (!Number.isFinite(x)) return value;
      if (value === null) value = x;
      else {
        const dt = Math.max(0, time - last);
        const a = 1 - 2 ** (-dt / halfLifeMs);
        value += a * (x - value);
      }
      last = time;
      return value;
    },
    value: () => value,
  };
}

// ───────────────────────── as-of join ─────────────────────────

/**
 * As-of join: the latest value of each key AT OR BEFORE a time, if not older than `toleranceMs`. Because ticks are
 * processed in replay order, "latest seen" is exactly "latest at or before"; ticks with the same time are ordered by
 * seq, so ties resolve the same way live and in history.
 * @param {{ toleranceMs?: number }} [opts]
 */
export function asof({ toleranceMs = Infinity } = {}) {
  const last = new Map();
  return {
    set(key, time, value) {
      last.set(key, { time, value });
    },
    /** The value, or null when there is none at or before `time` within the tolerance. */
    get(key, time) {
      const e = last.get(key);
      if (!e || e.time > time || time - e.time > toleranceMs) return null;
      return e.value;
    },
    /** { time, value } of the last entry, whatever its age. */
    entry: (key) => last.get(key) ?? null,
  };
}

/**
 * Turns a cumulative counter (day volume, open interest) into the change since the last tick, per key. Returns null on
 * the first value and when the counter went down (a new day, a reset): never a made-up negative volume.
 */
export function deltaOf() {
  const prev = new Map();
  return (key, x) => {
    if (!Number.isFinite(x)) return null;
    const p = prev.get(key);
    prev.set(key, x);
    if (p === undefined || x < p) return null;
    return x - p;
  };
}

// ───────────────────────── tick features ─────────────────────────

const fin = (v) => typeof v === "number" && Number.isFinite(v);

/** (bid + ask) / 2, or null without a sane two-sided quote. */
export const mid = (t) => (fin(t.bid) && fin(t.ask) && t.bid > 0 && t.ask >= t.bid ? (t.bid + t.ask) / 2 : null);
/** ask - bid, or null. */
export const spread = (t) => (fin(t.bid) && fin(t.ask) && t.bid > 0 && t.ask >= t.bid ? t.ask - t.bid : null);
/** Size-weighted mid: leans towards the side with less quantity waiting. Null without both sizes. */
export const microprice = (t) => {
  const m = mid(t);
  if (m === null || !fin(t.bidQty) || !fin(t.askQty) || t.bidQty + t.askQty <= 0) return null;
  return (t.bid * t.askQty + t.ask * t.bidQty) / (t.bidQty + t.askQty);
};
/** (bidQty - askQty) / (bidQty + askQty), from -1 to 1, or null. */
export const imbalance = (t) => (fin(t.bidQty) && fin(t.askQty) && t.bidQty + t.askQty > 0 ? (t.bidQty - t.askQty) / (t.bidQty + t.askQty) : null);
/** ln(b / a), or null unless both are positive. */
export const logReturn = (a, b) => (fin(a) && fin(b) && a > 0 && b > 0 ? Math.log(b / a) : null);
