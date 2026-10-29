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
        series: { otm: true, ce: false, pe: false, wings: false, hv: true, ba: false, oi: false },
        range: "20",
        compare: "none",
        tab: "smile",
        surf: { mode: "delta", vsAtm: false },
        cols: ["dte", "atmIv", "curve", "straddle", "move", "range", "rr25", "bf25", "fwdVol", "perDay"],
        expiries: 6,
        hedgePct: 97,
        basis: "mid",
        rate: null,
        rateV: 2,
        bidAsk: false,
      });
    }
    expect(VOL_DEFAULTS.cols).toEqual(VOL_TERM_COLUMNS.filter((c) => c.def).map((c) => c.id));
  });

  it("keeps valid values and replaces bad ones", () => {
    const ok = volConfig({ x: "delta", series: { otm: false, ce: true, pe: true, wings: true }, range: "all", compare: "monthly", tab: "term", cols: ["hedge", "dte"], expiries: 12, hedgePct: 95, basis: "ltp", rate: 7.25, bidAsk: true });
    expect(ok).toMatchObject({ x: "delta", series: { otm: false, ce: true, pe: true, wings: true }, range: "all", compare: "monthly", tab: "term", cols: ["hedge", "dte"], expiries: 12, hedgePct: 95, basis: "ltp", rate: 7.25, bidAsk: true });
    const bad = volConfig({ x: "time", series: { otm: "yes" }, range: 20, compare: "prev", tab: "x", expiries: 5, hedgePct: 90, basis: "bid", rate: 40, bidAsk: "true" });
    expect(bad).toMatchObject({ x: "strike", series: { otm: true }, range: "20", compare: "none", tab: "smile", expiries: 6, hedgePct: 97, basis: "mid", rate: null, bidAsk: false });
    expect(volConfig({ rate: -1 }).rate).toBeNull();
    // The rate follows the reference (null) unless set; old saves of the built-in 6.5 follow the reference too.
    expect(volConfig({ rate: 6.5 }).rate).toBeNull();
    expect(volConfig({ rate: 6.5, rateV: 2 }).rate).toBe(6.5);
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

// docs/design/vol.md §13: colours, persistent charts, the surface columns and the pure chart helpers.
describe("Volatility round 2 (static and pure)", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (f) => readFileSync(resolve(here, f), "utf8");
  const css = read("app.css");
  const sec = css.slice(css.indexOf("12v · VOLATILITY"), css.indexOf("12g · ARBITRAGE"));
  const { surfaceColumns } = await import("./vol.js");
  const C = await import("./vol-curves.js");

  it("§12v uses the foundation tokens and no --ios-blue", () => {
    expect(sec).not.toMatch(/--ios-blue/);
    for (const t of ["--dv-iv", "--dv-call", "--dv-put", "--dv-band", "--dv-spot", "--sel-bg", "--seq-ink-5", "--warn"]) expect(sec, t).toContain(t);
  });
  it("every §12v keyframe has a reduced-motion rule", () => {
    const names = [...sec.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    expect(sec).toMatch(/prefers-reduced-motion: reduce/);
    const reduced = sec.slice(sec.lastIndexOf("prefers-reduced-motion"));
    for (const n of names) {
      const user = sec.split("\n").find((l) => new RegExp(`animation:[^;]*\\b${n}\\b`).test(l) && !l.includes("@keyframes"));
      const cls = user?.match(/\.([\w-]+)[^.{]*\{/)?.[1];
      expect(cls && reduced.includes(cls), n).toBe(true);
    }
  });
  it("the curves are persistent charts (no SVG rebuild on refresh)", () => {
    expect(typeof C.smileChart).toBe("function");
    expect(typeof C.termChart).toBe("function");
    expect(typeof C.smileSvg).toBe("function");
    expect(read("vol.js")).not.toMatch(/replaceChildren\(smileSvg\(|replaceChildren\(\s*termSvg\(/);
    expect(read("vol.js")).not.toMatch(/["'`][^"'`\n]*\bdemo\b/i);
  });
  it("surface columns per mode and device", () => {
    expect(surfaceColumns("delta", "desktop").map((c) => c.label)).toEqual(["10ΔP", "15ΔP", "20ΔP", "25ΔP", "35ΔP", "ATM", "35ΔC", "25ΔC", "20ΔC", "15ΔC", "10ΔC"]);
    expect(surfaceColumns("delta", "tablet")).toHaveLength(9);
    expect(surfaceColumns("delta", "phone").map((c) => c.label)).toEqual(["10ΔP", "25ΔP", "ATM", "25ΔC", "10ΔC"]);
    expect(surfaceColumns("mny", "phone").map((c) => c.label)).toEqual(["−4%", "−2%", "0%", "+2%", "+4%"]);
    expect(surfaceColumns("mny", "desktop").map((c) => c.m)).toEqual([-6, -4, -2, -1, 0, 1, 2, 4, 6]);
    expect(surfaceColumns("delta").find((c) => c.id === "p25").d).toBe(-0.25);
  });
  it("lerpSeries matches points by key; new points start at their target", () => {
    const from = { otm: [{ k: 1, x: 0, y: 0 }, { k: 2, x: 10, y: 10 }] };
    const to = { otm: [{ k: 2, x: 20, y: 30 }, { k: 3, x: 40, y: 40 }] };
    const mid = C.lerpSeries(from, to, 0.5).otm;
    expect(mid).toEqual([{ k: 2, x: 15, y: 20 }, { k: 3, x: 40, y: 40 }]);
    expect(C.lerpSeries(from, to, 1)).toEqual(to);
  });
  it("end labels merge when OTM, CE and PE end together, and stay apart otherwise", () => {
    const m = C.layoutEndLabels([{ y: 50, text: "OTM", cls: "otm" }, { y: 52, text: "CE", cls: "ce" }, { y: 55, text: "PE", cls: "pe" }, { y: 90, text: "10 Nov", cls: "compare" }], { top: 0, bottom: 200 });
    expect(m.map((l) => l.text)).toEqual(["OTM · CE · PE", "10 Nov"]);
    const apart = C.layoutEndLabels([{ y: 50, text: "OTM", cls: "otm" }, { y: 54, text: "CE", cls: "ce" }, { y: 120, text: "PE", cls: "pe" }], { top: 0, bottom: 200 });
    expect(apart.map((l) => l.text)).toEqual(["OTM", "CE", "PE"]);
    expect(apart[1].ly - apart[0].ly).toBeGreaterThanOrEqual(11);
  });
});
