/**
 * The local store and the saved-calls counter: what a dataset covers, the gaps the broker must fill, the labels.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeDatasetFixture } from "../downloads/testkit.mjs";
import { createLocalStore, readDatasetMeta, subtractCoverage } from "./localStore.mjs";
import { createSavedCalls } from "./savedCalls.mjs";

const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
const dir = () => mkdtempSync(join(tmpdir(), "mcb-ls-"));
const day = (d, base = 100) => ({ time: sec(`${d}T00:00:00+05:30`), open: base, high: base + 2, low: base - 1, close: base + 1, volume: 1000 });
const DAYS = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"].map((d, i) => day(d, 100 + i));
const cover = { from: sec("2026-10-12T00:00:00+05:30"), to: sec("2026-10-16T23:59:59+05:30") };

describe("subtractCoverage", () => {
  it("returns what the coverage does not reach", () => {
    expect(subtractCoverage(10, 20, null)).toEqual([{ from: 10, to: 20 }]);
    expect(subtractCoverage(10, 20, { from: 12, to: 18 })).toEqual([{ from: 10, to: 11 }, { from: 19, to: 20 }]);
    expect(subtractCoverage(10, 20, { from: 5, to: 20 })).toEqual([]);
    expect(subtractCoverage(10, 20, { from: 15, to: 30 })).toEqual([{ from: 10, to: 14 }]);
    expect(subtractCoverage(10, 20, { from: 30, to: 40 })).toEqual([{ from: 10, to: 20 }]);
    expect(subtractCoverage(20, 10, null)).toEqual([]);
  });
});

describe("readRange", () => {
  it("serves bars inside the coverage and lists the rest as gaps, with the dataset's own labels", async () => {
    const dataDir = dir();
    writeDatasetFixture(dataDir, "idx", { dataClass: "delayed", source: "yahoo", official: false, delaySec: 900, series: [{ symbol: "NSE:NIFTY", interval: "1d", bars: DAYS, coverage: cover }] });
    const store = createLocalStore({ dataDir });
    const r = await store.readRange("NSE:NIFTY", "1d", sec("2026-10-14T00:00:00+05:30"), sec("2026-10-20T12:00:00+05:30"));
    expect(r.bars.map((b) => b.time)).toEqual(DAYS.slice(2).map((b) => b.time));
    expect(r.complete).toBe(false);
    expect(r.gaps).toEqual([{ from: cover.to + 1, to: sec("2026-10-20T12:00:00+05:30") }]);
    expect(r.covered).toEqual({ from: sec("2026-10-14T00:00:00+05:30"), to: cover.to });
    expect(r.source).toMatchObject({ dataset: "idx", dataClass: "delayed", source: "yahoo", official: false, delaySec: 900 });
    const head = await store.readRange("NSE:NIFTY", "1d", sec("2026-10-05T00:00:00+05:30"), sec("2026-10-13T12:00:00+05:30"));
    expect(head.gaps).toEqual([{ from: sec("2026-10-05T00:00:00+05:30"), to: cover.from - 1 }]);
    expect(head.bars).toHaveLength(2);
  });

  it("is complete when the range is inside the coverage, even where the broker had no bar", async () => {
    const dataDir = dir();
    const noWed = DAYS.filter((b) => b.time !== sec("2026-10-14T00:00:00+05:30"));
    writeDatasetFixture(dataDir, "idx", { series: [{ symbol: "NSE:NIFTY", interval: "1d", bars: noWed, coverage: cover, holes: [{ from: sec("2026-10-14T00:00:00+05:30"), to: sec("2026-10-14T00:00:00+05:30"), missing: 1, kind: "missing-days" }] }] });
    const r = await createLocalStore({ dataDir }).readRange("NSE:NIFTY", "1d", cover.from, cover.to);
    expect(r.complete).toBe(true);
    expect(r.gaps).toEqual([]);
    expect(r.bars).toHaveLength(4);
    expect(r.holes).toHaveLength(1);
  });

  it("answers with no bars and the whole range as a gap when nothing is stored", async () => {
    const dataDir = dir();
    const store = createLocalStore({ dataDir });
    expect(await store.readRange("NSE:NIFTY", "1d", 100, 200)).toEqual({ bars: [], gaps: [{ from: 100, to: 200 }], complete: false, covered: null, holes: [], source: null });
    writeDatasetFixture(dataDir, "idx", { series: [{ symbol: "NSE:NIFTY", interval: "1d", bars: DAYS, coverage: cover }] });
    expect((await store.readRange("NSE:NIFTY", "5m", 100, 200)).source).toBeNull(); // another interval
    expect((await store.readRange("NSE:INFY", "1d", 100, 200)).source).toBeNull(); // another symbol
    expect((await store.readRange("NSE:NIFTY", "1d", cover.to + 10_000, cover.to + 20_000)).covered).toBeNull();
    expect((await store.readRange("NSE:NIFTY", "1d", 200, 100)).complete).toBe(true); // an empty range needs nothing
  });

  it("reads a named dataset only, and picks the one that covers most when none is named", async () => {
    const dataDir = dir();
    writeDatasetFixture(dataDir, "small", { series: [{ symbol: "NSE:NIFTY", interval: "1d", bars: DAYS.slice(0, 2), coverage: { from: cover.from, to: sec("2026-10-13T23:59:59+05:30") } }] });
    writeDatasetFixture(dataDir, "big", { series: [{ symbol: "NSE:NIFTY", interval: "1d", bars: DAYS, coverage: cover }] });
    const store = createLocalStore({ dataDir });
    expect((await store.readRange("NSE:NIFTY", "1d", cover.from, cover.to)).source.dataset).toBe("big");
    expect((await store.readRange("NSE:NIFTY", "1d", cover.from, cover.to, { dataset: "small" })).source.dataset).toBe("small");
    expect((await store.readRange("NSE:NIFTY", "1d", cover.from, cover.to, { dataset: "nope" })).source).toBeNull();
    expect(store.names()).toEqual(["big", "small"]);
  });

  it("reads JSONL and AmiBroker datasets too, and never a bar after the coverage (a write in progress)", async () => {
    const dataDir = dir();
    for (const format of ["jsonl", "amibroker"]) {
      writeDatasetFixture(dataDir, `f-${format}`, { format, series: [{ symbol: "NSE:NIFTY", interval: "1d", bars: DAYS, coverage: { from: cover.from, to: sec("2026-10-14T23:59:59+05:30") } }] });
      const r = await createLocalStore({ dataDir }).readRange("NSE:NIFTY", "1d", cover.from, cover.to, { dataset: `f-${format}` });
      expect(r.bars).toHaveLength(3);
      expect(r.bars[0]).toEqual(DAYS[0]);
    }
  });

  it("ignores folders that are not datasets and refuses names that could leave the folder", async () => {
    const dataDir = dir();
    writeDatasetFixture(dataDir, "ok", { series: [] });
    expect(readDatasetMeta(dataDir, "../ok")).toBeNull();
    expect(readDatasetMeta(dataDir, "OK")).toBeNull();
    expect(readDatasetMeta(dataDir, "ok")).toMatchObject({ name: "ok" });
    expect(createLocalStore({ dataDir }).names()).toEqual(["ok"]);
    expect(createLocalStore({ dataDir: dir() }).names()).toEqual([]);
  });
});

describe("saved calls", () => {
  it("counts avoided calls by reason and starts again each IST day", () => {
    let t = Date.parse("2026-10-20T10:00:00+05:30");
    const c = createSavedCalls({ now: () => t });
    c.record(3, "local-dataset");
    c.record(2, "local-dataset");
    c.record(1, "dataset-incremental");
    expect(c.snapshot()).toEqual({ day: "2026-10-20", total: 6, byReason: { "dataset-incremental": 1, "local-dataset": 5 } });
    t = Date.parse("2026-10-20T23:59:00+05:30");
    expect(c.snapshot().total).toBe(6);
    t = Date.parse("2026-10-21T00:01:00+05:30");
    expect(c.snapshot()).toEqual({ day: "2026-10-21", total: 0, byReason: {} });
  });
  it("ignores nonsense and cleans a reason that is not a short label", () => {
    const c = createSavedCalls();
    c.record(0, "x");
    c.record(-4, "x");
    c.record(NaN, "x");
    c.record(2.7, "Bad Reason!");
    c.record(1);
    expect(c.snapshot().byReason).toEqual({ other: 3 });
    c.reset();
    expect(c.snapshot().total).toBe(0);
  });
});
