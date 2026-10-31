// The OI suite's pure maths (oi-suite-core.js): frames, windows, leg moves and the board reading, PCR, max pain and
// the strike × time plane.
import { describe, expect, it } from "vitest";
import {
  atmOf,
  boardReading,
  buildupCode,
  changeByStrike,
  changeReading,
  expiryPcrs,
  framesFrom,
  heatPlane,
  leanOf,
  legMoves,
  painCurve,
  painFloor,
  painMoves,
  painSeries,
  pcrCrossings,
  pcrSeries,
  planeTop,
  scopeStrikes,
  scopedTotals,
  seriesStats,
  shade,
  strikePcrs,
  timeColumns,
  topMoves,
  windowFrames,
} from "./oi-suite-core.js";

/** A recorder snapshot (API shape) at IST hh:mm with 5 strikes. */
const snap = (hm, { spot = 100, atm = 100, co = [10e3, 20e3, 30e3, 25e3, 15e3], po = [30e3, 35e3, 25e3, 15e3, 5e3], cl = [22, 14, 8, 4, 2], pl = [2, 4, 8, 14, 22] } = {}) => ({
  slot: `2026-10-30T${hm}:00.000+05:30`,
  spot,
  atm,
  lotSize: 50,
  strikes: [90, 95, 100, 105, 110],
  ce: { oi: co, ltp: cl },
  pe: { oi: po, ltp: pl },
});
const frame = (hm, o) => framesFrom([snap(hm, o)])[0];

describe("framesFrom", () => {
  it("turns snapshots into frames, oldest first, and leaves out ones without a price", () => {
    const f = framesFrom([snap("09:20"), snap("09:16"), { ...snap("09:18"), spot: null }]);
    expect(f.map((x) => x.hm)).toEqual(["09:16", "09:20"]);
    expect(f[0]).toMatchObject({ spot: 100, atm: 100, lot: 50, k: [90, 95, 100, 105, 110] });
    expect(f[0].co[2]).toBe(30e3);
  });
  it("keeps a missing figure null, never 0", () => {
    const f = framesFrom([snap("09:16", { co: [null, 1, 2, 3, 4] })]);
    expect(f[0].co[0]).toBeNull();
  });
  it("trims warm-up frames that carry almost no OI", () => {
    const tiny = snap("09:15", { co: [1, 1, 1, 1, 1], po: [1, 1, 1, 1, 1] });
    const f = framesFrom([tiny, snap("09:16"), snap("09:17"), snap("09:18")]);
    expect(f[0].hm).toBe("09:16");
  });
});

describe("atmOf and scopeStrikes", () => {
  it("uses the recorder's ATM, else the strike nearest the price", () => {
    expect(atmOf(frame("09:16", { atm: 105 }))).toBe(105);
    expect(atmOf(frame("09:16", { atm: null, spot: 96 }))).toBe(95);
  });
  it("counts strikes in listed rows either side of ATM, or all", () => {
    const f = frame("09:16");
    expect(scopeStrikes(f, 1)).toEqual([95, 100, 105]);
    expect(scopeStrikes(f, 10)).toEqual([90, 95, 100, 105, 110]);
    expect(scopeStrikes(f, null)).toHaveLength(5);
  });
});

describe("windowFrames", () => {
  const fr = framesFrom(["09:15", "09:20", "09:25", "09:30", "09:35", "09:40"].map((t) => snap(t)));
  it("finds the frame nearest the boundary", () => {
    const w = windowFrames(fr, "15");
    expect(w.state).toBe("ok");
    expect(w.base.hm).toBe("09:25");
    expect(w.spanMin).toBe(15);
  });
  it("says when the session is younger than the window", () => {
    const w = windowFrames(fr, "60");
    expect(w).toMatchObject({ state: "short", spanMin: 25 });
    expect(w.base.hm).toBe("09:15");
  });
  it("refuses to widen a window over a hole in the recording", () => {
    const holed = framesFrom(["09:15", "09:16", "09:40"].map((t) => snap(t)));
    expect(windowFrames(holed, "5").state).toBe("gap");
  });
  it("compares Day with the first frame and needs two frames", () => {
    expect(windowFrames(fr, "day").base.hm).toBe("09:15");
    expect(windowFrames(fr.slice(0, 1), "5").state).toBe("none");
  });
});

describe("build-up and lean", () => {
  it("names the four corners and nothing when flat", () => {
    expect([buildupCode(5, 1), buildupCode(5, -1), buildupCode(-5, 1), buildupCode(-5, -1)]).toEqual(["LB", "SB", "SC", "LU"]);
    expect(buildupCode(0, 1)).toBeNull();
    expect(buildupCode(5, null)).toBeNull();
  });
  it("points calls one way and puts the other", () => {
    expect(leanOf("ce", "LB")).toBe(1);
    expect(leanOf("ce", "SB")).toBe(-1);
    expect(leanOf("pe", "SB")).toBe(1);
    expect(leanOf("pe", "SC")).toBe(-1);
    expect(leanOf("pe", null)).toBe(0);
  });
});

