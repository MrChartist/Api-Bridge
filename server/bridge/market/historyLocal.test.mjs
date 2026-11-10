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

describe("RDATA-02 a mixed answer carries partial and the worst class of any part", () => {
  const wrap = (broker, mutate) => {
    let n = 0;
    return async (p, o) => {
      const r = await broker.history(p, o);
      n += 1;
      return mutate(r, n);
    };
  };
  it("a partial broker tail is reported as partial", async () => {
    const t = await setup();
    const history = wrap(t.broker, (r) => ({ ...r, candles: r.candles.slice(0, 3), partial: true }));
    const r = await readHistoryLocalFirst({ ...t.deps, history }, { params: P({ to: "2026-11-03" }), opts: {}, dataset: "rel-5m", enabled: false });
    expect(r.data.partial).toBe(true);
    expect(r.data.candles).toHaveLength(75 + 3);
  });

  it("an end-of-day head with a real-time tail is labelled end-of-day and unofficial", async () => {
    const t = await setup();
    // the dataset holds only Monday; ask Friday 30 Oct to Tuesday: a head gap and a tail gap
    const history = wrap(t.broker, (r, n) => ({ ...r, freshness: { ...r.freshness, class: n === 1 ? "eod" : "realtime", official: n !== 1, delaySec: n === 1 ? 86400 : null, flags: n === 1 ? ["backup"] : [] } }));
    const r = await readHistoryLocalFirst({ ...t.deps, history }, { params: P({ from: "2026-10-30", to: "2026-11-03" }), opts: {}, dataset: "rel-5m", enabled: false });
    expect(r.meta.brokerCalls).toBe(2);
    expect(r.data.freshness).toMatchObject({ class: "eod", official: false, delaySec: 86400 });
    expect(r.data.freshness.flags).toEqual(expect.arrayContaining(["backup", "partly-local"]));
  });

  it("a delayed part beats real-time parts, whichever gap it is", async () => {
    const t = await setup();
    const history = wrap(t.broker, (r, n) => ({ ...r, freshness: { ...r.freshness, class: n === 1 ? "delayed" : "realtime", delaySec: n === 1 ? 900 : null } }));
    const r = await readHistoryLocalFirst({ ...t.deps, history }, { params: P({ from: "2026-10-30", to: "2026-11-03" }), opts: {}, dataset: "rel-5m", enabled: false });
    expect(r.data.freshness).toMatchObject({ class: "delayed", delaySec: 900 });
  });
});

describe("RDATA-03 from inside a daily or weekly bar still gets that bar", () => {
  const dayBars = (days) => days.map((d) => ({ time: sec(`${d}T00:00:00+05:30`), open: 1, high: 2, low: 1, close: 1.5, volume: 1 }));
  async function daily(days, interval = "1d") {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-hl-"));
    writeDatasetFixture(dataDir, "ds", { series: [{ symbol: "NSE:RELIANCE", interval, bars: dayBars(days), coverage: { from: sec(`${days[0]}T00:00:00+05:30`), to: sec(`${days.at(-1)}T23:59:59+05:30`) } }] });
    return { store: createLocalStore({ dataDir }), history: async () => { throw new Error("no broker call expected"); }, now: () => NOW };
  }
  it("1d: from at noon keeps that day's bar", async () => {
    const deps = await daily(["2026-11-02", "2026-11-03"]);
    const r = await readHistoryLocalFirst(deps, { params: { symbol: "NSE:RELIANCE", interval: "1d", from: "2026-11-02T12:00", to: "2026-11-03" }, opts: {}, dataset: "ds", enabled: false });
    expect(r.data.candles).toHaveLength(2);
  });
  it("1w: from on a Wednesday keeps that week's bar (stamped on its Monday)", async () => {
    const deps = await daily(["2026-10-26", "2026-11-02"], "1w");
    const r = await readHistoryLocalFirst(deps, { params: { symbol: "NSE:RELIANCE", interval: "1w", from: "2026-10-28", to: "2026-11-02" }, opts: {}, dataset: "ds", enabled: false });
    expect(r.data.candles).toHaveLength(2);
  });
  it("a mixed 1d answer stamps the broker's days at IST midnight like the stored ones", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-hl-"));
    writeDatasetFixture(dataDir, "ds", { series: [{ symbol: "NSE:RELIANCE", interval: "1d", bars: dayBars(["2026-11-02"]), coverage: { from: sec("2026-11-02T00:00:00+05:30"), to: sec("2026-11-02T23:59:59+05:30") } }] });
    const broker = createFakeHistory();
    const r = await readHistoryLocalFirst({ store: createLocalStore({ dataDir }), history: broker.history, now: () => NOW }, { params: { symbol: "NSE:RELIANCE", interval: "1d", from: "2026-11-02", to: "2026-11-04" }, opts: {}, dataset: "ds", enabled: false });
    expect(r.data.candles.map((c) => new Date(c.time * 1000 + 19800000).toISOString().slice(0, 16))).toEqual(["2026-11-02T00:00", "2026-11-03T00:00", "2026-11-04T00:00"]);
  });
});
