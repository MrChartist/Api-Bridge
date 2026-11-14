import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDensity, parseSidebar, resolveDensity, resolveSidebar, toggleSidebar } from "./layout-prefs.js";

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

describe("app.css: the space and density tokens", () => {
  const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");
  const firstRoot = css.slice(css.indexOf(":root {"), css.indexOf("color-scheme: light;"));
  it("declares the shell and density tokens in the first :root", () => {
    for (const t of ["--sidebar-w", "--rail-w", "--sb-w", "--page-gutter", "--th-py", "--td-py", "--cell-px", "--list-row-h"]) expect(firstRoot, t).toContain(`${t}:`);
    expect(firstRoot).toMatch(/--content-max: 1360px;/);
  });
  it("tightens them for compact and draws the rail from --rail-w", () => {
    const compact = css.slice(css.indexOf(':root[data-density="compact"] {'));
    expect(compact).toMatch(/--td-py: 7px/);
    expect(css).toMatch(/:root\[data-sb="rail"\] \{ --sb-w: var\(--rail-w\); \}/);
  });
  it("keeps the sidebar flush: no offset, no radius, one separator hairline", () => {
    const at = css.indexOf("\n.sidebar {");
    const rule = css.slice(at, css.indexOf("}", at));
    expect(rule).toMatch(/top: 0; left: 0; bottom: 0;/);
    expect(rule).not.toMatch(/border-radius/);
    expect(rule).toMatch(/inset calc\(-1 \* var\(--hl\)\) 0 0 var\(--separator\)/);
  });
  it("closes every block it opens (a merge that drops a brace swallows every rule after it)", () => {
    for (const f of ["./app.css", "./palette.css"]) {
      const text = readFileSync(new URL(f, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      let depth = 0;
      for (const ch of text) {
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
        expect(depth, f).toBeGreaterThanOrEqual(0);
      }
      expect(depth, f).toBe(0);
    }
  });
  it("uses the cell tokens in the generic table rules", () => {
    expect(css).toMatch(/td \{ padding: var\(--td-py\) var\(--cell-px\);/);
  });
});
