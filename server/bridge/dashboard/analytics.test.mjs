// The host of PR 17's analytics pages in this shell (analytics.js): the pure parts and the wiring to the menu.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MASONRY_ROW, VIEWS, lastSpan, masonrySpan, shortDay } from "./analytics.js";
import { skewSeries } from "./analyticsViews.js";
import { cumulativeFlows, flowRowH } from "./analyticsMore.js";
import { LEGACY, PAGES, resolveRoute } from "./views.js";

describe("analytics host", () => {
  it("lets the last panel take what is left of its row", () => {
    expect(lastSpan(1, 2)).toBe(2);
    expect(lastSpan(2, 2)).toBe(1);
    expect(lastSpan(3, 2)).toBe(2);
    expect(lastSpan(4, 3)).toBe(3);
    expect(lastSpan(5, 3)).toBe(2);
    expect(lastSpan(3, 1)).toBe(1);
    expect(lastSpan(0, 3)).toBe(1);
  });

  it("draws the call IV on top of the put IV, dashed with hollow markers, so equal IVs stay visible", () => {
    const [under, over] = skewSeries([{ strike: 100, ceIv: 20, peIv: 20 }]);
    expect([under.id, over.id]).toEqual(["pe", "ce"]);
    expect(under.dash).toBeUndefined();
    expect(over).toMatchObject({ dash: expect.any(String), hollow: true });
  });

  it("gives each panel as many masonry rows as its height needs, gap included", () => {
    expect(MASONRY_ROW).toBe(4);
    expect(masonrySpan(0, 12)).toBe(1);
    expect(masonrySpan(4, 0)).toBe(1);
    expect(masonrySpan(100, 12)).toBe(7); // 7 rows of 4 px and 6 gaps of 12 px = 100 px
    expect(masonrySpan(101, 12)).toBe(8);
  });

  it("FII and DII: the cumulative series run oldest first; bar rows use the room the window has", () => {
    const days = [{ date: "2026-10-30", fii: { net: 100 }, dii: { net: -40 } }, { date: "2026-10-29", fii: { net: -30 }, dii: { net: 10 } }];
    const [fii, dii] = cumulativeFlows(days);
    expect(fii.points.map((p) => p.y)).toEqual([-30, 70]);
    expect(dii.points.map((p) => p.y)).toEqual([10, -30]);
    expect(flowRowH(10, 300)).toBe(30);
    expect(flowRowH(60, 300)).toBe(26);
    expect(flowRowH(2, 900)).toBe(46);
  });

  it("names a day the way the desk does", () => {
    expect(shortDay("2026-11-03")).toBe("3 Nov");
    expect(shortDay("")).toBe("–");
  });

  it("every view is one tab of one page, and PR 17's page id opens it", () => {
    const tabs = PAGES.flatMap((p) => (p.tabs ?? []).map((t) => ({ page: p.id, ...t })));
    for (const view of Object.keys(VIEWS)) {
      expect(tabs.filter((t) => t.page === view).length, view).toBe(1);
      // PR 17's page id opens the tab: through LEGACY, or because it is the page's own id (Futures).
      expect(resolveRoute(`#/${view}`).view, view).toBe(view);
      expect(Boolean(LEGACY[view]) || PAGES.some((p) => p.id === view), view).toBe(true);
    }
  });

  it("the Analytics menu stays short: tabbed pages, not one item per view", () => {
    const an = PAGES.filter((p) => p.group === "Analytics");
    expect(an.map((p) => p.id)).toEqual(["exposure", "flow", "futures", "lab"]);
    for (const p of an) expect(p.tabs.length).toBeGreaterThan(1);
  });

  it("hosts PR 17's pages without inline styles, external hosts or locale number formatting", () => {
    const src = readFileSync(new URL("./analytics.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/setAttribute\(\s*["']style|\bstyle:|innerHTML|outerHTML|insertAdjacentHTML/);
    expect(src.match(/https?:\/\//g) ?? []).toEqual([]);
    expect(src).not.toMatch(/Intl\.NumberFormat|\.toLocaleString\(|toFixed\(/);
  });
});
