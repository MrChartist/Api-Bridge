/**
 * Snapshot store (docs/spec/p1-01-recorder.md §3.4, §3.6, §6.12, §12): append and range reads, torn lines, the gzip
 * roll and a crash inside it, a corrupt day skipped, retention by IST date, the disk cap, cursor paging, downsampling,
 * the full-day read time, the size per snapshot and no secrets in files.
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { demoChainAt, expiriesFor } from "../demo/demoAdapter.mjs";
import { clockSettings } from "../vol/config.mjs";
import { buildClockContext } from "../vol/context.mjs";
import { dayPlan, slotsOfDay } from "./calendar.mjs";
import { buildSnapshot, gapRecord } from "./snapshot.mjs";
import { createSnapshotStore, decodeCursor, downsample } from "./store.mjs";

const IST = (s) => Date.parse(`${s}+05:30`);
const tmp = () => mkdtempSync(join(tmpdir(), "mcb-rec-store-"));
const clockAt = (t) => ({ now: () => t });
const X = "2026-11-03";

const snap = (slot, extra = {}) => ({ v: 1, kind: "snap", u: "NIFTY", x: X, ex: "NFO", slot, ts: slot + 1500, source: "stream", accountId: "acc-1", broker: "demo", accounts: null, quality: "live", partial: false, missingLegs: 0, oiUnit: "units", oiUnitVerified: true, lot: 75, spot: 25150, fwd: 25170, atm: 25150, straddle: 270, rate: 0.065, t: 0.0137, tcal: 0.0137, model: "b76-vt1", k: [25100, 25150, 25200], ce: { ltp: [1, 2, 3], oi: [75, 150, 225] }, pe: { ltp: [3, 2, 1], oi: [225, 150, 75] }, ...extra });

describe("append and read", () => {
  it("reads snapshots and gaps in range, in slot order, and keeps the latest in memory", async () => {
    const root = tmp();
    const store = createSnapshotStore({ root, clock: clockAt(IST("2026-10-29T11:00:00")) });
    const t0 = IST("2026-10-29T09:15:00");
    for (let i = 0; i < 10; i++) {
      if (i === 4) await store.append(gapRecord({ u: "NIFTY", x: X, slot: t0 + i * 60_000, reason: "stream-down" }));
      else await store.append(snap(t0 + i * 60_000));
    }
    const r = await store.read({ u: "NIFTY", x: X, fromMs: t0 + 60_000, toMs: t0 + 8 * 60_000 });
    expect(r.snaps.map((s) => (s.slot - t0) / 60_000)).toEqual([1, 2, 3, 5, 6, 7, 8]);
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]).toMatchObject({ kind: "gap", reason: "stream-down" });
    expect(store.latest("NIFTY", X).slot).toBe(t0 + 9 * 60_000);
    expect(existsSync(join(root, "s1", "2026-10-29", "NIFTY", `${X}.ndjson`))).toBe(true);
    expect(statSync(join(root, "s1", "2026-10-29", "NIFTY", `${X}.ndjson`)).mode & 0o777).toBe(0o600);
    expect(store.chainsOn("2026-10-29")).toEqual([{ u: "NIFTY", x: X }]);
    expect(await store.lastSlotOn("2026-10-29", "NIFTY", X)).toBe(t0 + 9 * 60_000);
  });

  it("a torn last line is skipped and counted; the next append starts on a new line", async () => {
    const root = tmp();
    const store = createSnapshotStore({ root, clock: clockAt(IST("2026-10-29T11:00:00")) });
    const t0 = IST("2026-10-29T09:15:00");
    await store.append(snap(t0));
    const file = join(root, "s1", "2026-10-29", "NIFTY", `${X}.ndjson`);
    appendFileSync(file, '{"v":1,"kind":"snap","u":"NIFTY","x":"2026-11-0'); // crash mid-write
    await store.append(snap(t0 + 60_000));
    const text = readFileSync(file, "utf8");
    expect(text.split("\n").filter(Boolean)).toHaveLength(3);
    const r = await store.read({ u: "NIFTY", x: X, fromMs: t0, toMs: t0 + 120_000 });
    expect(r.snaps.map((s) => s.slot)).toEqual([t0, t0 + 60_000]);
    expect(store.health().corruptLines).toBe(1);
  });

  it("cursor paging is stable and every=5 keeps the last snapshot of each bucket", async () => {
    const root = tmp();
    const store = createSnapshotStore({ root, clock: clockAt(IST("2026-10-29T12:00:00")) });
    const t0 = IST("2026-10-29T09:15:00");
    for (let i = 0; i < 30; i++) await store.append(snap(t0 + i * 60_000));
    const all = [];
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const r = await store.read({ u: "NIFTY", x: X, fromMs: t0, toMs: t0 + 3_600_000, limit: 7, cursor: cursor ? decodeCursor(cursor) : null });
      all.push(...r.snaps.map((s) => s.slot));
      cursor = r.nextCursor;
      if (!cursor) break;
      // A new record after the cursor does not shift pages already read.
      if (page === 0) await store.append(snap(t0 + 40 * 60_000));
    }
    expect(all).toEqual([...Array.from({ length: 30 }, (_, i) => t0 + i * 60_000), t0 + 40 * 60_000]);
    const r5 = await store.read({ u: "NIFTY", x: X, fromMs: t0, toMs: t0 + 30 * 60_000, everyMinutes: 5 });
    expect(r5.snaps.map((s) => (s.slot - t0) / 60_000)).toEqual([4, 9, 14, 19, 24, 29]);
    expect(downsample([{ slot: t0 }], 1)).toHaveLength(1);
    expect(decodeCursor("not-a-cursor")).toBeNull();
  });

  it("suspect-holiday snapshots are left out unless asked for", async () => {
    const root = tmp();
    const store = createSnapshotStore({ root, clock: clockAt(IST("2026-10-29T12:00:00")) });
    const t0 = IST("2026-10-29T09:15:00");
    for (let i = 0; i < 3; i++) await store.append(snap(t0 + i * 60_000));
    await store.remarkDay("2026-10-29", "suspect-holiday");
    expect((await store.read({ u: "NIFTY", x: X, fromMs: t0, toMs: t0 + 600_000 })).snaps).toHaveLength(0);
    expect((await store.read({ u: "NIFTY", x: X, fromMs: t0, toMs: t0 + 600_000, includeSuspect: true })).snaps.map((s) => s.quality)).toEqual(["suspect-holiday", "suspect-holiday", "suspect-holiday"]);
  });
});

describe("day roll, crash safety and bad days", () => {
  it("gzips each file, verifies, deletes the plain file and writes day.json; reads come from the .gz", async () => {
    const root = tmp();
    const store = createSnapshotStore({ root, clock: clockAt(IST("2026-10-29T16:00:00")) });
    const t0 = IST("2026-10-29T09:15:00");
    for (let i = 0; i < 5; i++) await store.append(snap(t0 + i * 60_000));
    await store.appendUnd({ v: 1, kind: "und", u: "NIFTY", slot: t0, spot: 25150, fut: [] });
    const out = await store.rollDay("2026-10-29");
    expect(out.files).toBe(2);
    const dir = join(root, "s1", "2026-10-29", "NIFTY");
    expect(readdirSync(dir).sort()).toEqual([`${X}.ndjson.gz`, "_und.ndjson.gz"]);
    const day = JSON.parse(readFileSync(join(root, "s1", "2026-10-29", "day.json"), "utf8"));
    expect(day.chains[`NIFTY|${X}`]).toMatchObject({ snaps: 5, gaps: 0, partial: 0 });
    expect(store.isRolled("2026-10-29")).toBe(true);
    expect((await store.read({ u: "NIFTY", x: X, fromMs: t0, toMs: t0 + 600_000 })).snaps).toHaveLength(5);
    expect((await store.readUnd("2026-10-29", "NIFTY"))[0].spot).toBe(25150);
  });

  it("a crash between rename and delete leaves both files: reads prefer the .gz, the next roll removes the leftover", async () => {
    const root = tmp();
    const store = createSnapshotStore({ root, clock: clockAt(IST("2026-10-29T16:00:00")) });
    const t0 = IST("2026-10-29T09:15:00");
    for (let i = 0; i < 4; i++) await store.append(snap(t0 + i * 60_000));
    const plain = join(root, "s1", "2026-10-29", "NIFTY", `${X}.ndjson`);
    const text = readFileSync(plain, "utf8");
    writeFileSync(`${plain}.gz`, gzipSync(text));
    appendFileSync(plain, `${JSON.stringify(snap(t0 + 10 * 60_000))}\n`); // the plain file is a leftover now
    expect((await store.read({ u: "NIFTY", x: X, fromMs: t0, toMs: t0 + 3_600_000 })).snaps).toHaveLength(4);
    await store.rollDay("2026-10-29");
    expect(existsSync(plain)).toBe(false);
    expect(existsSync(`${plain}.gz`)).toBe(true);
  });

  it("a broken .gz next to its plain file: reads use the plain file and the next roll rebuilds the .gz from it", async () => {
    const root = tmp();
    const store = createSnapshotStore({ root, clock: clockAt(IST("2026-10-29T16:00:00")) });
    const t0 = IST("2026-10-29T09:15:00");
    for (let i = 0; i < 4; i++) await store.append(snap(t0 + i * 60_000));
    const plain = join(root, "s1", "2026-10-29", "NIFTY", `${X}.ndjson`);
    writeFileSync(`${plain}.gz`, gzipSync(readFileSync(plain, "utf8")).subarray(0, 20)); // a torn gzip
    expect((await store.read({ u: "NIFTY", x: X, fromMs: t0, toMs: t0 + 3_600_000 })).snaps).toHaveLength(4);
    await store.rollDay("2026-10-29");
    expect(existsSync(plain)).toBe(false);
    expect(gunzipSync(readFileSync(`${plain}.gz`)).toString("utf8").split("\n").filter(Boolean)).toHaveLength(4);
  });

  it("missingDailyDays lists recorded days without an S3 row per expiry, and drops them once written", async () => {
    const root = tmp();
    const store = createSnapshotStore({ root, clock: clockAt(IST("2026-10-30T16:00:00")) });
    await store.append(snap(IST("2026-10-29T10:00:00")));
    await store.append(snap(IST("2026-10-30T10:00:00")));
    await store.rollDay("2026-10-29");
    expect(await store.missingDailyDays()).toEqual(["2026-10-29", "2026-10-30"]);
    await store.writeDaily([{ v: 1, date: "2026-10-29", u: "NIFTY", x: X, pcrOi: 1 }]);
    expect(await store.hasDaily("NIFTY", "2026-10-29", X)).toBe(true);
    expect(await store.missingDailyDays({ skip: (d) => d === "2026-10-30" })).toEqual([]);
  });

  it("a corrupt .gz day is skipped and reported while other days still read", async () => {
    const root = tmp();
    const store = createSnapshotStore({ root, clock: clockAt(IST("2026-10-30T16:00:00")) });
    const d1 = IST("2026-10-29T10:00:00");
    const d2 = IST("2026-10-30T10:00:00");
    await store.append(snap(d1));
    await store.append(snap(d2));
    await store.rollDay("2026-10-29");
    writeFileSync(join(root, "s1", "2026-10-29", "NIFTY", `${X}.ndjson.gz`), Buffer.from("not gzip at all"));
    const r = await store.read({ u: "NIFTY", x: X, fromMs: d1 - 3_600_000, toMs: d2 + 3_600_000 });
    expect(r.snaps.map((s) => s.slot)).toEqual([d2]);
    expect(store.health().unreadableDays.map((d) => d.date)).toEqual(["2026-10-29"]);
  });

  it("retention deletes whole day folders older than retentionDays by IST date", async () => {
    const root = tmp();
    const store = createSnapshotStore({ root, clock: clockAt(IST("2026-10-29T16:00:00")), retentionDays: 7 });
    for (const d of ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-28"]) await store.append(snap(IST(`${d}T10:00:00`)));
    // 23:59 IST on the 21st is still the 21st (a UTC host would call it the 21st 18:29Z).
    expect(store.prune("2026-10-29")).toEqual(["2026-10-20", "2026-10-21"]);
    expect(store.days()).toEqual(["2026-10-22", "2026-10-28"]);
  });

  it("over maxDiskMb snapshots are refused (disk-full) and gaps still written; nothing inside retention is deleted", async () => {
    const root = tmp();
    const store = createSnapshotStore({ root, clock: clockAt(IST("2026-10-29T11:00:00")), maxDiskMb: 0.0002 });
    const t0 = IST("2026-10-29T09:15:00");
    expect((await store.append(snap(t0))).ok).toBe(true);
    store.refreshUsage();
    expect(await store.append(snap(t0 + 60_000))).toEqual({ ok: false, bytes: 0, reason: "disk-full" });
    expect((await store.append(gapRecord({ u: "NIFTY", x: X, slot: t0 + 60_000, reason: "disk-full" }))).ok).toBe(true);
    expect(store.usage().full).toBe(true);
    expect(store.days()).toEqual(["2026-10-29"]);
  });

  it("daily rows upsert per (date, expiry) and read back by range", async () => {
    const root = tmp();
    const store = createSnapshotStore({ root, clock: clockAt(IST("2026-10-29T16:00:00")) });
    await store.writeDaily([{ v: 1, date: "2026-10-28", u: "NIFTY", x: X, pcrOi: 1 }, { v: 1, date: "2026-10-29", u: "NIFTY", x: X, pcrOi: 2 }]);
    await store.writeDaily([{ v: 1, date: "2026-10-29", u: "NIFTY", x: X, pcrOi: 3 }]);
    expect((await store.readDaily({ u: "NIFTY", from: "2026-10-01", to: "2026-10-31" })).map((r) => r.pcrOi)).toEqual([1, 3]);
    expect([...(await store.dailyDates("NIFTY"))].sort()).toEqual(["2026-10-28", "2026-10-29"]);
  });

  it("state.json round-trips; a corrupt one is moved aside", () => {
    const root = tmp();
    const store = createSnapshotStore({ root, clock: clockAt(IST("2026-10-29T16:00:00")) });
    store.writeState({ lastSlot: 5 });
    expect(store.readState()).toEqual({ lastSlot: 5 });
    writeFileSync(join(root, "state.json"), "{nope");
    expect(store.readState()).toBeNull();
    expect(readdirSync(root).some((n) => n.startsWith("state.json.corrupt-"))).toBe(true);
  });
});

describe("a generated demo day (162 legs, 375 snapshots)", async () => {
  const root = tmp();
  const day = "2026-10-29";
  const store = createSnapshotStore({ root, clock: clockAt(IST(`${day}T16:00:00`)) });
  const clock = buildClockContext({ settings: clockSettings(null), session: { open: "09:15", close: "15:30" } });
  const expiry = expiriesFor("NIFTY", IST(`${day}T09:15:00`))[0];
  const slots = slotsOfDay(dayPlan({ date: day, open: "09:15", close: "15:30" }), "index");
  for (const slot of slots) {
    const c = demoChainAt("NIFTY", expiry, slot, 40);
    const rows = c.rows.map((r) => ({ strike: r.strike, ce: { ...r.ce, at: slot }, pe: { ...r.pe, at: slot } }));
    await store.append(buildSnapshot({ u: "NIFTY", x: expiry, ex: "NFO", slot, ts: slot + 1000, source: "backfill", accountId: "demo", broker: "demo", quality: "demo-backfill", oiUnitVerified: true, lot: c.lotSize, spot: c.underlyingLtp, rows }, { clock, rate: 0.065 }));
  }
  await store.rollDay(day);
  const gz = join(root, "s1", day, "NIFTY", `${expiry}.ndjson.gz`);

  it("≤ 3 KB gzipped per 162-leg snapshot, averaged over the day (§6.12)", () => {
    expect(slots).toHaveLength(375);
    expect(statSync(gz).size / 375).toBeLessThanOrEqual(3 * 1024);
  });

  it("a full-day read of oi, ltp and volume from the .gz takes ≤ 300 ms", async () => {
    const fresh = createSnapshotStore({ root, clock: clockAt(IST(`${day}T16:00:00`)) });
    const t = performance.now();
    const r = await fresh.read({ u: "NIFTY", x: expiry, fromMs: IST(`${day}T09:15:00`), toMs: IST(`${day}T15:30:00`), limit: 500 });
    const ms = performance.now() - t;
    expect(r.snaps).toHaveLength(375);
    expect(r.snaps[0].k).toHaveLength(81);
    expect(ms).toBeLessThanOrEqual(300);
  });

  it("files hold ids only: no credential values", () => {
    const secrets = ["dummy.access.token.for.fixtures.only", "demoToken", "Bearer "];
    const text = readFileSync(join(root, "s1", day, "day.json"), "utf8") + gunzipSync(readFileSync(gz)).toString("utf8");
    expect(text).toContain('"accountId":"demo"');
    for (const s of secrets) expect(text).not.toContain(s);
  });
});
