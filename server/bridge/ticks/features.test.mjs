/**
 * The second round of the tick research layer: depth, disk limits, compression, merged stores, output logs,
 * createReplayHub, verifySignal and the `mc-bridge ticks` command.
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ticksCommand } from "./cli.mjs";
import {
  auditTickLog,
  compressDay,
  createArrayStore,
  createOutputLog,
  createReplayHub,
  createTickLog,
  createTickLogStore,
  decodeTick,
  defineSignal,
  encodeTick,
  listTickDays,
  mergeStores,
  readOutputs,
  runHistorical,
  runLive,
  verifySignal,
  windowSum,
} from "./index.mjs";

const T0 = Date.parse("2026-11-18T09:15:00+05:30");
const all = async (it) => {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
};
const lvl = (price, qty, orders = null) => ({ price, qty, orders });

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ticks-features-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A stream with depth on every tick, for two symbols including an option. */
function depthTicks(n = 1500) {
  let seed = 5;
  const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  const syms = ["NSE:NIFTY", "NFO:NIFTY-2026-11-24-24000-CE"];
  const px = { [syms[0]]: 24000, [syms[1]]: 120 };
  const out = [];
  let t = T0;
  for (let i = 0; i < n; i += 1) {
    t += Math.floor(rnd() * 900);
    const s = syms[i % 3 === 0 ? 1 : 0];
    px[s] = Math.max(0.05, Math.round(px[s] * (1 + (rnd() - 0.5) * 0.001) * 20) / 20);
    const bids = Array.from({ length: 5 }, (_, k) => lvl(px[s] - 0.05 * (k + 1), 1 + Math.floor(rnd() * 500), 1 + k));
    const asks = Array.from({ length: 5 }, (_, k) => lvl(px[s] + 0.05 * (k + 1), 1 + Math.floor(rnd() * 500), 1 + k));
    out.push({ symbol: s, ltp: px[s], bid: bids[0].price, ask: asks[0].price, bidQty: bids[0].qty, askQty: asks[0].qty, volume: null, oi: null, open: null, high: null, low: null, close: null, exchangeTs: null, receivedAt: t, broker: "dhan", depth: { bids, asks } });
  }
  return out;
}

/** Uses three depth levels: identical outputs prove depth survives the tick log, the replay and the hub. */
const bookPressure = defineSignal({
  name: "book-pressure",
  symbols: ["NSE:NIFTY", "NFO:NIFTY-2026-11-24-24000-CE"],
  create() {
    const w = windowSum({ spanMs: 20_000 });
    return (tick, { time }) => {
      const b = tick.depth?.bids ?? [];
      const a = tick.depth?.asks ?? [];
      if (b.length < 3 || a.length < 3) return undefined;
      const sum = (ls) => ls.slice(0, 3).reduce((n, l) => n + (l.qty ?? 0), 0);
      w.push(time, (sum(b) - sum(a)) / (sum(b) + sum(a)));
      return { p: w.mean(time), n: w.count(time), top: [b[0].price, a[0].price] };
    };
  },
});

describe("depth", () => {
  it("is kept only when asked, and round-trips", () => {
    const t = depthTicks(1)[0];
    expect(decodeTick(encodeTick(t, 1)).depth).toBeUndefined();
    const back = decodeTick(encodeTick(t, 1, 3));
    expect(back.depth.bids).toHaveLength(3);
    expect(back.depth.bids[0]).toEqual(t.depth.bids[0]);
    expect(decodeTick(encodeTick({ ...t, depth: { bids: [{ price: 1, qty: "x" }], asks: [] } }, 1, 5)).depth.bids[0]).toEqual({ price: 1, qty: null, orders: null });
  });

  it("survives the tick log, the replay and the live StreamHub: verify says identical", async () => {
    const log = createTickLog({ root: dir, flushEveryMs: 0, depthLevels: 5 });
    for (const t of depthTicks()) log.append(t);
    log.close();
    const store = createTickLogStore({ root: dir });
    const r = await verifySignal(bookPressure, store, { fromMs: T0, toMs: T0 + 86_400_000 });
    expect(r.outputs).toBeGreaterThan(1000);
    expect(r.checks.deterministic.identical).toBe(true);
    expect(r.checks.replay.comparison.summary).toMatch(/^Identical/);
    expect(r.checks.replay.played).toMatchObject({ read: 1500, delivered: 1500 });
    expect(r.ok).toBe(true);
  });
});

