/** OI snapshot recorder (oi-store.js): throttle, de-duplication, cap, eviction and the market-hours rule. */
import { describe, expect, it } from "vitest";
import { SNAP_CAP, fromServerSnapshot, memoryBackend, openStore, serverCoverageText, snapKey, snapshotOf } from "./oi-store.js";

const ist = (y, mo, d, hh = 10, mm = 0) => Date.UTC(y, mo - 1, d, hh, mm) - 5.5 * 3600 * 1000;
const chain = (asOf, oi = 100) => ({
  underlying: "NIFTY",
  expiry: "2026-11-03",
  underlyingLtp: 26000,
  lotSize: 75,
  freshness: { asOf },
  rows: [25900, 26000, 26100].map((k) => ({ strike: k, ce: { oi, ltp: 10, volume: 5 }, pe: { oi: oi * 2, ltp: 12, volume: null } })),
});
const OPEN = ist(2026, 11, 2, 10, 0); // Monday 10:00 IST

describe("OI snapshot store", () => {
  it("records a compact columnar snapshot keyed by IST day", () => {
    const s = snapshotOf(chain("a"), OPEN);
    expect(s).toMatchObject({ key: "NIFTY|2026-11-03|2026-11-02", t: OPEN, istDate: "2026-11-02", asOf: "a", spot: 26000, lot: 75, k: [25900, 26000, 26100], co: [100, 100, 100], po: [200, 200, 200], cv: [5, 5, 5], pv: [null, null, null] });
    expect(snapshotOf({ ...chain("a"), rows: [{ strike: 1, ce: { oi: null }, pe: null }] }, OPEN)).toBeNull();
    expect(snapKey("NIFTY", "2026-11-03", ist(2026, 11, 2, 0, 10))).toBe("NIFTY|2026-11-03|2026-11-02");
  });

  it("writes at most once a minute per key, and never the same quote time twice", async () => {
    const st = openStore({ backend: memoryBackend(), nowMs: OPEN });
    const key = snapKey("NIFTY", "2026-11-03", OPEN);
    expect(await st.offer(chain("a"), OPEN)).toBe(true);
    expect(await st.offer(chain("b"), OPEN + 30_000)).toBe(false);
    expect(await st.offer(chain("a"), OPEN + 61_000)).toBe(false);
    expect(await st.offer(chain("c"), OPEN + 61_000)).toBe(true);
    expect((await st.list(key)).map((s) => s.asOf)).toEqual(["a", "c"]);
    expect((await st.latest(key)).asOf).toBe("c");
  });

  it("keeps the newest 400 per key", async () => {
    const be = memoryBackend();
    const st = openStore({ backend: be, nowMs: OPEN });
    const key = snapKey("NIFTY", "2026-11-03", OPEN);
    for (let i = 0; i < SNAP_CAP + 5; i += 1) await st.put({ ...snapshotOf(chain(`x${i}`), OPEN + i * 60_000), key });
    const snaps = await st.list(key);
    expect(snaps).toHaveLength(SNAP_CAP);
    expect(snaps[0].asOf).toBe("x5");
    expect(await be.list(key)).toHaveLength(SNAP_CAP);
  });

  it("drops snapshots more than 3 IST days old when it opens", async () => {
    const be = memoryBackend();
    const old = snapshotOf(chain("old"), ist(2026, 10, 28, 10));
    const recent = snapshotOf(chain("new"), ist(2026, 10, 30, 10));
    await be.put(old);
    await be.put(recent);
    const st = openStore({ backend: be, nowMs: OPEN });
    await st.ready;
    expect(await be.list(old.key)).toHaveLength(0);
    expect(await st.list(recent.key)).toHaveLength(1);
  });

  it("records only in market hours, except in demo mode", async () => {
    const st = openStore({ backend: memoryBackend(), nowMs: OPEN });
    const sat = ist(2026, 10, 31, 11);
    const night = ist(2026, 11, 2, 20);
    expect(await st.offer(chain("a"), sat)).toBe(false);
    expect(await st.offer(chain("a"), night)).toBe(false);
    expect(await st.offer(chain("a"), ist(2026, 11, 2, 9, 0))).toBe(false);
    expect(await st.offer(chain("a"), night, { demo: true })).toBe(true);
    expect(st.allowed(OPEN, false)).toBe(true);
  });

  it("falls back to memory when the persistent backend fails", async () => {
    const broken = { persistent: true, list: async () => { throw new Error("x"); }, put: async () => { throw new Error("x"); }, remove: async () => {}, clearKey: async () => {}, evictBefore: async () => { throw new Error("x"); } };
    const st = openStore({ backend: broken, nowMs: OPEN });
    expect(await st.offer(chain("a"), OPEN)).toBe(true);
    expect(st.persistent).toBe(false);
    expect(st.failed).toBe(true);
    const key = snapKey("NIFTY", "2026-11-03", OPEN);
    expect(await st.list(key)).toHaveLength(1);
    await st.clearKey(key);
    expect(await st.list(key)).toHaveLength(0);
  });
});

