#!/usr/bin/env node
/**
 * Server hot-path micro-benchmark (docs/perf/README.md).
 *
 *   node scripts/perf/bench-server.mjs [--rounds 200] [--json]
 *
 *   - Greeks: Black-76 IV solve + Greeks for every leg of a 91-strike chain (182 legs), as /v1/optionchain
 *     ?ivModel=b76-forward does on every read;
 *   - chain build: a demo broker chain (91 strikes) turned into OpenAPI rows with legacy Greeks, then serialised;
 *   - quote fan-out: one round of 100 option ticks sent to 20 stream clients (tick body, queue, JSON per client).
 * Reports mean and p95 ms per operation. Pure CPU, no network, no Bridge needed.
 */
import { performance } from "node:perf_hooks";
import { createDemoAdapter } from "../../server/bridge/demo/demoAdapter.mjs";
import { applyB76, rowsFromBrokerChain } from "../../server/bridge/market/chain.mjs";
import { createClientSession } from "../../server/bridge/stream/protocol.mjs";
import { resolveStreamConfig } from "../../server/bridge/stream/config.mjs";
import { pricingContext } from "../../server/bridge/vol/context.mjs";

const arg = (name, def = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const ROUNDS = Number(arg("rounds", "200"));

function time(fn, rounds = ROUNDS) {
  for (let i = 0; i < Math.min(20, rounds); i++) fn(i); // warm up
  const xs = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    fn(i);
    xs.push(performance.now() - t0);
  }
  xs.sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { mean: +mean.toFixed(3), p95: +xs[Math.floor(xs.length * 0.95)].toFixed(3) };
}

const demo = createDemoAdapter();
const t = Date.now();
const expiry = (await demo.fetchExpiryList({}, "NIFTY")).data[1];
const raw = await demo.fetchOptionChain({}, "NIFTY", expiry);
const base = { underlying: "NIFTY", expiry, exchange: "NFO", declared: "computed", greeks: true, nowMs: t, rate: 0.065, oiUnit: "units", lotSize: 75 };
const built = rowsFromBrokerChain(raw, base);
const chain = { underlying: "NIFTY", expiry, underlyingLtp: built.underlyingLtp, rows: built.rows };
const ctx = pricingContext({ config: {}, exchange: "NFO", kind: "index", now: t });
const check = applyB76(chain, { ctx, nowMs: t, rate: 0.065 });
const solved = check.rows.flatMap((r) => [r.ce, r.pe]).filter((l) => l?.iv > 0).length;
if (solved < 100) console.error(`warning: only ${solved} legs solved an IV; the Greeks timing is not representative`);

const results = {};
results.greeksB76Chain = time(() => applyB76(chain, { ctx, nowMs: t, rate: 0.065 }));
results.chainBuildLegacy = time(() => rowsFromBrokerChain(raw, base));
results.chainBuildNoGreeks = time(() => rowsFromBrokerChain(raw, { ...base, greeks: false }));
results.chainSerialise = time(() => JSON.stringify({ data: applyB76(chain, { ctx, nowMs: t, rate: 0.065 }) }));

// Quote fan-out: 20 clients, 100 symbols, one tick each per round.
{
  const cfg = resolveStreamConfig({});
  const sinks = [];
  const hub = { attachSink: (id, fn) => sinks.push(fn), detachSink() {}, clientSymbols: () => [], unsubscribeAll() {}, releaseClient() {}, dropClient() {} };
  const bus = { on: () => () => {} };
  const logger = { child: () => logger, debug() {}, info() {}, warn() {}, error() {} };
  let bytes = 0;
  const sessions = [];
  for (let c = 0; c < 20; c++) {
    const transport = { write: (m) => (bytes += JSON.stringify(m).length), bufferedBytes: () => 0, close() {} };
    sessions.push(createClientSession({ id: `ws_${c}`, kind: "ws", key: { id: "k", scopes: ["read"] }, hub, bus, transport, config: cfg, clock: { now: () => Date.now() }, logger }));
  }
  const symbols = built.rows.slice(0, 50).flatMap((r) => [r.ce?.symbol, r.pe?.symbol]).filter(Boolean);
  const ticks = symbols.map((symbol, i) => ({ symbol, ltp: 100 + i, open: 90, high: 110, low: 80, close: 95, volume: 1000, oi: 5000, bid: 99.5, ask: 100.5, bidQty: 75, askQty: 150, receivedAt: t, exchangeTs: t, accountId: "demo", broker: "demo" }));
  results.fanout100x20 = time(() => {
    for (const tk of ticks) for (const s of sinks) s(tk, "quote");
  }, 100);
  await new Promise((r) => setTimeout(r, 10));
  results.fanout100x20.bytesPerRound = Math.round(bytes / 120);
  for (const s of sessions) s.close?.("bench", false);
}

if (process.argv.includes("--json")) console.log(JSON.stringify(results, null, 2));
else {
  console.log("operation              mean ms   p95 ms");
  for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(22)} ${String(v.mean).padStart(7)}  ${String(v.p95).padStart(7)}`);
}
process.exit(0);
