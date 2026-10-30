import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { budgetSummary } from "../ratelimit/budget.mjs";
import { listJobs } from "../ratelimit/jobs.mjs";
import { createManualClock } from "../ratelimit/fake.mjs";
import { createLiveFacts } from "./liveFacts.mjs";
import { createPrewarm, istDate, nextAfterClose, nextWeekday } from "./prewarm.mjs";

const T0 = Date.parse("2026-10-30T05:00:00Z"); // Friday 10:30 IST
let dirs = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function candles(days = 30) {
  const out = [];
  for (let i = days; i >= 0; i -= 1) {
    const t = T0 - i * 86_400_000;
    out.push({ time: Math.floor(t / 1000), open: 100, high: 105, low: 95, close: 101 + i, volume: 1000 });
  }
  return out;
}

function setup({ userActiveAt = () => -Infinity } = {}) {
  const clock = createManualClock(T0);
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-prewarm-"));
  dirs.push(dataDir);
  let calls = 0;
  const marketData = {
    async history() {
      calls += 1;
      return { candles: candles(), freshness: { source: "broker" } };
    },
  };
  const liveFacts = createLiveFacts({ marketData, clock, dataDir });
  const universes = { resolve: async (name) => (name === "FNO" ? ["NSE:RELIANCE", "NSE:TCS", "NSE:ZZZ"] : []) };
  const prewarm = createPrewarm({ liveFacts, universes, scheduler: { userActiveAt }, clock });
  return { clock, liveFacts, prewarm, calls: () => calls, dataDir };
}

describe("scanner pre-warm", () => {
  it("fills the daily cache scans read, once, and shows its progress while it runs", async () => {
    const { prewarm, liveFacts, calls } = setup();
    const seen = [];
    const p = prewarm.run();
    seen.push(listJobs().map((j) => j.label));
    const r = await p;
    expect(seen[0]).toEqual(["Preparing scans"]);
    expect(r.fetched).toBe(r.total); // NIFTY50 + 3 FNO names (RELIANCE and TCS are in both)
    expect(r.total).toBe(51);
    expect(calls()).toBe(51);
    expect(listJobs()).toEqual([]);
    // A scan that reads daily bars now costs no history call.
    const before = calls();
    await liveFacts.collect(["NSE:RELIANCE", "NSE:TCS"], { needs: new Set(["daily"]) }).catch(() => null);
    expect(calls()).toBe(before);
    // A second run fetches nothing.
    expect((await prewarm.run()).fetched).toBe(0);
  });

  it("waits while a person is using the broker", async () => {
    let active = true;
    const { prewarm, clock, calls } = setup({ userActiveAt: () => (active ? clock.now() : -Infinity) });
    const p = prewarm.run();
    await clock.advance(5000);
    expect(calls()).toBe(0);
    expect(listJobs()[0]).toMatchObject({ label: "Preparing scans", paused: true });
    expect(budgetSummary({ accounts: [] }).jobs[0].label).toBe("Preparing scans");
    active = false;
    await clock.advance(2500);
    await p;
    expect(calls()).toBe(51);
  });

  it("after the close, prepares the next trading day's cache", async () => {
    expect(nextWeekday("2026-10-30")).toBe("2026-11-02");
    expect(istDate(nextAfterClose(T0))).toBe("2026-10-30");
    expect(new Date(nextAfterClose(T0)).toISOString()).toBe("2026-10-30T10:20:00.000Z");
    expect(istDate(nextAfterClose(Date.parse("2026-10-30T11:00:00Z")))).toBe("2026-11-02");
    const { prewarm } = setup();
    const r = await prewarm.run({ forDay: "2026-11-02" });
    expect(r.forDay).toBe("2026-11-02");
    expect(r.fetched).toBe(51);
  });
});
