/**
 * `bridge.historyAll`: candles over any length of time, as a stream of candles.
 *
 *   const candles = bridge.historyAll({ symbol: "NSE:RELIANCE", interval: "5m", from: "2024-01-01", to: "2024-12-31" });
 *   for await (const c of candles) { ... }       // fetched window by window, oldest first, no duplicates
 *   candles.freshness                            // the least current label of all windows (read it before using the data)
 *   await candles.toHistory();                   // { symbol, interval, candles, freshness, partial }
 *
 * One GET /v1/history call can cover only so much: the Bridge splits a long range across the broker's own limits, but it
 * stops after a fixed number of pieces and then says `partial`. This helper asks for windows that fit (`chunkDays`) and
 * halves a window the Bridge reports as partial until it fits or is one day long (a window that still comes back partial
 * is listed in `gaps`). Nothing is fetched until you iterate.
 *
 * `localFirst: true` (with `dataset: "name"` to read a particular dataset) lets the Bridge answer from the data it already
 * stored, realtime class and without gaps, and ask the broker only for what is missing: this saves API calls a live program
 * needs. `localWindows` and `brokerWindows` say how many windows came from where, and the freshness label stays honest
 * about bars from a delayed or end-of-day source.
 */
import { toCsv } from "./table.mjs";

export const DEFAULT_CHUNK_DAYS = Object.freeze({ intraday: 120, daily: 1500 });
const DAILY = new Set(["1d", "1w", "1M"]);
const IST_OFFSET_S = 19_800;
const CLASS_RANK = { realtime: 0, delayed: 1, eod: 2 };

/**
 * Epoch seconds from text, a Date or a number. Text without an offset is India time; a bare date means the start of that
 * day (or its last second, with `end`, so `to: "2024-12-31"` includes the whole day).
 * @param {string|number|Date|undefined} v
 * @param {{ end?: boolean, now?: number }} [o]
 */
