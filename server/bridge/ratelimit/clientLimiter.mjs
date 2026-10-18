/**
 * Inbound per-key request budget — stream S3 (Scheduler.checkClient). Protects the Bridge and, indirectly, the
 * broker budgets from one runaway script, sheet or AI client.
 *
 * A classic token bucket per principal: `burst` tokens, refilled at `perSecond`. One request costs one token.
 * Headers follow the IETF RateLimit header draft in the syntax the core tests pin (the draft may still change):
 *
 *   RateLimit:        limit=50, remaining=49, reset=1      reset = whole seconds until the bucket is full again
 *                                                           (on a refusal: until the next request is allowed)
 *   RateLimit-Policy: 50;w=1;burst=50
 *
 * Local (CLI) callers are not limited. Idle buckets are dropped so the map stays small.
 */

const MAX_TRACKED = 10_000;
const IDLE_DROP_MS = 10 * 60_000;

/**
 * @param {{ perSecond: number, burst?: number, keys?: Record<string, { perSecond: number, burst?: number }> }} cfg
 * @param {{ now: () => number }} clock
 */
export function createClientLimiter(cfg, clock) {
  /** @type {Map<string, { tokens: number, at: number, perSecond: number, burst: number }>} */
  const buckets = new Map();

  const policyFor = (id) => {
    const own = cfg.keys?.[id];
    const perSecond = own?.perSecond ?? cfg.perSecond;
    const burst = own?.burst ?? (own ? Math.max(1, Math.ceil(own.perSecond)) : cfg.burst ?? Math.max(1, Math.ceil(cfg.perSecond)));
    return { perSecond, burst };
  };

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
    const policy = policyFor(id.startsWith("key:") ? id.slice(4) : id);
    if (!b) {
      b = { tokens: policy.burst, at: now, ...policy };
    } else {
      const elapsed = Math.max(0, now - b.at) / 1000;
      b.tokens = Math.min(policy.burst, b.tokens + elapsed * policy.perSecond);
      b.at = now;
      b.perSecond = policy.perSecond;
      b.burst = policy.burst;
      buckets.delete(id); // re-insert to keep LRU order
    }
    buckets.set(id, b);
    prune(now);
    return b;
  }

  const headers = (b, remaining, resetS) => ({
    RateLimit: `limit=${formatNum(b.perSecond)}, remaining=${remaining}, reset=${resetS}`,
    "RateLimit-Policy": `${formatNum(b.perSecond)};w=1;burst=${b.burst}`,
  });

  return {
    /**
     * Spend one token for this caller.
     * @returns {{ ok: boolean, retryAfterMs: number, headers: Record<string, string> }}
     */
    check(ctx) {
      const id = principalId(ctx);
      if (id === null) return { ok: true, retryAfterMs: 0, headers: {} };
      const now = clock.now();
      const b = bucket(id, now);
      if (b.tokens >= 1) {
        b.tokens -= 1;
        const remaining = Math.floor(b.tokens);
        const resetS = Math.max(remaining < b.burst ? 1 : 0, Math.ceil((b.burst - b.tokens) / b.perSecond));
        return { ok: true, retryAfterMs: 0, headers: headers(b, remaining, resetS) };
      }
      const retryAfterMs = Math.max(1, Math.ceil(((1 - b.tokens) / b.perSecond) * 1000));
      return { ok: false, retryAfterMs, headers: headers(b, 0, Math.max(1, Math.ceil(retryAfterMs / 1000))) };
    },

    /** Current budget for this caller without spending anything. */
    peek(ctx) {
      const id = principalId(ctx);
      if (id === null) return { perSecond: null, burst: null, remaining: null, limited: false };
      const now = clock.now();
      const existing = buckets.get(id);
      const policy = policyFor(id.startsWith("key:") ? id.slice(4) : id);
      const tokens = existing ? Math.min(policy.burst, existing.tokens + (Math.max(0, now - existing.at) / 1000) * policy.perSecond) : policy.burst;
      return { perSecond: policy.perSecond, burst: policy.burst, remaining: Math.floor(tokens), limited: true };
    },

    /** Number of callers tracked (tests and diagnostics). */
    get tracked() {
      return buckets.size;
    },
  };
}

function formatNum(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}
