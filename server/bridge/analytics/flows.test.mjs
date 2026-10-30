import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeError } from "../core/errors.mjs";
import { demoFiiDiiHistory, flowsRoutes, netStreak, parseFiiDii } from "./flows.mjs";

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

  describe("persistence", () => {
    const dirs = [];
    afterEach(() => {
      for (const d of dirs.splice(0)) {
        try { chmodSync(d, 0o700); } catch {}
        rmSync(d, { recursive: true, force: true });
      }
    });
    const tmp = () => {
      const d = mkdtempSync(join(tmpdir(), "fiidii-"));
      dirs.push(d);
      return d;
    };
    const mk = (dataDir, responses, logger) => {
      let i = 0;
      const fiiDiiFetcher = async () => responses[Math.min(i++, responses.length - 1)];
      const [[, , , h]] = flowsRoutes({ fiiDiiFetcher, clock: { now: () => 5_000_000 }, paths: { dataDir }, logger });
      return h;
    };
    const file = (d) => join(d, "analytics", "fii-dii.json");

    it("survives a restart, writes 0600, and merges with newest source winning", async () => {
      const d = tmp();
      await mk(d, [nse("29-Oct-2026", 100, -50)])(ctx());
      expect(statSync(file(d)).mode & 0o777).toBe(0o600);
      const r = await mk(d, [nse("30-Oct-2026", 200, -60)])(ctx("days=5"));
      expect(r.meta.available).toBe(2);
      expect(r.data.days.map((x) => x.date)).toEqual(["2026-10-30", "2026-10-29"]);
      const r2 = await mk(d, [nse("29-Oct-2026", 999, 1)])(ctx("days=5"));
      expect(r2.data.days.find((x) => x.date === "2026-10-29").fii.net).toBe(999);
      expect(r2.meta.available).toBe(2);
      expect(readdirSync(join(d, "analytics")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    });

    it("serves persisted rows when the fetch fails", async () => {
      const d = tmp();
      await mk(d, [nse("29-Oct-2026", 1, 1)])(ctx());
      const r = await mk(d, [new BridgeError("UPSTREAM_ERROR", "down")])(ctx());
      expect(r.data.days.length).toBe(1);
      expect(r.meta.stale).toBe(true);
    });

    it("moves a corrupt file aside and carries on", async () => {
      const d = tmp();
      mkdirSync(join(d, "analytics"));
      writeFileSync(file(d), "{not json");
      const r = await mk(d, [nse("30-Oct-2026", 1, 2)])(ctx());
      expect(r.meta.available).toBe(1);
      expect(readdirSync(join(d, "analytics")).some((f) => f.startsWith("fii-dii.json.corrupt-"))).toBe(true);
      expect(JSON.parse(readFileSync(file(d), "utf8")).rows.length).toBe(1);
    });

    it("keeps only the newest 250 sessions, ordered newest first", async () => {
      const d = tmp();
      const rows = [];
      for (let i = 0; i < 260; i++) {
        const dt = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
        rows.push({ date: dt, fii: { buy: 1, sell: 1, net: 0 }, dii: { buy: 1, sell: 1, net: 0 } });
      }
      mkdirSync(join(d, "analytics"));
      writeFileSync(file(d), JSON.stringify({ version: 1, rows: rows.sort(() => 0.5 - Math.random()) }));
      const r = await mk(d, [nse("30-Oct-2026", 1, 1)])(ctx("days=60"));
      expect(r.meta.available).toBe(250);
      const dates = r.data.days.map((x) => x.date);
      expect(dates).toEqual([...dates].sort().reverse());
      expect(JSON.parse(readFileSync(file(d), "utf8")).rows.length).toBe(250);
    });

    it("never fails a request on disk errors", async () => {
      const d = tmp();
      writeFileSync(join(d, "analytics"), "i am a file, not a dir");
      const warnings = [];
      const r = await mk(d, [nse("30-Oct-2026", 1, 2)], { warn: (...a) => warnings.push(a) })(ctx());
      expect(r.data.days.length).toBe(1);
      expect(warnings.length).toBeGreaterThan(0);
    });
  });
});

describe("fii-dii demo history", () => {
  it("is weekdays only, before the given day, newest first, consistent sides and the same every time", () => {
    const rows = demoFiiDiiHistory("2026-10-30", 40);
    expect(rows).toHaveLength(40);
    expect(rows[0].date).toBe("2026-10-29");
    for (const r of rows) {
      expect([0, 6]).not.toContain(new Date(`${r.date}T00:00:00Z`).getUTCDay());
      for (const s of [r.fii, r.dii]) expect(s.buy - s.sell).toBeCloseTo(s.net, 1);
    }
    expect(rows.map((r) => r.date)).toEqual([...rows.map((r) => r.date)].sort().reverse());
    expect(demoFiiDiiHistory("2026-10-30", 40)).toEqual(rows);
    expect(netStreak(rows, "fii").count).toBeGreaterThan(0);
  });
});
