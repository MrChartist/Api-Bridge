import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { black76 } from "./pricing.js";
import { DASH, MINUS } from "./format.js";
import {
  actualDayPts,
  badgeLanes,
  changeOver,
  dayRange,
  daysTo,
  expiryRow,
  extremes,
  flipGist,
  ivTodayModel,
  ivTodaySpec,
  ivAtForward,
  ivVerdict,
  leanText,
  legAt,
  nearestStrikes,
  perSession,
  premiumVerdict,
  pricedVsActual,
  rupeeCr,
  sessionsLeft,
  sigmaMovePts,
  snapshotPoints,
  straddleLevels,
  straddleSplit,
  straddleSpec,
  timeOnlyLine,
} from "./vol-suite-core.js";

const ist = (s) => Date.parse(`${s}+05:30`);
/** A recorder snapshot priced by Black-76 at one flat IV, the way the recorder stores it. */
function snap(ts, { spot = 25000, forward = 25010, t = 0.01, iv = 15, strikes = [24900, 25000, 25100], ltpBump = 0 } = {}) {
  const leg = (right) => ({ ltp: strikes.map((k) => Math.round((black76(forward, k, t, iv, right) + ltpBump) * 100) / 100), iv: strikes.map(() => iv), oi: strikes.map(() => 100) });
  const atm = strikes.reduce((b, k) => (Math.abs(k - forward) < Math.abs(b - forward) ? k : b));
  const ce = leg("CE");
  const pe = leg("PE");
  const i = strikes.indexOf(atm);
  return { ts, spot, forward, atm, t, straddle: ce.ltp[i] + pe.ltp[i], strikes, ce, pe };
}

describe("ivAtForward", () => {
  it("is linear in strike between the strikes either side of the forward, each the mean of CE and PE", () => {
    expect(ivAtForward([100, 200], [10, 20], [12, 22], 150)).toBeCloseTo(16, 10);
    expect(ivAtForward([100, 200], [10, 20], [12, 22], 100)).toBe(11);
  });
  it("uses one side when the other has no IV, and gives null without a bracket", () => {
    expect(ivAtForward([100, 200], [10, 0], [0, 22], 100)).toBe(10);
    expect(ivAtForward([100, 200], [10, 20], [10, 20], 250)).toBeNull();
    expect(ivAtForward(null, [], [], 100)).toBeNull();
  });
});

describe("snapshotPoints", () => {
  it("keeps the latest session only, oldest first, and drops snapshots without a forward", () => {
    const pts = snapshotPoints([snap("2026-10-31T09:20:00+05:30"), snap("2026-10-30T15:20:00+05:30"), { ts: "2026-10-31T09:21:00+05:30", forward: 0, t: 0.01 }, snap("2026-10-31T09:15:00+05:30")]);
    expect(pts.map((p) => p.t)).toEqual([ist("2026-10-31T09:15:00"), ist("2026-10-31T09:20:00")]);
    expect(pts[0].atmIv).toBeCloseTo(15, 6);
    expect(pts[0].atm).toBe(25000);
    expect(pts[0].straddle).toBeGreaterThan(0);
  });
  it("is empty for nothing", () => {
    expect(snapshotPoints(undefined)).toEqual([]);
  });
});

describe("legAt", () => {
  it("reads one leg at a strike, 0 as missing", () => {
    const s = snap("2026-10-31T09:15:00+05:30");
    expect(legAt(s, 25000, "ce").iv).toBe(15);
    expect(legAt({ strikes: [1], ce: { ltp: [0], iv: [0] } }, 1, "ce")).toEqual({ ltp: null, iv: null });
    expect(legAt(s, 1, "pe")).toEqual({ ltp: null, iv: null });
  });
});

