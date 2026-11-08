/**
 * Start-time fair queueing inside a lane (priorityQueue.mjs): examples, and property-style tests with seeded random
 * operations (no starvation, proportional shares, conservation of work, consistent bookkeeping).
 */
import { describe, expect, it } from "vitest";
import { createPriorityQueue } from "./priorityQueue.mjs";

/** Seeded PRNG (mulberry32) so the property tests are reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRIORITIES = ["order", "live", "interactive", "background"];
const order = (q, now = 0) => [...q.iterate(now)];

describe("start-time fair queueing inside a lane", () => {
  it("serves a late, light consumer next, whatever the flood has queued", () => {
    const q = createPriorityQueue({ ageingMs: 1e9 });
    for (let i = 0; i < 100; i++) q.push(`f${i}`, { priority: "interactive", now: i, consumer: "flood" });
    q.push("light", { priority: "interactive", now: 200, consumer: "light" });
    const names = order(q, 200).map((i) => i.value);
    expect(names.slice(0, 3)).toEqual(["f0", "light", "f1"]);
    // the flood's own order is untouched
    expect(names.filter((n) => n.startsWith("f"))).toEqual(Array.from({ length: 100 }, (_, i) => `f${i}`));
  });

  it("is plain FIFO for one consumer and for callers that name none", () => {
    const q = createPriorityQueue({ ageingMs: 1e9 });
    for (let i = 0; i < 20; i++) q.push(i, { priority: "interactive", now: i });
    expect(order(q).map((i) => i.value)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it("shares a lane by weight, and only between consumers that compete", () => {
    const q = createPriorityQueue({ ageingMs: 1e9 });
    for (let i = 0; i < 40; i++) {
      q.push(`a${i}`, { priority: "interactive", now: i, consumer: "a", weight: 3 });
      q.push(`b${i}`, { priority: "interactive", now: i, consumer: "b", weight: 1 });
    }
    const first = order(q).slice(0, 40).map((i) => i.value[0]);
    expect(first.filter((x) => x === "a").length).toBeGreaterThanOrEqual(29);
    expect(first.filter((x) => x === "a").length).toBeLessThanOrEqual(31);
  });

  it("charges cost: a request that costs more pushes its consumer's next one back", () => {
    const q = createPriorityQueue({ ageingMs: 1e9 });
    q.push("big", { priority: "interactive", now: 0, consumer: "a", cost: 4 });
    q.push("a2", { priority: "interactive", now: 1, consumer: "a", cost: 1 });
    q.push("b1", { priority: "interactive", now: 2, consumer: "b", cost: 1 });
    q.push("b2", { priority: "interactive", now: 3, consumer: "b", cost: 1 });
    q.push("b3", { priority: "interactive", now: 4, consumer: "b", cost: 1 });
    expect(order(q).map((i) => i.value)).toEqual(["big", "b1", "b2", "b3", "a2"]);
  });

  it("keeps strict priority between lanes: an order or live request beats any amount of fair share", () => {
    const q = createPriorityQueue({ ageingMs: 1e9 });
    for (let i = 0; i < 10; i++) q.push(`i${i}`, { priority: "interactive", now: i, consumer: "heavy", weight: 16 });
    q.push("live", { priority: "live", now: 50, consumer: "tiny", weight: 1 });
    q.push("order", { priority: "order", now: 60, consumer: "tiny", weight: 1 });
    expect(order(q, 60).slice(0, 2).map((i) => i.value)).toEqual(["order", "live"]);
  });

  it("moves virtual time on service, so a newcomer starts level with the work in progress", () => {
    const q = createPriorityQueue({ ageingMs: 1e9 });
    const items = Array.from({ length: 10 }, (_, i) => q.push(i, { priority: "interactive", now: i, consumer: "a" }));
    for (let i = 0; i < 6; i++) q.remove(items[i], { served: true });
    const late = q.push("late", { priority: "interactive", now: 100, consumer: "b" });
    expect(late.tag).toBe(5); // the start tag of the last item served
    expect(order(q, 100)[0].value).toBe("late");
  });

  it("refunds the cost of a newest request that leaves without being served", () => {
    const q = createPriorityQueue({ ageingMs: 1e9 });
    q.push("a0", { priority: "interactive", now: 0, consumer: "a" });
    const aborted = q.push("a1", { priority: "interactive", now: 1, consumer: "a" });
    expect(q.remove(aborted)).toBe(true);
    expect(q.push("a1-again", { priority: "interactive", now: 2, consumer: "a" }).tag).toBe(aborted.tag);
    expect(q.remove(aborted)).toBe(false);
  });

  it("forgets consumers that have nothing waiting, and starts a fresh busy period when a lane empties", () => {
    const q = createPriorityQueue();
    const a = q.push(1, { priority: "background", now: 0, consumer: "a" });
    const b = q.push(2, { priority: "background", now: 0, consumer: "b" });
    expect([...q.consumers()]).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
    q.remove(a, { served: true });
    q.remove(b, { served: true });
    expect([...q.consumers()]).toEqual([]);
    expect(q.push(3, { priority: "background", now: 1, consumer: "a" }).tag).toBe(0);
  });

  it("counts the work ahead of a new request: its consumer's backlog and the tags at or below its start tag, not other backlogs", () => {
    const q = createPriorityQueue({ ageingMs: 1e9 });
    for (let i = 0; i < 50; i++) q.push(i, { priority: "interactive", now: i, consumer: "flood" });
    for (let i = 0; i < 3; i++) q.push(i, { priority: "interactive", now: i, consumer: "mine" });
    const ahead = (c) => {
      let n = 0;
      q.forEachAhead("interactive", c, () => (n += 1));
      return n;
    };
    expect(ahead("flood")).toBe(53); // the flooder waits behind everything of its own and every lower tag
    expect(ahead("mine")).toBe(3 + 4); // its own three, and the flood items with tags 0 to 3 (at or below its start tag 3)
    expect(ahead("new-consumer")).toBe(2); // only the two items with start tag 0
  });

  it("finds the newest waiting request of a consumer in its lowest lane, never an order", () => {
    const q = createPriorityQueue();
    q.push("o", { priority: "order", now: 0, consumer: "a" });
    q.push("i1", { priority: "interactive", now: 1, consumer: "a" });
    q.push("i2", { priority: "interactive", now: 2, consumer: "a" });
    const bg = q.push("bg", { priority: "background", now: 3, consumer: "a" });
    expect(q.newestOf("a")).toBe(bg);
    q.remove(bg);
    expect(q.newestOf("a").value).toBe("i2");
    expect(q.newestOf("nobody")).toBeNull();
    expect(q.queuedOf("a")).toBe(3);
  });
});

describe("fair queue properties (seeded random operations)", () => {
  it("keeps size, counts and per-consumer order consistent under random pushes, removals and walks", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = rng(seed);
      const q = createPriorityQueue({ ageingMs: 100 });
      const live = new Set();
      let now = 0;
      for (let step = 0; step < 300; step++) {
        now += Math.floor(rand() * 20);
        const r = rand();
        if (r < 0.55 || live.size === 0) {
          const item = q.push(step, {
            priority: PRIORITIES[Math.floor(rand() * 4)],
            now,
            consumer: `c${Math.floor(rand() * 5)}`,
            weight: 1 + Math.floor(rand() * 8),
            cost: 1 + Math.floor(rand() * 3),
          });
          live.add(item);
        } else if (r < 0.8) {
          const pick = [...live][Math.floor(rand() * live.size)];
          expect(q.remove(pick, { served: rand() < 0.5 })).toBe(true);
          live.delete(pick);
        } else {
          // walk everything, removing some while iterating
          const seen = [];
          for (const it of q.iterate(now)) {
            seen.push(it);
            if (rand() < 0.2) {
              q.remove(it, { served: true });
              live.delete(it);
            }
          }
          expect(new Set(seen).size).toBe(seen.length);
          const last = new Map();
          for (const it of seen) {
            const key = `${it.consumer}|${it.priority}`;
            const prev = last.get(key);
            if (prev) {
              expect(it.tag).toBeGreaterThanOrEqual(prev.tag);
              expect(it.seq).toBeGreaterThan(prev.seq);
            }
            last.set(key, it);
          }
        }
        expect(q.size).toBe(live.size);
        expect(Object.values(q.counts()).reduce((a, b) => a + b, 0)).toBe(live.size);
        expect(new Set(order(q, now))).toEqual(live);
      }
    }
  });

  it("yields lanes in priority order (before any ageing)", () => {
    for (let seed = 100; seed < 120; seed++) {
      const rand = rng(seed);
      const q = createPriorityQueue({ ageingMs: 1e9 });
      for (let i = 0; i < 200; i++) q.push(i, { priority: PRIORITIES[Math.floor(rand() * 4)], now: i, consumer: `c${Math.floor(rand() * 4)}`, weight: 1 + Math.floor(rand() * 4) });
      const ranks = order(q, 200).map((i) => PRIORITIES.indexOf(i.priority));
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    }
  });

  it("never starves a consumer: a light one is served within a few services however heavy and weighted the others are", () => {
    for (let seed = 200; seed < 215; seed++) {
      const rand = rng(seed);
      const q = createPriorityQueue({ ageingMs: 1e9 });
      const heavy = ["h1", "h2", "h3"];
      let t = 0;
      for (const h of heavy) for (let i = 0; i < 100; i++) q.push(`${h}:${i}`, { priority: "interactive", now: t++, consumer: h, weight: 1 + Math.floor(rand() * 8) });
      for (let i = 0; i < 20; i++) {
        q.remove(q.peek(t), { served: true });
        for (const h of heavy) q.push(`${h}:more`, { priority: "interactive", now: t++, consumer: h });
      }
      const light = q.push("light", { priority: "interactive", now: t++, consumer: "light", weight: 1 });
      let services = 0;
      for (;;) {
        const head = q.peek(t);
        q.remove(head, { served: true });
        services += 1;
        if (head === light) break;
        for (const h of heavy) q.push(`${h}:more`, { priority: "interactive", now: t++, consumer: h });
        expect(services).toBeLessThanOrEqual(4);
      }
    }
  });

  it("shares in proportion to weights: the normalised service of two backlogged consumers never differs by more than 1/w1 + 1/w2", () => {
    for (let seed = 300; seed < 330; seed++) {
      const rand = rng(seed);
      const q = createPriorityQueue({ ageingMs: 1e9 });
      const weights = { a: 1 + Math.floor(rand() * 8), b: 1 + Math.floor(rand() * 8), c: 1 + Math.floor(rand() * 8) };
      let t = 0;
      for (let i = 0; i < 150; i++) for (const c of Object.keys(weights)) q.push(c, { priority: "interactive", now: t++, consumer: c, weight: weights[c] });
      const served = { a: 0, b: 0, c: 0 };
      for (let n = 0; n < 200; n++) {
        const head = q.peek(t);
        q.remove(head, { served: true });
        served[head.value] += 1;
        for (const x of Object.keys(weights)) {
          for (const y of Object.keys(weights)) {
            if (x < y) expect(Math.abs(served[x] / weights[x] - served[y] / weights[y])).toBeLessThanOrEqual(1 / weights[x] + 1 / weights[y] + 1e-9);
          }
        }
      }
    }
  });

  it("conserves work: everything pushed is served, dropped or still waiting, and nothing is yielded twice", () => {
    const rand = rng(7);
    const q = createPriorityQueue({ ageingMs: 50 });
    let pushed = 0;
    let served = 0;
    let dropped = 0;
    const items = [];
    for (let step = 0; step < 2000; step++) {
      if (rand() < 0.6) {
        items.push(q.push(step, { priority: ["live", "interactive", "background"][Math.floor(rand() * 3)], now: step, consumer: `k${Math.floor(rand() * 6)}`, weight: 1 + Math.floor(rand() * 4) }));
        pushed += 1;
      } else {
        const head = q.peek(step);
        if (head) {
          if (rand() < 0.8) {
            q.remove(head, { served: true });
            served += 1;
          } else {
            q.remove(head);
            dropped += 1;
          }
        }
      }
    }
    expect(served + dropped + q.size).toBe(pushed);
    expect(items.filter((i) => i.queued)).toHaveLength(q.size);
  });
});
