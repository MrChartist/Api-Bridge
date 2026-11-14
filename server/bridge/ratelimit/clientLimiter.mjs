/**
 * Inbound per-key request budget (Scheduler.checkClient). Protects the Bridge and, indirectly, the
 * broker budgets from one runaway script, sheet or AI client.
 *
 * Three limits per principal, all from the key's quota (quotaStore.mjs: override > config key > default):
 *  - a classic token bucket: `burst` tokens, refilled at `perSecond`; one request costs one token;
 *  - an optional `perDay` cap on requests per IST calendar day;
 *  - a cap on requests in flight at once (`maxConcurrent`, 64 by default) for HTTP requests: the slot is held until
 *    the response is finished, so a sheet that fires hundreds of recalculations cannot hold hundreds of sockets.
 *
 * Headers follow the IETF RateLimit header draft in the syntax the core tests pin (the draft may still change):
 *
 *   RateLimit:        limit=50, remaining=49, reset=1      reset = whole seconds until the bucket is full again
 *                                                           (on a refusal: until the next request is allowed)
 *   RateLimit-Policy: 50;w=1;burst=50
 *
 * A refusal because of the daily cap reports that cap in the same syntax (limit = the daily figure, reset = seconds
 * to the next IST midnight, policy `<perDay>;w=86400`).
 *
 * A refused request also carries `error`: the RATE_LIMITED problem with scope "client", `retryAfterMs` and the
 * `limit` that said no, ready to throw (core/app.mjs does). Usage counters per key (lastMinute, today,
 * throttledToday) are kept in memory and reset at the IST day boundary.
 *
 * Local (CLI) callers are not limited. Idle buckets are dropped so the map stays small. The bucket never trusts the
 * clock to move forwards: a clock that steps back neither mints tokens nor moves the refill point back.
 */
import { BridgeError } from "../core/errors.mjs";
import { DEFAULT_KIND_WEIGHTS } from "./consumer.mjs";
import { DEFAULT_CLIENT_MAX_CONCURRENT } from "./config.mjs";
import { createQuotaStore } from "./quotaStore.mjs";
import { istDay, nextIstMidnight } from "./tokenBucket.mjs";

const MAX_TRACKED = 10_000;
const IDLE_DROP_MS = 10 * 60_000;
const MINUTE_SLOTS = 60;

/**
 * @param {{ perSecond: number, burst?: number, perDay?: number, maxConcurrent?: number, kindWeights?: object, keys?: Record<string, object> }} cfg
 * @param {{ now: () => number }} clock
 * @param {{ quotas?: ReturnType<typeof createQuotaStore> }} [opts]  quotas: the override-aware store (default: config only)
 */