describe("dayRange and changeOver", () => {
  const pts = [
    { t: ist("2026-10-31T09:15:00"), v: 10 },
    { t: ist("2026-10-31T09:30:00"), v: 14 },
    { t: ist("2026-10-31T09:45:00"), v: null },
    { t: ist("2026-10-31T10:00:00"), v: 8 },
  ];
  it("finds the day's high and low with their times", () => {
    expect(dayRange(pts, "v")).toEqual({ hi: 14, hiT: pts[1].t, lo: 8, loT: pts[3].t });
    expect(dayRange([], "v")).toBeNull();
  });
  it("measures from the first reading for the day, and from a reading close enough to the minutes back", () => {
    expect(changeOver(pts, "v", "day")).toMatchObject({ now: 8, base: 10, change: -2, pct: -20 });
    expect(changeOver(pts, "v", 30)).toMatchObject({ base: 14, change: -6 });
    // 15 minutes back is 09:45, which has no value; the nearest reading (09:30) is 15 minutes off: no baseline.
    expect(changeOver(pts, "v", 15)).toBeNull();
    // A reading a few seconds after the target counts (minute snapshots land a little late).
    const late = [{ t: 0, v: 1 }, { t: 600_000 + 4_000, v: 2 }, { t: 1_500_000, v: 3 }];
    expect(changeOver(late, "v", 15)).toMatchObject({ base: 2, change: 1 });
    expect(changeOver(pts.slice(0, 1), "v", "day")).toBeNull();
  });
});

describe("premiumVerdict", () => {
  it("calls rising or falling only beyond 1% of the baseline and one tick", () => {
    expect(premiumVerdict({ change: 3, base: 280 })).toBe("rising");
    expect(premiumVerdict({ change: -3, base: 280 })).toBe("falling");
    expect(premiumVerdict({ change: -2.5, base: 280 })).toBe("steady");
    expect(premiumVerdict({ change: 0.05, base: 2 })).toBe("steady");
    expect(premiumVerdict(null)).toBeNull();
  });
});

describe("moves", () => {
  it("prices the expected move at 0.85 × the straddle around spot, and breakevens at the strike ± premium", () => {
    const l = straddleLevels({ premium: 278.85, strike: 24550, spot: 24512.35 });
    expect(l.expectedMove).toBeCloseTo(237.0225, 6);
    expect(l.rangeLo).toBeCloseTo(24275.33, 2);
    expect(l.beLo).toBeCloseTo(24271.15, 2);
    expect(l.beHi).toBeCloseTo(24828.85, 2);
    expect(straddleLevels({ premium: null })).toBeNull();
  });
  it("turns IV into points with the square root of time", () => {
    expect(sigmaMovePts(24512.35, 11.84, 6.174 / 365)).toBeCloseTo(377.5, 0);
    expect(sigmaMovePts(0, 11, 1)).toBeNull();
    expect(perSession(377.5, 3.649)).toBeCloseTo(197.6, 1);
    expect(actualDayPts(24512.35, 10)).toBeCloseTo(154.4, 1);
  });
  it("counts sessions left: the rest of today plus each weekday to expiry", () => {
    // Wednesday 11:30 to Tuesday's expiry: 0.64 of today + Thu, Fri, Mon, Tue (no holiday calendar here).
    const n = sessionsLeft(ist("2026-09-30T11:30:00"), "2026-10-06");
    expect(n).toBeCloseTo(4 + 240 / 375, 6);
    expect(sessionsLeft(ist("2026-10-03T11:30:00"), "2026-10-05")).toBe(1); // a Saturday: only Monday
    expect(sessionsLeft(ist("2026-10-06T15:31:00"), "2026-10-06")).toBeNull();
    expect(sessionsLeft(ist("2026-10-06T14:00:00"), "bad")).toBeNull();
  });
  it("words the priced day against the actual day on the whole points shown", () => {
    expect(pricedVsActual(198, 154)).toMatchObject({ word: "bigger", priced: 198, actual: 154 });
    expect(pricedVsActual(160, 154).word).toBe("like");
    expect(pricedVsActual(120, 154).word).toBe("smaller");
    expect(pricedVsActual(120, null)).toBeNull();
  });
  it("words the IV percentile on the whole number", () => {
    expect(ivVerdict(79.6)).toBe("high");
    expect(ivVerdict(20.4)).toBe("low");
    expect(ivVerdict(65)).toBe("normal");
    expect(ivVerdict(null)).toBeNull();
  });
});

