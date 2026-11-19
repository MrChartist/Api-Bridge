/**
 * One call that answers "can I trust this signal live?", in three checks of increasing reach:
 *
 *   1. deterministic  the historical run done twice gives the same outputs (catches Date.now(), Math.random(), state
 *                     kept outside create()). Cheap, needs no hub.
 *   2. replay         the historical run equals a live run on a replay of the same ticks through the real StreamHub
 *                     (catches anything the live path does differently: normalising, ordering, subscriptions).
 *   3. live           optional: the historical run equals outputs saved from a real live run (outputLog.mjs), for the
 *                     same range (catches ticks the live run missed, such as a WebSocket client that was conflated).
 *
 * `ok` is true only when every check that ran says identical.
 */
import { compareRuns } from "./compare.mjs";
import { createReplayHub } from "./replay.mjs";
import { runHistorical, runLive } from "./runner.mjs";

/**
 * Run the signal on history twice and compare.
 * @returns {Promise<{ identical: boolean, comparison: ReturnType<typeof compareRuns>, outputs: any[] }>}
 */
export async function checkDeterminism(signal, store, range, { tolerance = 0 } = {}) {
  const a = await runHistorical(signal, store, range);
  const b = await runHistorical(signal, store, range);
  const comparison = compareRuns(a.outputs, b.outputs, { tolerance });
  return { identical: comparison.identical, comparison, outputs: a.outputs, ticks: a.ticks };
}

/**
 * Run the signal live on a replay of the store through the real StreamHub.
 * @returns {Promise<{ outputs: any[], played: object, rejected: any[] }>}
 */
export async function runReplay(signal, store, range, { speed = Infinity } = {}) {
  const { hub, replay, close } = createReplayHub({ store, range: { ...range, symbols: [...signal.symbols] }, speed });
  try {
    const live = await runLive(signal, hub);
    await new Promise((r) => setImmediate(r)); // let the hub place the subscriptions on the replay feed
    const played = await replay.start();
    live.stop();
    return { outputs: live.outputs, played, rejected: live.rejected };
  } finally {
    close();
  }
}

/**
 * @param {ReturnType<typeof import("./signal.mjs").defineSignal>} signal
 * @param {import("./store.mjs").TickStore} store
 * @param {{ fromMs: number, toMs: number }} range
 * @param {{ tolerance?: number, replay?: boolean, liveOutputs?: any[] }} [opts]
 */
export async function verifySignal(signal, store, range, { tolerance = 0, replay = true, liveOutputs = null } = {}) {
  const det = await checkDeterminism(signal, store, range, { tolerance });
  const checks = { deterministic: { identical: det.identical, comparison: det.comparison } };
  if (replay) {
    const r = await runReplay(signal, store, range);
    const comparison = compareRuns(det.outputs, r.outputs, { tolerance });
    checks.replay = { identical: comparison.identical && r.rejected.length === 0, comparison, played: r.played, rejected: r.rejected };
  }
  if (liveOutputs) {
    const comparison = compareRuns(det.outputs, liveOutputs, { tolerance });
    checks.live = { identical: comparison.identical, comparison };
  }
  const ok = Object.values(checks).every((c) => c.identical);
  return { signal: signal.name, store: store.id, storeKind: store.kind ?? "ticks", ticks: det.ticks, outputs: det.outputs.length, ok, checks };
}
