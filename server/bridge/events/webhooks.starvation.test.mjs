/**
 * OPS-02: scheduling is per subscription. A receiver that accepts the connection and never answers (a friend's PC that is
 * switched off, a lapsed automation account) must not delay the other subscriptions. The audit's scenario: four
 * subscriptions to a receiver that never replies, one healthy receiver, ten events.
 */
import { describe, expect, it } from "vitest";
import { SECRET, URL_OK, bootWebhooks, createClock, createFakeReceiver } from "./testkit.mjs";

const HUNG = (n) => `https://hooks.example.test/in/hung${n}`;
const GOOD = "https://hooks.example.test/in/good";
const order = (b, n) => b.eventLog.record("order.updated", { orderId: `o${n}`, accountId: "paper", status: "filled" });
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await tick();
};

/** A receiver whose "hung" paths never answer (until released), and whose other paths answer 200. */
function hangingReceiver(clock) {
  const rx = createFakeReceiver({ clock });
  const hungCalls = new Map();
  const releases = [];
  const transport = async (req) => {
    if (req.url.pathname.startsWith("/in/hung")) {
      hungCalls.set(req.url.pathname, (hungCalls.get(req.url.pathname) ?? 0) + 1);
      await new Promise((resolve) => releases.push(resolve));
      return { status: 504, retryAfter: null, hasLocation: false };
    }
    return rx.transport(req);
  };
  return { rx, transport, hungCalls, release: () => releases.splice(0).forEach((r) => r()) };
}

describe("a receiver that never answers", () => {
  it("does not delay a healthy subscription: ten events reach it at once while four hung ones sit in their own slots", async () => {
    const clock = createClock();
    const h = hangingReceiver(clock);
    const b = bootWebhooks({ clock, receiver: { transport: h.transport, calls: h.rx.calls, script: h.rx.script, bodies: h.rx.bodies, secret: SECRET } });
    const hung = [];
    for (let i = 1; i <= 4; i += 1) hung.push(await b.svc.create({ url: HUNG(i), topics: ["order.*"], secret: SECRET }));
    const good = await b.svc.create({ url: GOOD, topics: ["order.*"], secret: SECRET });
    for (let i = 1; i <= 10; i += 1) order(b, i);
    void b.svc.pump(); // never resolves while the hung receivers hold their attempts
    await settle();
    // all ten reached the healthy receiver, in order, without waiting for any timeout
    expect(h.rx.bodies().map((x) => x.data.orderId)).toEqual(Array.from({ length: 10 }, (_, i) => `o${i + 1}`));
    expect(b.svc.get(good.id)).toMatchObject({ pending: 0, health: { delivered: 10 } });
    // each hung subscription holds at most its own two slots; the rest of its events wait their turn
    for (const s of hung) expect(h.hungCalls.get(new URL(HUNG(hung.indexOf(s) + 1)).pathname)).toBe(2);
    expect(b.svc.status().inflight).toBe(8);
    expect(b.svc.get(hung[0].id).pending).toBe(10);
    h.release();
    await settle();
  });

  it("a slot that frees up is refilled at once (no waiting for the slowest of a batch)", async () => {
    const clock = createClock();
    const h = hangingReceiver(clock);
    const b = bootWebhooks({ clock, receiver: { transport: h.transport, calls: h.rx.calls, script: h.rx.script, bodies: h.rx.bodies, secret: SECRET } });
    await b.svc.create({ url: HUNG(1), topics: ["order.*"], secret: SECRET });
    await b.svc.create({ url: GOOD, topics: ["order.*"], secret: SECRET });
    for (let i = 1; i <= 3; i += 1) order(b, i);
    void b.svc.pump();
    await settle();
    expect(h.rx.calls).toHaveLength(3);
    // events that arrive later are delivered too, with the hung attempts still open
    for (let i = 4; i <= 6; i += 1) order(b, i);
    void b.svc.pump();
    await settle();
    expect(h.rx.calls).toHaveLength(6);
    h.release();
    await settle();
  });
});

describe("the circuit breaker", () => {
  it("after a few no-answer failures in a row, a subscription gets one attempt per backoff period, not one per event", async () => {
    const clock = createClock();
    const b = bootWebhooks({ clock, config: { webhooks: { breakerAfter: 3, retry: { baseMs: 5000, maxMs: 60_000, jitter: 0 } } } });
    const s = await b.svc.create({ url: URL_OK, topics: ["order.*"], secret: SECRET });
    b.receiver.always({ throws: "ETIMEDOUT" });
    for (let i = 1; i <= 12; i += 1) order(b, i);
    await b.svc.pump();
    const firstRound = b.receiver.calls.length;
    expect(firstRound).toBeLessThanOrEqual(4); // three failures trip it; at most the other slot was already in flight
    expect(firstRound).toBeGreaterThanOrEqual(3);
    // more events arrive while it is held: nothing is attempted
    for (let i = 13; i <= 20; i += 1) order(b, i);
    await b.svc.pump();
    expect(b.receiver.calls).toHaveLength(firstRound);
    expect(b.svc.get(s.id).health.state).toBe("failing");
    // the hold ends: ONE probe, not a burst
    clock.advance(10 * 60_000);
    await b.svc.pump();
    expect(b.receiver.calls.length).toBeLessThanOrEqual(firstRound + 2);
    expect(b.receiver.calls.length).toBeGreaterThan(firstRound);
    // the receiver comes back: the queue drains and the hold is forgotten
    const before = b.receiver.calls.length;
    b.receiver.always({ status: 200 });
    clock.advance(60 * 60_000);
    await b.svc.pump();
    await b.svc.pump();
    expect(b.receiver.calls.length).toBeGreaterThan(before);
    expect(b.svc.get(s.id).health.state).toBe("ok");
  });

  it("an answer such as 500 or 400 does not trip it (the slot was freed at once)", async () => {
    const b = bootWebhooks({ config: { webhooks: { breakerAfter: 2 } } });
    await b.svc.create({ url: URL_OK, topics: ["order.*"], secret: SECRET });
    b.receiver.always({ status: 400 });
    for (let i = 1; i <= 8; i += 1) order(b, i);
    await b.svc.pump();
    expect(b.receiver.calls).toHaveLength(8);
  });
});
