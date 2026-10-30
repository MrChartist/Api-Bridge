import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeMarketData } from "../market/fake.mjs";
import { closeHv, expectedMove, labelIvHv, logReturns, parkinsonHv, rankAndPercentile, rollingHv, volStatsRoutes } from "./volStats.mjs";

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {}
    rmSync(d, { recursive: true, force: true });
  }
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "volstats-"));
  dirs.push(d);
  return d;
};

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-30T10:00:00+05:30");
const ctx = (qs = "underlying=NIFTY") => ({ requestId: "r1", query: new URLSearchParams(qs) });

/** n daily candles with a deterministic zig-zag so HV is non-zero and varies. */
function candles(n, amp = 0.01) {
  let c = 25000;
  return Array.from({ length: n }, (_, i) => {
    c *= 1 + (i % 2 ? amp : -amp) * (1 + (i % 7) / 10);
    return { time: Math.floor((T0 - (n - i) * DAY) / 1000), open: c, high: c * 1.005, low: c * 0.995, close: c, volume: 1 };
  });
}
const leg = (iv) => ({ ltp: 100, iv, oi: 1, volume: 1 });
function setup({ n = 120, iv = 15, deps = {}, expiries } = {}) {
  const md = createFakeMarketData({ prices: { "NSE:NIFTY": 25000 }, clock: { now: () => T0 } });
  md.setCandles("NSE:NIFTY", "1d", candles(n));
  md.setExpiries("NIFTY", expiries ?? ["2026-11-01", "2026-11-10", "2026-11-17", "2026-11-24", "2026-12-01"]);
  for (const e of ["2026-11-01", "2026-11-10", "2026-11-17", "2026-11-24", "2026-12-01"]) {
    md.setChain("NIFTY", e, { underlyingLtp: 25000, lotSize: 75, rows: [24950, 25000, 25050].map((k) => ({ strike: k, ce: leg(iv), pe: leg(iv + 1) })) });
  }
  let t = T0;
  const clock = { now: () => t };
  const mk = (extraDeps = {}) => volStatsRoutes({ marketData: md, clock, ...deps, ...extraDeps });
  return { md, mk, advance: (ms) => (t += ms) };
}
const handlers = (routes) => Object.fromEntries(routes.map(([, p, , h]) => [p, h]));

describe("pure maths", () => {
  it("computes close-to-close HV by hand", () => {
    const closes = [100, 101, 100, 101, 100];
    const r = logReturns(closes);
    const m = r.reduce((s, x) => s + x, 0) / r.length;
    const sd = Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1));
    expect(closeHv(closes, 4)).toBe(Math.round(sd * Math.sqrt(252) * 100 * 100) / 100);
    expect(closeHv(closes, 5)).toBeNull();
  });
  it("computes Parkinson HV", () => {
    const cs = Array.from({ length: 5 }, () => ({ high: 101, low: 100 }));
    const expected = Math.sqrt(Math.log(1.01) ** 2 / (4 * Math.log(2))) * Math.sqrt(252) * 100;
    expect(parkinsonHv(cs, 5)).toBeCloseTo(expected, 1);
    expect(parkinsonHv(cs, 6)).toBeNull();
  });
  it("ranks and percentiles the last value", () => {
    expect(rankAndPercentile([10, 20, 30, 15])).toEqual({ rank: 25, percentile: 25 });
    expect(rankAndPercentile([5])).toEqual({ rank: null, percentile: null });
    expect(rollingHv(candles(40).map((c) => c.close), 20)).toHaveLength(20);
  });
  it("labels and expected move", () => {
    expect([labelIvHv(1.2), labelIvHv(0.8), labelIvHv(1), labelIvHv(1.15), labelIvHv(null)]).toEqual(["rich", "cheap", "fair", "fair", null]);
    const m = expectedMove(25000, 20, 365);
    expect(m).toMatchObject({ oneSigma: 5000, lower: 20000, upper: 30000, pct: 20 });
    expect(expectedMove(25000, null, 5)).toBeNull();
  });
});

