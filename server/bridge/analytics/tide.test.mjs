import { mkdtempSync, rmSync, readFileSync, statSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aggressorSide, createTideStore, intervalFlow, istDay, midPrice, recordTide, SENTIMENT_THRESHOLD, tideRoutes, tideSentiment, tideSnapshot } from "./tide.mjs";
import { createFakeMarketData } from "../market/fake.mjs";

const T0 = Date.parse("2026-10-27T05:00:00Z"); // 10:30 IST
const MIN = 60_000;
const leg = (volume, ltp, bid, ask) => ({ volume, ltp, bid, ask });
const chainOf = (rows, lotSize = 10) => ({ underlying: "NIFTY", underlyingLtp: 25000, lotSize, rows: rows.map(([strike, ce, pe]) => ({ strike, ce, pe })) });

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tide-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("pure helpers", () => {
  it("computes mid and the aggressor proxy", () => {
    expect(midPrice({ bid: 99, ask: 101, ltp: 100.5 })).toBe(100);
    expect(midPrice({ bid: null, ask: 101, ltp: 100.5 })).toBe(100.5);
    expect(aggressorSide({ bid: 99, ask: 101, ltp: 101 })).toBe("buy");
    expect(aggressorSide({ bid: 99, ask: 101, ltp: 99 })).toBe("sell");
    expect(aggressorSide({ bid: 99, ask: 101, ltp: 100 })).toBeNull();
    expect(aggressorSide({ bid: null, ask: 101, ltp: 101 })).toBeNull();
  });
  it("estimates interval premium and ignores resets and new contracts", () => {
    const a = tideSnapshot(chainOf([[25000, leg(100, 100, 99, 101), leg(50, 80, 79, 81)], [25100, leg(10, 50, 49, 51), null]]), 0);
    const b = tideSnapshot(chainOf([[25000, leg(110, 101, 99, 101), leg(60, 79, 79, 81)], [25100, leg(5, 50, 49, 51), leg(7, 5, 4, 6)]]), 1);
    const { flow, byStrike } = intervalFlow(a, b, 10);
    expect(flow.callPremium).toBe(10 * 100 * 10);
    expect(flow.callBuy).toBe(10_000);
    expect(flow.putPremium).toBe(10 * 80 * 10);
    expect(flow.putSell).toBe(8000);
    expect(byStrike.size).toBe(1);
  });
  it("labels sentiment against the threshold", () => {
    const f = (o) => ({ callPremium: 0, putPremium: 0, callBuy: 0, callSell: 0, putBuy: 0, putSell: 0, ...o });
    expect(tideSentiment(f({})).label).toBe("neutral");
    expect(tideSentiment(f({ callBuy: 60, putSell: 40 })).label).toBe("bullish");
    expect(tideSentiment(f({ callSell: 60, putBuy: 40 })).label).toBe("bearish");
    expect(tideSentiment(f({ callBuy: 52, putBuy: 48 }))).toMatchObject({ label: "neutral", threshold: SENTIMENT_THRESHOLD });
  });
  it("uses the IST day", () => {
    expect(istDay(Date.parse("2026-10-27T18:29:00Z"))).toBe("2026-10-27");
    expect(istDay(Date.parse("2026-10-27T18:31:00Z"))).toBe("2026-10-28");
  });
});

function setup(extra = {}) {
  const clock = { t: T0, now: () => clock.t };
  const md = createFakeMarketData({ prices: { "NSE:NIFTY": 25000 }, clock });
  md.setExpiries("NIFTY", ["2026-10-20", "2026-10-27", "2026-11-03"]);
  const paths = { dataDir: dir };
  const deps = { marketData: md, clock, paths, ...extra };
  const [[, , , handler]] = tideRoutes(deps);
  const call = (query = "underlying=NIFTY&expiry=2026-10-27") => handler({ query: new URLSearchParams(query), requestId: "r1", signal: undefined, requireAccountAccess() {}, auth: {} });
  return { clock, md, deps, call };
}
const setVol = (md, ce, pe, expiry = "2026-10-27") => md.setChain("NIFTY", expiry, chainOf([[25000, ce, pe]]));

