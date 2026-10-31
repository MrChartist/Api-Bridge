import { describe, expect, it } from "vitest";
import { brokerTag, createIdempotencyStore } from "./idempotencyStore.mjs";
import { endOfIstDay, idempotencyExpiry, istDay, istIso } from "./time.mjs";

const T0 = Date.parse("2026-10-19T09:30:00+05:30");

describe("IST time helpers", () => {
  it("compute IST days, ends of day and +05:30 timestamps", () => {
    expect(istDay(Date.parse("2026-10-18T20:00:00Z"))).toBe("2026-10-19"); // 01:30 IST next day
    expect(endOfIstDay(T0)).toBe(Date.parse("2026-10-20T00:00:00+05:30"));
    expect(istIso(T0)).toBe("2026-10-19T09:30:00.000+05:30");
    expect(idempotencyExpiry(T0)).toBe(T0 + 86_400_000); // 24 h is later than midnight
  });
});

describe("idempotency store", () => {
  const make = () => {
    let t = T0;
    const store = createIdempotencyStore({ now: () => t });
    return { store, advance: (ms) => (t += ms) };
  };

  it("starts, reports in-progress, then replays the same body", () => {
    const { store } = make();
    expect(store.begin("k1", "fpA")).toEqual({ replay: false });
    expect(() => store.begin("k1", "fpA")).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_IN_PROGRESS", status: 409, retryable: true }));
    store.attach("k1", { orderId: "ord_1", accountId: "a", mode: "live" });
    store.complete("k1");
    const r = store.begin("k1", "fpA");
    expect(r.replay).toBe(true);
    expect(r.record).toMatchObject({ orderId: "ord_1", mode: "live", state: "done" });
  });

  it("refuses a different body with 409 (or the code the caller names)", () => {
    const { store } = make();
    store.begin("k1", "fpA");
    store.complete("k1", { orderId: "x", accountId: "a", mode: "paper" });
    expect(() => store.begin("k1", "fpB")).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 }));
    expect(() => store.begin("k1", "fpB", { reuseCode: "DUPLICATE_CLIENT_ORDER_ID" })).toThrow(expect.objectContaining({ code: "DUPLICATE_CLIENT_ORDER_ID" }));
  });

  it("release lets a refused request be retried; records expire after the retention window", () => {
    const { store, advance } = make();
    store.begin("k1", "fpA");
    store.release("k1");
    expect(store.begin("k1", "fpB")).toEqual({ replay: false });
    store.complete("k1", { orderId: "x", accountId: "a", mode: "paper" });
    advance(86_400_000 + 1);
    expect(store.get("k1")).toBeNull();
    expect(store.begin("k1", "fpC")).toEqual({ replay: false });
    store.prune();
  });

  it("is safe under a burst of concurrent begins: exactly one starts", () => {
    const { store } = make();
    const outcomes = Array.from({ length: 50 }, () => {
      try {
        return store.begin("same", "fp").replay ? "replay" : "started";
      } catch (e) {
        return e.code;
      }
    });
    expect(outcomes.filter((o) => o === "started")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "IDEMPOTENCY_IN_PROGRESS")).toHaveLength(49);
  });

  it("maps clientOrderIds per account per IST day, with short broker tags", () => {
    const { store, advance } = make();
    const r = store.reserveClientId("zerodha-main", "my-strategy-order-000000000000000000000001", "fp");
    expect(r.tag).toMatch(/^MCB[A-Z2-7]{13}$/);
    expect(r.tag).toBe(brokerTag("zerodha-main", "my-strategy-order-000000000000000000000001", r.day));
    expect(() => store.reserveClientId("zerodha-main", "my-strategy-order-000000000000000000000001", "fp")).toThrow(expect.objectContaining({ code: "DUPLICATE_CLIENT_ORDER_ID" }));
    expect(store.reserveClientId("dhan-main", "my-strategy-order-000000000000000000000001", "fp").tag).not.toBe(r.tag); // other account
    store.linkClientId("zerodha-main", r.clientOrderId, r.day, { orderId: "ord_9", mode: "live" });
    expect(store.findClientId(r.clientOrderId, (a) => a === "zerodha-main")).toMatchObject({ orderId: "ord_9" });
    expect(store.findClientId(r.clientOrderId, () => false)).toBeNull();
    advance(86_400_000);
    expect(() => store.reserveClientId("zerodha-main", r.clientOrderId, "fp")).not.toThrow(); // a new IST day
  });

  it("restores from a dump: in-progress with an order becomes done, without one is dropped", () => {
    const { store } = make();
    store.begin("a", "fp");
    store.attach("a", { orderId: "ord_a", accountId: "x", mode: "live" });
    store.begin("b", "fp");
    const c = store.reserveClientId("x", "c1", "fp");
    store.linkClientId("x", "c1", c.day, { orderId: "ord_a", mode: "live" });
    store.reserveClientId("x", "c2", "fp"); // never linked
    const dump = JSON.parse(JSON.stringify(store.dump()));
    const { store: again } = make();
    again.load(dump);
    expect(again.get("a")).toMatchObject({ state: "done", orderId: "ord_a" });
    expect(again.get("b")).toBeNull();
    expect(again.size()).toEqual({ records: 1, clientIds: 1 });
    expect(again.begin("a", "fp").replay).toBe(true);
  });
});
