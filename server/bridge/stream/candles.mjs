/**
 * Tick-to-candle aggregator for live chart bars (anything that draws charts).
 *
 * Bars are aligned to the IST trading session, the way Indian charts show them: NSE/BSE/NFO/BFO minute bars start at
 * 09:15, so 60m bars are 09:15, 10:15 ... 15:15 (the last one 15 minutes long); MCX and CDS start at 09:00. Daily bars
 * are stamped at IST midnight. Bar `time` is epoch SECONDS of the bar open, like Candle in core/contracts.mjs.
 *
 * Volume: broker feeds send the day's cumulative volume, so a bar's volume is the rise in that number during the bar
 * (the first tick after a restart adds nothing, because the earlier part is unknown). Daily bars take the cumulative
 * number itself. OI is the latest value.
 *
 * Ticks outside the session (pre-open, post-close) are ignored by default (`outsideSession: "drop"`); special sessions
 * such as Muhurat trading can be given per IST date. Late ticks for a bar that has already closed are ignored, so a
 * closed bar never changes. Memory is bounded: `maxBars` closed bars per series and `maxSeries` series (least recently
 * updated evicted first).
 */

export const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** Interval -> length in seconds ("1d" is one IST day). */
export const INTERVAL_SECONDS = Object.freeze({ "1m": 60, "3m": 180, "5m": 300, "10m": 600, "15m": 900, "30m": 1800, "60m": 3600, "1d": 86_400 });

/** Regular sessions per exchange, IST "HH:MM" (needs verification against each exchange's current circulars; MCX closes at 23:30 or 23:55 with US daylight saving). */
export const DEFAULT_SESSIONS = Object.freeze({
  NSE: { open: "09:15", close: "15:30" },
  BSE: { open: "09:15", close: "15:30" },
  NFO: { open: "09:15", close: "15:30" },
  BFO: { open: "09:15", close: "15:30" },
  CDS: { open: "09:00", close: "17:00" },
  MCX: { open: "09:00", close: "23:55" },
});

