/**
 * Worker thread for studies (pool.mjs starts it). Loads the ChartistScript core once and answers jobs:
 *
 *   in:  { id, op: "plan", job }              out: { id, ok: true, value: planJob(job) }
 *   in:  { id, op: "run", job, candles, from } out: { id, ok: true, value: runJob(job, candles, { from }) }
 *   on error:                                  { id, ok: false, error: { code, detail, errors? } }
 *
 * The thread has no Bridge services: it receives candles and returns numbers. It never sees an order, a key or a
 * secret, and it is terminated (not asked) when a job runs past its time limit.
 */
import { parentPort } from "node:worker_threads";
import { BridgeError } from "../core/errors.mjs";
import { planJob, runJob } from "./compute.mjs";

function errorOf(err) {
  if (err instanceof BridgeError) return { code: err.code, detail: err.detail, ...(err.errors ? { errors: err.errors } : {}) };
  return { code: "INTERNAL", detail: "The calculation failed." };
}

parentPort?.on("message", (msg) => {
  const { id, op } = msg ?? {};
  try {
    let value;
    if (op === "plan") value = planJob(msg.job);
    else if (op === "run") value = runJob(msg.job, msg.candles, { from: msg.from });
    else if (op === "spin") {
      // Tests only: hold the thread for `ms`, as a script that never ends would.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Number(msg.ms) || 0));
      value = true;
    } else throw new BridgeError("VALIDATION_FAILED", "Unknown worker operation.");
    parentPort.postMessage({ id, ok: true, value });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: errorOf(err) });
  }
});
