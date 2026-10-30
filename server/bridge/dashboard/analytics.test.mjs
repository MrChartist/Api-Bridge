// The host of PR 17's analytics pages in this shell (analytics.js): the pure parts and the wiring to the menu.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VIEWS, lastSpan, shortDay, stackRow } from "./analytics.js";
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

  it("stacks a row when a short panel would leave a band of nothing beside a tall one", () => {
    expect(stackRow([900, 150])).toBe(true);
    expect(stackRow([600, 500])).toBe(false);
    expect(stackRow([900, 400])).toBe(false); // the short one is tall enough to hold its own
    expect(stackRow([500])).toBe(false);
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
