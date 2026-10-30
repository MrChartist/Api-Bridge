// The host of PR 17's analytics pages in this shell (analytics.js): the pure parts and the wiring to the menu.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MASONRY_ROW, VIEWS, lastSpan, masonrySpan, shortDay } from "./analytics.js";
import { skewSeries } from "./analyticsViews.js";
import { OPT_VIEWS, cumulativeFlows, flowRowH, legsToBasket, optimizerQuery, payoffWindow } from "./analyticsMore.js";
import { ruleText, volOiText } from "./analyticsFlow.js";
import { backtestBody, concentrationWords, equitySeries, histogramLayout, inrShort, pickAccount, weightText } from "./analyticsRisk.js";
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

  it("caps a far strike's volume against OI at >100x, and the tide's formula goes behind the panel's ?", () => {
    expect(volOiText(1469.5)).toBe(">100x");
    expect(volOiText(63.26)).toBe("63.26x");
    expect(ruleText({ rule: "score = a - b.", threshold: 0.1 })).toBe("score = a - b. Neutral inside ±0.10.");
    expect(ruleText(null)).toBe("");
  });

  it("hands strategy legs to the Strategy Builder's basket (options only, sides in capitals)", () => {
    const b = legsToBasket([{ type: "CE", side: "sell", strike: 26200, lots: 2 }, { type: "PE", side: "buy", strike: 26000 }, { type: "FUT", side: "buy" }], "2026-11-03");
    expect(b).toEqual([
      { right: "CE", strike: 26200, side: "SELL", lots: 2, expiry: "2026-11-03" },
      { right: "PE", strike: 26000, side: "BUY", lots: 1, expiry: "2026-11-03" },
    ]);
  });

  it("draws a payoff around its strikes, not across the whole curve", () => {
    const curve = Array.from({ length: 61 }, (_, i) => ({ price: 24000 + i * 100, pnl: 0 }));
    const w = payoffWindow(curve, [{ strike: 26000 }, { strike: 26400 }], 26200);
    expect(w[0].price).toBeGreaterThanOrEqual(26000 - 786);
    expect(w.at(-1).price).toBeLessThanOrEqual(26400 + 786);
    expect(payoffWindow(curve, [], 26200)).toBe(curve);
  });

  it("Risk: starts on the desk's account, else paper; says concentration in words; short rupees with a true minus", () => {
    const accs = [{ id: "demo", broker: "demo", capabilities: ["quotes"] }, { id: "zerodha", broker: "zerodha", capabilities: ["positions"] }, { id: "paper-1", broker: "paper", capabilities: ["positions"] }];
    expect(pickAccount(accs, "zerodha")).toBe("zerodha");
    expect(pickAccount(accs, "demo")).toBe("paper-1");
    expect(pickAccount([], null)).toBeNull();
    expect(concentrationWords(2, 2)).toBe("Spread evenly over 2 underlyings");
    expect(concentrationWords(1.4, 3)).toBe("Weighted like 1.4 even underlyings");
    expect(concentrationWords(1, 1)).toBe("All in one underlying");
    expect(inrShort(-4800)).toBe("\u2212₹4.8k");
    expect(weightText(0.2532)).toBe("25.3%");
  });

  it("Risk: the P&L histogram marks the days at or beyond the VaR loss as the tail, with VaR and ES lines", () => {
    const bins = [{ from: -300, to: -200, count: 2 }, { from: -200, to: -100, count: 5 }, { from: -100, to: 0, count: 40 }, { from: 0, to: 100, count: 50 }];
    const L = histogramLayout(bins, { width: 400, height: 200, varLoss: 200, esLoss: 250 });
    expect(L.bars.map((b) => b.tail)).toEqual([true, false, false, false]);
    expect(L.lines.map((l) => l.label)).toEqual(["VaR", "ES"]);
    expect(L.lines[1].x).toBeLessThan(L.lines[0].x); // the shortfall is the bigger loss, further left
    expect(histogramLayout([], {}).empty).toBe(true);
  });

  it("Backtest: the form becomes the POST body, and a bad field is named", () => {
    const ok = backtestBody({ symbol: "nse:reliance", interval: "1d", entry: "rsi(14) < 30", exit: "", side: "long", countback: "500", stopLossPct: "4", targetPct: "", maxBarsInTrade: "" });
    expect(ok.body).toEqual({ symbol: "NSE:RELIANCE", interval: "1d", entry: "rsi(14) < 30", side: "long", countback: 500, stopLossPct: 4 });
    expect(backtestBody({ symbol: "RELIANCE", entry: "", countback: "1.5" }).problems).toHaveLength(3);
    const eq = equitySeries(Array.from({ length: 1000 }, (_, i) => ({ date: `2026-01-01 09:${i}`, equity: 1000 + i })), 1000, 400);
    expect(eq[0].points.length).toBeLessThanOrEqual(401);
    expect(eq[0].points[0].y).toBe(0);
    expect(eq[0].points.at(-1).y).toBe(99.9); // 1999 on 1000 is +99.9 %
  });

  it("Finder: one finder on the optimizer; range-bound is in neutral; limits become the query", () => {
    expect(OPT_VIEWS.map(([v]) => v)).toEqual(["neutral", "bullish", "bearish", "volatile"]);
    const v = { underlying: "NIFTY", expiry: "2026-11-03" };
    const q = new URLSearchParams(optimizerQuery(v, { view: "neutral", objective: "riskReward", minPop: "55", maxLoss: "", capital: "200000" }).query);
    expect(Object.fromEntries(q)).toEqual({ underlying: "NIFTY", expiry: "2026-11-03", view: "neutral", objective: "riskReward", top: "6", capital: "200000", minPop: "55" });
    expect(optimizerQuery(v, { view: "bullish", minPop: "120", maxLoss: "0" }).problems).toHaveLength(2);
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
    expect(an.map((p) => p.id)).toEqual(["exposure", "flow", "futures", "lab", "risk"]);
    for (const p of an) expect(p.tabs.length).toBeGreaterThan(1);
  });

  it("scopes every analytics CSS rule under the page root, so a generic class (.leg-row, .kv, .chart) cannot reach another page", () => {
    const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");
    const from = css.indexOf("15 · ANALYTICS (analyticsViews.js)");
    expect(from).toBeGreaterThan(0);
    // The analytics sections run to the end of the file (15, 16, 17 and 15d).
    const text = css.slice(css.indexOf("*/", from) + 2).replace(/\/\*[\s\S]*?\*\//g, "");
    const roots = [".an-page", ".an-cap", ".an-fresh", ".an-ctx-sheet", ".an-help-text"];
    const bad = [];
    for (const [, prelude] of text.matchAll(/([^{};]+)\{/g)) {
      const p = prelude.trim();
      if (p.startsWith("@")) continue;
      let depth = 0;
      let cur = "";
      const sels = [];
      for (const ch of p) {
        if (ch === "(" || ch === "[") depth++;
        if (ch === ")" || ch === "]") depth--;
        if (ch === "," && depth === 0) (sels.push(cur), (cur = ""));
        else cur += ch;
      }
      sels.push(cur);
      // A theme or layout condition on :root may come first (":root[data-layout="desk"] .an-page …").
      for (const s of sels.map((x) => x.trim().replace(/^:root(\[[^\]]*\])*\s+/, ""))) if (!roots.some((r) => s === r || s.startsWith(r))) bad.push(s);
    }
    expect(bad).toEqual([]);
    expect(readFileSync(new URL("./analyticsViews.js", import.meta.url), "utf8")).not.toMatch(/class: "(small )?leg-(row|remove)"/);
  });

  it("hosts PR 17's pages without inline styles, external hosts or locale number formatting", () => {
    const src = readFileSync(new URL("./analytics.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/setAttribute\(\s*["']style|\bstyle:|innerHTML|outerHTML|insertAdjacentHTML/);
    expect(src.match(/https?:\/\//g) ?? []).toEqual([]);
    expect(src).not.toMatch(/Intl\.NumberFormat|\.toLocaleString\(|toFixed\(/);
  });
});
