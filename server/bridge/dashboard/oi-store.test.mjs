/** OI snapshot recorder (oi-store.js): throttle, de-duplication, cap, eviction and the market-hours rule. */
import { describe, expect, it } from "vitest";
import { SNAP_CAP, memoryBackend, openStore, snapKey, snapshotOf } from "./oi-store.js";

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
