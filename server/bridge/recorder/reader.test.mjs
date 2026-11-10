/**
 * Reading recorded rows back (for local-first history): from the files a recording wrote, plain or gzipped, with the gaps.
 */
import { afterEach, describe, expect, it } from "vitest";
import { daysBetween, readRecorded } from "./reader.mjs";
import { NIFTY, at, bootRecorder } from "./testkit.mjs";

let w;
afterEach(async () => {
  await w?.close();
  w = null;
});

describe("readRecorded", () => {
  it("returns the rows of a symbol in a range, oldest first, with the gaps the recorder logged", async () => {
    w = bootRecorder({ start: at("2026-11-09T09:00:00") });
    await w.svc.start();
    const r = await w.svc.create({ kind: "quotes", symbols: [NIFTY], everySec: 1, sessionOnly: false, compress: true });
    await w.run(2000);
    for (let i = 0; i < 4; i += 1) {
      w.hub.pushTick({ symbol: NIFTY, ltp: 100 + i });
      await w.run(2000);
    }
    w.hub.setConnected(false);
    await w.run(40_000, 2000);
    w.hub.setConnected(true);
    await w.svc.pumpAll();
    await w.run(2000);
    w.hub.pushTick({ symbol: NIFTY, ltp: 200 });
    await w.run(3000);
    const res = readRecorded({ dataDir: w.dir, symbol: NIFTY, fromMs: at("2026-11-09T09:00:00"), toMs: at("2026-11-09T10:00:00") });
    expect(res).toMatchObject({ symbol: NIFTY, dataClass: "realtime", source: "recorded" });
    expect(res.rows.length).toBeGreaterThanOrEqual(5);
    expect(res.rows[0]).toMatchObject({ class: "realtime", recordingId: r.id });
    expect(res.rows.map((x) => x.time)).toEqual([...res.rows.map((x) => x.time)].sort());
    expect(res.rows.at(-1).ltp).toBe(200);
    expect(res.recordings).toEqual([{ id: r.id, kind: "quotes", everySec: 1, files: ["2026-11-09__NSE_NIFTY.csv"] }]);
    expect(res.gaps).toHaveLength(1);
    expect(res.gaps[0]).toMatchObject({ recordingId: r.id, reason: "feed-down" });
    // a range with no data, another symbol, and a narrower range
    expect(readRecorded({ dataDir: w.dir, symbol: NIFTY, fromMs: at("2026-11-12T09:00:00"), toMs: at("2026-11-12T10:00:00") }).rows).toEqual([]);
    expect(readRecorded({ dataDir: w.dir, symbol: "NSE:INFY", fromMs: at("2026-11-09T09:00:00"), toMs: at("2026-11-09T10:00:00") }).recordings).toEqual([]);
    const narrow = readRecorded({ dataDir: w.dir, symbol: NIFTY, fromMs: res.rows[1].time ? Date.parse(res.rows[1].time) : 0, toMs: Date.parse(res.rows[2].time) });
    expect(narrow.rows).toHaveLength(2);
  });

  it("reads gzipped finished days after the sweep compressed them", async () => {
    w = bootRecorder({ start: at("2026-11-09T09:00:00") });
    await w.svc.start();
    const r = await w.svc.create({ kind: "quotes", symbols: [NIFTY], everySec: 1, sessionOnly: false, compress: true });
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    writeFileSync(join(w.dir, "recordings", r.id, "2026-11-06__NSE_NIFTY.csv"), "time,symbol,ltp,bid,ask,bidQty,askQty,volume,oi,oiChange,open,high,low,close,iv,delta,gamma,theta,vega,spot,tickAt,source,class\n2026-11-06T10:00:00.000+05:30,NSE:NIFTY,24000,,,,,,,,,,,,,,,,,,2026-11-06T10:00:00.000+05:30,stream,realtime\n");
    w.svc.sweepNow();
    const res = readRecorded({ dataDir: w.dir, symbol: NIFTY, fromMs: at("2026-11-06T09:00:00"), toMs: at("2026-11-06T16:00:00") });
    expect(res.recordings[0].files).toEqual(["2026-11-06__NSE_NIFTY.csv.gz"]);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ ltp: 24000, source: "stream" });
  });

  it("an empty data folder is an empty answer, and daysBetween lists IST days", () => {
    expect(readRecorded({ dataDir: "/nonexistent-folder-for-test", symbol: NIFTY, fromMs: 0, toMs: 1 }).rows).toEqual([]);
    expect(daysBetween(at("2026-11-08T23:00:00"), at("2026-11-10T01:00:00"))).toEqual(["2026-11-08", "2026-11-09", "2026-11-10"]);
  });
});
