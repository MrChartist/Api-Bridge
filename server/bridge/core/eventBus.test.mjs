import { describe, expect, it, vi } from "vitest";
import { TOPICS, createEventBus } from "./eventBus.mjs";

describe("event bus", () => {
  it("delivers in subscription order and returns the handler count", () => {
    const bus = createEventBus();
    const seen = [];
    bus.on("tick", (p) => seen.push(["a", p.symbol]));
    bus.on("tick", (p) => seen.push(["b", p.symbol]));
    expect(bus.emit("tick", { symbol: "NSE:NIFTY" })).toBe(2);
    expect(seen).toEqual([["a", "NSE:NIFTY"], ["b", "NSE:NIFTY"]]);
  });

  it("unsubscribes and supports once()", () => {
    const bus = createEventBus();
    const fn = vi.fn();
    const off = bus.on("order.updated", fn);
    bus.once("order.updated", fn);
    bus.emit("order.updated", {});
    off();
    bus.emit("order.updated", {});
    expect(fn).toHaveBeenCalledTimes(2);
    expect(bus.listenerCount()).toBe(0);
  });

  it("isolates a throwing handler and logs it", () => {
    const errors = [];
    const bus = createEventBus({ logger: { error: (m, f) => errors.push(f.topic) } });
    const after = vi.fn();
    bus.on("safety.kill_switch", () => {
      throw new Error("boom");
    });
    bus.on("safety.kill_switch", after);
    expect(bus.emit("safety.kill_switch", { engaged: true })).toBe(1);
    expect(after).toHaveBeenCalled();
    expect(errors).toEqual(["safety.kill_switch"]);
  });

  it("refuses unknown topics on both sides", () => {
    const bus = createEventBus();
    expect(() => bus.on("tik", () => {})).toThrow(/Unknown event topic/);
    expect(() => bus.emit("tik", {})).toThrow(/Unknown event topic/);
    expect(TOPICS).toContain("account.status");
  });
});