describe("server-backed keys (the Bridge recorder, docs/spec/p1-01-recorder.md §7.2)", () => {
  const page = (slots) =>
    slots.map((slot, i) => ({
      slot,
      ts: slot.replace(":00.000", ":01.412"),
      source: "stream",
      spot: 26000 + i,
      lotSize: 75,
      strikes: [25950, 26000, 26050],
      ce: { oi: [7500, 15000 + i * 75, null], ltp: [80, 52.5, 30], volume: [750, 1500, 0] },
      pe: { oi: [9000, 12000, 6000], ltp: [28, 47, 75] },
    }));

  it("maps a recorded snapshot to the record shape", () => {
    const [s] = page(["2026-11-02T10:15:00.000+05:30"]);
    const r = fromServerSnapshot(s, "NIFTY", "2026-11-03");
    expect(r).toEqual({
      key: "NIFTY|2026-11-03|2026-11-02",
      t: Date.parse("2026-11-02T10:15:00+05:30"),
      istDate: "2026-11-02",
      asOf: "2026-11-02T10:15:01.412+05:30",
      spot: 26000,
      lot: 75,
      k: [25950, 26000, 26050],
      co: [7500, 15000, null],
      po: [9000, 12000, 6000],
      cl: [80, 52.5, 30],
      pl: [28, 47, 75],
      cv: [750, 1500, 0],
      pv: [null, null, null],
      src: "server",
    });
    expect(fromServerSnapshot({ ...s, strikes: [] }, "NIFTY", "2026-11-03")).toBeNull();
    expect(fromServerSnapshot({ ...s, slot: "x" }, "NIFTY", "2026-11-03")).toBeNull();
  });

  it("a server-backed key takes no page snapshots and drops the ones the page recorded", async () => {
    const st = openStore({ backend: memoryBackend(), nowMs: OPEN });
    const key = snapKey("NIFTY", "2026-11-03", OPEN);
    expect(await st.offer(chain("a"), OPEN)).toBe(true);
    await st.markServerBacked(key);
    expect(st.serverBacked(key)).toBe(true);
    expect(await st.list(key)).toEqual([]);
    expect(await st.offer(chain("b"), OPEN + 120_000)).toBe(false);
  });

  it("merges pages without duplicate minutes, and keeps the first snapshot of the day at the cap", async () => {
    const be = memoryBackend();
    const st = openStore({ backend: be, nowMs: OPEN });
    const key = snapKey("NIFTY", "2026-11-03", OPEN);
    await st.markServerBacked(key);
    const slots = Array.from({ length: SNAP_CAP + 20 }, (_, i) => new Date(Date.parse("2026-11-02T09:15:00+05:30") + i * 60_000).toISOString());
    const recs = page(slots).map((s) => fromServerSnapshot(s, "NIFTY", "2026-11-03"));
    await st.putMany(recs.slice(0, 10));
    await st.putMany(recs.slice(5, 15)); // overlaps 5..9
    expect((await st.list(key)).map((s) => s.t)).toEqual(recs.slice(0, 15).map((r) => r.t));
    await st.putMany(recs);
    const kept = await st.list(key);
    expect(kept).toHaveLength(SNAP_CAP);
    expect(kept[0].t).toBe(recs[0].t);
    expect(kept[1].t).toBe(recs[21].t);
    expect(kept.at(-1).t).toBe(recs.at(-1).t);
    expect(new Set(kept.map((s) => s.t)).size).toBe(SNAP_CAP);
    expect(await be.list(key)).toHaveLength(SNAP_CAP);
  });

  it("the coverage line names the latest gap", () => {
    const fmt = (n) => String(n);
    const text = serverCoverageText(
      {
        coverage: { expectedSlots: 61, recordedSlots: 58, gapSlots: 3, firstSlot: "2026-10-29T09:15:00.000+05:30" },
        gaps: [{ from: "2026-10-29T10:41:00.000+05:30", to: "2026-10-29T10:43:00.000+05:30", slots: 3, reason: "stream-down" }],
      },
      fmt,
    );
    expect(text).toBe("Server recording since 09:15 · 58 of 61 minutes · 3 missing (feed down 10:41–10:43)");
    expect(serverCoverageText({ coverage: { expectedSlots: 5, recordedSlots: 5, gapSlots: 0, firstSlot: "2026-10-29T09:15:00.000+05:30" }, gaps: [] }, fmt)).toBe("Server recording since 09:15 · 5 of 5 minutes");
  });
});
