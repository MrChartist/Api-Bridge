/**
 * The whole loop of docs/guides/tick-research.md, with the real StreamHub in the middle:
 *
 *   live ticks ─"tick" bus─► tick log ─► tick log store ─┬─► runHistorical ─────────────────────┐
 *                                                        └─► replay adapter ─► StreamHub ─► runLive ─► compareRuns: identical
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createStreamHub } from "../stream/streamHub.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { asof, auditTickLog, compareRuns, createReplayAdapter, createReplayClock, createTickLog, createTickLogStore, defineSignal, deltaOf, ema, imbalance, microprice, runHistorical, runLive, windowExtremes, windowSum } from "./index.mjs";

const INSTRUMENTS = [
  { symbol: "NSE:NIFTY", lotSize: 1, refs: { dhan: { token: "13" } } },
  { symbol: "NSE:BANKNIFTY", lotSize: 1, refs: { dhan: { token: "25" } } },
  { symbol: "NSE:RELIANCE", lotSize: 1, refs: { dhan: { token: "2885" } } },
];
const REF = { "NSE:NIFTY": { exchange: "NSE", token: "13" }, "NSE:BANKNIFTY": { exchange: "NSE", token: "25" }, "NSE:RELIANCE": { exchange: "NSE", token: "2885" } };
const START = Date.parse("2026-11-18T09:15:00+05:30");

/** A deterministic, irregular two-hour stream over three symbols, with same-millisecond ties and a zero price. */
function marketTicks(n = 6000) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  const px = { "NSE:NIFTY": 24000, "NSE:BANKNIFTY": 52000, "NSE:RELIANCE": 1300 };
  const vol = { "NSE:NIFTY": 0, "NSE:BANKNIFTY": 0, "NSE:RELIANCE": 1e6 };
  const syms = Object.keys(px);
  const out = [];
  let t = START;
  for (let i = 0; i < n; i += 1) {
    if (rnd() > 0.2) t += Math.floor(rnd() * 2400); // ~20 % of ticks share a millisecond with the one before
    const s = syms[Math.floor(rnd() * syms.length)];
    px[s] = Math.round((px[s] * (1 + (rnd() - 0.5) * 0.0008)) * 20) / 20;
    vol[s] += Math.floor(rnd() * 500);
    const spreadTicks = 1 + Math.floor(rnd() * 4);
    out.push({
      symbol: s,
      ltp: i === 4000 ? 0 : px[s], // the hub drops a zero price; the historical run must drop it too
      bid: px[s] - 0.05 * spreadTicks,
      ask: px[s] + 0.05 * spreadTicks,
      bidQty: 1 + Math.floor(rnd() * 900),
      askQty: 1 + Math.floor(rnd() * 900),
      volume: vol[s] || null,
      oi: null,
      open: null,
      high: null,
      low: null,
      close: null,
      exchangeTs: t - Math.floor(rnd() * 300),
      receivedAt: t,
      accountId: "dhan-main",
      broker: "dhan",
    });
  }
  return out;
}

/** A signal that uses every operator: as-of join, window sums and extremes, EMA, volume deltas, book features. */
const relativeValue = defineSignal({
  name: "relative-value",
  symbols: ["NSE:NIFTY", "NSE:BANKNIFTY", "NSE:RELIANCE"],
  create() {
    const last = asof({ toleranceMs: 5000 });
    const ratio = windowSum({ spanMs: 60_000 });
    const range = windowExtremes({ spanMs: 120_000 });
    const fast = ema({ halfLifeMs: 15_000 });
    const flow = windowSum({ spanMs: 30_000 });
    const dVol = deltaOf();
    return (tick, { time }) => {
      last.set(tick.symbol, time, tick.ltp);
      const d = dVol(tick.symbol, tick.volume);
      if (d !== null) flow.push(time, d * (imbalance(tick) ?? 0));
      if (tick.symbol !== "NSE:NIFTY") return undefined;
      const bank = last.get("NSE:BANKNIFTY", time);
      if (bank === null) return undefined;
      const r = tick.ltp / bank;
      ratio.push(time, r);
      range.push(time, r);
      return { z: (r - ratio.mean(time)) / Math.sqrt(ratio.variance(time) || 1), hi: range.max(time), lo: range.min(time), ema: fast.push(time, microprice(tick) ?? tick.ltp), flow: flow.sum(time), n: ratio.count(time) };
    };
  },
});

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ticks-parity-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Record: the live bus's "tick" events into a tick log with a small buffer (so it flushes many times). */
function record(ticks) {
  const bus = createEventBus({ logger: createNullLogger() });
  const log = createTickLog({ root: dir, maxBufferedTicks: 97, flushEveryMs: 0 });
  const off = log.attach(bus);
  for (const t of ticks) bus.emit("tick", t);
  off();
  log.close();
  return log.stats();
}

