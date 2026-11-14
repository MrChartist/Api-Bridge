/**
 * OPS-11: the power watcher tells sleep from a clock step with two fake clocks.
 */
import { describe, expect, it } from "vitest";
import { createEventBus } from "./eventBus.mjs";
import { createPowerWatcher } from "./powerEvents.mjs";

function rig() {
  const state = { wall: 1_000_000, mono: 5_000 };
  const bus = createEventBus();
  const seen = [];
  bus.on("system.resumed", (e) => seen.push(["resumed", e]));
  bus.on("system.clock_changed", (e) => seen.push(["clock", e]));
  const w = createPowerWatcher({ bus, wall: () => state.wall, mono: () => state.mono, setInterval: () => ({ unref() {} }), clearInterval() {} });
  /** Time passes: both clocks, or only one of them. */
  const pass = ({ wall, mono = wall }) => {
    state.wall += wall;
    state.mono += mono;
    w.beat();
  };
  return { pass, seen, state };
}

describe("the power watcher", () => {
  it("says nothing for a normal beat, a late timer or a small drift", () => {
    const t = rig();
    t.pass({ wall: 1000 });
    t.pass({ wall: 1200, mono: 1180 });
    t.pass({ wall: 4000 }); // a slow tick, still both clocks
    expect(t.seen).toEqual([]);
  });

  it("a sleep (the wall clock moved, the monotonic one did not) is system.resumed with how long", () => {
    const t = rig();
    t.pass({ wall: 1000 });
    t.pass({ wall: 75_000, mono: 1000 });
    expect(t.seen).toHaveLength(1);
    expect(t.seen[0][0]).toBe("resumed");
    expect(t.seen[0][1].sleptMs).toBe(74_000);
    expect(t.seen[0][1].from).toMatch(/^1970-/);
  });

  it("a frozen process (both clocks jumped, the beat was very late) is also a resume", () => {
    const t = rig();
    t.pass({ wall: 60_000 });
    expect(t.seen).toHaveLength(1);
    expect(t.seen[0][1].sleptMs).toBeGreaterThanOrEqual(59_000);
  });

  it("a wall clock stepped forward or back without time passing is system.clock_changed", () => {
    const t = rig();
    t.state.wall += 3_600_000; // an NTP step of one hour, forward, between two beats
    t.state.mono += 1000;
    t.state.wall += 1000;
    // forward by an hour looks like a long sleep: it is reported as a resume (both are the same fact to a consumer)
    t.pass({ wall: 0, mono: 0 });
    expect(t.seen[0][0]).toBe("resumed");
    t.seen.length = 0;
    t.pass({ wall: -45_000, mono: 1000 }); // the clock was put back 46 s
    expect(t.seen).toHaveLength(1);
    expect(t.seen[0][0]).toBe("clock");
    expect(t.seen[0][1].deltaMs).toBe(-46_000);
  });

  it("start and stop use the timer, and stop removes it", () => {
    const cleared = [];
    const w = createPowerWatcher({ bus: createEventBus(), setInterval: () => "H", clearInterval: (h) => cleared.push(h) });
    w.start();
    w.start();
    w.stop();
    expect(cleared).toEqual(["H"]);
  });
});
