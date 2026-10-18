import { describe, expect, it } from "vitest";
import { createPriorityQueue } from "./priorityQueue.mjs";

const names = (q, now) => [...q.iterate(now)].map((i) => i.value);

describe("priority queue", () => {
  it("orders by priority, then FIFO", () => {
    const q = createPriorityQueue({ ageingMs: 10_000 });
    q.push("bg1", { priority: "background", now: 0 });
    q.push("i1", { priority: "interactive", now: 1 });
    q.push("o1", { priority: "order", now: 2 });
    q.push("l1", { priority: "live", now: 3 });
    q.push("i2", { priority: "interactive", now: 4 });
    expect(names(q, 5)).toEqual(["o1", "l1", "i1", "i2", "bg1"]);
    expect(q.size).toBe(5);
    expect(q.counts()).toEqual({ order: 1, live: 1, interactive: 2, background: 1 });
    expect(q.peek(5).value).toBe("o1");
  });

  it("ages waiting reads upwards, never above live, so orders always come first", () => {
    const q = createPriorityQueue({ ageingMs: 1000 });
    q.push("bg-old", { priority: "background", now: 0 });
    q.push("i-new", { priority: "interactive", now: 1500 });
    // At t=1500 the background item has aged one level (score 2) and is older: it goes first.
    expect(names(q, 1500)).toEqual(["bg-old", "i-new"]);
    q.push("live-new", { priority: "live", now: 5000 });
    q.push("order-new", { priority: "order", now: 9000 });
    // bg-old is at the live level by now and older than live-new; the order still leads.
    expect(names(q, 9000)).toEqual(["order-new", "bg-old", "i-new", "live-new"]);
    expect(q.score({ priority: "background", enqueuedAt: 0 }, 1_000_000)).toBe(1);
    expect(q.score({ priority: "order", enqueuedAt: 0 }, 0)).toBe(0);
  });

  it("supports removal, also while iterating", () => {
    const q = createPriorityQueue();
    const items = Array.from({ length: 200 }, (_, i) => q.push(i, { priority: i % 2 ? "interactive" : "background", now: i }));
    const seen = [];
    for (const it of q.iterate(0)) {
      seen.push(it.value);
      q.remove(it);
      if (it.value === 1) q.remove(items[3]); // remove a later item mid-walk
    }
    expect(seen).not.toContain(3);
    expect(seen.length).toBe(199);
    expect(q.size).toBe(0);
    expect(q.remove(items[0])).toBe(false);
    expect([...q.iterate(0)]).toEqual([]);
    // The queue stays usable after compaction.
    q.push("again", { priority: "live", now: 1 });
    expect(names(q, 1)).toEqual(["again"]);
  });

  it("rejects unknown priorities and bad ageing", () => {
    const q = createPriorityQueue();
    expect(() => q.push("x", { priority: "urgent", now: 0 })).toThrow(RangeError);
    expect(() => createPriorityQueue({ ageingMs: 0 })).toThrow(RangeError);
  });
});
