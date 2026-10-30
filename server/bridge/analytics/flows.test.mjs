import { describe, expect, it } from "vitest";
import { BridgeError } from "../core/errors.mjs";
import { flowsRoutes, netStreak, parseFiiDii } from "./flows.mjs";

const nse = (date, fii, dii) => [
  { category: "DII", date, buyValue: "1,000.50", sellValue: String(1000.5 - dii), netValue: String(dii) },
  { category: "FII/FPI ", date, buyValue: "2000", sellValue: String(2000 - fii), netValue: String(fii) },
];
const ctx = (qs = "") => ({ requestId: "r1", query: new URLSearchParams(qs) });
const setup = (responses) => {
  let t = 1_000_000;
  const calls = [];
  const fiiDiiFetcher = async () => {
    calls.push(1);
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  const [[, , , h]] = flowsRoutes({ fiiDiiFetcher, clock: { now: () => t } });
  return { h, calls, tick: (ms) => (t += ms) };
};

describe("fii-dii", () => {
  it("declares its route", () => {
    const [[m, p, o]] = flowsRoutes({ fiiDiiFetcher: async () => [] });
    expect([m, p, o]).toEqual(["GET", "/v1/analytics/fii-dii", { scope: "read" }]);
  });

  it("parses rows and reports meta", async () => {
    const { h } = setup([nse("30-Oct-2026", -500, 700)]);
    const r = await h(ctx());
    expect(r.data.days[0]).toEqual({ date: "2026-10-30", fii: { buy: 2000, sell: 2500, net: -500 }, dii: { buy: 1000.5, sell: 300.5, net: 700 } });
    expect(r.meta.source).toBe("nse");
    expect(r.meta.fetchedAt).toBe(new Date(1_000_000).toISOString());
  });

  it("caches within the TTL, refetches after, and builds history", async () => {
    const { h, calls, tick } = setup([nse("29-Oct-2026", 100, -50), nse("30-Oct-2026", 200, -60)]);
    await h(ctx());
    await h(ctx());
    expect(calls.length).toBe(1);
    tick(6 * 60_000);
    const r = await h(ctx("days=5"));
    expect(calls.length).toBe(2);
    expect(r.data.days.map((d) => d.date)).toEqual(["2026-10-30", "2026-10-29"]);
    expect(r.data.rolling.find((w) => w.window === 5)).toEqual({ window: 5, days: 2, fiiNet: 300, diiNet: -110 });
    expect(r.data.streak.fii).toEqual({ direction: "buying", count: 2 });
    expect(r.data.streak.dii).toEqual({ direction: "selling", count: 2 });
  });

  it("serves stale data when a refresh fails", async () => {
    const { h, tick } = setup([nse("30-Oct-2026", 1, 1), new BridgeError("UPSTREAM_ERROR", "down")]);
    await h(ctx());
    tick(10 * 60_000);
    const r = await h(ctx());
    expect(r.meta.stale).toBe(true);
  });

  it("rejects bad days with VALIDATION_FAILED", async () => {
    const { h } = setup([nse("30-Oct-2026", 1, 1)]);
    for (const q of ["days=0", "days=61", "days=abc"]) await expect(h(ctx(q))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("maps upstream failures to BridgeError, never raw", async () => {
    await expect(setup([new BridgeError("UPSTREAM_ERROR", "refused")]).h(ctx())).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    const raw = setup([new TypeError("boom")]).h(ctx());
    await expect(raw).rejects.toBeInstanceOf(BridgeError);
    await expect(raw).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    await expect(setup([{ not: "array" }]).h(ctx())).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    await expect(setup([[]]).h(ctx())).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("netStreak handles flips and flat", () => {
    const d = (n) => ({ fii: { net: n } });
    expect(netStreak([d(5), d(3), d(-1), d(4)], "fii")).toEqual({ direction: "buying", count: 2 });
    expect(netStreak([d(0)], "fii")).toEqual({ direction: "flat", count: 0 });
    expect(netStreak([], "fii").count).toBe(0);
  });

  it("parseFiiDii skips malformed rows", () => {
    expect(parseFiiDii([...nse("30-Oct-2026", 1, 2), { category: "X" }]).length).toBe(1);
  });
});