describe("routes", () => {
  it("declares read-scope GET routes", () => {
    const { mk } = setup();
    expect(mk().map(([m, p, o]) => [m, p, o])).toEqual([
      ["GET", "/v1/analytics/vol-stats", { scope: "read" }],
      ["GET", "/v1/analytics/vol-stats/term", { scope: "read" }],
    ]);
  });

  it("returns HV, IV from the first expiry with >= 3 days, spread and expected move", async () => {
    const { mk, md } = setup({ iv: 15 });
    const r = await handlers(mk())["/v1/analytics/vol-stats"](ctx());
    expect(r.data.iv.expiry).toBe("2026-11-10"); // 11-02 has under 3 days left
    expect(r.data.iv.atmIv).toBe(15.5);
    expect(r.data.hv.hv10).toBeGreaterThan(0);
    expect(r.data.hv.hv60).toBeGreaterThan(0);
    expect(r.data.hv.parkinson20).toBeGreaterThan(0);
    expect(r.data.ivVsHv.spread).toBeCloseTo(15.5 - r.data.hv.hv20, 2);
    expect(["rich", "cheap", "fair"]).toContain(r.data.ivVsHv.label);
    const dte = r.data.iv.daysToExpiry;
    expect(r.data.expectedMove.oneSigma).toBeCloseTo(25000 * 0.155 * Math.sqrt(dte / 365), 0);
    expect(r.data.hv20Rank.observations).toBe(120 - 20);
    expect(md.calls.find((c) => c[0] === "history")[1]).toMatchObject({ symbol: "NSE:NIFTY", interval: "1d", countback: 251 });
  });

  it("labels rich when IV is far above HV and cheap when far below", async () => {
    expect((await handlers(setup({ iv: 80 }).mk())["/v1/analytics/vol-stats"](ctx())).data.ivVsHv.label).toBe("rich");
    expect((await handlers(setup({ iv: 1 }).mk())["/v1/analytics/vol-stats"](ctx())).data.ivVsHv.label).toBe("cheap");
  });

  it("falls back to HV rank until 20 days of IV history, then ranks IV", async () => {
    const dataDir = tmp();
    const { mk, advance } = setup({ deps: { paths: { dataDir } } });
    const h = handlers(mk({ paths: { dataDir } }))["/v1/analytics/vol-stats"];
    let r = await h(ctx());
    expect(r.data).toMatchObject({ ivRank: null, ivPercentile: null, ivHistoryDays: 1 });
    expect(r.data.ivRankFallback.basis).toBe("hv20");
    expect(r.data.note).toMatch(/20 days/);
    // same IST day: still one point
    await h(ctx());
    expect((await h(ctx())).data.ivHistoryDays).toBe(1);
    // seed 25 older days of rising IV in the file, new route instance loads lazily
    const series = { NIFTY: Array.from({ length: 25 }, (_, i) => ({ date: new Date(Date.parse("2026-10-04T00:00:00Z") + i * DAY).toISOString().slice(0, 10), iv: 10 + i * 0.1 })) };
    writeFileSync(join(dataDir, "analytics", "iv-history.json"), JSON.stringify({ version: 1, series }));
    advance(0);
    r = await handlers(mk({ paths: { dataDir } }))["/v1/analytics/vol-stats"](ctx());
    expect(r.data.ivHistoryDays).toBe(26);
    expect(r.data.ivRankFallback).toBeNull();
    expect(r.data.ivRank).toBe(100); // 15.5 is the highest stored value
    expect(r.data.ivPercentile).toBeCloseTo((25 / 26) * 100, 1);
  });

  it("persists atomically with mode 0600, one point per IST day, capped at 400", async () => {
    const dataDir = tmp();
    const dir = join(dataDir, "analytics");
    mkdirSync(dir, { recursive: true });
    const old = Array.from({ length: 405 }, (_, i) => ({ date: new Date(Date.parse("2025-01-01T00:00:00Z") + i * DAY).toISOString().slice(0, 10), iv: 12 }));
    writeFileSync(join(dir, "iv-history.json"), JSON.stringify({ version: 1, series: { NIFTY: old } }));
    const { mk } = setup();
    await handlers(mk({ paths: { dataDir } }))["/v1/analytics/vol-stats"](ctx());
    const file = join(dir, "iv-history.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    expect(doc.series.NIFTY).toHaveLength(400);
    expect(doc.series.NIFTY.at(-1)).toEqual({ date: "2026-10-30", iv: 15.5 });
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("moves a corrupt file aside and still answers", async () => {
    const dataDir = tmp();
    mkdirSync(join(dataDir, "analytics"), { recursive: true });
    writeFileSync(join(dataDir, "analytics", "iv-history.json"), "{not json");
    const { mk } = setup();
    const r = await handlers(mk({ paths: { dataDir } }))["/v1/analytics/vol-stats"](ctx());
    expect(r.data.ivHistoryDays).toBe(1);
    expect(readdirSync(join(dataDir, "analytics")).some((f) => f.includes(".corrupt-"))).toBe(true);
  });

  it("never fails the request on disk errors", async () => {
    const dataDir = tmp();
    writeFileSync(join(dataDir, "analytics"), "a file where the directory should be");
    const warns = [];
    const { mk } = setup();
    const r = await handlers(mk({ paths: { dataDir }, logger: { warn: (...a) => warns.push(a) } }))["/v1/analytics/vol-stats"](ctx());
    expect(r.data.ivHistoryDays).toBe(1);
    expect(warns.length).toBeGreaterThan(0);
  });

  it("returns null IV pieces when no expiry has 3 days left", async () => {
    const { mk } = setup({ expiries: ["2026-11-01"] });
    const r = await handlers(mk())["/v1/analytics/vol-stats"](ctx());
    expect(r.data.iv.atmIv).toBeNull();
    expect(r.data.expectedMove).toBeNull();
    expect(r.data.ivVsHv.label).toBeNull();
    expect(r.data.ivHistoryDays).toBe(0);
  });

  it("validates input", async () => {
    const { mk } = setup();
    const h = handlers(mk())["/v1/analytics/vol-stats"];
    await expect(h(ctx(""))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(h(ctx("underlying=NIFTY&days=5"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(h(ctx("underlying=NIFTY&days=abc"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("term lists ATM IV for the next 4 expiries", async () => {
    const { mk } = setup({ iv: 15 });
    const r = await handlers(mk())["/v1/analytics/vol-stats/term"](ctx());
    expect(r.data.expiries.map((e) => e.expiry)).toEqual(["2026-11-01", "2026-11-10", "2026-11-17", "2026-11-24"]);
    expect(r.data.expiries.every((e) => e.atmIv === 15.5)).toBe(true);
    expect(r.data.termStructure).toBe("flat");
  });
});
