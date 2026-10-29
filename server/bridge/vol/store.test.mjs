/**
 * store.mjs (docs/spec/p1-03-pricing-vol.md §2.3, §9.1): append and read; the last line for a key wins; a torn last
 * line is skipped and counted; a live row is never replaced by a back-fill row (a back-fill may fill a missed day);
 * compaction through writeFileAtomic when > 20 % of lines are superseded; retention; predictions by month; state.
 */
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createVolStore, mayReplace } from "./store.mjs";

const row = (date, expiry, atmIv, quality = "live") => ({ v: 1, underlying: "NIFTY", date, expiry, quality, atmIv, tv: 0.0001, clock: { units: 3.9, T: 0.0147, Tw: 0.0147, Tcal: 0.0143, Ttd: 0.0152 }, flags: [] });
const sum = (date, quality = "live", extra = {}) => ({ v: 1, underlying: "NIFTY", date, quality, missed: false, cm30: { weighted: 12 }, ...extra });
const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), "mcb-vol-store-"));
  const s = createVolStore({ root });
  s.load();
  return { root, s };
};

describe("vol store", () => {
  it("appends, reloads, and the last line for a key wins", async () => {
    const { root, s } = fresh();
    s.putExpiryRows("NIFTY", [row("2026-10-28", "2026-11-03", 12.1), row("2026-10-29", "2026-11-03", 12.4)]);
    s.putExpiryRows("NIFTY", [row("2026-10-29", "2026-11-03", 12.6)]);
    s.putSummaries("NIFTY", [sum("2026-10-28"), sum("2026-10-29")]);
    await s.flush();
    const again = createVolStore({ root });
    again.load();
    expect(again.underlyings()).toEqual(["NIFTY"]);
    expect(again.expiryIndex("NIFTY").map((r) => [r.date, r.atmIv])).toEqual([
      ["2026-10-28", 12.1],
      ["2026-10-29", 12.6],
    ]);
    expect(again.readExpiryRows("NIFTY", { from: "2026-10-29" }).map((r) => r.atmIv)).toEqual([12.6]);
    expect(again.summaries("NIFTY").map((r) => r.date)).toEqual(["2026-10-28", "2026-10-29"]);
  });

  it("skips and counts a torn last line and a corrupt line", async () => {
    const { root, s } = fresh();
    s.putSummaries("NIFTY", [sum("2026-10-28")]);
    await s.flush();
    const file = join(root, "daily", "NIFTY", "summary.jsonl");
    appendFileSync(file, "not json\n");
    appendFileSync(file, '{"v":1,"date":"2026-10-29","quali');
    const again = createVolStore({ root });
    const h = again.load();
    expect(again.summaries("NIFTY").map((r) => r.date)).toEqual(["2026-10-28"]);
    expect(h).toMatchObject({ corruptLines: 1, tornTails: 1 });
    // The next append repairs the missing newline first.
    again.putSummaries("NIFTY", [sum("2026-10-30")]);
    await again.flush();
    expect(readFileSync(file, "utf8").trim().split("\n").at(-1)).toContain("2026-10-30");
  });

  it("live beats back-fill for the same key; a back-fill fills a missed day; missed never replaces a row", () => {
    expect(mayReplace({ quality: "live" }, { quality: "backfill-eod" })).toBe(false);
    expect(mayReplace({ quality: "backfill-eod" }, { quality: "live" })).toBe(true);
    expect(mayReplace({ missed: true, quality: null }, { quality: "backfill-eod" })).toBe(true);
    expect(mayReplace({ quality: "live" }, { missed: true })).toBe(false);
    const { s } = fresh();
    s.putExpiryRows("NIFTY", [row("2026-10-29", "2026-11-03", 12.4)]);
    expect(s.putExpiryRows("NIFTY", [row("2026-10-29", "2026-11-03", 15, "backfill-eod")])).toEqual([]);
    expect(s.expiryIndex("NIFTY")[0].atmIv).toBe(12.4);
    s.putSummaries("NIFTY", [{ v: 1, underlying: "NIFTY", date: "2026-10-20", missed: true, reason: "BRIDGE_OFF", quality: null }]);
    expect(s.putSummaries("NIFTY", [sum("2026-10-20", "backfill-eod")])).toHaveLength(1);
    expect(s.summaryOn("NIFTY", "2026-10-20").quality).toBe("backfill-eod");
  });

  it("compacts superseded lines atomically and applies retention", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcb-vol-store-"));
    const s = createVolStore({ root, retentionDays: 30 });
    s.load();
    s.putSummaries("NIFTY", [sum("2026-08-01"), sum("2026-10-28")]);
    for (let i = 0; i < 5; i++) s.putSummaries("NIFTY", [sum("2026-10-29", "live", { cm30: { weighted: 12 + i } })]);
    s.putExpiryRows("NIFTY", [row("2026-08-01", "2026-08-04", 11), row("2026-10-29", "2026-11-03", 12)]);
    s.putVix([{ date: "2026-10-29", c: 13, source: "demo" }]);
    await s.flush();
    const done = await s.compactAll({ today: "2026-10-29" });
    expect(done).toEqual(expect.arrayContaining(["NIFTY/summary", "NIFTY/expiries"]));
    const lines = readFileSync(join(root, "daily", "NIFTY", "summary.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).cm30.weighted).toBe(16);
    expect(s.summaries("NIFTY").map((r) => r.date)).toEqual(["2026-10-28", "2026-10-29"]);
    expect(s.expiryIndex("NIFTY").map((r) => r.date)).toEqual(["2026-10-29"]);
    expect(s.bytes()).toBeGreaterThan(0);
  });

  it("predictions by month, last line per id; state round-trips", async () => {
    const { s } = fresh();
    await s.appendPredictions([
      { id: "a", ts: "2026-09-30T15:25:00+05:30", metric: "band1" },
      { id: "b", ts: "2026-10-29T15:25:00+05:30", metric: "band1" },
      { id: "b", ts: "2026-10-29T15:25:00+05:30", metric: "band1", outcome: 1 },
    ]);
    expect(s.readPredictions({ from: "2026-10-01", to: "2026-10-31" })).toEqual([{ id: "b", ts: "2026-10-29T15:25:00+05:30", metric: "band1", outcome: 1 }]);
    expect(s.readPredictions({ from: "2026-09-01", to: "2026-10-31" }).map((r) => r.id)).toEqual(["a", "b"]);
    s.writeState({ days: { "2026-10-29": { NIFTY: { attempted: true } } } });
    expect(s.readState()).toEqual({ days: { "2026-10-29": { NIFTY: { attempted: true } } } });
  });
});
