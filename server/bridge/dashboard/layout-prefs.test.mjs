import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDensity, parseSidebar, resolveDensity, resolveSidebar, toggleSidebar, wideExtras, WIDE_EXTRAS } from "./layout-prefs.js";

describe("stored preferences", () => {
  it("parses the sidebar choice, anything unknown is auto", () => {
    expect(parseSidebar("rail")).toBe("rail");
    expect(parseSidebar("full")).toBe("full");
    for (const v of [null, undefined, "", "RAIL", "collapsed", "{}", 1]) expect(parseSidebar(v)).toBe("auto");
  });
  it("parses the density choice, anything unknown is auto", () => {
    expect(parseDensity("compact")).toBe("compact");
    expect(parseDensity("comfortable")).toBe("comfortable");
    for (const v of [null, undefined, "", "dense", "Compact", 0]) expect(parseDensity(v)).toBe("auto");
  });
});

describe("sidebar", () => {
  it("has no sidebar below 1024 px, whatever was chosen", () => {
    for (const p of ["auto", "rail", "full"]) {
      expect(resolveSidebar(p, 390)).toBe("none");
      expect(resolveSidebar(p, 1023)).toBe("none");
    }
    expect(resolveSidebar("full", Number.NaN)).toBe("none");
  });
  it("is the rail from 1024 to 1279 px and full from 1280 px on auto", () => {
    expect(resolveSidebar("auto", 1024)).toBe("rail");
    expect(resolveSidebar("auto", 1279)).toBe("rail");
    expect(resolveSidebar("auto", 1280)).toBe("full");
    expect(resolveSidebar(null, 2560)).toBe("full");
  });
  it("keeps an explicit choice at any desktop width", () => {
    expect(resolveSidebar("rail", 1920)).toBe("rail");
    expect(resolveSidebar("full", 1100)).toBe("full");
  });
  it("toggles to the other mode, storing auto when that is what auto would draw", () => {
    expect(toggleSidebar("full", 1920)).toBe("rail");
    expect(toggleSidebar("rail", 1920)).toBe("auto");
    expect(toggleSidebar("rail", 1100)).toBe("full");
    expect(toggleSidebar("full", 1100)).toBe("auto");
  });
});

describe("density", () => {
  it("is compact on a desktop with a fine pointer, comfortable on smaller screens", () => {
    expect(resolveDensity("auto", { fine: true, width: 1440 })).toBe("compact");
    expect(resolveDensity("auto", { fine: true, width: 820 })).toBe("comfortable");
  });
  it("is always comfortable on touch (44 px targets), even when compact was chosen", () => {
    expect(resolveDensity("compact", { fine: false, width: 1920 })).toBe("comfortable");
    expect(resolveDensity("auto", { fine: false, width: 1920 })).toBe("comfortable");
    expect(resolveDensity("compact")).toBe("comfortable");
  });
  it("keeps an explicit choice with a fine pointer", () => {
    expect(resolveDensity("comfortable", { fine: true, width: 1920 })).toBe("comfortable");
    expect(resolveDensity("compact", { fine: true, width: 900 })).toBe("compact");
  });
});

describe("wide-screen chain columns", () => {
  const widths = { delta: 60, theta: 60, vega: 60, gamma: 60, pitm: 60, default: 60 };
  it("adds nothing without room, for a custom list, or with no side shown", () => {
    expect(wideExtras({ preset: "oi", slack: 0, widths })).toEqual([]);
    expect(wideExtras({ preset: "custom", slack: 5000, widths })).toEqual([]);
    expect(wideExtras({ preset: "oi", slack: 5000, sides: 0, widths })).toEqual([]);
  });
  it("adds the preset's extras in order while they fit (both sides pay)", () => {
    // Each costs 2 × 60 × 1.12 = 134.4 px.
    expect(wideExtras({ preset: "oi", slack: 140, widths })).toEqual(["delta"]);
    expect(wideExtras({ preset: "oi", slack: 270, widths })).toEqual(["delta", "theta"]);
    expect(wideExtras({ preset: "oi", slack: 5000, widths })).toEqual(WIDE_EXTRAS.oi);
  });
  it("skips columns already shown and keeps breathing room on the used width", () => {
    expect(wideExtras({ preset: "buyer", cols: ["ltp", "iv"], slack: 5000, widths })).not.toContain("iv");
    expect(wideExtras({ preset: "oi", slack: 270, used: 2000, widths })).toEqual([]);
  });
});

describe("app.css: the space and density tokens", () => {
  const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");
  const firstRoot = css.slice(css.indexOf(":root {"), css.indexOf("color-scheme: light;"));
  it("declares the shell and density tokens in the first :root", () => {
    for (const t of ["--sidebar-w", "--rail-w", "--sb-w", "--page-gutter", "--th-py", "--td-py", "--cell-px", "--desk-top", "--chain-row", "--chain-row-1", "--list-row-h"]) expect(firstRoot, t).toContain(`${t}:`);
    expect(firstRoot).toMatch(/--content-max: none;/);
  });
  it("tightens them for compact and draws the rail from --rail-w", () => {
    const compact = css.slice(css.indexOf(':root[data-density="compact"] {'));
    expect(compact).toMatch(/--chain-row: 30px/);
    expect(compact).toMatch(/--td-py: 6px/);
    expect(css).toMatch(/:root\[data-sb="rail"\] \{ --sb-w: var\(--rail-w\); \}/);
  });
  it("keeps the sidebar flush: no offset, no radius, one separator hairline", () => {
    const at = css.indexOf("  .sidebar.glass {");
    const rule = css.slice(at, css.indexOf("}", at));
    expect(rule).toMatch(/top: 0; left: 0; bottom: 0;/);
    expect(rule).toMatch(/border-radius: 0/);
    expect(rule).toMatch(/inset calc\(-1 \* var\(--hl\)\) 0 0 var\(--mat-separator\)/);
  });
  it("uses the cell tokens in the generic table rules", () => {
    expect(css).toMatch(/td \{ padding: var\(--td-py\) var\(--cell-px\);/);
    expect(css).toMatch(/table\.chain \{ --desk-row: var\(--chain-row\);/);
  });
});
