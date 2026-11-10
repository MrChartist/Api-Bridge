/**
 * Local-first history: bars served from a dataset are the broker's bars (intraday: identical), the broker is asked only
 * for the missing part, and the labels stay honest.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeHistory, writeDatasetFixture } from "../downloads/testkit.mjs";
import { readHistoryLocalFirst } from "./historyLocal.mjs";
import { createLocalStore } from "./localStore.mjs";
import { resetSavedCalls, snapshot } from "./savedCalls.mjs";

const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
const NOW = Date.parse("2026-11-04T10:00:00+05:30");

async function setup({ dataClass = "realtime", delaySec = null, official = true, coverTo = "2026-11-02T23:59:59+05:30" } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-hl-"));
  const broker = createFakeHistory();
  // what the broker says for Monday 2 November 2026, 5-minute bars
  const monday = (await broker.history({ symbol: "NSE:RELIANCE", interval: "5m", from: sec("2026-11-02T00:00:00+05:30"), to: sec("2026-11-02T23:59:59+05:30") }, {})).candles;
  broker.calls.length = 0;
  writeDatasetFixture(dataDir, "rel-5m", { dataClass, delaySec, official, source: "fake", series: [{ symbol: "NSE:RELIANCE", interval: "5m", bars: monday, coverage: { from: sec("2026-11-02T00:00:00+05:30"), to: sec(coverTo) } }] });
  const store = createLocalStore({ dataDir });
  const deps = { store, history: broker.history, now: () => NOW };
  return { dataDir, broker, monday, deps };
}
const P = (o = {}) => ({ symbol: "NSE:RELIANCE", interval: "5m", from: "2026-11-02", to: "2026-11-02", ...o });

beforeEach(() => resetSavedCalls());

describe("readHistoryLocalFirst", () => {
  it("serves a stored day from disk with no broker call, and the bars equal the broker's bars", async () => {
    const t = await setup();
    const r = await readHistoryLocalFirst(t.deps, { params: P(), opts: {}, dataset: "rel-5m", enabled: false });
    expect(t.broker.calls).toEqual([]);
    expect(r.meta).toEqual({ source: "local", dataset: "rel-5m", localBars: 75, brokerCalls: 0 });
    expect(r.data.candles).toEqual(t.monday);
    expect(r.data).toMatchObject({ symbol: "NSE:RELIANCE", interval: "5m", partial: false });
    expect(r.data.freshness).toMatchObject({ source: "cache", provider: "dataset:rel-5m", class: "realtime", official: true, flags: ["local"], stale: false });
    expect(snapshot().byReason["local-history"]).toBe(1);
  });

  it("asks the broker only for what the dataset does not cover, and the merged bars equal a full broker read", async () => {
    const t = await setup();
    const r = await readHistoryLocalFirst(t.deps, { params: P({ to: "2026-11-03" }), opts: { accountId: "acc1" }, dataset: "rel-5m", enabled: false });
    expect(t.broker.calls).toHaveLength(1);
    expect(t.broker.calls[0].params.from).toBe(sec("2026-11-02T23:59:59+05:30") + 1);
    expect(t.broker.calls[0].opts.accountId).toBe("acc1");
    expect(r.meta).toMatchObject({ source: "mixed", brokerCalls: 1, localBars: 75 });
    const whole = (await createFakeHistory().history({ symbol: "NSE:RELIANCE", interval: "5m", from: sec("2026-11-02T00:00:00+05:30"), to: sec("2026-11-03T23:59:59+05:30") }, {})).candles;
    expect(r.data.candles).toEqual(whole);
    expect(r.data.freshness.flags).toContain("partly-local");
    expect(snapshot().byReason["local-history"]).toBeUndefined(); // a broker call was still needed
  });

  it("keeps the label honest: stored delayed or end-of-day bars are never called realtime", async () => {
    const t = await setup({ dataClass: "delayed", delaySec: 900, official: false });
    const local = await readHistoryLocalFirst(t.deps, { params: P(), opts: {}, dataset: "rel-5m", enabled: false });
    expect(local.data.freshness).toMatchObject({ class: "delayed", delaySec: 900, official: false });
    const mixed = await readHistoryLocalFirst(t.deps, { params: P({ to: "2026-11-03" }), opts: {}, dataset: "rel-5m", enabled: false });
    expect(mixed.data.freshness).toMatchObject({ class: "delayed", delaySec: 900, official: false });
    expect(mixed.data.freshness.flags).toContain("partly-local");
  });

  it("does nothing for the plain route unless market.history.localFirst is on, and then serves any covering dataset", async () => {
    const t = await setup();
    expect(await readHistoryLocalFirst(t.deps, { params: P(), opts: {}, enabled: false })).toBeNull();
    const on = await readHistoryLocalFirst(t.deps, { params: P(), opts: {}, enabled: true });
    expect(on.meta.dataset).toBe("rel-5m");
    // nothing stored for this symbol: fall through to the broker path
    expect(await readHistoryLocalFirst(t.deps, { params: P({ symbol: "NSE:INFY" }), opts: {}, enabled: true })).toBeNull();
    // a range the dataset does not touch
    expect(await readHistoryLocalFirst(t.deps, { params: P({ from: "2026-12-01", to: "2026-12-02" }), opts: {}, enabled: true })).toBeNull();
  });

  it("is explicit about a dataset that cannot answer", async () => {
    const t = await setup();
    await expect(readHistoryLocalFirst(t.deps, { params: P({ symbol: "NSE:INFY" }), opts: {}, dataset: "rel-5m", enabled: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readHistoryLocalFirst(t.deps, { params: P(), opts: {}, dataset: "Bad Name", enabled: false })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(readHistoryLocalFirst(t.deps, { params: { symbol: "NSE:RELIANCE", interval: "5m", countback: 10 }, opts: {}, dataset: "rel-5m", enabled: false })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // countback on the plain route is simply not served locally
    expect(await readHistoryLocalFirst(t.deps, { params: { symbol: "NSE:RELIANCE", interval: "5m", countback: 10 }, opts: {}, enabled: true })).toBeNull();
  });

  it("leaves a symbol it cannot read, or a backwards range, to the normal path", async () => {
    const t = await setup();
    expect(await readHistoryLocalFirst(t.deps, { params: P({ symbol: "not a symbol" }), opts: {}, enabled: true })).toBeNull();
    expect(await readHistoryLocalFirst(t.deps, { params: P({ from: "2026-11-03", to: "2026-11-02" }), opts: {}, enabled: true })).toBeNull();
  });
});
