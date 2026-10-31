/**
 * A small pool of worker threads for studies, so a slow or hostile script can never hold the Bridge's event loop.
 *
 *  - Each job gets `timeoutMs`. Past it the worker is terminated (the only way to stop synchronous work) and the job
 *    fails with COMPUTE_TIMEOUT; a fresh worker starts for the next job.
 *  - At most `size` jobs run at once and `maxQueue` wait; more are refused with RATE_LIMITED (retry shortly).
 *  - Each worker has V8 heap limits (`maxOldMb`), so a job cannot take the Bridge's memory with it.
 *  - Workers start on first use and are unref'd, so an idle pool never keeps the process alive.
 */
import { Worker } from "node:worker_threads";
import { BridgeError } from "../core/errors.mjs";

const WORKER_URL = new URL("./worker.mjs", import.meta.url);

/**
 * @param {{ size?: number, timeoutMs?: number, maxQueue?: number, maxOldMb?: number }} [o]
 */
export function createStudyPool({ size = 2, timeoutMs = 10_000, maxQueue = 16, maxOldMb = 256 } = {}) {
  /** @type {Array<{ worker: Worker | null, busy: boolean }>} */
  const slots = Array.from({ length: Math.max(1, size) }, () => ({ worker: null, busy: false }));
  const queue = [];
  let nextId = 1;
  let closed = false;
  const stats = { jobs: 0, timeouts: 0, refused: 0, restarts: 0 };

  function spawn(slot) {
    const w = new Worker(WORKER_URL, { resourceLimits: { maxOldGenerationSizeMb: maxOldMb, maxYoungGenerationSizeMb: 32 } });
    w.unref();
    slot.worker = w;
    return w;
  }

  function settle(slot) {
    slot.busy = false;
    pump();
  }

  function runOn(slot, task) {
    slot.busy = true;
    const w = slot.worker ?? spawn(slot);
    const id = nextId++;
    let done = false;
    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      w.off("message", onMessage);
      w.off("error", onError);
      w.off("exit", onExit);
      fn();
      settle(slot);
    };
    const kill = () => {
      slot.worker = null;
      stats.restarts += 1;
      w.terminate().catch(() => {});
    };
    const onMessage = (msg) => {
      if (msg?.id !== id) return;
      finish(() => {
        if (msg.ok) task.resolve(msg.value);
        else task.reject(new BridgeError(msg.error?.code ?? "INTERNAL", msg.error?.detail, msg.error?.errors ? { errors: msg.error.errors } : {}));
      });
    };
    const onError = (err) => {
      finish(() => {
        kill();
        const oom = /memory|ERR_WORKER_OUT_OF_MEMORY/i.test(String(err?.code ?? err?.message ?? ""));
        task.reject(oom ? new BridgeError("COMPUTE_LIMIT", "The calculation needed more memory than its limit.") : new BridgeError("INTERNAL", "The calculation failed."));
      });
    };
    const onExit = () => {
      finish(() => {
        slot.worker = null;
        task.reject(new BridgeError("INTERNAL", "The calculation stopped unexpectedly."));
      });
    };
    const timer = setTimeout(() => {
      finish(() => {
        stats.timeouts += 1;
        kill();
        task.reject(new BridgeError("COMPUTE_TIMEOUT", `The calculation took longer than ${timeoutMs} ms and was stopped. Ask for fewer candles or studies, or simplify the script.`));
      });
    }, timeoutMs);
    timer.unref?.();
    w.on("message", onMessage);
    w.on("error", onError);
    w.on("exit", onExit);
    // A caller that went away (client disconnected) frees the slot at once: the worker is stopped, not waited for.
    if (task.signal) {
      if (task.signal.aborted) {
        finish(() => {
          kill();
          task.reject(task.signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        });
        return;
      }
      task.signal.addEventListener("abort", () => finish(() => {
        kill();
        task.reject(task.signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      }), { once: true });
    }
    stats.jobs += 1;
    w.postMessage({ ...task.msg, id });
  }

  function pump() {
    while (queue.length) {
      const slot = slots.find((s) => !s.busy);
      if (!slot) return;
      runOn(slot, queue.shift());
    }
  }

  /**
   * @param {object} msg { op, ... } (worker.mjs)
   * @param {{ signal?: AbortSignal }} [o]
   */
  function exec(msg, { signal } = {}) {
    if (closed) return Promise.reject(new BridgeError("INTERNAL", "The studies service is stopping."));
    const busy = slots.every((s) => s.busy);
    if (busy && queue.length >= maxQueue) {
      stats.refused += 1;
      return Promise.reject(new BridgeError("RATE_LIMITED", "Too many study calculations are running. Try again in a moment.", { retryAfterMs: 1000 }));
    }
    return new Promise((resolve, reject) => {
      queue.push({ msg, resolve, reject, signal });
      pump();
    });
  }

  return {
    plan: (job, o) => exec({ op: "plan", job }, o),
    run: (job, candles, from, o) => exec({ op: "run", job, candles, from }, o),
    /** Tests only: occupy a worker for `ms`. */
    spin: (ms, o) => exec({ op: "spin", ms }, o),
    stats: () => ({ ...stats, running: slots.filter((s) => s.busy).length, queued: queue.length, timeoutMs }),
    async close() {
      closed = true;
      for (const t of queue.splice(0)) t.reject(new BridgeError("INTERNAL", "The studies service is stopping."));
      await Promise.all(slots.map((s) => (s.worker ? s.worker.terminate().catch(() => {}) : null)));
      for (const s of slots) s.worker = null;
    },
  };
}