describe("straddleSplit", () => {
  it("adds up exactly to the traded change, and puts an IV-only change in the IV row", () => {
    const a = snap("2026-10-31T09:15:00+05:30", { iv: 15 });
    const b = snap("2026-10-31T11:15:00+05:30", { iv: 14 });
    const s = straddleSplit(a, b, 25000);
    const sum = s.parts.reduce((t, p) => t + p.value, 0);
    expect(sum).toBeCloseTo(s.total, 9);
    const by = Object.fromEntries(s.parts.map((p) => [p.id, p.value]));
    expect(by.spot).toBeCloseTo(0, 9);
    expect(by.time).toBeCloseTo(0, 9);
    expect(by.iv).toBeLessThan(0);
    expect(Math.abs(by.other)).toBeLessThan(0.02); // only the rounding of the stored prices
    expect(s.ivPts).toBeCloseTo(-1, 9);
    expect(s.minutes).toBe(120);
    expect(s.rough).toBe(false);
  });
  it("puts time passing in the time row and a price move in the price row", () => {
    const a = snap("2026-10-31T09:15:00+05:30", { t: 0.01 });
    const b = snap("2026-10-31T15:15:00+05:30", { t: 0.009, forward: 25100, spot: 25090 });
    const by = Object.fromEntries(straddleSplit(a, b, 25000).parts.map((p) => [p.id, p.value]));
    expect(by.time).toBeLessThan(0);
    expect(by.spot).toBeGreaterThan(0);
  });
  it("flags a split whose unexplained part is large, and gives null when a leg is missing", () => {
    const a = snap("2026-10-31T09:15:00+05:30");
    const b = snap("2026-10-31T09:45:00+05:30", { ltpBump: 30 });
    expect(straddleSplit(a, b, 25000).rough).toBe(true);
    expect(straddleSplit(a, b, 1)).toBeNull();
    expect(straddleSplit(null, b, 25000)).toBeNull();
  });
});

describe("timeOnlyLine", () => {
  it("scales the first premium by the square root of the time left", () => {
    const line = timeOnlyLine([{ t: 1, straddle: 100, years: 0.04 }, { t: 2, straddle: 90, years: 0.01 }]);
    expect(line).toEqual([{ t: 1, v: 100 }, { t: 2, v: 50 }]);
    expect(timeOnlyLine([])).toEqual([]);
  });
});

describe("expiryRow and extremes", () => {
  const chain = { expiry: "2026-11-03", underlyingLtp: 25000, atmStrike: 25000, rows: [{ strike: 25000, ce: { ltp: 200, iv: 14 }, pe: { ltp: 180, iv: 16 } }] };
  it("prices the ATM straddle, its levels and the moves", () => {
    const r = expiryRow(chain, ist("2026-10-31T11:30:00"));
    expect(r.premium).toBe(380);
    expect(r.atmIv).toBe(15);
    expect(r.levels.expectedMove).toBeCloseTo(323, 6);
    expect(r.days).toBeCloseTo(3 + 4 / 24, 6);
    expect(r.sigma).toBeCloseTo(25000 * 0.15 * Math.sqrt(r.days / 365), 6);
    expect(r.perDay).toBeCloseTo(r.sigma / Math.sqrt(r.sessions), 9);
  });
  it("leaves the straddle out when a leg has no price", () => {
    const r = expiryRow({ ...chain, rows: [{ strike: 25000, ce: { ltp: 0 }, pe: { ltp: 180 } }] }, ist("2026-10-31T11:30:00"));
    expect(r.premium).toBeNull();
    expect(r.levels).toBeNull();
  });
  it("names the highest and lowest rows", () => {
    expect(extremes([{ expiry: "a", v: 1 }, { expiry: "b", v: 3 }, { expiry: "c", v: null }], "v")).toEqual({ hi: "b", lo: "a" });
    expect(extremes([{ expiry: "a", v: 1 }], "v")).toEqual({ hi: null, lo: null });
  });
  it("counts calendar days to the 15:30 close", () => {
    expect(daysTo(ist("2026-11-03T15:30:00"), "2026-11-03")).toBe(0);
    expect(daysTo(1, "x")).toBeNull();
  });
});

