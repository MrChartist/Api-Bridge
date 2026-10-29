/**
 * The option sweep (docs/spec/p1-06-stocks.md §2.4, §2.6, §9.2): single flight (join, reuse, force), the background
 * gate never takes a window below 50 %, rate-limit pauses (Fyers never retried), cancel keeps finished chains, resume
 * after a restart, day roll, HV pass, throttled progress events, lease-driven auto-repeat, no secrets on disk.
 */
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { redact } from "../core/logger.mjs";
import { BridgeError } from "../core/errors.mjs";
import { createManualClock } from "../ratelimit/fake.mjs";
import { T0, fakeUniverse, legRows, sweepHarness } from "./__fixtures__/sweepHarness.mjs";

const keysOf = (h) => {
  const out = [];
  let since = 0;
  for (;;) {
    const p = h.sweeper.chains({ since, limit: 40 });
    out.push(...p.items.map((x) => x.key));
    since = p.nextCursor;
    if (!p.items.length || p.done) return { keys: out, page: p };
  }
};

describe("single flight", () => {
  it("a second start joins the running sweep; a start within minIntervalSeconds reuses the last one; force starts anew only when idle", async () => {
    const h = sweepHarness();
    const a = await h.sweeper.start({});
    expect(a.created).toBe(true);
    expect(a.job.status).toBe("running");
    const b = await h.sweeper.start({ force: true });
    expect(b).toMatchObject({ created: false, job: { id: a.job.id, joined: true } });
    await h.settle();
    expect(h.sweeper.current().status).toBe("done");
    const c = await h.sweeper.start({});
    expect(c).toMatchObject({ created: false, job: { id: a.job.id, reused: true } });
    const d = await h.sweeper.start({ force: true });
    expect(d.created).toBe(true);
    expect(d.job.id).not.toBe(a.job.id);
    await h.settle();
  });

  it("plans index keys (2 nearest + monthly) and stock keys (nearest monthly, plus the next in expiry week)", async () => {
    const h = sweepHarness();
    const r = await h.sweeper.start({});
    await h.settle();
    const { keys, page } = keysOf(h);
    // NIFTY: the 2 nearest (24 Nov is also November's monthly). 19 Nov is 4 days before the 23 Nov stock monthly, so
    // the next one is added too (§6.10).
    expect(r.job.progress.total).toBe(2 + 4);
    expect(keys.sort()).toEqual(["NIFTY|2026-11-24", "NIFTY|2026-12-01", "RELIANCE|2026-11-23", "RELIANCE|2026-12-29", "SBIN|2026-11-23", "SBIN|2026-12-29"]);
    expect(page.done).toBe(true);
    expect(Object.keys(page.hv).sort()).toEqual(["NIFTY", "RELIANCE", "SBIN"]);
  });
});

describe("budget", () => {
  it("over 1,000 scheduled calls the background gate never leaves a window below 50 % of its limit", { timeout: 60_000 }, async () => {
    const stocks = Array.from({ length: 500 }, (_, i) => `STK${i}`);
    const universe = { names: async () => ({ indices: [], stocks }), facts: async () => ({ expiries: ["2026-11-23", "2026-12-29"], strikeStep: 20 }), list: async () => ({ items: stocks.map((u) => ({ underlying: u, spot: `NSE:${u}` })) }) };
    const h = sweepHarness({ universe, perSecond: 10, shared: true, maxQuoteBatch: 20, cfg: { sweep: { maxMinutes: 60, hv: { source: "off" } } } });
    await h.sweeper.start({ method: "chain" });
    await h.settle(900_000, 250);
    expect(h.scheduler.takes.filter((t) => t.background).length).toBeGreaterThanOrEqual(1000);
    expect(h.sweeper.current().progress.done).toBe(1000);
    expect(h.scheduler.minRemaining()).toBeGreaterThanOrEqual(5);
    // every call went at background priority with the share (floor mode on a 10/s window)
    for (const c of h.marketData.calls) expect(c.opts).toMatchObject({ priority: "background", backgroundShare: 0.5 });
  });

  it("a 1/s window (floor = limit) is paced: no backgroundShare, at most share × the per-minute rate", async () => {
    const h = sweepHarness({ perSecond: 1, cfg: { sweep: { hv: { source: "off" } } } });
    await h.sweeper.start({ method: "chain" });
    await h.settle(600_000);
    const calls = h.marketData.calls.filter((c) => c.kind === "chain");
    expect(calls.length).toBe(6);
    for (const c of calls) expect(c.opts.backgroundShare).toBeUndefined();
    // never more than 30 per rolling minute (0.5 × 60/min), and never two in one second
    const at = calls.map((c) => c.at).sort((a, b) => a - b);
    for (let i = 1; i < at.length; i += 1) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(1000);
  });
});

