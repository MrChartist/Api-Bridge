/**
 * OPS-11: a recording that lost its data because the computer slept says so ("computer-asleep") instead of blaming the feed.
 * The feed is taken away for 40 s (what a sleeping computer looks like to the recorder), then comes back.
 */
import { afterEach, describe, expect, it } from "vitest";
import { NIFTY, bootRecorder } from "./testkit.mjs";

let w;
afterEach(async () => {
  await w?.close();
  w = null;
});

async function sleepAndWake({ announce }) {
  w = bootRecorder();
  await w.svc.start();
  const r = await w.svc.create({ kind: "quotes", symbols: [NIFTY], everySec: 1, sessionOnly: false });
  await w.run(1000);
  w.hub.pushTick({ symbol: NIFTY, ltp: 1 });
  await w.run(2000);
  w.hub.setConnected(false);
  await w.run(40_000, 2000);
  expect(w.svc.get(r.id).gaps.open).toBeTruthy(); // the gap is open while the "sleep" lasts
  if (announce) w.bus.emit("system.resumed", { sleptMs: 40_000, from: "x", to: "y" });
  w.hub.setConnected(true);
  await w.svc.pumpAll();
  await w.run(3000);
  w.hub.pushTick({ symbol: NIFTY, ltp: 2 });
  await w.run(3000);
  return w.svc.get(r.id);
}

describe("a gap while the computer slept", () => {
  it("is labelled computer-asleep once the power watcher reports the wake", async () => {
    const v = await sleepAndWake({ announce: true });
    expect(v.gaps.total).toBe(1);
    expect(v.gaps.recent[0]).toMatchObject({ reason: "computer-asleep", state: "closed" });
    expect(v.gaps.recent[0].detail).toMatch(/computer was asleep/);
    expect(w.eventsOf("recording.gap").at(-1)).toMatchObject({ state: "closed", reason: "computer-asleep" });
  });

  it("without the report it keeps the feed's reason (the old behaviour)", async () => {
    const v = await sleepAndWake({ announce: false });
    expect(v.gaps.recent[0]).toMatchObject({ reason: "feed-down", state: "closed" });
  });
});