describe("disk limits", () => {
  it("stops before maxBytes and counts what it gave up as DISK_LIMIT", () => {
    const losses = [];
    const log = createTickLog({ root: dir, flushEveryMs: 0, maxBufferedTicks: 10, maxBytes: 3000, onLoss: (l) => losses.push(l) });
    for (let i = 0; i < 200; i += 1) log.append({ symbol: "NSE:NIFTY", ltp: 100 + i, receivedAt: T0 + i });
    const s = log.stats();
    expect(s.usedBytes).toBeLessThanOrEqual(3000);
    expect(s.blocked).toBe("DISK_LIMIT");
    expect(s.lost).toBeGreaterThan(0);
    expect(losses[0].error).toBe("DISK_LIMIT");
  });

  it("holds writes while free space is low and goes on when there is room again", async () => {
    let free = 100;
    const log = createTickLog({ root: dir, flushEveryMs: 0, maxBufferedTicks: 10, minFreeBytes: 1000, statfs: () => free });
    for (let i = 0; i < 15; i += 1) log.append({ symbol: "NSE:NIFTY", ltp: 1 + i, receivedAt: T0 + i });
    expect(log.stats()).toMatchObject({ written: 0, blocked: "DISK_LOW", lost: 0 });
    free = 1e9;
    log.close();
    expect(log.stats()).toMatchObject({ written: 15, blocked: null, lost: 0 });
    expect((await auditTickLog({ root: dir })).complete).toBe(true);
  });
});

describe("compression", () => {
  it("gzips a finished day; readers and seq resumption see the same ticks", async () => {
    const log = createTickLog({ root: dir, flushEveryMs: 0 });
    for (let i = 0; i < 300; i += 1) log.append({ symbol: "NSE:NIFTY", ltp: 100 + (i % 7), receivedAt: T0 + i * 10 });
    log.close();
    const before = await all(createTickLogStore({ root: dir }).read({ fromMs: T0, toMs: T0 + 1e6 }));
    expect(compressDay(dir, "2026-11-18")).toBeGreaterThan(0);
    expect(compressDay(dir, "2026-11-18")).toBe(0);
    expect(listTickDays(dir)).toEqual([expect.objectContaining({ date: "2026-11-18", gz: true })]);
    expect(await all(createTickLogStore({ root: dir }).read({ fromMs: T0, toMs: T0 + 1e6 }))).toEqual(before);
    expect((await auditTickLog({ root: dir })).days[0]).toMatchObject({ ticks: 300, holes: [] });
  });
});

describe("mergeStores", () => {
  it("merges in time order; the first store wins a tie; seq is renumbered and the source kept", async () => {
    const archive = createArrayStore([{ symbol: "NSE:A", ltp: 1, receivedAt: 10 }, { symbol: "NSE:A", ltp: 3, receivedAt: 30 }], { id: "archive" });
    const recent = createArrayStore([{ symbol: "NSE:B", ltp: 2, receivedAt: 10 }, { symbol: "NSE:B", ltp: 4, receivedAt: 40 }], { id: "recent", kind: "samples" });
    const m = mergeStores([archive, recent]);
    expect(m).toMatchObject({ id: "archive+recent", kind: "mixed" });
    const got = await all(m.read({ fromMs: 0, toMs: 100 }));
    expect(got.map((t) => [t.seq, t.ltp, t.store, t.storeSeq])).toEqual([[1, 1, "archive", 1], [2, 2, "recent", 1], [3, 3, "archive", 2], [4, 4, "recent", 2]]);
    expect(() => mergeStores([])).toThrow();
  });
});

describe("output log and a saved live run", () => {
  it("round-trips outputs, skips a torn line, and verify compares a saved live run", async () => {
    const ticks = depthTicks(600);
    const store = createArrayStore(ticks);
    const range = { fromMs: T0, toMs: T0 + 86_400_000 };
    // A "production" live run on the real hub (here fed by a replay), with its outputs saved as it goes.
    const path = join(dir, "out", "live.outputs.jsonl");
    const log = createOutputLog({ path, maxBuffered: 7 });
    const { hub, replay, close } = createReplayHub({ store, range });
    const live = await runLive(bookPressure, hub, { onOutput: log.append, keep: false });
    await new Promise((r) => setImmediate(r));
    await replay.start();
    live.stop();
    close();
    log.close();
    appendFileSync(path, '{"n":9999,"ti'); // a crash mid-write
    const saved = readOutputs(path);
    expect(saved.bad).toBe(1);
    expect(saved.outputs.length).toBe((await runHistorical(bookPressure, store, range)).outputs.length);
    expect((await verifySignal(bookPressure, store, range, { replay: false, liveOutputs: saved.outputs })).ok).toBe(true);
    // The live run missed one output: verify says where.
    const missing = saved.outputs.filter((_, i) => i !== 40);
    const r = await verifySignal(bookPressure, store, range, { replay: false, liveOutputs: missing });
    expect(r.ok).toBe(false);
    expect(r.checks.live.comparison).toMatchObject({ missing: 1, firstDivergence: { kind: "missing", n: 41 } });
  });
});