describe("errors, cancel, resume", () => {
  it("UPSTREAM_RATE_LIMITED pauses and retries once; Fyers is never retried", async () => {
    let n = 0;
    const throttle = (kind) => (kind === "chain" && n++ === 0 ? new BridgeError("UPSTREAM_RATE_LIMITED", "slow down", { retryAfterMs: 3000 }) : null);
    const h = sweepHarness({ fail: throttle, cfg: { sweep: { hv: { source: "off" } } } });
    await h.sweeper.start({ method: "chain" });
    await h.settle();
    expect(h.sweeper.current()).toMatchObject({ status: "done", progress: { failed: 0 } });
    const chainAt = h.marketData.calls.filter((c) => c.kind === "chain").map((c) => c.at);
    expect(chainAt[1] - chainAt[0]).toBeGreaterThanOrEqual(3000);

    n = 0;
    const f = sweepHarness({ fail: throttle, broker: "fyers", cfg: { sweep: { hv: { source: "off" } } } });
    await f.sweeper.start({ method: "chain" });
    await f.settle();
    expect(f.sweeper.current()).toMatchObject({ status: "partial", progress: { failed: 1 } });
    expect(f.marketData.calls.filter((c) => c.kind === "chain")).toHaveLength(6);
  });

  it("cancel aborts and keeps the finished chains", async () => {
    const h = sweepHarness({ cfg: { sweep: { hv: { source: "off" } } }, perSecond: 1 });
    await h.sweeper.start({ method: "chain" });
    await h.clock.advance(2500);
    const j = await h.sweeper.cancel();
    expect(j.status).toBe("cancelled");
    const kept = keysOf(h).keys;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(6);
  });

  it("resumes a running job after a restart within 30 minutes without repeating keys; older jobs are marked interrupted", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "mcb-fno-")), "fno");
    const clock = createManualClock(T0);
    const a = sweepHarness({ dir, clock, perSecond: 1, cfg: { sweep: { hv: { source: "off" } } } });
    await a.sweeper.start({ method: "chain" });
    await clock.advance(3500);
    const before = keysOf(a).keys;
    expect(before.length).toBeGreaterThan(0);
    a.sweeper.stopTimers(); // the process goes away mid-run (state.json still says running)
    await a.sweeper.idle();
    // The aborted job was saved as cancelled by the abort; put the on-disk state back to "running" as a crash would.
    const state = a.store.readState();
    a.store.writeState({ ...state.job, status: "running", finishedAt: null });
    const b = sweepHarness({ dir, clock, perSecond: 1, cfg: { sweep: { hv: { source: "off" } } } });
    await b.sweeper.resume();
    await b.settle(600_000);
    const all = keysOf(b).keys;
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(6);
    const resumedCalls = b.marketData.calls.filter((c) => c.kind === "chain").map((c) => `${c.p.underlying}|${c.p.expiry}`);
    for (const k of before) expect(resumedCalls).not.toContain(k);

    const s = b.store.readState();
    b.store.writeState({ ...s.job, status: "running", finishedAt: null });
    await clock.advance(31 * 60_000);
    const c = sweepHarness({ dir, clock, cfg: { sweep: { hv: { source: "off" } } } });
    expect((await c.sweeper.resume()).status).toBe("interrupted");
  });
});

