/**
 * The worker pool: a job past its time limit is stopped (the worker is terminated) and the next job gets a fresh
 * worker; a full queue is refused; errors cross the thread as Bridge errors; an aborted caller frees its worker.
 * The "spin" job holds a worker with Atomics.wait, as a script that never ends would.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createStudyPool } from "./pool.mjs";
import { makeCandles } from "./__fixtures__/candles.mjs";

let pool;
afterEach(async () => {
  await pool?.close();
  pool = null;
});

describe("study pool", () => {
  it("runs a job in a worker and returns the result", async () => {
    pool = createStudyPool({ size: 1, timeoutMs: 20_000 });
    const job = { studies: [{ id: "sma", params: { length: 3 } }] };
    expect((await pool.plan(job)).warmBars).toBe(2);
    const r = await pool.run(job, makeCandles(10), 0);
    expect(r.series[0].values.slice(0, 3)).toEqual([null, null, expect.any(Number)]);
  });

  it("brings a job's Bridge error back across the thread", async () => {
    pool = createStudyPool({ size: 1, timeoutMs: 20_000 });
    await expect(pool.plan({ studies: [{ id: "nope" }] })).rejects.toMatchObject({ name: "BridgeError", code: "VALIDATION_FAILED", status: 400 });
    await expect(pool.plan({ script: "plot(close +\n" })).rejects.toMatchObject({ code: "VALIDATION_FAILED", errors: [expect.objectContaining({ path: "script" })] });
  });

  it("stops a job past its time limit with COMPUTE_TIMEOUT, then serves the next job on a fresh worker", async () => {
    pool = createStudyPool({ size: 1, timeoutMs: 300 });
    await expect(pool.spin(30_000)).rejects.toMatchObject({ code: "COMPUTE_TIMEOUT", status: 504 });
    expect(pool.stats()).toMatchObject({ timeouts: 1, restarts: 1, running: 0 });
    // The next job runs on a new worker; give it room for the worker to start and load the core.
    pool = (await pool.close(), createStudyPool({ size: 1, timeoutMs: 20_000 }));
    expect((await pool.plan({ studies: [{ id: "rsi" }] })).warmBars).toBe(14);
  });

  it("a timed-out worker is replaced within the same pool", async () => {
    pool = createStudyPool({ size: 1, timeoutMs: 5000 });
    await pool.plan({ studies: [{ id: "sma" }] }); // worker started and the core loaded
    await expect(pool.spin(60_000)).rejects.toMatchObject({ code: "COMPUTE_TIMEOUT" });
    expect((await pool.plan({ studies: [{ id: "ema" }] })).warmBars).toBe(8);
    expect(pool.stats().restarts).toBe(1);
  });

  it("refuses with RATE_LIMITED when every worker is busy and the queue is full", async () => {
    pool = createStudyPool({ size: 1, timeoutMs: 20_000, maxQueue: 1 });
    const a = pool.spin(400);
    const b = pool.spin(1);
    await expect(pool.spin(1)).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
    await expect(a).resolves.toBe(true);
    await expect(b).resolves.toBe(true);
    expect(pool.stats().refused).toBe(1);
  });

  it("an aborted caller frees its worker at once", async () => {
    pool = createStudyPool({ size: 1, timeoutMs: 60_000 });
    const ctl = new AbortController();
    const p = pool.spin(60_000, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 50);
    await expect(p).rejects.toBeDefined();
    expect(pool.stats().running).toBe(0);
    expect((await pool.plan({ studies: [{ id: "sma", params: { length: 5 } }] })).warmBars).toBe(4);
  });
});
