// The right rail's pure side (right-rail-core.js) and its sector list (sector-map.js), plus the wiring right-rail.js
// needs to be served and found. Node only: no DOM.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DASHBOARD_FILES } from "../core/app.mjs";
import { FNO_STOCKS, symbolMeta } from "../scanner/sectors.mjs";
import {
  CUSTOMISE,
  PANEL_W,
  RAIL_CARD,
  RAIL_DEFAULTS,
  RAIL_TOOLS,
  chainAtm,
  groupBySector,
  heatStep,
  heatmapLayout,
  mergeMovers,
  miniChainRows,
  moveTool,
  normalizeRail,
  pctMoveLevel,
  railLayout,
  railToStore,
  setToolHidden,
  squarify,
  toggleTool,
  visibleTools,
} from "./right-rail-core.js";
import { SECTORS, SECTOR_TICKERS, sectorLabel, sectorOf } from "./sector-map.js";

const read = (f) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
const IDS = RAIL_TOOLS.map((t) => t.id);

describe("rail state", () => {
  it("starts with every tool shown, nothing open, placed by width", () => {
    expect(normalizeRail(null)).toEqual({ open: null, order: IDS, hidden: [], place: "auto" });
    expect(normalizeRail("not json")).toEqual(normalizeRail({}));
    expect(normalizeRail(RAIL_DEFAULTS)).toEqual(normalizeRail({}));
  });
  it("drops unknown tools and duplicates, appends missing ones, keeps a tool's own memory", () => {
    const s = normalizeRail({ order: ["heatmap", "nope", "heatmap", "chain"], hidden: ["depth", "x"], open: "depth", place: "edge", wl: "w2" });
    expect(s.order).toEqual(["heatmap", "chain", "watchlist", "depth", "positions", "alerts"]);
    expect(s.hidden).toEqual(["depth"]);
    expect(s.open).toBe(null); // a hidden tool is never open
    expect(s.place).toBe("edge");
    expect(s.wl).toBe("w2");
    expect(normalizeRail(railToStore(s))).toEqual(s);
  });
  it("Customise can be open and always shows last", () => {
    expect(normalizeRail({ open: "customise" }).open).toBe("customise");
    const s = setToolHidden(normalizeRail({}), "positions", true);
    expect(visibleTools(s)).toEqual(["watchlist", "chain", "depth", "alerts", "heatmap", CUSTOMISE.id]);
    expect(setToolHidden(s, "customise", true)).toBe(s);
  });
  it("opens one tool at a time and closes it on a second press", () => {
    let s = normalizeRail({});
    s = toggleTool(s, "chain");
    expect(s.open).toBe("chain");
    s = toggleTool(s, "depth");
    expect(s.open).toBe("depth");
    expect(toggleTool(s, "depth").open).toBe(null);
    expect(toggleTool(s, "bogus").open).toBe(null);
    expect(toggleTool(setToolHidden(s, "chain", true), "chain").open).toBe(null);
  });
  it("moves a tool one place, and not past either end", () => {
    const s = normalizeRail({});
    expect(moveTool(s, "chain", -1).order.slice(0, 2)).toEqual(["chain", "watchlist"]);
    expect(moveTool(s, "watchlist", -1)).toBe(s);
    expect(moveTool(s, "heatmap", 1)).toBe(s);
    expect(moveTool(s, "heatmap", -1).order.slice(-2)).toEqual(["heatmap", "alerts"]);
  });
  it("hiding the open tool closes it; showing it again does not reopen it", () => {
    const s = setToolHidden(toggleTool(normalizeRail({}), "alerts"), "alerts", true);
    expect(s.open).toBe(null);
    expect(setToolHidden(s, "alerts", false)).toMatchObject({ open: null, hidden: [] });
  });
});