describe("checkDeterminism through verifySignal", () => {
  it("catches a signal that reads the wall clock", async () => {
    const store = createArrayStore(depthTicks(50));
    const clocky = defineSignal({ name: "clocky", symbols: ["NSE:NIFTY"], create: () => () => performance.now() });
    const r = await verifySignal(clocky, store, { fromMs: T0, toMs: T0 + 86_400_000 }, { replay: false });
    expect(r.ok).toBe(false);
    expect(r.checks.deterministic.comparison.value).toBeGreaterThan(0);
  });
});

describe("mc-bridge ticks", () => {
  const run = async (args, flags = {}) => {
    const lines = { out: [], err: [] };
    const io = { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s), env: {}, cwd: dir };
    const code = await ticksCommand(args, { config: join(dir, "bridge.config.json"), ...flags }, io, { now: () => Date.parse("2026-11-20T10:00:00+05:30") });
    return { code, out: lines.out.join("\n"), err: lines.err.join("\n") };
  };

  beforeEach(() => {
    writeFileSync(join(dir, "bridge.config.json"), JSON.stringify({ dataDir: join(dir, "data"), ticks: { record: true, depthLevels: 5 } }));
    const log = createTickLog({ root: join(dir, "data", "ticks"), flushEveryMs: 0, depthLevels: 5 });
    for (const t of depthTicks(400)) log.append(t);
    log.close();
    const lib = pathToFileURL(join(import.meta.dirname, "index.mjs")).href;
    writeFileSync(
      join(dir, "signal.mjs"),
      `import { defineSignal } from ${JSON.stringify(lib)};
       export default defineSignal({ name: "last-price", symbols: ["NSE:NIFTY"], create: () => (t) => t.ltp });
       export const other = defineSignal({ name: "other", symbols: ["NSE:NIFTY"], create: () => () => Math.random() });`,
    );
  });

  it("status and audit describe the tick log", async () => {
    const s = await run(["status"]);
    expect(s.code).toBe(0);
    expect(s.out).toMatch(/Tick log: recording/);
    expect(s.out).toMatch(/2026-11-18/);
    const a = await run(["audit"]);
    expect(a.code).toBe(0);
    expect(a.out).toMatch(/400 ticks .* no holes/);
    expect(a.out).toMatch(/^Complete/m);
  });

  it("run and verify a signal file; verify fails with exit 1 on a non-deterministic signal", async () => {
    const r = await run(["run", "signal.mjs"], { from: "2026-11-18", out: "out.jsonl" });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/last-price on ticklog: \d+ ticks in, \d+ outputs/);
    expect(readOutputs(join(dir, "out.jsonl")).outputs.length).toBeGreaterThan(200);
    const v = await run(["verify", "signal.mjs"], { from: "2026-11-18", live: "out.jsonl" });
    expect(v.out).toMatch(/✓ deterministic/);
    expect(v.out).toMatch(/✓ replay through the live StreamHub/);
    expect(v.out).toMatch(/✓ saved live run/);
    expect(v.code).toBe(0);
    const bad = await run(["verify", "signal.mjs"], { from: "2026-11-18", name: "other" });
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/✗ deterministic/);
    expect(bad.out).toMatch(/first difference: value/);
  });

  it("compress gzips finished days only, and errors are plain", async () => {
    const c = await run(["compress"]);
    expect(c.out).toMatch(/Compressed 1 finished days/);
    expect(existsSync(join(dir, "data", "ticks", "2026-11-18.ticks.jsonl.gz"))).toBe(true);
    await expect(run(["run", "signal.mjs"])).rejects.toThrow(/--from/);
    await expect(run(["run", "missing.mjs"], { from: "2026-11-18" })).rejects.toThrow(/No file/);
    await expect(run(["run", "signal.mjs"], { from: "yesterday" })).rejects.toThrow(/not a day/);
    expect((await run(["nope"])).code).toBe(1);
    expect(readFileSync(join(dir, "bridge.config.json"), "utf8")).toContain("ticks");
  });
});