const minutesOf = (hhmm) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm));
  if (!m) throw new Error(`Not an HH:MM time: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/** IST midnight (epoch ms) of the IST day containing `ms`. */
export const istMidnight = (ms) => Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
const istDate = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

/** Tick time in epoch ms: exchange time when present (seconds are accepted), else when the Bridge received it. */
export function tickTimeMs(tick) {
  const ex = typeof tick.exchangeTs === "number" && tick.exchangeTs > 0 ? tick.exchangeTs : null;
  if (ex !== null) return ex < 1e12 ? ex * 1000 : ex;
  return tick.receivedAt;
}

/**
 * Session window (epoch ms) for an exchange on the IST day containing `ms`.
 * @param {number} ms @param {string} exchange
 * @param {{ sessions?: Record<string, { open: string, close: string }>, specialSessions?: Record<string, { open: string, close: string }> }} [opts]
 * @returns {{ open: number, close: number } | null}
 */
export function sessionWindow(ms, exchange, { sessions = DEFAULT_SESSIONS, specialSessions = {} } = {}) {
  const mid = istMidnight(ms);
  const s = specialSessions[istDate(ms)] ?? sessions[exchange];
  if (!s) return null;
  return { open: mid + minutesOf(s.open) * 60_000, close: mid + minutesOf(s.close) * 60_000 };
}

/**
 * Start (epoch seconds) of the bar that contains `ms`, or null when it falls outside the session and
 * outsideSession is "drop". With "clock", out-of-session times get plain clock-aligned buckets.
 * @param {number} ms @param {keyof typeof INTERVAL_SECONDS} interval @param {string} exchange
 * @param {{ sessions?: object, specialSessions?: object, outsideSession?: "drop"|"clock" }} [opts]
 */
export function bucketStart(ms, interval, exchange, opts = {}) {
  const step = INTERVAL_SECONDS[interval];
  if (!step) throw new Error(`Unknown interval ${interval}`);
  const win = sessionWindow(ms, exchange, opts);
  const inside = win && ms >= win.open && ms < win.close;
  if (!inside && (opts.outsideSession ?? "drop") === "drop") return null;
  if (interval === "1d") return istMidnight(ms) / 1000;
  const stepMs = step * 1000;
  if (inside) return (win.open + Math.floor((ms - win.open) / stepMs) * stepMs) / 1000;
  const mid = istMidnight(ms);
  return (mid + Math.floor((ms - mid) / stepMs) * stepMs) / 1000;
}

/** End (epoch ms, exclusive) of a bar: the next bucket, cut at the session close. */
function barEndMs(barTimeS, interval, exchange, opts) {
  const startMs = barTimeS * 1000;
  const win = sessionWindow(startMs + (interval === "1d" ? 12 * 3600_000 : 0), exchange, opts);
  if (interval === "1d") return win ? win.close : startMs + DAY_MS;
  const end = startMs + INTERVAL_SECONDS[interval] * 1000;
  return win && startMs >= win.open && startMs < win.close ? Math.min(end, win.close) : end;
}

/**
 * @typedef {import("../core/contracts.mjs").Candle} Candle
 * @typedef {{ symbol: string, interval: string, bar: Candle, closed: boolean }} BarEvent
 */

/**
 * @param {{ intervals?: string[], maxBars?: number, maxSeries?: number, sessions?: object, specialSessions?: object,
 *   outsideSession?: "drop"|"clock", onBar?: (e: BarEvent) => void }} [opts]
 */
export function createCandleAggregator({ intervals = ["1m"], maxBars = 500, maxSeries = 2000, sessions = DEFAULT_SESSIONS, specialSessions = {}, outsideSession = "drop", onBar } = {}) {
  for (const i of intervals) if (!INTERVAL_SECONDS[i]) throw new Error(`Unknown interval ${i}`);
  const opts = { sessions, specialSessions, outsideSession };
  /** @type {Map<string, { symbol: string, interval: string, exchange: string, bars: Candle[], current: Candle | null, cumVol: number | null, lastOi?: number }>} */
  const series = new Map();

  const keyOf = (symbol, interval) => `${symbol}|${interval}`;
  const touch = (k, s) => {
    series.delete(k);
    series.set(k, s);
    while (series.size > maxSeries) series.delete(series.keys().next().value);
  };
  const emit = (s, bar, closed) => {
    if (!onBar) return;
    try {
      onBar({ symbol: s.symbol, interval: s.interval, bar: { ...bar }, closed });
    } catch {
      /* a listener must not break aggregation */
    }
  };
  const closeCurrent = (s) => {
    if (!s.current) return;
    s.bars.push(s.current);
    if (s.bars.length > maxBars) s.bars.splice(0, s.bars.length - maxBars);
    emit(s, s.current, true);
    s.current = null;
  };

  /**
   * Add one tick. Returns the number of series it updated.
   * @param {import("../core/contracts.mjs").Tick} tick
   */
  function push(tick) {
    if (!tick || typeof tick.symbol !== "string" || !(tick.ltp > 0)) return 0;
    const exchange = tick.symbol.split(":")[0];
    const ms = tickTimeMs(tick);
    if (!Number.isFinite(ms)) return 0;
    let updated = 0;
    for (const interval of intervals) {
      const t = bucketStart(ms, interval, exchange, opts);
      if (t === null) continue;
      const k = keyOf(tick.symbol, interval);
      let s = series.get(k);
      if (!s) s = { symbol: tick.symbol, interval, exchange, bars: [], current: null, cumVol: null, lastOi: undefined };
      touch(k, s);
      if (s.current ? t < s.current.time : t <= (s.bars.at(-1)?.time ?? -Infinity)) continue; // late tick for a closed bar
      let delta = 0;
      const cum = typeof tick.volume === "number" && Number.isFinite(tick.volume) ? tick.volume : null;
      if (cum !== null) {
        if (s.cumVol !== null && cum >= s.cumVol) delta = cum - s.cumVol;
        s.cumVol = cum;
      }
      if (!s.current || t > s.current.time) {
        if (s.current) closeCurrent(s);
        s.current = { time: t, open: tick.ltp, high: tick.ltp, low: tick.ltp, close: tick.ltp, volume: interval === "1d" && cum !== null ? cum : delta };
      } else {
        const c = s.current;
        if (tick.ltp > c.high) c.high = tick.ltp;
        if (tick.ltp < c.low) c.low = tick.ltp;
        c.close = tick.ltp;
        c.volume = interval === "1d" && cum !== null ? cum : c.volume + delta;
      }
      if (typeof tick.oi === "number" && Number.isFinite(tick.oi)) s.lastOi = tick.oi;
      if (s.lastOi !== undefined) s.current.oi = s.lastOi; // OI carries over into a bar with no OI update
      emit(s, s.current, false);
      updated += 1;
    }
    return updated;
  }

  /**
   * Close every open bar whose end is at or before `nowMs` (call it on a timer so a quiet symbol's bar still closes).
   * @param {number} nowMs @returns {number} bars closed
   */
  function flush(nowMs) {
    let n = 0;
    for (const s of series.values()) {
      if (s.current && barEndMs(s.current.time, s.interval, s.exchange, opts) <= nowMs) {
        closeCurrent(s);
        n += 1;
      }
    }
    return n;
  }

  /**
   * Closed bars (oldest first) plus the forming bar.
   * @param {string} symbol @param {string} interval @param {{ includeCurrent?: boolean, limit?: number }} [o]
   * @returns {Candle[]}
   */
  function bars(symbol, interval, { includeCurrent = true, limit } = {}) {
    const s = series.get(keyOf(symbol, interval));
    if (!s) return [];
    const out = s.bars.map((b) => ({ ...b }));
    if (includeCurrent && s.current) out.push({ ...s.current });
    return limit ? out.slice(-limit) : out;
  }

  /** The forming bar, or null. */
  function current(symbol, interval) {
    const c = series.get(keyOf(symbol, interval))?.current;
    return c ? { ...c } : null;
  }

  /**
   * Prefill closed history (e.g. from MarketDataService.history) so live bars continue it. Candles must be ascending;
   * the last one is treated as the forming bar when it is still open at `nowMs`.
   * @param {string} symbol @param {string} interval @param {Candle[]} candles @param {number} [nowMs]
   */
  function seed(symbol, interval, candles, nowMs) {
    if (!INTERVAL_SECONDS[interval]) throw new Error(`Unknown interval ${interval}`);
    const k = keyOf(symbol, interval);
    const s = { symbol, interval, exchange: symbol.split(":")[0], bars: candles.slice(-maxBars).map((c) => ({ ...c })), current: null, cumVol: null };
    const last = s.bars.at(-1);
    if (last && nowMs !== undefined && barEndMs(last.time, interval, s.exchange, opts) > nowMs) s.current = s.bars.pop();
    touch(k, s);
  }

  /** Forget one symbol's series, or everything. */
  function clear(symbol) {
    if (symbol === undefined) series.clear();
    else for (const k of [...series.keys()]) if (k.startsWith(`${symbol}|`)) series.delete(k);
  }

  return { push, flush, bars, current, seed, clear, intervals: Object.freeze([...intervals]), stats: () => ({ series: series.size }) };
}

/**
 * An aggregator fed by the bus "tick" topic, with a timer that closes quiet bars. For S10's live chart bars:
 *   const live = createLiveCandles({ bus, clock, intervals: ["1m", "5m"] });
 *   live.bars("NSE:NIFTY", "1m");  ...  live.dispose();
 * @param {{ bus: { on: Function }, clock?: { now(): number }, flushEveryMs?: number } & Parameters<typeof createCandleAggregator>[0]} opts
 */
export function createLiveCandles({ bus, clock = { now: () => Date.now() }, flushEveryMs = 1000, ...rest }) {
  const agg = createCandleAggregator(rest);
  const off = bus.on("tick", (t) => agg.push(t));
  const timer = setInterval(() => agg.flush(clock.now()), flushEveryMs);
  timer.unref?.();
  return {
    ...agg,
    dispose() {
      off();
      clearInterval(timer);
    },
  };
}