describe("room on screen", () => {
  const sbFull = 260 + 16; // the sidebar card and its inset
  const sbRail = 72 + 16;
  it("phones and tablets have no rail", () => {
    expect(railLayout({ width: 1023, open: true })).toEqual({ rail: "off", panel: null });
    expect(railLayout({ width: 375 })).toEqual({ rail: "off", panel: null });
  });
  it("folds to a thin edge at 1280 px, so the chain keeps its columns, and the panel floats", () => {
    expect(railLayout({ width: 1280, pageW: 1280 - sbFull })).toEqual({ rail: "edge", panel: null });
    expect(railLayout({ width: 1280, pageW: 1280 - sbRail })).toEqual({ rail: "edge", panel: null });
    expect(railLayout({ width: 1280, pageW: 1280 - sbFull, open: true })).toEqual({ rail: "edge", panel: "overlay" });
  });
  it("sits beside the page from about 1440 px and pushes the page only when both fit", () => {
    expect(railLayout({ width: 1600, pageW: 1600 - sbFull })).toEqual({ rail: "full", panel: null });
    expect(railLayout({ width: 1600, pageW: 1600 - sbFull, open: true })).toEqual({ rail: "full", panel: "overlay" });
    expect(railLayout({ width: 1600, pageW: 1600 - sbRail, open: true })).toEqual({ rail: "full", panel: "push" });
    expect(railLayout({ width: 1920, pageW: 1920 - sbFull, open: true })).toEqual({ rail: "full", panel: "push" });
    // The page beside a pushed panel keeps at least 960 px.
    const pageW = 1920 - sbFull;
    expect(pageW - (RAIL_CARD + 16) - (PANEL_W + 16)).toBeGreaterThanOrEqual(960);
  });
  it("Thin edge in Customise keeps the edge at any width", () => {
    expect(railLayout({ width: 2560, place: "edge", open: true })).toEqual({ rail: "edge", panel: "overlay" });
  });
  it("app.css draws the rail and panel from the same widths", () => {
    const css = read("app.css");
    expect(css).toContain(`--rr-card: ${RAIL_CARD}px`);
    expect(css).toContain(`--rr-panel-w: ${PANEL_W}px`);
  });
});

describe("mini option chain", () => {
  const leg = (ltp, oi) => ({ ltp, oi, symbol: "NFO:X" });
  const chain = { underlying: "NIFTY", underlyingLtp: 24_510, atmStrike: 24_500, rows: Array.from({ length: 21 }, (_, i) => ({ strike: 24_000 + i * 50, ce: leg(500 - i * 20, 1000 + i * 100), pe: i === 3 ? null : leg(20 + i * 20, 4000 - i * 100) })) };
  it("takes ATM ±5 strikes around the chain's own ATM", () => {
    const m = miniChainRows(chain, 5);
    expect(m.atm).toBe(24_500);
    expect(m.rows.map((r) => r.strike)).toEqual([24_250, 24_300, 24_350, 24_400, 24_450, 24_500, 24_550, 24_600, 24_650, 24_700, 24_750]);
    expect(m.rows.filter((r) => r.atm).map((r) => r.strike)).toEqual([24_500]);
  });
  it("marks the in-the-money side against spot and scales OI to the largest shown", () => {
    const m = miniChainRows(chain, 5);
    const r = m.rows.find((x) => x.strike === 24_450);
    expect([r.ceItm, r.peItm]).toEqual([true, false]);
    const max = Math.max(...m.rows.flatMap((x) => [x.ce?.oi ?? 0, x.pe?.oi ?? 0]));
    expect(m.rows.some((x) => x.ce?.oiShare === 1 || x.pe?.oiShare === 1)).toBe(true);
    expect(r.ce.oiShare).toBeCloseTo(r.ce.oi / max, 10);
  });
  it("finds ATM from spot when the chain names none, and keeps a missing leg null", () => {
    expect(chainAtm({ ...chain, atmStrike: null, underlyingLtp: 24_160 })).toBe(24_150);
    const m = miniChainRows({ ...chain, atmStrike: null, underlyingLtp: 24_160 }, 2);
    expect(m.rows.find((x) => x.strike === 24_150).pe).toBe(null);
    expect(miniChainRows({ rows: [] })).toEqual({ atm: null, spot: null, rows: [] });
  });
  it("clips at the chain's ends", () => {
    expect(miniChainRows({ ...chain, atmStrike: 24_000 }, 5).rows).toHaveLength(6);
  });
});