describe("day roll, HV, events, auto-repeat", () => {
  it("the next IST day starts empty: current() is NOT_FOUND", async () => {
    const h = sweepHarness({ cfg: { sweep: { hv: { source: "off" } } } });
    await h.sweeper.start({});
    await h.settle();
    expect(h.sweeper.current().status).toBe("done");
    await h.clock.advance(24 * 3600_000);
    await h.sweeper.tick();
    expect(() => h.sweeper.current()).toThrow(/No option sweep has run today/);
  });

  it("the HV pass runs after the chains and reports hv.done of hv.total", async () => {
    const h = sweepHarness();
    await h.sweeper.start({});
    await h.settle();
    const kinds = h.marketData.calls.map((c) => c.kind);
    expect(kinds.lastIndexOf("chain")).toBeLessThan(kinds.indexOf("history"));
    expect(h.sweeper.current().progress.hv).toEqual({ done: 3, total: 3 });
  });

  it("fno.sweep.progress is throttled to 1/s; fno.sweep.completed fires once", async () => {
    const h = sweepHarness({ perSecond: 1 });
    await h.sweeper.start({ method: "chain" });
    await h.settle(600_000);
    const prog = h.events.filter((e) => e.topic === "fno.sweep.progress").map((e) => e.at);
    for (let i = 1; i < prog.length; i += 1) if (prog[i] !== prog[i - 1]) expect(prog[i] - prog[i - 1]).toBeGreaterThanOrEqual(1000);
    expect(h.events.filter((e) => e.topic === "fno.sweep.completed")).toHaveLength(1);
    expect(h.events.find((e) => e.topic === "fno.sweep.completed").payload).toMatchObject({ status: "done", chains: 6, failed: 0 });
  });

  it("auto-repeat runs only while leased (background switch off by default) and stops when the lease expires", async () => {
    const h = sweepHarness({ cfg: { sweep: { hv: { source: "off" }, leaseSeconds: 180 } } });
    expect(h.sweeper.settings().background).toBe(false);
    expect(await h.sweeper.tick()).toBeNull(); // no lease, no sweep
    await h.sweeper.start({});
    await h.settle();
    h.sweeper.current({ lease: true });
    await h.clock.advance(121_000);
    const j = await h.sweeper.tick();
    expect(j?.requestedBy).toBe("auto");
    await h.settle();
    await h.clock.advance(200_000); // lease (180 s) expired
    expect(await h.sweeper.tick()).toBeNull();
  });
});

describe("store safety", () => {
  it("no token-shaped string under dataDir/fno after a sweep", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "mcb-fno-")), "fno");
    const h = sweepHarness({ dir });
    await h.sweeper.setSettings({ optIn: ["RELIANCE"] }, "key:k_admin01");
    await h.sweeper.start({});
    await h.settle();
    const filesUnder = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? filesUnder(join(d, f)) : [join(d, f)]));
    const tokenShaped = (text) => {
      for (let i = 0; i < text.length; i += 800) {
        const w = text.slice(i, i + 1000);
        if (redact(w) !== w) return true;
      }
      return false;
    };
    const files = filesUnder(dir);
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(tokenShaped("key mcb_abcdefgh12_secretpart")).toBe(true);
    for (const f of files) expect(tokenShaped(readFileSync(f, "latin1")), f).toBe(false);
  });
});

