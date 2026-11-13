/**
 * Delivery of forwarded events: one signed JSON POST per event per target.
 *
 *   POST <target url>
 *   Content-Type: application/json
 *   X-MCB-Event: order.updated
 *   X-MCB-Delivery: <unique id, the same on every retry>
 *   X-MCB-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(signingSecret, "<t>." + raw body)>
 *
 *   { "id": "<delivery id>", "event": "order.updated", "at": "<ISO time>", "data": { ... } }
 *
 * The signature is the one the Bridge accepts on its own signed hooks, so one verifier works both ways. A delivery
 * succeeds on any 2xx. Anything else is retried (RETRY_DELAYS_MS), then dropped and counted as failed. Each target
 * has its own queue, delivered in order, so a slow project never delays another; a full queue drops the newest
 * event. Redirects are not followed (a redirect could send order data somewhere the owner never typed).
 */
import { createHmac, randomBytes } from "node:crypto";

export const RETRY_DELAYS_MS = Object.freeze([1_000, 5_000, 20_000]);
export const DELIVERY_TIMEOUT_MS = 8_000;
export const MAX_QUEUE = 500;

/** The X-MCB-Signature header value for a body. Pure. */
export function signBody(secret, body, unixSeconds) {
  return `t=${unixSeconds},v1=${createHmac("sha256", secret).update(`${unixSeconds}.${body}`).digest("hex")}`;
}

/** The JSON envelope of one delivery. Pure. */
export function envelope(event, data, { id, at }) {
  return JSON.stringify({ id, event, at, data });
}

/**
 * @param {{ store: ReturnType<typeof import("./store.mjs").createForwardStore>, logger?: any, now?: () => number,
 *   fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, retryDelays?: readonly number[] }} opts
 */
export function createForwardSender({ store, logger, now = () => Date.now(), fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.()), retryDelays = RETRY_DELAYS_MS }) {
  /** target id -> { items: object[], running: boolean } */
  const queues = new Map();
  let stopped = false;
  let pending = 0;
  let idle = [];

  const settle = () => {
    if (pending === 0) {
      const w = idle;
      idle = [];
      for (const f of w) f();
    }
  };

  /** One attempt. @returns {Promise<{ ok: boolean, status: number | null, error: string | null }>} */
  async function attempt(target, secret, item) {
    const t = Math.floor(now() / 1000);
    try {
      const r = await fetchImpl(target.url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        headers: { "Content-Type": "application/json", "User-Agent": "mc-bridge-forward", "X-MCB-Event": item.event, "X-MCB-Delivery": item.id, "X-MCB-Signature": signBody(secret, item.body, t) },
        body: item.body,
      });
      try {
        await r.body?.cancel?.();
      } catch {
        /* the answer's body is not needed */
      }
      const ok = r.status >= 200 && r.status < 300;
      return { ok, status: r.status, error: ok ? null : `the project answered ${r.status}` };
    } catch (err) {
      return { ok: false, status: null, error: err?.name === "TimeoutError" ? "no answer in time" : "could not connect" };
    }
  }

  async function deliver(target, item) {
    const secret = await store.secretFor(target.id);
    if (!secret) return { ok: false, status: null, error: "the signing secret is missing; delete this target and add it again" };
    let last = { ok: false, status: null, error: "not sent" };
    for (let i = 0; i <= retryDelays.length; i += 1) {
      if (stopped && i > 0) break;
      last = await attempt(target, secret, item);
      if (last.ok) break;
      if (i < retryDelays.length) await sleep(retryDelays[i]);
    }
    return last;
  }

  async function drain(id) {
    const q = queues.get(id);
    if (!q || q.running) return;
    q.running = true;
    try {
      while (q.items.length) {
        const item = q.items.shift();
        const target = store.get(id);
        if (target && target.enabled !== false) {
          const r = await deliver(target, item);
          store.recordDelivery(id, r);
          if (!r.ok) logger?.warn?.("forward delivery failed", { targetId: id, event: item.event, status: r.status, error: r.error });
        }
        pending -= 1;
      }
    } finally {
      q.running = false;
      store.flush();
      settle();
    }
  }

  return {
    /** Queue one event for every target that asked for it. Never throws; never waits. @returns {number} targets queued */
    publish(event, data) {
      if (stopped) return 0;
      let n = 0;
      for (const target of store.list()) {
        if (target.enabled === false || !target.events.includes(event)) continue;
        let q = queues.get(target.id);
        if (!q) queues.set(target.id, (q = { items: [], running: false }));
        if (q.items.length >= MAX_QUEUE) {
          store.recordDelivery(target.id, { ok: false, error: "queue full: the project is not answering" });
          continue;
        }
        const id = `dl_${randomBytes(9).toString("hex")}`;
        q.items.push({ id, event, body: envelope(event, data, { id, at: new Date(now()).toISOString() }) });
        pending += 1;
        n += 1;
        queueMicrotask(() => drain(target.id));
      }
      return n;
    },

    /** Send one test event to one target now, without retries. */
    async test(target) {
      const secret = await store.secretFor(target.id);
      if (!secret) return { ok: false, status: null, error: "the signing secret is missing; delete this target and add it again" };
      const id = `dl_${randomBytes(9).toString("hex")}`;
      const data = { test: true, message: "A test from Mr. Chartist API Bridge. Real order updates look like data in the guide." };
      const r = await attempt(target, secret, { id, event: "forward.test", body: envelope("forward.test", data, { id, at: new Date(now()).toISOString() }) });
      store.recordDelivery(target.id, r);
      store.flush();
      return r;
    },

    /** Resolves when every queued delivery has finished (tests, shutdown). */
    idle: () => (pending === 0 ? Promise.resolve() : new Promise((r) => idle.push(r))),

    stop() {
      stopped = true;
      for (const q of queues.values()) {
        pending -= q.items.length;
        q.items.length = 0;
      }
      store.flush();
      settle();
    },
  };
}
