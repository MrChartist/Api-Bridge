import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GREEKS, acrossItems, aggressorInfo, analyticsFlowPages, compactFine, crore, cumulativeLayout, exposureItems, heatGrid, heatLevel, inr, ivRankView, moveMarkers, nseLabel, parseScoreFormula, presetToForm, screenerQuery, scoreParts, sentimentView, sortRows, tideBarsLayout, tideReady, topCellRanks, unusualQuery } from "./analyticsFlow.js";

const METHOD = { score: "score = 30*min(volOi/3,1) + 25*min(premiumInr/20000000,1) + 15*min(otmPct/5,1) + 15*min(|iv/atmIv-1|/0.5,1) + 15*min(oiChangePct/20,1); each term is clamped" };

describe("unusual activity", () => {
  it("builds and validates the query", () => {
    expect(unusualQuery({ underlyings: "nifty, banknifty", minPremium: "1000000", side: "put", sort: "premium", limit: "25" })).toEqual({ ok: true, query: "underlyings=NIFTY%2CBANKNIFTY&side=put&sort=premium&limit=25&minPremium=1000000" });
    expect(unusualQuery({ underlyings: "" }).ok).toBe(false);
    expect(unusualQuery({ underlyings: "A,B,C,D,E,F,G,H,I,J,K" }).ok).toBe(false);
    expect(unusualQuery({ underlyings: "NIFTY", minPremium: "-1" }).ok).toBe(false);
  });
  it("reads the score terms from data.method and adds them up", () => {
    expect(parseScoreFormula(METHOD.score).map((t) => [t.id, t.weight, t.divisor])).toEqual([["volOi", 30, 3], ["premiumInr", 25, 20000000], ["otmPct", 15, 5], ["ivVsAtm", 15, 0.5], ["oiChangePct", 15, 20]]);
    const parts = scoreParts({ volOi: 1.5, premiumInr: 10_000_000, otmPct: -2, ivVsAtm: 1.25, oiChangePct: null }, METHOD);
    expect(parts.map((p) => p.points)).toEqual([15, 12.5, 0, 7.5, 0]);
    expect(parts[4].shown).toBe("not available");
    expect(scoreParts({}, {}).length).toBe(5); // falls back when the method text is missing
  });
  it("labels the aggressor as a proxy", () => {
    expect(aggressorInfo({ side: "buyer-aggressive", position: 0.82 })).toMatchObject({ text: "Buy-side", sub: "proxy · 82% of spread", tone: "up" });
    expect(aggressorInfo({ side: null }).text).toBe("No quote");
  });
  it("prints rupees", () => {
    expect(inr(12_500_000)).toBe("₹1.25 Cr");
    expect(inr(null)).toBe("--");
    expect(crore(768.94)).toBe("₹768.94 Cr");
  });
});

describe("tide", () => {
  const pts = [0, 1, 2].map((i) => ({ ts: 1_793_333_400_000 + i * 300_000, callPremium: 100 * (i + 1), putPremium: 50, cumulativeNet: 50 * (i + 1) - (i === 2 ? 200 : 0) }));
  it("is not ready before the first interval", () => {
    expect(tideReady({ series: [] })).toBe(false);
    expect(tideReady({ series: pts })).toBe(true);
    expect(sentimentView({ label: "bearish", score: -0.2 })).toMatchObject({ text: "Bearish", tone: "bad", score: "-0.20" });
  });
  it("keeps bars inside the plot and calls above the zero line", () => {
    for (const width of [240, 390, 1200]) {
      const L = tideBarsLayout(pts, { width });
      for (const b of L.bars) {
        expect(b.x).toBeGreaterThanOrEqual(L.padL - 1);
        expect(b.x + b.w).toBeLessThanOrEqual(L.plotRight + 1);
        expect(b.callY + b.callH).toBeCloseTo(L.zeroY, 0);
      }
    }
    const C = cumulativeLayout(pts, { width: 390 });
    expect(C.area.endsWith("Z")).toBe(true);
    expect(C.zeroY).toBeGreaterThan(C.padT);
    expect(cumulativeLayout([], {}).line).toBe("");
  });
});

