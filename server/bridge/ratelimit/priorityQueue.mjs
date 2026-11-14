/**
 * Per-account priority queue with ageing and start-time fair queueing (SFQ) inside each lane.
 *
 * Four lanes, one per priority: order > live > interactive > background. Iteration yields waiting items in
 * EFFECTIVE order at a given time:
 *
 *   score(item, now) = 0                                                    for "order" items (always first)
 *                    = max(1, rank(priority) - floor(waited / ageingMs))     for everything else
 *
 * Between lanes the lane FAIR HEADS are merged by score, then enqueue time, then insertion sequence. A waiting
 * background item therefore climbs one level every `ageingMs` until it is level with "live": delayed under load,
 * never starved. Reads never climb above "live", so an order always jumps the queue. Ageing is applied to the
 * lane's fair head: an aged item deeper in its lane is promoted when it reaches the head.
 *
 * Inside a lane, items of different CONSUMERS (an API key, or whatever the caller passes) are ordered by virtual
 * start tags instead of arrival time (start-time fair queueing, Goyal, Vin and Cheng):
 *
 *   S = max(V, F[consumer]);  F[consumer] = S + cost / weight;  item.tag = S
 *
 * where V is the lane's virtual time (the largest start tag served so far). A consumer that floods the lane builds
 * up a long run of rising tags; a light consumer arriving later has S = V and runs next, whatever the flood's
 * backlog. Consumers share the lane in proportion to their weights, but only when they compete: an idle
 * consumer's share is used by the others. With one consumer the order is plain FIFO, exactly as before.
 *
 * State is bounded: a consumer with nothing queued whose finish tag is behind V is forgotten, and an empty lane
 * resets V and F. Removal is O(1) (items are flagged and the per-consumer lists compacted lazily). Removing an item
 * WITHOUT serving it (abort, deadline) refunds its cost when it is the consumer's newest item.
 */
import { PRIORITIES } from "../core/contracts.mjs";

export const PRIORITY_RANK = Object.freeze(Object.fromEntries(PRIORITIES.map((p, i) => [p, i])));

/** The consumer key used when a caller does not name one (one shared FIFO). */
export const DEFAULT_CONSUMER = "";

/** Fair-queue state kept per lane is dropped beyond this many idle consumers (a safety net, never reached normally). */
const MAX_IDLE_CONSUMERS = 4096;

/**
 * @template T
 * @typedef {{ priority: string, enqueuedAt: number, seq: number, queued: boolean, value: T, consumer: string,
 *   weight: number, cost: number, tag: number }} QueueItem
 */

/** Minimal binary min-heap over cursors { q, idx }, ordered by the (tag, seq) of the item each points at. */
function heapPush(h, c) {
  h.push(c);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!cursorBefore(h[i], h[p])) break;
    [h[i], h[p]] = [h[p], h[i]];
    i = p;
  }
}

function heapPop(h) {
  const top = h[0];
  const last = h.pop();
  if (h.length) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < h.length && cursorBefore(h[l], h[m])) m = l;
      if (r < h.length && cursorBefore(h[r], h[m])) m = r;
      if (m === i) break;
      [h[i], h[m]] = [h[m], h[i]];
      i = m;
    }
  }
  return top;
}

function cursorBefore(a, b) {
  const x = a.q.items[a.idx];
  const y = b.q.items[b.idx];
  return x.tag !== y.tag ? x.tag < y.tag : x.seq < y.seq;
}

/**
 * @param {{ ageingMs?: number }} [opts]
 */
