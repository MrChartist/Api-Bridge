import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditTickLog } from "./store.mjs";
import { createTickLog, decodeTick, encodeTick, lastSeqOf, tickFileName } from "./tickLog.mjs";

const T0 = Date.parse("2026-11-18T09:15:00+05:30");
const tick = (i, extra = {}) => ({ symbol: i % 2 ? "NSE:NIFTY" : "NSE:INFY", ltp: 100 + i, bid: null, ask: null, bidQty: null, askQty: null, volume: i, oi: null, open: null, high: null, low: null, close: null, exchangeTs: null, receivedAt: T0 + i, accountId: "secret-acct", broker: "dhan", ...extra });

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ticklog-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("codec", () => {
  it("round-trips a tick, leaves out unknown fields and never writes the account", () => {
    const line = encodeTick(tick(3, { bid: 102.5, exchangeTs: T0 }), 9);
    expect(line).not.toContain("secret-acct");
    expect(line).not.toContain("null");
    expect(decodeTick(line)).toMatchObject({ seq: 9, symbol: "NSE:NIFTY", ltp: 103, bid: 102.5, ask: null, exchangeTs: T0, receivedAt: T0 + 3, broker: "dhan" });
    expect(decodeTick("{torn")).toBeNull();
    expect(decodeTick('{"q":1}')).toBeNull();
  });
});

describe("tick log", () => {
  it("keeps memory bounded and writes every tick, in order, with contiguous seq", async () => {
    const log = createTickLog({ root: dir, maxBufferedTicks: 250, flushEveryMs: 0 });
    for (let i = 0; i < 20_000; i += 1) log.append(tick(i));
    expect(log.stats().maxBuffered).toBeLessThanOrEqual(250);
    log.close();
    expect(log.stats()).toMatchObject({ written: 20_000, lost: 0, buffered: 0, seq: 20_000 });
    const audit = await auditTickLog({ root: dir });
    expect(audit).toMatchObject({ complete: true, days: [{ date: "2026-11-18", ticks: 20_000, firstSeq: 1, lastSeq: 20_000, holes: [], bad: 0 }] });
  });

  it("also flushes on bytes, and on its timer", () => {
    let intervalFn;
    const timers = { setInterval: (fn) => ((intervalFn = fn), 1), clearInterval: () => {} };
    const log = createTickLog({ root: dir, maxBufferedTicks: 1e6, maxBufferedBytes: 2048, timers });
    for (let i = 0; i < 100; i += 1) log.append(tick(i));
    expect(log.stats().bufferedBytes).toBeLessThan(2048);
    expect(log.stats().flushes).toBeGreaterThan(0);
    intervalFn();
    expect(log.stats().buffered).toBe(0);
  });

  it("goes on from the last seq after a restart, starting on a fresh line after a torn one", async () => {
    const a = createTickLog({ root: dir, flushEveryMs: 0 });
    for (let i = 0; i < 10; i += 1) a.append(tick(i));
    a.close();
    const file = join(dir, tickFileName("2026-11-18"));
    appendFileSync(file, '{"q":11,"t":'); // a crash mid-write
    expect(lastSeqOf(file)).toBe(10);
    const b = createTickLog({ root: dir, flushEveryMs: 0 });
    expect(b.append(tick(10))).toBe(11);
    b.close();
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    expect(decodeTick(lines.at(-1)).seq).toBe(11);
    const audit = await auditTickLog({ root: dir });
    expect(audit.days[0]).toMatchObject({ ticks: 11, holes: [], bad: 1 }); // the torn line, counted
  });

  it("starts a new file on a new IST day, numbering from 1", () => {
    const log = createTickLog({ root: dir, flushEveryMs: 0 });
    log.append(tick(0));
    const nextDay = Date.parse("2026-11-19T00:00:00.001+05:30");
    expect(log.append(tick(1, { receivedAt: nextDay }))).toBe(1);
    log.close();
    expect(readFileSync(join(dir, tickFileName("2026-11-18")), "utf8").split("\n").filter(Boolean)).toHaveLength(1);
    expect(readFileSync(join(dir, tickFileName("2026-11-19")), "utf8").split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("holds lines while the disk refuses them, and counts and reports what it had to give up", async () => {
    let failing = true;
    const losses = [];
    const append = (p, d) => {
      if (failing) throw Object.assign(new Error("full"), { code: "ENOSPC" });
      appendFileSync(p, d);
    };
    const log = createTickLog({ root: dir, maxBufferedTicks: 10, flushEveryMs: 0, append, onLoss: (l) => losses.push(l) });
    for (let i = 0; i < 25; i += 1) log.append(tick(i));
    expect(log.stats().buffered).toBeLessThanOrEqual(20);
    expect(log.stats().lost).toBeGreaterThan(0);
    expect(losses[0]).toMatchObject({ fromSeq: 1, error: "ENOSPC" });
    failing = false;
    log.close();
    const st = log.stats();
    expect(st.written + st.lost).toBe(25);
    const audit = await auditTickLog({ root: dir });
    expect(audit.complete).toBe(false);
    expect(audit.days[0].holes[0]).toEqual({ from: 1, to: st.lost }); // the loss is visible in the file itself
  });

  it("keeps only the symbols asked for and ignores ticks without a time", () => {
    const log = createTickLog({ root: dir, flushEveryMs: 0, symbols: (s) => s === "NSE:NIFTY" });
    expect(log.append(tick(1))).toBe(1);
    expect(log.append(tick(2))).toBeNull();
    expect(log.append(tick(3, { receivedAt: NaN }))).toBeNull();
    log.close();
    expect(log.append(tick(5))).toBeNull();
  });

  it("does not trust a damaged tail line when resuming", () => {
    const file = join(dir, tickFileName("2026-11-18"));
    writeFileSync(file, `${encodeTick(tick(0), 41)}garbage\n`);
    expect(lastSeqOf(file)).toBe(41);
  });
});
