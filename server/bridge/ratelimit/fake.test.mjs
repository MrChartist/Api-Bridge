import { describe, expect, it } from "vitest";
import { SessionRequiredError } from "../../brokers/contract.mjs";
import { assertService } from "../core/contracts.mjs";
import { TOPICS, createEventBus } from "../core/eventBus.mjs";
import { createFakeScheduler, createManualClock } from "./fake.mjs";

describe("createManualClock", () => {
  it("fires timers in order as time advances, including timers set by timers", async () => {
    const clock = createManualClock(0);
    const fired = [];
    clock.setTimeout(() => fired.push(["b", clock.now()]), 200);
    clock.setTimeout(() => {
      fired.push(["a", clock.now()]);
      clock.setTimeout(() => fired.push(["c", clock.now()]), 150);
    }, 100);
    const gone = clock.setTimeout(() => fired.push(["never", clock.now()]), 50);
    clock.clearTimeout(gone);
    expect(clock.pending()).toBe(2);
    await clock.advance(1000);
    expect(fired).toEqual([["a", 100], ["b", 200], ["c", 250]]);
    expect(clock.now()).toBe(1000);
    await clock.set(5000);
    expect(clock.now()).toBe(5000);
  });
});

describe("createFakeScheduler", () => {
  it("satisfies the Scheduler contract", () => {
    expect(() => assertService("scheduler", createFakeScheduler())).not.toThrow();
  });

  it("runs calls at once, records them and coalesces reads", async () => {
    const s = createFakeScheduler();
    let n = 0;
    const fn = async () => ++n;
    const [a, b] = await Promise.all([1, 2].map(() => s.schedule({ accountId: "dhan-main", endpointClass: "quote", coalesceKey: "k" }, fn)));
    expect([a, b]).toEqual([1, 1]);
    await s.schedule({ accountId: "dhan-main", endpointClass: "order", coalesceKey: "k" }, fn);
    expect(s.calls).toEqual([
      { accountId: "dhan-main", endpointClass: "quote", priority: "interactive", coalesceKey: "k", cost: 1 },
      { accountId: "dhan-main", endpointClass: "order", priority: "order", coalesceKey: "k", cost: 1 },
    ]);
    expect(s.savings.coalesced).toBe(1);
    await expect(s.schedule({ accountId: "x", endpointClass: "nope" }, fn)).rejects.toThrow(TypeError);
  });

  it("can be told to throttle, and reports session errors on the bus", async () => {
    const bus = createEventBus({ topics: TOPICS });
    const seen = [];
    bus.on("account.session_rejected", (p) => seen.push(p));
    bus.on("limits.throttled", (p) => seen.push(p));
    const s = createFakeScheduler({ bus });
    s.noteUpstreamThrottle("dhan-main", "quote", 60_000);
    await expect(s.schedule({ accountId: "dhan-main", endpointClass: "quote" }, async () => 1)).rejects.toMatchObject({ code: "UPSTREAM_RATE_LIMITED" });
    expect(s.tryAcquire("dhan-main", "quote").ok).toBe(false);
    expect(s.headroom("dhan-main", "quote").remaining).toBe(0);
    expect(s.pickAccount({ candidates: ["dhan-main", "zerodha-2"], endpointClass: "quote" })).toBe("zerodha-2");
    const err = new SessionRequiredError();
    await expect(s.schedule({ accountId: "dhan-main", endpointClass: "portfolio" }, async () => Promise.reject(err))).rejects.toBe(err);
    expect(seen).toContainEqual({ accountId: "dhan-main", broker: "dhan", code: "SESSION_LOGIN_REQUIRED" });
    s.recordSaving("stream", 2);
    expect(s.usage().savings.servedFromStream).toBe(2);
    expect(s.policyFor("zerodha").limits.quote.perSecond).toBe(1);
    expect(s.checkClient({}).ok).toBe(true);
    s.reset();
    expect(s.calls).toEqual([]);
  });
});