describe("% move alert level", () => {
  it("is spot moved by the percent, crossed upward for a rise and downward for a fall", () => {
    expect(pctMoveLevel(24_000, 1)).toEqual({ level: 24_240, op: "above" });
    expect(pctMoveLevel(24_000, -1.5)).toEqual({ level: 23_640, op: "below" });
    expect(pctMoveLevel("1000", "0.333")).toEqual({ level: 1003.33, op: "above" });
  });
  it("needs a spot and a move", () => {
    expect(pctMoveLevel(null, 1)).toBe(null);
    expect(pctMoveLevel(24_000, 0)).toBe(null);
    expect(pctMoveLevel(24_000, "")).toBe(null);
    expect(pctMoveLevel(24_000, -100)).toBe(null);
  });
});

describe("sector heatmap", () => {
  const items = [
    { symbol: "NSE:HDFCBANK", changePct: 1.2, turnover: 900 },
    { symbol: "NSE:ICICIBANK", changePct: -0.4, turnover: 300 },
    { symbol: "NSE:TCS", changePct: -2, turnover: 400 },
    { symbol: "NSE:INFY", changePct: null, turnover: null },
    { symbol: "NSE:NEWCO", changePct: 3, turnover: 100 },
  ];
  it("merges mover lists, each symbol once", () => {
    expect(mergeMovers([{ symbol: "A", v: 1 }], [{ symbol: "A", v: 2 }, { symbol: "B" }], null).map((x) => [x.symbol, x.v])).toEqual([
      ["A", 1],
      ["B", undefined],
    ]);
  });
  it("colours every rise green and every fall red, flat neutral, missing none", () => {
    expect([0.01, 0.99, 1, 2.49, 2.5, 9].map(heatStep)).toEqual([1, 1, 2, 2, 3, 3]);
    expect([-0.01, -1.5, -4].map(heatStep)).toEqual([-1, -2, -3]);
    expect(heatStep(0)).toBe(0);
    expect(heatStep(null)).toBe(null);
  });
  it("groups by sector, weighs by turnover, averages the change by weight", () => {
    const g = groupBySector(items);
    expect(g.map((x) => x.sector)).toEqual(["Banks", "IT", "Other"]);
    const banks = g[0];
    expect(banks.weight).toBe(1200);
    expect(banks.changePct).toBe(Math.round(((1.2 * 900 - 0.4 * 300) / 1200) * 100) / 100);
    expect([banks.up, banks.down]).toEqual([1, 1]);
    const tech = g[1];
    // INFY has no turnover: it counts as the smallest known (100), and its missing change is left out of the mean.
    expect(tech.stocks.map((s) => [s.ticker, s.weight])).toEqual([
      ["TCS", 400],
      ["INFY", 100],
    ]);
    expect(tech.changePct).toBe(-2);
    expect(g[2].stocks[0].ticker).toBe("NEWCO");
  });
  it("equal sizing gives every stock the same weight", () => {
    const g = groupBySector(items, { sizeBy: "equal" });
    expect(g.find((x) => x.sector === "Banks").weight).toBe(2);
    expect(g.flatMap((x) => x.stocks).every((s) => s.weight === 1)).toBe(true);
  });

  const area = (r) => r.w * r.h;
  const inside = (r, box) => r.x >= box.x - 1e-9 && r.y >= box.y - 1e-9 && r.x + r.w <= box.x + box.w + 1e-9 && r.y + r.h <= box.y + box.h + 1e-9;
  const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  it("squarify fills the box, areas in proportion to weight, no overlaps", () => {
    const weights = [6, 6, 4, 3, 2, 2, 1];
    const box = { x: 10, y: 20, w: 600, h: 400 };
    const rects = squarify(
      weights.map((weight, i) => ({ weight, id: i })),
      box,
    );
    expect(rects).toHaveLength(weights.length);
    const total = weights.reduce((a, b) => a + b, 0);
    for (const r of rects) {
      expect(inside(r, box)).toBe(true);
      expect(area(r)).toBeCloseTo((r.weight / total) * box.w * box.h, 6);
    }
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i], rects[j])).toBeLessThan(1e-6);
    expect(rects.reduce((s, r) => s + area(r), 0)).toBeCloseTo(box.w * box.h, 6);
    // Largest first, and the squarified layout keeps the rectangles near square (the textbook example's worst is 9/4... ).
    expect(rects[0].weight).toBe(6);
    expect(Math.max(...rects.map((r) => Math.max(r.w / r.h, r.h / r.w)))).toBeLessThan(4);
  });
  it("squarify leaves out non-positive weights and an empty box", () => {
    expect(squarify([{ weight: 0 }, { weight: -1 }, { weight: null }], { w: 100, h: 100 })).toEqual([]);
    expect(squarify([{ weight: 1 }], { w: 0, h: 100 })).toEqual([]);
    expect(squarify([{ weight: 5 }], { w: 100, h: 50 })).toEqual([{ weight: 5, x: 0, y: 0, w: 100, h: 50 }]);
  });
  it("lays sectors out as blocks with their stocks inside, under a label strip when tall enough", () => {
    const g = groupBySector(items);
    const blocks = heatmapLayout(g, { w: 320, h: 400, head: 20, gap: 4 });
    expect(blocks.map((b) => b.sector).sort()).toEqual(["Banks", "IT", "Other"]);
    for (const b of blocks) {
      for (const t of b.tiles) expect(inside(t, { x: b.x, y: b.y + (b.labelled ? 20 : 0), w: b.w, h: b.h - (b.labelled ? 20 : 0) })).toBe(true);
      expect(b.tiles).toHaveLength(g.find((x) => x.sector === b.sector).stocks.length);
    }
    expect(blocks.find((b) => b.sector === "Banks").labelled).toBe(true);
  });
});