describe("legMoves and boardReading", () => {
  // Calls written above the price (OI up, premium down); puts written below it.
  const a = frame("09:15");
  const b = frame("09:30", { co: [10e3, 20e3, 36e3, 40e3, 15e3], cl: [21, 13, 7, 3, 2], po: [40e3, 45e3, 25e3, 15e3, 5e3], pl: [1.5, 3, 8, 14, 22] });
  const moves = legMoves(a, b);
  it("measures every leg against its own book", () => {
    const c105 = moves.find((m) => m.strike === 105 && m.side === "ce");
    expect(c105).toMatchObject({ oi0: 25e3, oi1: 40e3, d: 15e3, code: "SB", lean: -1, thin: false });
    expect(c105.pct).toBeCloseTo(60);
    expect(c105.pxPct).toBeCloseTo(-25);
  });
  it("marks a thin start and gives it no build-up", () => {
    const thin = legMoves(a, b, { thinOi: 20e3 }).find((m) => m.strike === 95 && m.side === "ce");
    expect(thin).toMatchObject({ thin: true, code: null, lean: 0 });
  });
  it("reads only the legs and strikes asked for", () => {
    expect(legMoves(a, b, { legs: "pe" }).every((m) => m.side === "pe")).toBe(true);
    expect(legMoves(a, b, { strikes: [100] })).toHaveLength(2);
  });
  it("calls a board of new writing on both wings building, with its lean and levels", () => {
    const r = boardReading(moves, { bar: 20, lot: 50, spot: 100 });
    expect(r.regime).toBe("building");
    expect(r.opened).toBe(6e3 + 15e3 + 10e3 + 10e3);
    expect(r.closed).toBe(0);
    // Call writing points down (21e3), put writing points up (20e3): no lean either way.
    expect(r.lean).toBe("none");
    expect(r.word).toBe("Positions added on both sides");
    expect(r.levels.ceiling.strike).toBe(105);
    expect(r.levels.floor.strike).toBe(95);
    expect(r.checks.find((c) => c.id === "big").pass).toBe(true);
  });
  it("is quiet under the floor", () => {
    const c = frame("09:30", { co: [10e3, 20e3, 30e3 + 10, 25e3, 15e3], cl: [22, 14, 7, 4, 2] });
    expect(boardReading(legMoves(a, c), { lot: 50 }).regime).toBe("quiet");
  });
  it("leans up when the puts written dominate", () => {
    const c = frame("09:30", { po: [60e3, 70e3, 25e3, 15e3, 5e3], pl: [1, 2, 8, 14, 22] });
    const r = boardReading(legMoves(a, c), { lot: 50, spot: 100 });
    expect(r).toMatchObject({ regime: "building", lean: "up", tone: "pos", word: "Leans up · new positions" });
  });
  it("ranks top moves by contracts, never by percent", () => {
    const t = topMoves(moves, 1);
    expect(t.SB.rows[0]).toMatchObject({ strike: 105, side: "ce" });
    expect(t.SB.more).toBe(3);
    expect(t.LB.rows).toEqual([]);
  });
});

describe("changeByStrike and changeReading", () => {
  it("adds up what each side added and cut", () => {
    const a = frame("09:15");
    const b = frame("09:30", { co: [10e3, 20e3, 25e3, 30e3, 15e3], po: [30e3, 40e3, 25e3, 15e3, 5e3] });
    const c = changeByStrike(legMoves(a, b));
    expect(c.totals).toMatchObject({ ceAdd: 5e3, ceCut: 5e3, ce: 0, peAdd: 5e3, pe: 5e3 });
    expect(c.rows.map((r) => r.strike)).toEqual([90, 95, 100, 105, 110]);
    expect(changeReading(c.totals).key).toBe("put-add-call-cut");
  });
  it("calls a near tie even, and reads both sides cut", () => {
    expect(changeReading({ ce: 100, pe: 105 }).key).toBe("even");
    expect(changeReading({ ce: -500, pe: -100 }).key).toBe("calls-closed");
    expect(changeReading({ ce: 0, pe: 0 }).key).toBe("flat");
    expect(changeReading(null).word).toBe("Not measured");
  });
});

