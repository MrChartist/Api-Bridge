// The OI suite's time helpers (oi-suite-core.js): custom windows, the live reading laid over the newest frame, the
// replay cursor, and the fourth Spurts check (the biggest legs kept going) with the leg that argues back.
import { describe, expect, it } from "vitest";
import { boardReading, clockChoices, customWindow, framesBetween, framesFrom, hmMinutes, keptGoing, legMoves, liveFrame, moveCursor } from "./oi-suite-core.js";

const snap = (hm, { spot = 100, co = [10e3, 20e3, 30e3, 25e3, 15e3], po = [30e3, 35e3, 25e3, 15e3, 5e3], cl = [22, 14, 8, 4, 2], pl = [2, 4, 8, 14, 22] } = {}) => ({
  slot: `2026-10-30T${hm}:00.000+05:30`,
  spot,
  atm: 100,
  lotSize: 50,
  strikes: [90, 95, 100, 105, 110],
  ce: { oi: co, ltp: cl },
  pe: { oi: po, ltp: pl },
});

describe("clocks and custom windows", () => {
  it("reads a clock as minutes and refuses anything else", () => {
    expect(hmMinutes("09:15")).toBe(555);
    expect(hmMinutes("15:30")).toBe(930);
    expect(hmMinutes("9:15")).toBeNull();
    expect(hmMinutes(null)).toBeNull();
  });
  it("offers From 09:15–15:15 and To 09:30–15:30 in 15-minute steps", () => {
    const c = clockChoices(15);
    expect(c.from[0][0]).toBe("09:15");
    expect(c.from.at(-1)[0]).toBe("15:15");
    expect(c.to[0][0]).toBe("09:30");
    expect(c.to.at(-1)[0]).toBe("15:30");
    expect(c.from).toHaveLength(25);
  });
  const frames = framesFrom(["09:15", "09:30", "09:45", "10:00", "10:15"].map((hm) => snap(hm)));
  it("keeps the frames between two clocks, both ends included", () => {
    expect(framesBetween(frames, "09:30", "10:00").map((f) => f.hm)).toEqual(["09:30", "09:45", "10:00"]);
    expect(framesBetween(frames, null, "09:30").map((f) => f.hm)).toEqual(["09:15", "09:30"]);
  });
  it("compares the first reading at or after From with the last at or before To", () => {
    const w = customWindow(frames, "09:20", "10:05");
    expect(w).toMatchObject({ state: "ok", custom: true, spanMin: 30 });
    expect(w.base.hm).toBe("09:30");
    expect(w.latest.hm).toBe("10:00");
  });
  it("is not measured with fewer than two readings inside, or To not after From", () => {
    expect(customWindow(frames, "10:10", "10:20").state).toBe("none");
    expect(customWindow(frames, "10:00", "09:30").state).toBe("none");
  });
});

describe("liveFrame", () => {
  const base = framesFrom([snap("10:00")])[0];
  it("lays quotes over the newest frame as a new, live frame (the recorded one unchanged)", () => {
    const q = new Map([["100|ce", { oi: 33e3, ltp: 7.5 }], ["95|pe", { oi: 36e3, ltp: null }]]);
    const f = liveFrame(base, q, { spot: 101, t: base.t + 30e3, hm: "10:00" });
    expect(f).toMatchObject({ live: true, spot: 101, atm: null, hm: "10:00" });
    expect(f.co[2]).toBe(33e3);
    expect(f.cl[2]).toBe(7.5);
    expect(f.po[1]).toBe(36e3);
    expect(f.pl[1]).toBe(4);
    expect(base.co[2]).toBe(30e3);
    expect(f.t).toBe(base.t + 30e3);
  });
  it("drops an OI in another unit (lots against contracts) so a tick never fakes a move", () => {
    const f = liveFrame(base, new Map([["100|ce", { oi: 600, ltp: 7.5 }]]), { t: base.t + 1 });
    expect(f.co[2]).toBe(30e3);
    expect(f.cl[2]).toBe(7.5);
  });
  it("is null when nothing changed", () => {
    expect(liveFrame(base, new Map([["100|ce", { oi: 30e3, ltp: 8 }]]), { spot: 100 })).toBeNull();
    expect(liveFrame(null, new Map())).toBeNull();
  });
  it("never stamps the live frame before the recorded one", () => {
    const f = liveFrame(base, new Map([["100|ce", { oi: 31e3 }]]), { t: base.t - 5000 });
    expect(f.t).toBeGreaterThan(base.t);
  });
});

