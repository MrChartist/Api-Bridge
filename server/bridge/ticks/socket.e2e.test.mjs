/**
 * "Replay through sockets": the replay, the real StreamHub AND the WebSocket client protocol (createClientSession, the
 * code behind /v1/stream), with every frame passed through JSON as on the wire. A signal fed from the frames must give
 * what the historical run gives.
 */
import { describe, expect, it } from "vitest";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { resolveStreamConfig } from "../stream/config.mjs";
import { createClientSession } from "../stream/protocol.mjs";
import { asof, compareRuns, createArrayStore, createReplayHub, createSignalRunner, defineSignal, runHistorical, windowSum } from "./index.mjs";

const T0 = Date.parse("2026-11-18T09:15:00+05:30");
const RANGE = { fromMs: T0, toMs: T0 + 86_400_000 };
const KEY = { id: "abcdefghij", label: "t", scopes: ["read"], accounts: ["replay"] };

function ticks(n = 3000) {
  let seed = 9;
  const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  const px = { "NSE:NIFTY": 24000, "NSE:BANKNIFTY": 52000 };
  const out = [];
  let t = T0;
  for (let i = 0; i < n; i += 1) {
    t += Math.floor(rnd() * 500);
    const s = rnd() > 0.5 ? "NSE:NIFTY" : "NSE:BANKNIFTY";
    px[s] = Math.round(px[s] * (1 + (rnd() - 0.5) * 0.0006) * 20) / 20;
    out.push({ symbol: s, ltp: px[s], bid: px[s] - 0.05, ask: px[s] + 0.05, bidQty: 1 + Math.floor(rnd() * 99), askQty: 1 + Math.floor(rnd() * 99), receivedAt: t, exchangeTs: t - 40 });
  }
  return out;
}

const spreadSignal = defineSignal({
  name: "spread",
  symbols: ["NSE:NIFTY", "NSE:BANKNIFTY"],
  create() {
    const last = asof({ toleranceMs: 3000 });
    const w = windowSum({ spanMs: 30_000 });
    return (t, { time }) => {
      last.set(t.symbol, time, t.ltp);
      const n = last.get("NSE:NIFTY", time);
      const b = last.get("NSE:BANKNIFTY", time);
      if (n === null || b === null) return undefined;
      w.push(time, b / n);
      return [w.mean(time), (t.bidQty - t.askQty) / (t.bidQty + t.askQty)];
    };
  },
});

/** A client on the WebSocket protocol: every frame goes through JSON; tick frames feed the runner. */
async function overSocket(store, { stallAfter = Infinity } = {}) {
  const { hub, replay, bus, clock, close } = createReplayHub({ store, range: RANGE });
  const runner = createSignalRunner(spreadSignal);
  const frames = [];
  let ticksSeen = 0;
  let stalled = false;
  const drains = [];
  const transport = {
    kind: "ws",
    write(msg) {
      const m = JSON.parse(JSON.stringify(msg));
      frames.push(m);
      if (m.type !== "tick") return;
      runner.push(m);
      if (++ticksSeen === stallAfter) stalled = true; // the client stops reading for a while
    },
    bufferedBytes: () => (stalled ? 64 * 1024 * 1024 : 0),
    close() {},
    onDrain(cb) {
      drains.push(cb);
    },
  };
  const session = createClientSession({ id: "ws_replay", kind: "ws", key: KEY, hub, bus: bus ?? createEventBus(), transport, config: resolveStreamConfig({ heartbeatMs: 120_000 }), clock, logger: createNullLogger() });
  await session.handleMessage(JSON.stringify({ op: "subscribe", symbols: [...spreadSignal.symbols], mode: "quote", id: "s1" }));
  await new Promise((r) => setImmediate(r));
  await replay.start();
  stalled = false;
  for (const cb of drains.splice(0)) cb();
  await new Promise((r) => setImmediate(r));
  session.close("done");
  close();
  return { outputs: runner.outputs, frames };
}

describe("replay through the WebSocket protocol", () => {
  it("gives the historical outputs exactly when the client keeps up", async () => {
    const store = createArrayStore(ticks());
    const historical = await runHistorical(spreadSignal, store, RANGE);
    const { outputs, frames } = await overSocket(store);
    expect(frames.filter((f) => f.type === "tick")).toHaveLength(3000);
    expect(frames.some((f) => f.type === "error")).toBe(false);
    const cmp = compareRuns(historical.outputs, outputs);
    expect(cmp.summary).toBe(`Identical: ${historical.outputs.length} outputs match tick by tick.`);
  });

  it("shows a slow client's conflated ticks as missing outputs", async () => {
    const store = createArrayStore(ticks());
    const historical = await runHistorical(spreadSignal, store, RANGE);
    const { outputs, frames } = await overSocket(store, { stallAfter: 1000 });
    expect(frames.filter((f) => f.type === "tick").length).toBe(1002); // 1000, then only the latest per symbol after the stall
    const cmp = compareRuns(historical.outputs, outputs);
    expect(cmp.identical).toBe(false);
    expect(cmp.missing).toBeGreaterThan(0);
  });
});
