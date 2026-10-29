/** OI Analysis settings (oi.js): bad values fall back to the defaults; unlisted extra expiries are dropped. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// views.js imports desk.js (the router), which imports oi.js: load it first so the circular import settles.
await import("./views.js");
const { OI_DEFAULTS, oiConfig } = await import("./oi.js");

describe("OI page settings", () => {
  it("fills defaults for an empty or broken save", () => {
    for (const saved of [undefined, null, "x", [], {}]) {
      const c = oiConfig(saved);
      expect(c).toEqual({ window: "prev", metric: "oi", band: "10", unit: "lots", scope: "one", chart: true, extra: {}, th: { ...OI_DEFAULTS.th } });
    }
  });

  it("keeps valid values and replaces bad ones", () => {
    const c = oiConfig({ window: "15", metric: "vol", band: "all", unit: "qty", scope: "all", th: { minLots: 25, minOiPct: 2, minPxPct: 1 } });
    expect(c).toMatchObject({ window: "15", metric: "vol", band: "all", unit: "qty", scope: "all", th: { minLots: 25, minOiPct: 2, minPxPct: 1 } });
    const bad = oiConfig({ window: "7", metric: "x", band: 15, unit: "kg", scope: "both", th: { minLots: -1, minOiPct: "a", minPxPct: 500 } });
    expect(bad).toMatchObject({ window: "prev", metric: "oi", band: "10", unit: "lots", scope: "one", th: { minLots: 10, minOiPct: 1, minPxPct: 0.5 } });
    expect(oiConfig({ band: 20, window: 60 })).toMatchObject({ band: "20", window: "60" });
    expect(oiConfig({ chart: false }).chart).toBe(false);
    expect(oiConfig({ chart: "no" }).chart).toBe(true);
  });

  it("keeps at most 3 real extra expiries and drops those no longer listed", () => {
    const saved = { extra: { NIFTY: ["2026-11-10", "2026-11-17", "bad", "2026-11-10", "2026-11-24", "2026-12-01"], BANKNIFTY: ["2026-11-24"], "bad key": ["2026-11-10"], SENSEX: "x" } };
    expect(oiConfig(saved).extra).toEqual({ NIFTY: ["2026-11-10", "2026-11-17", "2026-11-24"], BANKNIFTY: ["2026-11-24"] });
    const listed = oiConfig(saved, { underlying: "NIFTY", expiries: ["2026-11-03", "2026-11-17", "2026-12-01"] });
    expect(listed.extra).toEqual({ NIFTY: ["2026-11-17", "2026-12-01"], BANKNIFTY: ["2026-11-24"] });
    expect(oiConfig(saved, { underlying: "NIFTY", expiries: ["2026-11-03"] }).extra).toEqual({ BANKNIFTY: ["2026-11-24"] });
  });
});

// docs/design/oi.md §14: the page's colours come from the data-viz tokens, not the old blue / orange accents.
describe("OI page colours (static)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(resolve(here, "app.css"), "utf8");
  const js = readFileSync(resolve(here, "oi.js"), "utf8");
  const a = css.indexOf("12e · OI ANALYSIS");
  const oiCss = css.slice(a, css.indexOf("12f · POSITIONS", a));
  const rules = [...oiCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  const ladder = rules.filter((r) => /table\.oi-ladder/.test(r.sel));
  it("colours the ladder bars by side with --dv-call and --dv-put", () => {
    const text = ladder.map((r) => `${r.sel}{${r.body}}`).join("\n");
    expect(text).toMatch(/td\.ob\.ce\s*\{[^}]*--sc:\s*var\(--dv-call\)/);
    expect(text).toMatch(/td\.ob\.pe\s*\{[^}]*--sc:\s*var\(--dv-put\)/);
    expect(text).toMatch(/\.now\s*\{[^}]*hsl\(var\(--sc\)/);
  });
  it("uses no --ios-blue or --ios-orange in any OI rule", () => {
    const bad = rules.filter((r) => /\.oi-|oi-ladder|\.obu/.test(r.sel) && /--ios-(blue|orange)/.test(r.body)).map((r) => r.sel);
    expect(bad).toEqual([]);
  });
  it("has no window-start .mark tick and no padded spot row", () => {
    expect(oiCss).not.toMatch(/\.mark\b/);
    expect(js).not.toMatch(/class: "mark"/);
    for (const r of rules.filter((x) => /th\.k\[data-spot\]/.test(x.sel))) expect(r.body, r.sel).not.toMatch(/padding-top/);
  });
  it('never says "Demo data" (the toolbar indicator is the one demo marker)', () => {
    expect(js).not.toContain("Demo data");
  });
  it("opens the chain for either side from the detail row", () => {
    expect(js).toMatch(/onOpenChain\(k, s\.side\)/);
  });
});