describe("PCR", () => {
  const f = frame("09:15");
  it("divides put OI by call OI over the strikes in scope", () => {
    const all = scopedTotals(f, null);
    expect(all).toMatchObject({ ce: 100e3, pe: 110e3, n: 5, lo: 90, hi: 110 });
    expect(all.pcr).toBeCloseTo(1.1);
    expect(scopedTotals(f, 0).pcr).toBeCloseTo(25 / 30);
  });
  it("has no ratio without call OI", () => {
    expect(scopedTotals(frame("09:15", { co: [0, 0, 0, 0, 0] })).pcr).toBeNull();
  });
  it("finds crossings of 1.00 on the printed figure", () => {
    const s = [{ pcr: 0.98, hm: "a" }, { pcr: 0.996, hm: "b" }, { pcr: 1.05, hm: "c" }, { pcr: null, hm: "d" }, { pcr: 0.9, hm: "e" }];
    expect(pcrCrossings(s).map((c) => [c.hm, c.dir])).toEqual([["b", "up"], ["e", "down"]]);
  });
  it("draws a series and its stats", () => {
    const s = pcrSeries([f, frame("09:30", { po: [40e3, 35e3, 25e3, 15e3, 5e3] })]);
    const st = seriesStats(s);
    expect(st.first).toBeCloseTo(1.1);
    expect(st.last).toBeCloseTo(1.2);
    expect(st.hiAt).toBe("09:30");
  });
  it("reads each strike and each expiry", () => {
    expect(strikePcrs(f, 0)).toEqual([{ strike: 100, ce: 30e3, pe: 25e3, pcr: 25 / 30 }]);
    expect(expiryPcrs([{ expiry: "x", callOi: 200, putOi: 100 }, { expiry: "y", callOi: 0, putOi: 5 }])).toEqual([
      { expiry: "x", ce: 200, pe: 100, pcr: 0.5 },
      { expiry: "y", ce: 0, pe: 5, pcr: null },
    ]);
  });
});

describe("max pain", () => {
  it("finds the cheapest settlement and splits the pain into its sides", () => {
    const pc = painCurve(frame("09:15"));
    // At 100: calls 10e3·10 + 20e3·5 = 200e3; puts 15e3·5 + 5e3·10 = 125e3.
    const at100 = pc.curve.find((c) => c.strike === 100);
    expect(at100).toEqual({ strike: 100, pain: 325e3, call: 200e3, put: 125e3 });
    expect(pc.strike).toBe(100);
  });
  it("breaks a tie toward the price", () => {
    const flat = frame("09:15", { spot: 104, co: [0, 0, 0, 0, 0], po: [0, 0, 0, 0, 0] });
    flat.co[2] = 1;
    flat.po[2] = 1;
    flat.co[3] = 1;
    flat.po[3] = 1;
    expect(painCurve(flat).strike).toBe(105);
  });
  it("tracks the level through the day and where it moved", () => {
    const s = painSeries([frame("09:15"), frame("09:30", { po: [30e3, 35e3, 25e3, 90e3, 5e3] })]);
    expect(s.map((p) => p.strike)).toEqual([100, 105]);
    expect(painMoves(s)).toEqual([{ t: s[1].t, hm: "09:30", from: 100, to: 105 }]);
  });
  it("says how flat the floor is", () => {
    const fl = painFloor({ strike: 100, pain: 100, curve: [{ strike: 95, pain: 100.5 }, { strike: 100, pain: 100 }, { strike: 105, pain: 130 }] });
    expect(fl.word).toBe("flat");
    expect(painFloor({ strike: 100, pain: 100, curve: [{ strike: 100, pain: 100 }, { strike: 105, pain: 110 }] }).word).toBe("sharp");
    expect(painCurve(null)).toBeNull();
  });
});

describe("heatmap through the day", () => {
  const fr = framesFrom(["09:15", "09:20", "09:31", "09:44", "09:46"].map((t, i) => snap(t, { co: [10e3, 20e3, 30e3 + i * 1000, 25e3, 15e3], cl: [22, 14, 8 - i * 0.5, 4, 2] })));
  it("keeps the last reading of each step and the newest one", () => {
    expect(timeColumns(fr, 15).map((f) => f.hm)).toEqual(["09:20", "09:44", "09:46"]);
    expect(timeColumns([], 15)).toEqual([]);
  });
  it("draws the plane with each tile's change and build-up against the column before", () => {
    const cols = timeColumns(fr, 15);
    const p = heatPlane(cols, [100, 110]);
    expect(p.rows.map((r) => r.strike)).toEqual([110, 100]);
    const c100 = p.rows[1].ce;
    expect(c100[0]).toMatchObject({ oi: 31e3, d: null, code: null });
    expect(c100[1]).toMatchObject({ oi: 33e3, d: 2e3, code: "SB" });
    expect(p.max.ce).toBe(34e3);
    expect(p.max.dce).toBe(2e3);
    expect(planeTop(p, "ce", 1).has("100|2")).toBe(true);
  });
  it("shades on a square-root scale", () => {
    expect(shade(25, 100)).toBe(0.5);
    expect(shade(null, 100)).toBe(0);
    expect(shade(-100, 100)).toBe(1);
  });
});