export function toEpochSeconds(v, { end = false, now = Date.now() } = {}) {
  if (v === undefined || v === null) return Math.floor(now / 1000);
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  if (typeof v === "number") return Math.floor(Math.abs(v) > 1e11 ? v / 1000 : v);
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(`${s}T00:00:00+05:30`);
    if (Number.isNaN(t)) throw new TypeError(`not a date: ${JSON.stringify(v)}`);
    return Math.floor(t / 1000) + (end ? 86_399 : 0);
  }
  const t = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s}+05:30`);
  if (Number.isNaN(t)) throw new TypeError(`not a date or time: ${JSON.stringify(v)}`);
  return Math.floor(t / 1000);
}

/** `2026-11-09T09:15:00+05:30` for epoch seconds. */
export const istIso = (sec) => `${new Date((sec + IST_OFFSET_S) * 1000).toISOString().slice(0, 19)}+05:30`;

/** The least current of several freshness labels (delayed beats real-time, end-of-day beats delayed, stale beats fresh). */
export function leastCurrent(labels) {
  let best;
  const key = (f) => [CLASS_RANK[f.class ?? "realtime"] ?? 1, f.delaySec ?? 0, f.stale ? 1 : 0];
  for (const f of labels) {
    if (!best) best = f;
    else {
      const a = key(f);
      const b = key(best);
      if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) best = f;
    }
  }
  return best;
}

/**
 * @typedef {{ symbol: string, interval: string, from: string|number|Date, to?: string|number|Date, chunkDays?: number, localFirst?: boolean,
 *   dataset?: string, account?: string, backup?: boolean }} HistoryAllParams
 */
export class HistoryAll {
  /** @param {import("./client.mjs").BridgeClient} client  @param {HistoryAllParams} p */
  constructor(client, p) {
    this.client = client;
    this.symbol = p.symbol;
    this.interval = p.interval;
    const now = client._now?.() ?? Date.now();
    this.start = toEpochSeconds(p.from, { now });
    this.end = toEpochSeconds(p.to, { end: true, now });
    if (this.end < this.start) throw new TypeError("to is before from");
    this.chunkDays = p.chunkDays ?? DEFAULT_CHUNK_DAYS[DAILY.has(p.interval) ? "daily" : "intraday"];
    if (!(this.chunkDays >= 1)) throw new TypeError("chunkDays must be at least 1");
    this.localFirst = p.localFirst === true;
    this.dataset = p.dataset;
    this.account = p.account;
    this.backup = p.backup;
    this.calls = 0;
    this.localWindows = 0;
    this.brokerWindows = 0;
    /** @type {Record<string, number>} */
    this.sources = {};
    /** @type {Array<[number, number]>} windows (epoch seconds) that stayed partial even at one day */
    this.gaps = [];
    this.partial = false;
    this.count = 0;
    this._labels = [];
    this._cache = null;
  }

  async _fetch(a, b) {
    this.calls += 1;
    const r = await this.client.history({ symbol: this.symbol, interval: this.interval, from: a, to: b, account: this.account, localFirst: this.localFirst ? true : undefined, dataset: this.dataset, backup: this.backup });
    const data = r.data ?? {};
    const src = r.meta?.source ?? data.freshness?.source ?? "unknown";
    this.sources[src] = (this.sources[src] ?? 0) + 1;
    if (src === "local") this.localWindows += 1;
    else this.brokerWindows += 1;
    if (data.freshness) this._labels.push(data.freshness);
    return { candles: [...(data.candles ?? [])].sort((x, y) => x.time - y.time), partial: Boolean(data.partial) };
  }

  async *_walk() {
    const step = Math.floor(this.chunkDays * 86_400);
    const stack = [];
    let cursor = this.start;
    let last = null;
    while (cursor <= this.end || stack.length) {
      let a;
      let b;
      if (stack.length) [a, b] = stack.pop();
      else {
        a = cursor;
        b = Math.min(cursor + step - 1, this.end);
        cursor = b + 1;
      }
      const { candles, partial } = await this._fetch(a, b);
      if (partial) {
        const span = b - a;
        if (span > 86_401) {
          const mid = a + Math.floor(span / 2);
          stack.push([mid + 1, b]); // the later half goes in first so the earlier one is fetched next (oldest first)
          stack.push([a, mid]);
          continue;
        }
        this.partial = true;
        this.gaps.push([a, b]);
      }
      for (const c of candles) {
        if (last !== null && c.time <= last) continue;
        last = c.time;
        this.count += 1;
        yield c;
      }
    }
  }

  [Symbol.asyncIterator]() {
    if (this._cache) return (async function* (cache) { yield* cache; })(this._cache);
    return this._walk();
  }

  /** The least current label among the windows fetched so far (undefined before the first one). */
  get freshness() {
    return leastCurrent(this._labels);
  }

  /** Fetch everything (if not yet) and return one history: { symbol, interval, candles, freshness, partial, windows, sources, gaps }. */
  async toHistory() {
    if (!this._cache) {
      const out = [];
      for await (const c of this._walk()) out.push(c);
      this._cache = out;
    }
    return {
      symbol: this.symbol,
      interval: this.interval,
      candles: [...this._cache],
      freshness: this.freshness ?? { source: "unknown", class: "delayed", official: false, confidence: "low" },
      partial: this.partial,
      windows: this.calls,
      sources: { ...this.sources },
      gaps: this.gaps.map(([a, b]) => [istIso(a), istIso(b)]),
    };
  }

  async toArray() {
    return (await this.toHistory()).candles;
  }

  /** One object per candle with `time` as IST ISO text and the freshness columns (source, class, delaySec, official, confidence). */
  async records({ freshness = true } = {}) {
    const h = await this.toHistory();
    const f = h.freshness;
    return h.candles.map((c) => ({
      time: istIso(c.time), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, ...(c.oi !== undefined ? { oi: c.oi } : {}),
      ...(freshness ? { source: f.source, class: f.class ?? "realtime", delaySec: f.delaySec ?? 0, official: f.official ?? true, confidence: f.confidence ?? "high" } : {}),
    }));
  }

  /** CSV text (with the freshness columns unless `freshness: false`); written to `file` when given. */
  async toCsv({ file, freshness = true } = {}) {
    const rows = await this.records({ freshness });
    const hasOi = rows.some((r) => r.oi !== undefined);
    const cols = ["time", "open", "high", "low", "close", "volume", ...(hasOi ? ["oi"] : []), ...(freshness ? ["source", "class", "delaySec", "official", "confidence"] : [])];
    const text = toCsv(rows, cols);
    if (file) await (await import("node:fs")).promises.writeFile(file, text);
    return text;
  }

  /** Throws unless every window was real-time (call after iterating or toHistory()). */
  requireRealtime() {
    const f = this.freshness;
    if (f && (f.class ?? "realtime") !== "realtime") throw new Error(`The history of ${this.symbol} is ${f.class} data (${f.provider ?? f.source}, delay about ${f.delaySec ?? 0} s), not real-time: do not use it for orders, risk, paper fills or alerts.`);
    return this;
  }
}