describe("master lookups, ΔOI basis, HV sources, spot reads", () => {
  /** A symbols fake with the real search's free-text rule: an exchange word in q filters unless exchange is given. */
  const wordAwareSymbols = () => ({
    async search(q) {
      const word = ["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"].includes(String(q.q).toUpperCase()) ? String(q.q).toUpperCase() : null;
      const exchange = q.exchange ?? word;
      return { items: q.kind === "OPT" && (!exchange || exchange === "NFO") ? legRows(q.underlying, q.expiry) : [], nextCursor: null };
    },
  });

  it("stocks named BSE and MCX get their option legs (an explicit exchange beats the parsed word)", async () => {
    const h = sweepHarness({ universe: fakeUniverse({ indices: [], stocks: ["BSE", "MCX"] }), symbols: wordAwareSymbols(), cfg: { sweep: { hv: { source: "off" } } } });
    await h.sweeper.start({ method: "quotes" });
    await h.settle();
    expect(h.sweeper.current()).toMatchObject({ status: "done", progress: { done: 4, failed: 0 } });
    expect(keysOf(h).keys.sort()).toEqual(["BSE|2026-11-23", "BSE|2026-12-29", "MCX|2026-11-23", "MCX|2026-12-29"]);
  });

  it("ΔOI on the quotes path uses the recorder's previous-day OI (basis recorder, §6.11 worked figure)", async () => {
    const reads = [];
    const recorder = {
      async snapshots(p) {
        reads.push(p);
        // 18 Nov 15:29: 12,45,000 on every strike of the window
        const k = Array.from({ length: 41 }, (_, i) => 1260 + i * 20);
        return { snapshots: [{ slot: p.toMs - 60_000, k, ce: { oi: k.map(() => 1_245_000) }, pe: { oi: k.map(() => 1_245_000) } }] };
      },
    };
    const calendar = () => ({ prevTradingDay: (d) => (d === "2026-11-19" ? "2026-11-18" : null) });
    const h = sweepHarness({ universe: fakeUniverse({ indices: [], stocks: ["RELIANCE"] }), recorder, oi: 1_302_500, reference: { calendar }, cfg: { sweep: { hv: { source: "off" } } } });
    await h.sweeper.start({ method: "quotes" });
    await h.settle();
    const line = h.sweeper.chains({ since: 0, limit: 40 }).items.find((x) => x.key === "RELIANCE|2026-11-23");
    expect(line.method).toBe("quotes");
    const leg = line.chain.rows[0].ce;
    expect(leg).toMatchObject({ oiChange: 57_500, oiChangeBasis: "recorder" });
    // one in-process read per key, ending at the previous trading day's close
    expect(reads.length).toBe(2);
    expect(reads[0]).toMatchObject({ underlying: "RELIANCE", expiry: "2026-11-23", toMs: Date.parse("2026-11-18T15:30:00+05:30"), fields: ["oi"] });
  });

  it("without a recorder the quotes path falls back to the day baseline", async () => {
    const h = sweepHarness({ universe: fakeUniverse({ indices: [], stocks: ["RELIANCE"] }), cfg: { sweep: { hv: { source: "off" } } } });
    await h.sweeper.start({ method: "quotes" });
    await h.settle();
    const line = h.sweeper.chains({ since: 0, limit: 40 }).items[0];
    expect(line.chain.rows[0].ce.oiChangeBasis).toBe("day-baseline");
  });

  for (const source of ["backup", "auto"]) {
    it(`hv.source "${source}": HV20 from the backup service's time-range history, no broker history call`, async () => {
      const asked = [];
      const backupData = {
        status: () => ({ enabled: true }),
        async history(p) {
          asked.push(p);
          const closes = Array.from({ length: 40 }, (_, i) => 100 * Math.exp(0.01 * Math.sin(i)));
          return { candles: closes.map((close, i) => ({ time: Math.floor(p.fromMs / 1000) + i * 86_400, close })) };
        },
      };
      const h = sweepHarness({ backupData, cfg: { sweep: { hv: { source } } } });
      await h.sweeper.start({});
      await h.settle();
      const page = keysOf(h).page;
      for (const u of ["NIFTY", "RELIANCE", "SBIN"]) expect(Number.isFinite(page.hv[u])).toBe(true);
      expect(h.marketData.calls.filter((c) => c.kind === "history")).toHaveLength(0);
      expect(asked[0]).toMatchObject({ interval: "1d", toMs: expect.any(Number) });
      expect(asked[0].fromMs).toBeLessThan(asked[0].toMs);
      expect(asked[0]).not.toHaveProperty("countback");
    });
  }

  it("hv.source auto uses the broker when the backup service is off", async () => {
    const backupData = { status: () => ({ enabled: false }), history: async () => ({ candles: [] }) };
    const h = sweepHarness({ backupData });
    await h.sweeper.start({});
    await h.settle();
    expect(h.marketData.calls.filter((c) => c.kind === "history")).toHaveLength(3);
  });

  it("the chain method reads no spots (each chain call carries its own)", async () => {
    const h = sweepHarness({ cfg: { sweep: { hv: { source: "off" } } } });
    await h.sweeper.start({ method: "chain" });
    await h.settle();
    expect(h.marketData.calls.filter((c) => c.kind === "quote")).toHaveLength(0);
  });
});