export function createClientLimiter(cfg, clock, { quotas = createQuotaStore({ config: cfg }) } = {}) {
  const maxConcurrent = cfg.maxConcurrent ?? DEFAULT_CLIENT_MAX_CONCURRENT;
  /** @type {Map<string, { tokens: number, at: number, perSecond: number, burst: number }>} */
  const buckets = new Map();
  /** @type {Map<string, { day: number, today: number, throttledToday: number, slotSec: Float64Array, slots: Uint32Array }>} */
  const usage = new Map();
  /** requests in flight per principal id */
  const inFlight = new Map();

  const rawId = (id) => (id.startsWith("key:") ? id.slice(4) : id);
  const policyFor = (id) => quotas.resolve(rawId(id));

  function principalId(ctx) {
    if (!ctx || ctx.principal?.kind === "local") return null;
    if (ctx.key?.id) return `key:${ctx.key.id}`;
    if (ctx.principal?.id) return `${ctx.principal.kind}:${ctx.principal.id}`;
    return "anonymous";
  }

  function prune(now) {
    if (buckets.size <= MAX_TRACKED) return;
    for (const [id, b] of buckets) if (now - b.at > IDLE_DROP_MS) buckets.delete(id);
    // Still too many: drop the oldest entries (Map keeps insertion order; refreshed entries are re-inserted).
    while (buckets.size > MAX_TRACKED) buckets.delete(buckets.keys().next().value);
  }

  function bucket(id, now) {
    let b = buckets.get(id);
    const policy = policyFor(id);
    if (!b) {
      b = { tokens: policy.burst, at: now, perSecond: policy.perSecond, burst: policy.burst };
    } else {
      // Refill from the latest time seen; a clock that stepped back changes nothing (no tokens minted, no rewind).
      const elapsed = Math.max(0, now - b.at) / 1000;
      b.tokens = Math.min(policy.burst, b.tokens + elapsed * policy.perSecond);
      b.at = Math.max(b.at, now);
      b.perSecond = policy.perSecond;
      b.burst = policy.burst;
      buckets.delete(id); // re-insert to keep LRU order
    }
    buckets.set(id, b);
    prune(now);
    return b;
  }

  /** Usage counters for a principal, rolled to the current IST day. */
  function usageRow(id, now, create) {
    let u = usage.get(id);
    const day = istDay(now);
    if (!u) {
      if (!create) return null;
      u = { day, today: 0, throttledToday: 0, slotSec: new Float64Array(MINUTE_SLOTS).fill(-1), slots: new Uint32Array(MINUTE_SLOTS) };
      usage.set(id, u);
      if (usage.size > MAX_TRACKED) usage.delete(usage.keys().next().value);
    } else if (u.day !== day) {
      u.day = day;
      u.today = 0;
      u.throttledToday = 0;
    }
    return u;
  }

  function countAdmitted(u, now) {
    u.today += 1;
    const sec = Math.floor(now / 1000);
    const slot = ((sec % MINUTE_SLOTS) + MINUTE_SLOTS) % MINUTE_SLOTS;
    if (u.slotSec[slot] !== sec) {
      u.slotSec[slot] = sec;
      u.slots[slot] = 0;
    }
    u.slots[slot] += 1;
  }

  function lastMinute(u, now) {
    const sec = Math.floor(now / 1000);
    let n = 0;
    for (let i = 0; i < MINUTE_SLOTS; i++) if (u.slotSec[i] > sec - MINUTE_SLOTS && u.slotSec[i] <= sec) n += u.slots[i];
    return n;
  }

  const headers = (b, remaining, resetS) => ({
    RateLimit: `limit=${formatNum(b.perSecond)}, remaining=${remaining}, reset=${resetS}`,
    "RateLimit-Policy": `${formatNum(b.perSecond)};w=1;burst=${b.burst}`,
  });

  function refusal(retryAfterMs, detail, limit, hdrs) {
    return {
      ok: false,
      retryAfterMs,
      headers: hdrs,
      error: new BridgeError("RATE_LIMITED", detail, { retryAfterMs, scope: "client", limit }),
    };
  }

  const waitText = (ms) => (ms < 1000 ? `${ms} ms` : `${Math.ceil(ms / 1000)} seconds`);

  /** Hold one in-flight slot until the response ends. Only for HTTP requests (they have a response to wait for). */
  function acquireSlot(id, ctx) {
    const res = ctx?.res;
    if (!res || typeof res.once !== "function") return;
    inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (inFlight.get(id) ?? 1) - 1;
      if (n > 0) inFlight.set(id, n);
      else inFlight.delete(id);
    };
    res.once("close", release);
    res.once("finish", release);
  }

  return {
    /**
     * Spend one token for this caller.
     * @returns {{ ok: boolean, retryAfterMs: number, headers: Record<string, string>, error?: BridgeError }}
     */
    check(ctx) {
      const id = principalId(ctx);
      if (id === null) return { ok: true, retryAfterMs: 0, headers: {} };
      const now = clock.now();
      const b = bucket(id, now);
      const policy = policyFor(id);
      const u = usageRow(id, now, true);

      // The daily cap does not spend anything: it is checked first so a refused request costs no token.
      if (policy.perDay !== null && u.today >= policy.perDay) {
        u.throttledToday += 1;
        const resetMs = Math.max(1, nextIstMidnight(now) - now);
        return refusal(
          resetMs,
          `This API key has used its daily budget of ${formatNum(policy.perDay)} requests. It resets at midnight IST, in ${waitText(resetMs)}.`,
          { name: "perDay", remaining: 0, resetMs },
          { RateLimit: `limit=${formatNum(policy.perDay)}, remaining=0, reset=${Math.ceil(resetMs / 1000)}`, "RateLimit-Policy": `${formatNum(policy.perDay)};w=86400` },
        );
      }
      const open = inFlight.get(id) ?? 0;
      if (ctx?.res && open >= maxConcurrent) {
        u.throttledToday += 1;
        return refusal(
          1000,
          `This API key already has ${open} requests in flight (the limit is ${maxConcurrent}). Wait for some to finish.`,
          { name: "concurrency", remaining: 0, resetMs: 1000 },
          headers(b, Math.floor(b.tokens), 1),
        );
      }
      if (b.tokens >= 1) {
        b.tokens -= 1;
        countAdmitted(u, now);
        acquireSlot(id, ctx);
        const remaining = Math.floor(b.tokens);
        const resetS = Math.max(remaining < b.burst ? 1 : 0, Math.ceil((b.burst - b.tokens) / b.perSecond));
        return { ok: true, retryAfterMs: 0, headers: headers(b, remaining, resetS) };
      }
      u.throttledToday += 1;
      const retryAfterMs = Math.max(1, Math.ceil(((1 - b.tokens) / b.perSecond) * 1000));
      return refusal(
        retryAfterMs,
        `This API key is sending more than ${formatNum(b.perSecond)} requests a second (burst ${b.burst}). Try again in ${waitText(retryAfterMs)}.`,
        { name: "perSecond", remaining: 0, resetMs: retryAfterMs },
        headers(b, 0, Math.max(1, Math.ceil(retryAfterMs / 1000))),
      );
    },

    /** Current budget for this caller without spending anything. */
    peek(ctx) {
      const id = principalId(ctx);
      if (id === null) return { perSecond: null, burst: null, remaining: null, limited: false };
      const now = clock.now();
      const existing = buckets.get(id);
      const policy = policyFor(id);
      const tokens = existing ? Math.min(policy.burst, existing.tokens + (Math.max(0, now - existing.at) / 1000) * policy.perSecond) : policy.burst;
      return { perSecond: policy.perSecond, burst: policy.burst, remaining: Math.floor(tokens), limited: true };
    },

    /** What one key has used: { lastMinute, today, throttledToday } (zeros for a key not seen today). */
    usageOf(keyId) {
      const now = clock.now();
      const u = usageRow(`key:${keyId}`, now, false);
      if (!u) return { lastMinute: 0, today: 0, throttledToday: 0 };
      return { lastMinute: lastMinute(u, now), today: u.today, throttledToday: u.throttledToday };
    },

    /** Requests this key has in flight now. */
    inFlightOf: (keyId) => inFlight.get(`key:${keyId}`) ?? 0,

    /** The fair-queue weight of a key: its quota's weight, else the weight of its clientKind. */
    weightFor(keyId, clientKind) {
      const w = keyId ? quotas.resolve(keyId).weight : null;
      return w ?? { ...DEFAULT_KIND_WEIGHTS, ...cfg.kindWeights }[clientKind] ?? DEFAULT_KIND_WEIGHTS.other;
    },

    /** The weights by clientKind in force. */
    kindWeights: () => ({ ...DEFAULT_KIND_WEIGHTS, ...cfg.kindWeights }),

    /** The concurrency cap per key. */
    maxConcurrent,

    quotas,

    /** Number of callers tracked (tests and diagnostics). */
    get tracked() {
      return buckets.size;
    },
  };
}

function formatNum(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}
