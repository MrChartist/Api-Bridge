/**
 * Per-account priority queue with ageing.
 *
 * Four FIFO lanes, one per priority: order > live > interactive > background. Iteration yields waiting items in
 * EFFECTIVE order at a given time:
 *
 *   score(item, now) = 0                                                    for "order" items (always first)
 *                    = max(1, rank(priority) - floor(waited / ageingMs))     for everything else
 *
 * then by enqueue time, then by insertion sequence. A waiting background item therefore climbs one level every
 * `ageingMs` until it is level with "live", where FIFO order means it eventually reaches the front: delayed under
 * load, never starved. Reads never climb above "live", so an order always jumps the queue.
 *
 * Within a lane older items always score at least as well as newer ones, so a 4-way merge of the lane heads gives
 * the exact order without sorting. Removal is O(1) (items are flagged and lanes compacted lazily).
 */
import { PRIORITIES } from "../core/contracts.mjs";

export const PRIORITY_RANK = Object.freeze(Object.fromEntries(PRIORITIES.map((p, i) => [p, i])));

/**
 * @template T
 * @typedef {{ priority: string, enqueuedAt: number, seq: number, queued: boolean, value: T }} QueueItem
 */

/**
 * @param {{ ageingMs?: number }} [opts]
 */
export function createPriorityQueue({ ageingMs = 2000 } = {}) {
  if (!(ageingMs > 0)) throw new RangeError("ageingMs must be > 0");
  /** @type {QueueItem<any>[][]} */
  const lanes = PRIORITIES.map(() => []);
  const heads = PRIORITIES.map(() => 0);
  const dead = PRIORITIES.map(() => 0);
  let size = 0;
  let seq = 0;
  /** Open iterators; lanes are only compacted when none is open (iterators hold indexes into the lane arrays). */
  let iterating = 0;

  const score = (item, now) => {
    const rank = PRIORITY_RANK[item.priority];
    if (rank === 0) return 0;
    return Math.max(1, rank - Math.floor(Math.max(0, now - item.enqueuedAt) / ageingMs));
  };

  const before = (a, b, now) => {
    const sa = score(a, now);
    const sb = score(b, now);
    if (sa !== sb) return sa < sb;
    if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt < b.enqueuedAt;
    return a.seq < b.seq;
  };

  function skipDead(lane) {
    const l = lanes[lane];
    while (heads[lane] < l.length && !l[heads[lane]].queued) {
      heads[lane] += 1;
      dead[lane] -= 1;
    }
    if (heads[lane] > 64 && heads[lane] * 2 > l.length) {
      lanes[lane] = l.slice(heads[lane]);
      heads[lane] = 0;
    }
  }

  function compact(lane) {
    if (dead[lane] < 64 || dead[lane] * 2 < lanes[lane].length - heads[lane]) return;
    lanes[lane] = lanes[lane].slice(heads[lane]).filter((it) => it.queued);
    heads[lane] = 0;
    dead[lane] = 0;
  }

  return {
    /**
     * Add an item. Unknown priorities are an error.
     * @template T
     * @param {T} value
     * @param {{ priority: string, now: number }} opts
     * @returns {QueueItem<T>}
     */
    push(value, { priority, now }) {
      const lane = PRIORITY_RANK[priority];
      if (lane === undefined) throw new RangeError(`Unknown priority "${priority}"`);
      const item = { priority, enqueuedAt: now, seq: seq++, queued: true, value };
      lanes[lane].push(item);
      size += 1;
      return item;
    },

    /** Remove an item (idempotent). Returns true if it was waiting. */
    remove(item) {
      if (!item?.queued) return false;
      item.queued = false;
      size -= 1;
      const lane = PRIORITY_RANK[item.priority];
      dead[lane] += 1;
      if (iterating === 0) {
        skipDead(lane);
        compact(lane);
      }
      return true;
    },

    /**
     * Waiting items in effective order at `now`. Safe to remove() the yielded item (or later ones) while iterating.
     * @param {number} now
     */
    *iterate(now) {
      iterating += 1;
      try {
        yield* walk(now);
      } finally {
        iterating -= 1;
        if (iterating === 0) {
          for (let lane = 0; lane < lanes.length; lane++) {
            skipDead(lane);
            compact(lane);
          }
        }
      }
    },

    /** The first item in effective order, or null. */
    peek(now) {
      for (const it of this.iterate(now)) return it;
      return null;
    },

    get size() {
      return size;
    },

    /** Waiting count per priority. */
    counts() {
      const out = {};
      PRIORITIES.forEach((p, lane) => {
        out[p] = lanes[lane].length - heads[lane] - dead[lane];
      });
      return out;
    },

    score,
  };

  /** 4-way merge of the lane heads (see the file comment). */
  function* walk(now) {
    const cursors = heads.slice();
    for (;;) {
      let best = -1;
      for (let lane = 0; lane < lanes.length; lane++) {
        const l = lanes[lane];
        while (cursors[lane] < l.length && !l[cursors[lane]].queued) cursors[lane] += 1;
        if (cursors[lane] >= l.length) continue;
        if (best === -1 || before(l[cursors[lane]], lanes[best][cursors[best]], now)) best = lane;
      }
      if (best === -1) return;
      const item = lanes[best][cursors[best]];
      cursors[best] += 1;
      yield item;
    }
  }
}
