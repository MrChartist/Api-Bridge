/** Volatility page settings (vol.js): defaults, bad values fall back, unknown columns are dropped. */
import { describe, expect, it } from "vitest";

// views.js imports desk.js (the router), which imports vol.js: load it first so the circular import settles.
await import("./views.js");
const { VOL_DEFAULTS, VOL_TERM_COLUMNS, volConfig } = await import("./vol.js");

describe("Volatility page settings", () => {
  it("fills defaults for an empty or broken save", () => {
    for (const saved of [undefined, null, "x", [], {}]) {
      const c = volConfig(saved);
      expect(c).toEqual({
        x: "strike",
        series: { otm: true, ce: false, pe: false, wings: false },
        range: "20",
        compare: "none",
        tab: "smile",
        cols: ["dte", "atmIv", "straddle", "move", "range", "rr25", "bf25", "fwdVol", "perDay"],
        expiries: 6,
        hedgePct: 97,
        basis: "mid",
        rate: 6.5,
        bidAsk: false,
      });
    }
    expect(VOL_DEFAULTS.cols).toEqual(VOL_TERM_COLUMNS.filter((c) => c.def).map((c) => c.id));
  });

  it("keeps valid values and replaces bad ones", () => {
    const ok = volConfig({ x: "delta", series: { otm: false, ce: true, pe: true, wings: true }, range: "all", compare: "monthly", tab: "term", cols: ["hedge", "dte"], expiries: 12, hedgePct: 95, basis: "ltp", rate: 7.25, bidAsk: true });
    expect(ok).toMatchObject({ x: "delta", series: { otm: false, ce: true, pe: true, wings: true }, range: "all", compare: "monthly", tab: "term", cols: ["hedge", "dte"], expiries: 12, hedgePct: 95, basis: "ltp", rate: 7.25, bidAsk: true });
    const bad = volConfig({ x: "time", series: { otm: "yes" }, range: 20, compare: "prev", tab: "x", expiries: 5, hedgePct: 90, basis: "bid", rate: 40, bidAsk: "true" });
    expect(bad).toMatchObject({ x: "strike", series: { otm: true }, range: "20", compare: "none", tab: "smile", expiries: 6, hedgePct: 97, basis: "mid", rate: 6.5, bidAsk: false });
    expect(volConfig({ rate: -1 }).rate).toBe(6.5);
    expect(volConfig({ rate: 0 }).rate).toBe(0);
  });

  it("drops unknown and repeated columns, and an empty list falls back to the defaults", () => {
    expect(volConfig({ cols: ["dte", "nope", "dte", "be"] }).cols).toEqual(["dte", "be"]);
    expect(volConfig({ cols: ["nope"] }).cols).toEqual(VOL_DEFAULTS.cols);
  });

  it("prints every column for a row without figures as -- or n/a, never null", () => {
    const empty = { days: null, atmIv: null, straddle: null, straddlePct: null, move: null, movePct: null, lo: null, hi: null, rr25: null, bf25: null, perDay: null, atmStrike: null, ceIv: null, peIv: null, rupee: null, beLo: null, beHi: null, ratio: null, rr10: null, F: null, basis: null, carryPct: null, futGap: null, hedge: null };
    for (const col of VOL_TERM_COLUMNS) {
      const v = col.cell(empty, {});
      expect(String(v.t), col.id).toMatch(/^(--|n\/a)$/);
      expect(`${v.t}${v.s ?? ""}`).not.toMatch(/null|undefined|NaN/);
    }
  });
});
