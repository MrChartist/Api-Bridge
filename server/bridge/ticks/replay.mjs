/**
 * Replay: plays stored ticks back as if they were a broker's live feed, so the live path (StreamHub, the WebSocket and
 * SSE endpoints, runLive) runs unchanged on yesterday's market. It plugs in where every broker does: an adapter with
 * createFeed(creds, { onTick, onStatus }) (server/brokers/contract.mjs). The hub needs no replay mode.
 *
 *   const clock = createReplayClock();
 *   const replay = createReplayAdapter({ store, range, clock, refFor: (s) => symbols.resolve(s).refs.replay });
 *   // build the StreamHub with deps.clock = clock and an account whose adapter is replay.adapter, then:
 *   const live = await runLive(signal, hub);
 *   await replay.start();            // every stored tick, in replay order, through the hub
 *   compareRuns(historical.outputs, live.outputs)   // identical
 *
 * Time: the hub stamps `receivedAt` with deps.clock.now(). The replay clock is set to each tick's recorded receivedAt
 * just before the tick is handed over, so the live run sees the same event times the historical run reads from the
 * store. Do not share a replay clock with a Bridge that also trades: it is for a simulation process.
 *
 * Pace: `speed: Infinity` (default) plays as fast as the consumers keep up, yielding to the event loop every
 * `yieldEvery` ticks so sockets drain. A finite speed waits (gap between ticks) / speed of real time: 1 is real time.
 */
import { assertTickStore } from "./store.mjs";

/** A clock the replay moves. Same shape as deps.clock ({ now() }). */
export function createReplayClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    set(ms) {
      t = ms;
    },
  };
}

/** Default instrument ref for a canonical symbol: exchange from the prefix, the symbol itself as token. */
export const canonicalRef = (symbol) => ({ exchange: String(symbol).split(":")[0], token: String(symbol) });

const QUOTE_FIELDS = ["ltp", "bid", "ask", "bidQty", "askQty", "volume", "oi", "open", "high", "low", "close", "exchangeTs"];

/**
 * @param {{ store: import("./store.mjs").TickStore, range: { fromMs: number, toMs: number, symbols?: string[] },
 *   clock: { set(ms: number): void }, refFor?: (symbol: string) => { exchange: string, token: string } | null,
 *   speed?: number, yieldEvery?: number, sleep?: (ms: number) => Promise<void> }} opts
 */
export function createReplayAdapter({ store, range, clock, refFor = canonicalRef, speed = Infinity, yieldEvery = 256, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  assertTickStore(store);
  if (!clock || typeof clock.set !== "function") throw new Error("a replay needs a replay clock (createReplayClock)");
  if (!(speed > 0)) throw new Error("speed must be > 0");
  /** @type {Set<object>} open feeds */
  const feeds = new Set();
  const stats = { read: 0, delivered: 0, notSubscribed: 0, noRef: 0, running: false, done: false };
  const refs = new Map();
  const refOf = (symbol) => {
    if (!refs.has(symbol)) refs.set(symbol, refFor(symbol) ?? null);
    return refs.get(symbol);
  };
  const tick = () => new Promise((r) => setImmediate(r));

  const adapter = {
    createFeed(_creds, { onTick, onStatus } = {}) {
      const subs = new Set();
      const feed = {
        subs,
        onTick,
        subscribe(list) {
          for (const r of list ?? []) subs.add(`${r.exchange}:${r.token}`);
        },
        unsubscribe(list) {
          for (const r of list ?? []) subs.delete(`${r.exchange}:${r.token}`);
        },
        close() {
          if (!feeds.delete(feed)) return;
          onStatus?.({ connected: false, reason: "closed" });
        },
      };
      feeds.add(feed);
      queueMicrotask(() => {
        if (feeds.has(feed)) onStatus?.({ connected: true });
      });
      return feed;
    },
  };

  /**
   * Play the range once. Resolves with the counters when every tick was handed over (call it after the consumers
   * have subscribed: a feed sends only what is subscribed, as a broker does).
   */
  async function start() {
    if (stats.running) throw new Error("this replay is already running");
    stats.running = true;
    let prevAt = null;
    try {
      for await (const t of store.read({ symbols: range.symbols, fromMs: range.fromMs, toMs: range.toMs })) {
        stats.read += 1;
        const ref = refOf(t.symbol);
        if (!ref) {
          stats.noRef += 1;
          continue;
        }
        if (Number.isFinite(speed) && prevAt !== null && t.receivedAt > prevAt) await sleep((t.receivedAt - prevAt) / speed);
        prevAt = t.receivedAt;
        const key = `${ref.exchange}:${ref.token}`;
        const q = { token: ref.token, exchange: ref.exchange };
        for (const f of QUOTE_FIELDS) q[f] = t[f];
        let sent = false;
        for (const feed of feeds) {
          if (!feed.subs.has(key)) continue;
          clock.set(t.receivedAt); // the hub reads the clock while it handles this tick
          feed.onTick?.({ ...q });
          sent = true;
        }
        if (sent) stats.delivered += 1;
        else stats.notSubscribed += 1;
        if (!Number.isFinite(speed) && stats.read % yieldEvery === 0) await tick();
      }
      await tick();
      stats.done = true;
      return { ...stats };
    } finally {
      stats.running = false;
    }
  }

  return { adapter, start, stats: () => ({ ...stats }) };
}
