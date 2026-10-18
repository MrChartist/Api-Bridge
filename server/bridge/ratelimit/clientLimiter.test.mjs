import { describe, expect, it } from "vitest";
import { createLogger } from "../core/logger.mjs";
import { createCallContext } from "../core/context.mjs";
import { createClientLimiter } from "./clientLimiter.mjs";

const log = createLogger({ level: "silent" });
const keyCtx = (id) => createCallContext({ source: "rest", key: { id, label: id, scopes: ["read"], accounts: "*" }, log });

function clockAt(t = 1_000_000) {
  const c = { t, now: () => c.t };
  return c;
}

describe("client limiter", () => {
  it("spends one token per request and reports RateLimit headers", () => {
    const clock = clockAt();
    const lim = createClientLimiter({ perSecond: 10 }, clock);
    const ctx = keyCtx("abcd000001");
    const r = lim.check(ctx);
    expect(r).toEqual({ ok: true, retryAfterMs: 0, headers: { RateLimit: "limit=10, remaining=9, reset=1", "RateLimit-Policy": "10;w=1;burst=10" } });
    for (let i = 0; i < 9; i++) expect(lim.check(ctx).ok).toBe(true);
    const refused = lim.check(ctx);
    expect(refused.ok).toBe(false);
    expect(refused.retryAfterMs).toBe(100);
    expect(refused.headers.RateLimit).toBe("limit=10, remaining=0, reset=1");
    clock.t += 100;
    expect(lim.check(ctx).ok).toBe(true);
  });

  it("keeps separate budgets per key, honours per-key settings and burst", () => {
    const clock = clockAt();
    const lim = createClientLimiter({ perSecond: 50, burst: 5, keys: { slow000001: { perSecond: 1 } } }, clock);
    const slow = keyCtx("slow000001");
    expect(lim.check(slow).ok).toBe(true);
    const r = lim.check(slow);
    expect(r).toMatchObject({ ok: false, retryAfterMs: 1000 });
    expect(r.headers["Retry-After"]).toBeUndefined();
    const other = keyCtx("fast000001");
    for (let i = 0; i < 5; i++) expect(lim.check(other).ok).toBe(true);
    expect(lim.check(other).ok).toBe(false);
    expect(lim.peek(other)).toMatchObject({ perSecond: 50, burst: 5, remaining: 0, limited: true });
    clock.t += 1000;
    expect(lim.peek(other).remaining).toBe(5);
    expect(lim.tracked).toBe(2);
  });

  it("does not limit local (CLI) callers and limits hooks by their id", () => {
    const lim = createClientLimiter({ perSecond: 1 }, clockAt());
    const local = createCallContext({ source: "cli", principal: { kind: "local", id: "cli" }, log });
    for (let i = 0; i < 10; i++) expect(lim.check(local)).toEqual({ ok: true, retryAfterMs: 0, headers: {} });
    expect(lim.peek(local).limited).toBe(false);
    const hook = createCallContext({ source: "webhook", principal: { kind: "hook", id: "tv-1" }, log });
    expect(lim.check(hook).ok).toBe(true);
    expect(lim.check(hook).ok).toBe(false);
  });

  it("formats fractional budgets", () => {
    const lim = createClientLimiter({ perSecond: 0.5 }, clockAt());
    expect(lim.check(keyCtx("frac000001")).headers["RateLimit-Policy"]).toBe("0.5;w=1;burst=1");
  });
});
