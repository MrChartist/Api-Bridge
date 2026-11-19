/**
 * Runs a signal (signal.mjs) two ways, through ONE code path:
 *
 *   runHistorical(signal, store, range)   one batch over stored ticks (research, backtests)
 *   runLive(signal, hub, ...)             streaming from the StreamHub (live, or a replay fed through it: replay.mjs)
 *
 * Both build a runner with createSignalRunner() and push ticks into it one at a time. Stored ticks are first passed
 * through the StreamHub's own quoteToTick(), so a historical tick has exactly the shape and the same filtering (a price of
 * zero is dropped, numeric strings become numbers) as a tick that came through the live hub.
 *
 * Each output is { n, time, symbol, value }: n is the output's position (1, 2, 3 ...), time the event time of the tick
 * that produced it. compare.mjs lines two lists of outputs up.
 */
import { quoteToTick } from "../stream/streamHub.mjs";
import { assertTickStore } from "./store.mjs";

/** Plain-data copy of an output value, so later changes to a signal's internal objects cannot rewrite history. */
function snapshot(v) {
  if (v === null || typeof v !== "object") return v;
  return structuredClone(v);
}

/**
 * The one place a tick meets a signal.
 * @param {ReturnType<typeof import("./signal.mjs").defineSignal>} signal
 * @param {{ onOutput?: (out: { n: number, time: number, symbol: string, value: any }) => void, keep?: boolean }} [opts]
 *   keep: hold every output in `outputs` (default true; turn off for long runs that only stream onOutput).
 */
export function createSignalRunner(signal, { onOutput, keep = true } = {}) {
  const fn = signal.create();
  if (typeof fn !== "function") throw new Error(`signal ${signal.name}: create() must return a function`);
  const wanted = new Set(signal.symbols);
  const outputs = [];
  let ticks = 0;
  let n = 0;
  return {
    outputs,
    /** Push one canonical Tick. Returns the output it produced, or null. */
    push(tick) {
      if (!tick || !wanted.has(tick.symbol)) return null;
      const time = tick[signal.time];
      if (!Number.isFinite(time)) return null;
      ticks += 1;
      const value = fn(tick, { time, n: ticks });
      if (value === undefined) return null;
      n += 1;
      const out = { n, time, symbol: tick.symbol, value: snapshot(value) };
      if (keep) outputs.push(out);
      onOutput?.(out);
      return out;
    },
    stats: () => ({ ticks, produced: n }),
  };
}

/** A stored tick in the shape the live hub hands out (same normaliser), or null when the hub would have dropped it. */
export function asHubTick(t) {
  return quoteToTick(t, { symbol: t.symbol, accountId: null, broker: t.broker ?? null, receivedAt: t.receivedAt });
}

/**
 * Historical run: one batch over a store.
 * @param {ReturnType<typeof import("./signal.mjs").defineSignal>} signal
 * @param {import("./store.mjs").TickStore} store
 * @param {{ fromMs: number, toMs: number }} range
 * @param {{ onOutput?: Function, keep?: boolean }} [opts]
 */
export async function runHistorical(signal, store, range, opts = {}) {
  assertTickStore(store);
  const runner = createSignalRunner(signal, opts);
  for await (const t of store.read({ symbols: signal.symbols, fromMs: range.fromMs, toMs: range.toMs })) {
    const tick = asHubTick(t);
    if (tick) runner.push(tick);
  }
  return { signal: signal.name, store: store.id, storeKind: store.kind ?? "ticks", outputs: runner.outputs, ...runner.stats() };
}

/**
 * Live run: subscribe the signal's symbols on a StreamHub (the real one or a replay through it) and feed every tick
 * to the runner as it arrives. Uses the same client path as the WebSocket and SSE endpoints (attachSink + subscribe).
 * @param {ReturnType<typeof import("./signal.mjs").defineSignal>} signal
 * @param {object} hub  StreamHub (SERVICE_CONTRACTS.streamHub plus attachSink)
 * @param {{ clientId?: string, mode?: "ltp"|"quote"|"depth", onOutput?: Function, keep?: boolean }} [opts]
 * @returns {Promise<{ runner: ReturnType<typeof createSignalRunner>, outputs: any[], rejected: any[], stop: () => void }>}
 */
export async function runLive(signal, hub, { clientId = `signal-${signal.name}`, mode = "quote", ...opts } = {}) {
  const runner = createSignalRunner(signal, opts);
  hub.attachSink(clientId, (tick) => runner.push(tick));
  const { rejected } = await hub.subscribe(clientId, [...signal.symbols], mode);
  return { runner, outputs: runner.outputs, rejected, stop: () => hub.dropClient(clientId) };
}