/** A real StreamHub whose only account's adapter is the replay. */
function replayHub(store, range) {
  const clock = createReplayClock(START);
  const replay = createReplayAdapter({ store, range, clock, refFor: (s) => REF[s] ?? null });
  const bus = createEventBus({ logger: createNullLogger() });
  const accounts = createFakeAccountManager({ accounts: [{ id: "replay", broker: "dhan", adapter: replay.adapter, capabilities: ["feed", "ltp"], creds: { clientId: "r", accessToken: "r" } }], bus });
  const symbols = createFakeSymbolService({ instruments: INSTRUMENTS, today: "2026-11-18" });
  const hub = createStreamHub({ config: { stream: {} }, logger: createNullLogger(), bus, clock, accounts, symbols }, { random: () => 1, marketOpen: () => false });
  return { hub, replay };
}

const settle = () => new Promise((r) => setImmediate(r));
const RANGE = { fromMs: START, toMs: START + 24 * 3600_000 };

describe("historical run == live run through a replay of the same ticks", () => {
  it("records everything, then gives identical output tick by tick", async () => {
    const ticks = marketTicks();
    const st = record(ticks);
    expect(st).toMatchObject({ written: ticks.length, lost: 0, buffered: 0 });
    expect(st.maxBuffered).toBeLessThanOrEqual(97);
    const audit = await auditTickLog({ root: dir });
    expect(audit.complete).toBe(true);
    expect(audit.days[0].ticks).toBe(ticks.length);

    const store = createTickLogStore({ root: dir });
    const historical = await runHistorical(relativeValue, store, RANGE);
    expect(historical.ticks).toBe(ticks.length - 1); // the zero price is dropped, as the hub drops it
    expect(historical.outputs.length).toBeGreaterThan(1000);

    const { hub, replay } = replayHub(store, RANGE);
    const live = await runLive(relativeValue, hub);
    expect(live.rejected).toEqual([]);
    await settle();
    const played = await replay.start();
    live.stop();
    hub.stop();
    expect(played).toMatchObject({ read: ticks.length, delivered: ticks.length, notSubscribed: 0, noRef: 0 });

    const cmp = compareRuns(historical.outputs, live.outputs);
    expect(cmp.summary).toBe(`Identical: ${historical.outputs.length} outputs match tick by tick.`);
    expect(cmp.identical).toBe(true);
  });

  it("names the cause when a signal is not deterministic", async () => {
    record(marketTicks(800));
    const store = createTickLogStore({ root: dir });
    let calls = 0;
    const leaky = defineSignal({
      name: "leaky",
      symbols: ["NSE:NIFTY"],
      create: () => (tick) => tick.ltp + (++calls % 7 === 0 ? 1e-9 : 0), // state outside create(): differs between runs
    });
    const historical = await runHistorical(leaky, store, RANGE);
    const { hub, replay } = replayHub(store, RANGE);
    const live = await runLive(leaky, hub);
    await settle();
    await replay.start();
    hub.stop();
    const cmp = compareRuns(historical.outputs, live.outputs);
    expect(cmp.identical).toBe(false);
    expect(cmp.value).toBeGreaterThan(0);
    expect(cmp.missing + cmp.extra).toBe(0);
    expect(cmp.firstDivergence.kind).toBe("value");
  });

  it("reports ticks the live side never received as missing outputs", async () => {
    record(marketTicks(800));
    const store = createTickLogStore({ root: dir });
    const historical = await runHistorical(relativeValue, store, RANGE);
    const { hub, replay } = replayHub(store, RANGE);
    const live = await runLive(relativeValue, hub);
    await settle();
    hub.unsubscribe(`signal-${relativeValue.name}`, ["NSE:BANKNIFTY"]); // live loses one input half-way: no ticks for it
    await settle();
    await replay.start();
    hub.stop();
    const cmp = compareRuns(historical.outputs, live.outputs);
    expect(cmp.identical).toBe(false);
    expect(cmp.diffs.length).toBeGreaterThan(0);
  });
});