describe("GEX words", () => {
  it("prints rupees in crore and lakh with a true minus", () => {
    expect(rupeeCr(7868e7)).toBe("₹7868 Cr");
    expect(rupeeCr(-605.77e7)).toBe(`${MINUS}₹605.8 Cr`);
    expect(rupeeCr(1.5e5)).toBe("₹1.5 L");
    expect(rupeeCr(5e3)).toBe("< ₹1 L");
    expect(rupeeCr(null)).toBe(DASH);
  });
  it("prints the lean truncated toward the 10% band near it", () => {
    expect(leanText(0.0996)).toBe("9.9%");
    expect(leanText(0.21)).toBe("21%");
    expect(leanText(null)).toBe(DASH);
  });
  it("says where the price is from the flip", () => {
    expect(flipGist("NIFTY", 109.4)).toBe("NIFTY 109 above the flip");
    expect(flipGist("NIFTY", -32)).toBe("NIFTY 32 below the flip");
    expect(flipGist("NIFTY", null)).toBe("No flip within 25% of NIFTY");
  });
  it("puts overlapping badges on separate lanes", () => {
    const out = badgeLanes([{ id: "a", x: 100, w: 60 }, { id: "b", x: 120, w: 60 }, { id: "c", x: 300, w: 60 }]);
    expect(out.map((i) => [i.id, i.lane])).toEqual([["a", 0], ["b", 1], ["c", 0]]);
  });
  it("keeps the strikes nearest spot", () => {
    const ks = [24800, 24900, 25000, 25100, 25200].map((strike) => ({ strike }));
    expect(nearestStrikes(ks, 25040, 3).map((s) => s.strike)).toEqual([24900, 25000, 25100]);
    expect(nearestStrikes(ks, 25040, 0)).toHaveLength(5);
  });
});

describe("chart specs and the IV-today answers", () => {
  const day = [
    { t: ist("2026-10-31T09:15:00"), spot: 25000, straddle: 300, years: 0.01, atmIv: 15 },
    { t: ist("2026-10-31T10:15:00"), spot: 25050, straddle: 290, years: 0.0099, atmIv: 14.5 },
    { t: ist("2026-10-31T11:15:00"), spot: 25020, straddle: 295, years: 0.0098, atmIv: null },
  ];
  it("draws the straddle with the time-alone line and spot, and says so with one reading", () => {
    const spec = straddleSpec(day, { underlying: "NIFTY", expiry: "2026-11-03" });
    expect(spec.series.map((x) => x.id)).toEqual(["st", "decay", "hi", "lo", "spot"]);
    expect(spec.series[1].data[1].v).toBeCloseTo(300 * Math.sqrt(0.0099 / 0.01), 9);
    expect(spec.series.find((x) => x.id === "hi").value).toBe(300);
    expect(straddleSpec(day.slice(0, 1), {}).empty).toBeTruthy();
  });
  it("draws the ATM IV with the day's high and low, leaving gaps out", () => {
    const spec = ivTodaySpec(day, { underlying: "NIFTY", expiry: "2026-11-03" });
    expect(spec.series[0].data).toHaveLength(2);
    expect(spec.series.find((x) => x.id === "lo").value).toBe(14.5);
    expect(ivTodaySpec([], {}).empty.title).toBe("Nothing recorded today");
  });
  it("answers the four questions from the latest reading, and nothing without one", () => {
    const pts = day.slice(0, 2);
    const m = ivTodayModel(pts, { expiry: "2026-11-03", nowMs: ist("2026-10-30T10:15:00"), hv20: 12, rank: { ivp: 85, ivr: 40, n: 252 } });
    expect(m.atmIv).toBe(14.5);
    expect(m.sinceOpen).toBeCloseTo(-0.5, 9);
    expect(m.move).toBeCloseTo(25050 * 0.145 * Math.sqrt(0.0099), 9);
    expect(m.day).toBeCloseTo(m.move / Math.sqrt(m.sessions), 9);
    expect(m.vsActual.actual).toBe(Math.round(25050 * 0.12 / Math.sqrt(252)));
    expect(m.verdict).toBe("high");
    expect(m.lastSession).toBe(false);
    expect(ivTodayModel(day, { expiry: "2026-11-03", nowMs: 0 }).gaps).toBe(1);
    expect(ivTodayModel([], { expiry: "2026-11-03", nowMs: 0 })).toBeNull();
  });
});

describe("house rules", () => {
  it("formats numbers only through format.js", () => {
    const src = readFileSync(new URL("./vol-suite-core.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/Intl\.NumberFormat|\.toLocaleString\(|toFixed\(/);
  });
});