export function createPriorityQueue({ ageingMs = 2000 } = {}) {
  if (!(ageingMs > 0)) throw new RangeError("ageingMs must be > 0");
  /** @type {Array<{ V: number, F: Map<string, number>, cons: Map<string, { c: string, items: QueueItem<any>[], head: number, live: number }>, live: number }>} */
  const lanes = PRIORITIES.map(() => ({ V: 0, F: new Map(), cons: new Map(), live: 0 }));
  let size = 0;
  let seq = 0;
  /** Open iterators; per-consumer lists are only compacted when none is open (iterators hold indexes into them). */
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

  /** Drop dead items at the head of a consumer's list and compact when many are dead. */
  function tidy(q) {
    const items = q.items;
    while (q.head < items.length && !items[q.head].queued) q.head += 1;
    if (q.head > 64 && q.head * 2 > items.length) {
      q.items = items.slice(q.head);
      q.head = 0;
    } else if (items.length - q.head - q.live >= 64 && (items.length - q.head - q.live) * 2 >= items.length - q.head) {
      q.items = items.slice(q.head).filter((it) => it.queued);
      q.head = 0;
    }
  }

  /** Forget one consumer with nothing queued, or tidy its list. Only when nobody iterates. */
  function tidyConsumer(L, q) {
    if (q.live > 0) {
      tidy(q);
      return;
    }
    L.cons.delete(q.c);
    const f = L.F.get(q.c);
    if (f !== undefined && f <= L.V) L.F.delete(q.c);
  }

  /** An empty lane starts a new busy period; a lane with very many idle consumers drops their finish tags. */
  function resetIfIdle(L) {
    if (L.live === 0) {
      L.V = 0;
      L.F.clear();
    } else if (L.F.size > MAX_IDLE_CONSUMERS) {
      for (const c of L.F.keys()) if (!L.cons.has(c)) L.F.delete(c);
    }
  }

  function cleanup(lane) {
    const L = lanes[lane];
    for (const q of [...L.cons.values()]) tidyConsumer(L, q);
    resetIfIdle(L);
  }

  function* walk(now) {
    /** One heap of consumer cursors per lane (null for an empty lane). */
    const heaps = new Array(lanes.length);
    let nonEmpty = 0;
    for (let lane = 0; lane < lanes.length; lane++) {
      const L = lanes[lane];
      heaps[lane] = null;
      if (L.live === 0) continue;
      const h = [];
      for (const q of L.cons.values()) {
        if (q.live === 0) continue;
        const items = q.items;
        let i = q.head;
        while (i < items.length && !items[i].queued) i += 1;
        if (i < items.length) heapPush(h, { q, idx: i });
      }
      if (h.length) {
        heaps[lane] = h;
        nonEmpty += 1;
      }
    }
    while (nonEmpty > 0) {
      let best = -1;
      let bestItem = null;
      for (let lane = 0; lane < heaps.length; lane++) {
        const h = heaps[lane];
        if (h === null) continue;
        const it = h[0].q.items[h[0].idx];
        if (best === -1 || before(it, bestItem, now)) {
          best = lane;
          bestItem = it;
        }
      }
      const h = heaps[best];
      const cur = heapPop(h);
      if (bestItem.queued) yield bestItem;
      // Move to this consumer's next waiting item (it may have been removed in the meantime).
      const list = cur.q.items;
      let j = cur.idx + 1;
      while (j < list.length && !list[j].queued) j += 1;
      if (j < list.length) {
        cur.idx = j;
        heapPush(h, cur);
      } else if (h.length === 0) {
        heaps[best] = null;
        nonEmpty -= 1;
      }
    }
  }

  return {
    /**
     * Add an item. Unknown priorities are an error.
     * @template T
     * @param {T} value
     * @param {{ priority: string, now: number, consumer?: string, weight?: number, cost?: number, group?: string | null }} opts
     *   consumer: the fairness key (default: one shared consumer). weight > 0 (default 1). cost > 0 (default 1).
     *   group: a label the caller wants waiting units totalled by (aheadUnits); the scheduler passes the endpoint class.
     * @returns {QueueItem<T>}
     */
    push(value, { priority, now, consumer = DEFAULT_CONSUMER, weight = 1, cost = 1, group = null }) {
      const laneIx = PRIORITY_RANK[priority];
      if (laneIx === undefined) throw new RangeError(`Unknown priority "${priority}"`);
      const w = weight > 0 && Number.isFinite(weight) ? weight : 1;
      const c = cost > 0 && Number.isFinite(cost) ? cost : 1;
      const L = lanes[laneIx];
      const start = Math.max(L.V, L.F.get(consumer) ?? 0);
      L.F.set(consumer, start + c / w);
      const item = { priority, enqueuedAt: now, seq: seq++, queued: true, value, consumer, weight: w, cost: c, group, tag: start };
      let q = L.cons.get(consumer);
      if (!q) {
        q = { c: consumer, items: [], head: 0, live: 0, units: new Map() };
        L.cons.set(consumer, q);
      }
      q.items.push(item);
      if (group !== null) q.units.set(group, (q.units.get(group) ?? 0) + c);
      q.live += 1;
      L.live += 1;
      size += 1;
      return item;
    },

    /**
     * Remove an item (idempotent). Returns true if it was waiting. `served: true` marks it as taken for service:
     * the lane's virtual time moves to its start tag. Without it (abort, deadline) the cost is refunded when the
     * item was its consumer's newest.
     * @param {QueueItem<any>} item
     * @param {{ served?: boolean }} [opts]
     */
    remove(item, { served = false } = {}) {
      if (!item?.queued) return false;
      const laneIx = PRIORITY_RANK[item.priority];
      const L = lanes[laneIx];
      const q = L.cons.get(item.consumer);
      if (served) L.V = Math.max(L.V, item.tag);
      else if (q) {
        let i = q.items.length - 1;
        while (i >= q.head && !q.items[i].queued) i -= 1;
        if (q.items[i] === item) L.F.set(item.consumer, Math.max(L.V, item.tag));
      }
      item.queued = false;
      size -= 1;
      L.live -= 1;
      if (q) {
        q.live -= 1;
        if (item.group !== null) q.units.set(item.group, (q.units.get(item.group) ?? 0) - item.cost);
      }
      if (iterating === 0) {
        if (q) tidyConsumer(L, q);
        resetIfIdle(L);
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
        if (iterating === 0) for (let lane = 0; lane < lanes.length; lane++) cleanup(lane);
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
        out[p] = lanes[lane].live;
      });
      return out;
    },

    /**
     * The waiting units a NEW item of `consumer` would sit behind in its own lane, totalled by group: the consumer's own
     * waiting items and, for every other consumer, the items whose start tag is at or below the tag the new item would
     * get. Another consumer's backlog beyond that point is not counted. Items in higher lanes are not included.
     * Calls add(group, units) per group and consumer. A consumer whose newest tag is covered is added from its running
     * totals (O(1)); only a consumer that straddles the new tag is walked.
     * @param {string} priority
     * @param {string} consumer
     * @param {(group: string, units: number) => void} add
     */
    aheadUnits(priority, consumer, add) {
      const L = lanes[PRIORITY_RANK[priority]];
      const start = Math.max(L.V, L.F.get(consumer) ?? 0);
      for (const q of L.cons.values()) {
        if (q.live === 0) continue;
        const items = q.items;
        if (items[items.length - 1].tag <= start) {
          for (const [g, u] of q.units) if (u > 0) add(g, u);
          continue;
        }
        for (let i = q.head; i < items.length; i++) {
          const it = items[i];
          if (it.tag > start) break;
          if (it.queued && it.group !== null) add(it.group, it.cost);
        }
      }
    },

    /** The start tag a new item of `consumer` would get in a lane right now (where it would stand in line). */
    startTag(priority, consumer) {
      const L = lanes[PRIORITY_RANK[priority]];
      return Math.max(L.V, L.F.get(consumer) ?? 0);
    },

    /** Waiting items of one consumer across lanes. */
    queuedOf(consumer) {
      let n = 0;
      for (const L of lanes) n += L.cons.get(consumer)?.live ?? 0;
      return n;
    },

    /**
     * The newest waiting item of `consumer` in the lowest priority lane it has items in, never an order; null when
     * none. This is what the scheduler drops to make room when a queue that is full is dominated by that consumer.
     */
    newestOf(consumer) {
      for (let laneIx = lanes.length - 1; laneIx >= 1; laneIx--) {
        const q = lanes[laneIx].cons.get(consumer);
        if (!q || q.live === 0) continue;
        for (let i = q.items.length - 1; i >= q.head; i--) if (q.items[i].queued) return q.items[i];
      }
      return null;
    },

    /** Distinct consumers with waiting items in any lane, with their counts (diagnostics and tests). */
    consumers() {
      /** @type {Map<string, number>} */
      const out = new Map();
      for (const L of lanes) for (const [c, q] of L.cons) if (q.live > 0) out.set(c, (out.get(c) ?? 0) + q.live);
      return out;
    },

    score,
  };
}