describe("exposure", () => {
  const d = { callWall: 100, putWall: 90, zeroGammaLevel: 95, strikes: [90, 95, 100].map((s, i) => ({ strike: s, netGex: (i - 1) * 5, netDelta: i, netVanna: 1, netCharm: -1 })) };
  it("marks walls and the zero-gamma strike, highest strike first", () => {
    const items = exposureItems(d, "gamma");
    expect(items.map((i) => [i.label, i.tag, i.band])).toEqual([["100", "Call wall", "wall-call"], ["95", "Zero gamma", "pain"], ["90", "Put wall", "wall-put"]]);
    expect(exposureItems(d, "delta")[0].bars[0].value).toBe(2);
    expect(Object.keys(GREEKS)).toEqual(["delta", "gamma", "vanna", "charm"]);
    expect(acrossItems({ ...d, strikes: d.strikes }).length).toBe(3);
  });
  it("prints huge rupee figures in lakh crore", () => {
    expect(compactFine(2.6e12)).toBe("2.6 L Cr");
    expect(compactFine(5e10)).toBe("5k Cr");
    expect(compactFine(0.456)).toBe("0.46");
  });
  const data = { expiries: ["a", "b"], strikes: [{ strike: 1, callOi: 5, putOi: 1, totalOi: 6, cells: [{ expiry: "a", callOi: 5, putOi: 0, totalOi: 5 }, { expiry: "b", callOi: 0, putOi: 1, totalOi: 1 }] }, { strike: 2, callOi: 2, putOi: 9, totalOi: 11, cells: [{ expiry: "a", callOi: 1, putOi: 3, totalOi: 4 }, { expiry: "b", callOi: 1, putOi: 6, totalOi: 7 }] }] };
  it("heats and ranks cells", () => {
    expect(heatLevel(0, 10)).toBe(0);
    expect(heatLevel(10, 10)).toBe(5);
    expect(heatLevel(0.1, 10)).toBe(1);
    expect([...topCellRanks(data, "total", 2)]).toEqual([["2|b", 1], ["1|a", 2]]);
    const g = heatGrid(data, "put");
    expect(g.map((r) => r.strike)).toEqual([2, 1]);
    expect(g[0].cells[1]).toMatchObject({ level: 5, rank: 1 });
  });
});

describe("screener", () => {
  it("fills the form from a preset and builds the query back", () => {
    const f = presetToForm("underlyings=NIFTY&type=put&moneyness=otm&minIv=20&minOi=5000&sort=iv&dir=desc&limit=25");
    expect(f).toMatchObject({ type: "put", minIv: "20", sort: "iv", limit: "25", maxIv: "" });
    expect(screenerQuery(f)).toEqual({ ok: true, query: "underlyings=NIFTY&type=put&moneyness=otm&sort=iv&dir=desc&limit=25&minIv=20&minOi=5000" });
    expect(screenerQuery({ minIv: "x" }).ok).toBe(false);
    expect(screenerQuery({ expiry: "11/24" }).ok).toBe(false);
    expect(screenerQuery({ underlyings: "" }).ok).toBe(false);
  });
  it("sorts in the browser with missing figures last", () => {
    const rows = [{ oi: 5 }, { oi: null }, { oi: 9 }, { oi: 1 }];
    expect(sortRows(rows, "oi", "desc").map((r) => r.oi)).toEqual([9, 5, 1, null]);
    expect(sortRows(rows, "oi", "asc").map((r) => r.oi)).toEqual([1, 5, 9, null]);
  });
});

describe("vol and NSE", () => {
  it("labels the HV20 fallback", () => {
    expect(ivRankView({ ivRank: null, ivHistoryDays: 3, ivRankFallback: { rank: 54, percentile: 59 } })).toMatchObject({ fallback: true, rank: 54, title: "HV20 rank (fallback)" });
    expect(ivRankView({ ivRank: 71, ivPercentile: 80 })).toMatchObject({ fallback: false, rank: 71, title: "IV rank" });
  });
  it("marks the expected move band", () => {
    const m = moveMarkers({ iv: { spot: 100 }, expectedMove: { lower: 95, upper: 105 } });
    expect(m.markers.map((x) => x.id)).toEqual(["lo", "spot", "hi"]);
    expect(moveMarkers({}).band).toBeNull();
  });
  it("labels NSE data and staleness", () => {
    expect(nseLabel({ source: "nse", fetchedAt: "2026-10-30T09:00:00Z", stale: true })).toMatchObject({ tone: "warn" });
    expect(nseLabel({ source: "nse", fetchedAt: "2026-10-30T09:00:00Z", stale: true }).text).toMatch(/^Source: NSE India · fetched .* IST · stale$/);
    expect(nseLabel(undefined).tone).toBe("warn");
  });
});

describe("pages and CSP", () => {
  it("adds four Analytics pages", () => {
    const pages = analyticsFlowPages(() => ({}));
    expect(pages.map((p) => p.id)).toEqual(["unusual", "tide", "exposure", "screener"]);
    expect(new Set(pages.map((p) => p.group))).toEqual(new Set(["Analytics"]));
    expect(pages.some((p) => p.tab)).toBe(false);
  });
  it("is served from the dashboard allowlist and imported once by views.js", () => {
    expect(readFileSync(new URL("../core/app.mjs", import.meta.url), "utf8")).toMatch(/"analyticsFlow\.js": "text\/javascript/);
    const views = readFileSync(new URL("./views.js", import.meta.url), "utf8");
    expect(views.match(/analyticsFlow\.js/g)).toHaveLength(1);
    expect(views.match(/analyticsFlowPages\(/g)).toHaveLength(1);
  });
  it("uses no inline styles, external hosts or locale number formatting", () => {
    const src = readFileSync(new URL("./analyticsFlow.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/setAttribute\(\s*["']style|\bstyle:|innerHTML|outerHTML|insertAdjacentHTML/);
    expect(src.match(/https?:\/\//g) ?? []).toEqual([]);
    expect(src).not.toMatch(/Intl\.NumberFormat|\.toLocaleString\(|toFixed\(/);
  });
});