describe("moveCursor", () => {
  it("steps, seeks and returns to the newest", () => {
    expect(moveCursor(null, "prev", 10)).toBe(8);
    expect(moveCursor(null, "first", 10)).toBe(0);
    expect(moveCursor(0, "prev", 10)).toBe(0);
    expect(moveCursor(8, "next", 10)).toBe(9);
    expect(moveCursor(9, "next", 10)).toBe(9);
    expect(moveCursor(3, 42, 10)).toBe(9);
    expect(moveCursor(3, 4.4, 10)).toBe(4);
    expect(moveCursor(3, "latest", 10)).toBeNull();
  });
});

describe("keptGoing: the fourth check", () => {
  // Call 105 written steadily all window; put 95 written early and then easing back.
  const hms = ["09:15", "09:16", "09:17", "09:18", "09:19"];
  const co105 = [25e3, 30e3, 35e3, 40e3, 45e3];
  const po95 = [35e3, 50e3, 48e3, 46e3, 44e3];
  const frames = framesFrom(hms.map((hm, i) => snap(hm, { co: [10e3, 20e3, 30e3, co105[i], 15e3], cl: [22, 14, 8, 4 - i * 0.2, 2], po: [30e3, po95[i], 25e3, 15e3, 5e3], pl: [2, 4 - i * 0.1, 8, 14, 22] })));
  const moves = legMoves(frames[0], frames.at(-1));
  it("scores the biggest legs on the last three steps, weighted by size", () => {
    const k = keptGoing(moves, frames, { n: 2, steps: 3 });
    // Call 105 (+20e3) agreed on 3 of 3; put 95 (+9e3) on 0 of 3: (20 × 3) ÷ 29 = 2.07.
    expect(k).toMatchObject({ legs: 2, steps: 3, pass: true });
    expect(k.score).toBeCloseTo(2.1, 1);
  });
  it("fails when the biggest leg stalled", () => {
    const k = keptGoing(moves.filter((m) => m.strike === 95), frames, { n: 5 });
    expect(k).toMatchObject({ score: 0, pass: false });
  });
  it("is null without four readings in a row", () => {
    expect(keptGoing(moves, frames.slice(0, 3))).toBeNull();
  });
  it("adds a fourth check to the board, counted only when it could be read", () => {
    const r = boardReading(moves, { lot: 50, spot: 100, kept: keptGoing(moves, frames, { n: 2 }) });
    expect(r.checks).toHaveLength(4);
    expect(r.checks[3]).toMatchObject({ id: "kept", pass: true });
    expect(r.counted).toBe(4);
    const short = boardReading(moves, { lot: 50, spot: 100, kept: null });
    expect(short.checks[3].pass).toBeNull();
    expect(short.counted).toBe(3);
    expect(boardReading(moves, { lot: 50, spot: 100 }).checks).toHaveLength(3);
  });
  it("names the loudest leg against the lean", () => {
    // Puts written below the price (lean up) heavily, one call written above (lean down) against it.
    const a = framesFrom([snap("09:15")])[0];
    const b = framesFrom([snap("09:30", { po: [60e3, 70e3, 25e3, 15e3, 5e3], pl: [1, 2, 8, 14, 22], co: [10e3, 20e3, 30e3, 30e3, 15e3], cl: [22, 14, 8, 3, 2] })])[0];
    const r = boardReading(legMoves(a, b), { lot: 50, spot: 100 });
    expect(r.lean).toBe("up");
    expect(r.against).toMatchObject({ strike: 105, side: "ce", code: "SB" });
  });
});