describe("route", () => {
  it("builds the series across calls and respects min spacing", async () => {
    const { clock, md, call } = setup();
    setVol(md, leg(100, 100, 99, 101), leg(100, 80, 79, 81));
    const first = (await call()).data;
    expect(first.series).toEqual([]);
    expect(first.sentiment.label).toBe("neutral");
    clock.t += 5_000;
    expect((await call()).data.recorded).toBe(false);
    clock.t += 5 * MIN;
    setVol(md, leg(120, 101, 99, 101), leg(110, 79, 79, 81)); // calls bought 20, puts sold 10
    const second = (await call()).data;
    expect(second.series).toHaveLength(1);
    expect(second.series[0]).toMatchObject({ callPremium: 20 * 100 * 10, putPremium: 10 * 80 * 10, net: 12_000, cumulativeNet: 12_000, cumulativeDeltaAdjusted: 28_000 });
    expect(second.totals).toMatchObject({ callPremium: 20_000, putPremium: 8000, net: 12_000, unclassified: 0 });
    expect(second.sentiment).toMatchObject({ label: "bullish", proxy: true });
    expect(second.topStrikes[0]).toMatchObject({ strike: 25000, totalPremium: 28_000 });
    clock.t += 5 * MIN;
    setVol(md, leg(120, 101, 99, 101), leg(130, 79, 79, 81)); // puts sold 20 more
    const third = (await call("underlying=NIFTY&expiry=2026-10-27&windowMin=3")).data;
    expect(third.series).toHaveLength(1);
    expect(third.totals.cumulativeNet).toBe(12_000 - 16_000);
    expect(third.window).toMatchObject({ minutes: 3, putPremium: 16_000 });
    expect(third.notes.join(" ")).toMatch(/proxy/);
  });

  it("defaults to the nearest upcoming expiry and validates input", async () => {
    const { md, call } = setup();
    setVol(md, leg(1, 10, 9, 11), leg(1, 10, 9, 11), "2026-10-27");
    expect((await call("underlying=NIFTY")).data.expiry).toBe("2026-10-27");
    await expect(call("")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(call("underlying=../x")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(call("underlying=NIFTY&expiry=bad")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(call("underlying=NIFTY&windowMin=0")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("persists 0600, reloads lazily, and resets on a new IST day", async () => {
    const a = setup();
    setVol(a.md, leg(100, 100, 99, 101), leg(100, 80, 79, 81));
    await a.call();
    a.clock.t += 5 * MIN;
    setVol(a.md, leg(120, 101, 99, 101), leg(100, 80, 79, 81));
    await a.call();
    const file = join(dir, "analytics", "tide-NIFTY.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).points).toHaveLength(1);

    const b = setup(); // fresh in-memory store, same dir and day
    b.clock.t = a.clock.t + MIN;
    setVol(b.md, leg(130, 101, 99, 101), leg(100, 80, 79, 81));
    const r = (await b.call()).data;
    expect(r.intervals).toBe(1);
    expect(r.totals.callPremium).toBe(20_000);

    const c = setup();
    c.clock.t = T0 + 24 * 60 * MIN;
    setVol(c.md, leg(130, 101, 99, 101), leg(100, 80, 79, 81));
    expect((await c.call()).data.intervals).toBe(0);
  });

  it("never fails a request on disk errors, or on a corrupt file", async () => {
    mkdirSync(join(dir, "analytics"), { recursive: true });
    writeFileSync(join(dir, "analytics", "tide-NIFTY.json"), "{not json");
    const bad = setup();
    bad.deps.paths.dataDir = join(dir, "analytics", "tide-NIFTY.json", "nope"); // under a file: mkdir fails
    setVol(bad.md, leg(1, 10, 9, 11), leg(1, 10, 9, 11));
    const r = (await bad.call()).data;
    expect(r.persistence).toBe("failed");
    expect(r.recorded).toBe(true);
  });

  it("bounds the ring and the series", () => {
    const clock = { t: T0, now: () => clock.t };
    const store = createTideStore({ clock, maxSnapshots: 3, maxPoints: 4, minIntervalMs: 1000 });
    for (let i = 0; i < 10; i++) {
      clock.t = T0 + i * 2000;
      store.record("NIFTY", "e", chainOf([[25000, leg(i * 10, 100, 99, 101), leg(0, 80, 79, 81)]]));
    }
    const st = store.session("NIFTY");
    expect(st.ring).toHaveLength(3);
    expect(st.points).toHaveLength(4);
    expect(existsSync(join(dir, "analytics"))).toBe(false);
  });
});

describe("recordTide", () => {
  it("records into the same store the route reads", async () => {
    const { clock, md, deps, call } = setup();
    setVol(md, leg(100, 100, 99, 101), leg(100, 80, 79, 81));
    expect(await recordTide(deps, "nifty")).toMatchObject({ underlying: "NIFTY", expiry: "2026-10-27", recorded: true });
    clock.t += 5 * MIN;
    setVol(md, leg(120, 101, 99, 101), leg(100, 80, 79, 81));
    expect((await call("underlying=NIFTY")).data.intervals).toBe(1);
  });
});
