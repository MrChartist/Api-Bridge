/**
 * The bulk budget share: what a background download may take of an account's budget.
 */
import { describe, expect, it } from "vitest";
import { MAX_SHARE, createPacer, decide } from "./pacer.mjs";
import { timeAtShare } from "./estimate.mjs";

const w = (window, limit, remaining, resetMs = 500) => ({ bucket: "history", window, limit, remaining, used: limit - remaining, resetMs });

describe("decide", () => {
  it("never lets a share go above one half", () => {
    expect(MAX_SHARE).toBe(0.5);
    const d = decide({ windows: [w("1s", 10, 10)], backoffMs: 0 }, 0.9);
    expect(d.paceMs).toBe(200); // 0.5 x 10 = 5 calls a second
  });

  it("paces the per-second window to share x limit, even when the limit is tiny", () => {
    expect(decide({ windows: [w("1s", 5, 5)], backoffMs: 0 }, 0.3)).toMatchObject({ ok: true, paceMs: 667 });
    // a 3 a second broker with a 0.3 share still gets a call every 1.1 seconds: a floor of ceil(0.7 x 3) = 3 would never allow one
    expect(decide({ windows: [w("1s", 3, 3)], backoffMs: 0 }, 0.3)).toMatchObject({ ok: true, paceMs: 1112 });
    expect(decide({ windows: [w("1s", 1, 1)], backoffMs: 0 }, 0.3)).toMatchObject({ ok: true, paceMs: 3334 });
  });

  it("keeps a floor on every longer window: live use and other keys keep (1 - share) of the minute and the day", () => {
    // limit 100, share 0.3: calls only while at least 70 would still be free afterwards
    expect(decide({ windows: [w("1m", 100, 71)], backoffMs: 0 }, 0.3).ok).toBe(true);
    const full = decide({ windows: [w("1m", 100, 70, 12_000)], backoffMs: 0 }, 0.3);
    expect(full).toMatchObject({ ok: false, waitMs: 12_000, window: "1m" });
    const day = decide({ windows: [w("1s", 5, 5), w("day", 1000, 600, 3_600_000)], backoffMs: 0 }, 0.3);
    expect(day).toMatchObject({ ok: false, waitMs: 3_600_000, window: "day" });
  });

  it("stops while the account backs off after a throttle, and when the second window is used up", () => {
    expect(decide({ windows: [w("1s", 5, 5)], backoffMs: 4000 }, 0.3)).toMatchObject({ ok: false, waitMs: 4000, window: "backoff" });
    expect(decide({ windows: [w("1s", 5, 0, 300)], backoffMs: 0 }, 0.3)).toMatchObject({ ok: false, waitMs: 300 });
  });

  it("ignores windows without a limit (paper accounts) and takes no share of nothing", () => {
    expect(decide({ windows: [w("1s", Infinity, Infinity)], backoffMs: 0 }, 0.3)).toMatchObject({ ok: true, paceMs: 0 });
    expect(decide({ windows: [], backoffMs: 0 }, 0.3).ok).toBe(true);
  });
});

describe("createPacer", () => {
  function setup(view, share = 0.3) {
    let t = 0;
    const sleeps = [];
    const scheduler = { headroomWindows: () => (typeof view === "function" ? view(t) : view) };
    const pacer = createPacer({
      scheduler,
      share: () => share,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    return { pacer, sleeps, time: () => t, advance: (ms) => (t += ms) };
  }

  it("spaces calls by 1 / (share x limit) across every caller of one account", async () => {
    const h = setup({ windows: [w("1s", 5, 5)], backoffMs: 0 });
    const starts = [];
    await Promise.all([1, 2, 3].map(async () => {
      await h.pacer.acquire("a1", "history");
      starts.push(h.time());
    }));
    expect(starts.sort((a, b) => a - b)).toEqual([0, 667, 1334]);
  });

  it("is per account: another account is not held back", async () => {
    const h = setup({ windows: [w("1s", 5, 5)], backoffMs: 0 });
    await h.pacer.acquire("a1");
    await h.pacer.acquire("a2");
    expect(h.sleeps).toEqual([]);
  });

  it("waits out a full window and reports why", async () => {
    let remaining = 70;
    const h = setup((t) => ({ windows: [w("1m", 100, t >= 12_000 ? 100 : remaining, Math.max(0, 12_000 - t))], backoffMs: 0 }));
    const waits = [];
    await h.pacer.acquire("a1", "history", { onWait: (x) => waits.push(x) });
    expect(h.time()).toBeGreaterThanOrEqual(12_000);
    expect(waits[0]).toMatchObject({ reason: "budget", window: "1m" });
    void remaining;
  });

  it("stops at once when the job is cancelled", async () => {
    const h = setup({ windows: [w("1m", 100, 0, 60_000)], backoffMs: 0 });
    const ctrl = new AbortController();
    const p = h.pacer.acquire("a1", "history", { signal: ctrl.signal });
    ctrl.abort(new DOMException("cancelled", "AbortError"));
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports the calls a second the share allows", () => {
    const h = setup({ windows: [w("1s", 5, 5), w("1m", 100, 100)], backoffMs: 0 });
    expect(h.pacer.callsPerSecond("a1")).toBeCloseTo(1.5);
  });

  it("works with a scheduler that only has headroom()", async () => {
    let t = 0;
    const pacer = createPacer({ scheduler: { headroom: () => ({ remaining: 1000, limit: 1000, resetMs: 0 }) }, share: () => 0.3, now: () => t, sleep: async (ms) => (t += ms) });
    await pacer.acquire("a1");
    expect(t).toBe(0);
  });
});

describe("timeAtShare", () => {
  it("turns windows into a sustained rate: the slowest window sets the pace", () => {
    expect(timeAtShare(100, [{ window: "1s", limit: 5 }, { window: "day", limit: 1000 }], 0.3)).toMatchObject({ callsPerSecond: 0.003, binding: "day", days: 1 });
    const fast = timeAtShare(15, [{ window: "1s", limit: 5 }], 0.3);
    expect(fast).toMatchObject({ etaSec: 10, callsPerSecond: 1.5, binding: "1s", days: null });
    expect(timeAtShare(10, [], 0.3)).toEqual({ etaSec: null, callsPerSecond: null, binding: null, days: null });
  });
  it("says days when the daily limit sets the pace", () => {
    const t = timeAtShare(5000, [{ window: "day", limit: 10_000 }], 0.3);
    expect(t.days).toBe(2);
  });
});