describe("sector list", () => {
  it("is the Bridge scanner's list, ticker for ticker", () => {
    expect(SECTOR_TICKERS).toEqual([...FNO_STOCKS]);
    for (const t of FNO_STOCKS) expect(sectorOf(t), t).toBe(symbolMeta(t).sector);
  });
  it("reads exchange-prefixed symbols and says null for an unknown one", () => {
    expect(sectorOf("NSE:RELIANCE")).toBe("Energy");
    expect(sectorOf("m&m")).toBe("Auto");
    expect(sectorOf("NSE:NOPE")).toBe(null);
    expect(SECTORS).toContain("Banks");
    expect(sectorLabel("Capital")).toBe("Capital goods");
    expect(sectorLabel(null)).toBe("Other");
  });
});

describe("wiring", () => {
  it("serves the rail's files and mounts it after sign-in", () => {
    for (const f of ["right-rail.js", "right-rail-core.js", "sector-map.js"]) expect(Object.hasOwn(DASHBOARD_FILES, f), f).toBe(true);
    expect(read("app.js")).toContain('import("./right-rail.js").then((m) => m.mountRightRail())');
  });
  it("binds Shift+O only, as a capital O, outside fields and dialogs", () => {
    const src = read("right-rail.js");
    expect(src).toMatch(/e\.key !== "O" \|\| !e\.shiftKey \|\| e\.ctrlKey \|\| e\.metaKey \|\| e\.altKey/);
    expect(src).toMatch(/typing\(e\.target\)/);
    // No desk page binds a capital O (their own letters are lower case; O was free).
    for (const f of ["desk.js", "oi.js", "positions.js", "strategy.js", "vol.js", "arbitrage.js", "screener.js"]) expect(read(f), f).not.toMatch(/k(ey)? === "O"/);
  });
  it("reads only while a panel is open and the tab is in view", () => {
    const src = read("right-rail.js");
    expect(src).toContain('if (document.visibilityState === "visible")');
    expect(src).not.toMatch(/setInterval\(/);
  });
});
