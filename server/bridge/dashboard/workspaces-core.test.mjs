import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DASHBOARD_FILES } from "../core/app.mjs";
import { scanJs } from "./copyRules.mjs";
import {
  INTERVALS,
  SCALPER_CYCLE,
  WATCH_DEFAULT,
  WATCH_DEMO_DEFAULT,
  WORKSPACES,
  applyTick,
  atmOf,
  chainStrikes,
  changeOf,
  changeText,
  cleanSymbol,
  contractLabel,
  historyPath,
  isLayoutKey,
  layoutText,
  legOf,
  nextScalperLayout,
  quoteSymbolOf,
  readWatch,
  scalperLayout,
  scalperPanes,
  setTile,
  stepStrike,
  strikeWindow,
  tileSpec,
  tradeLeg,
  watchGrid,
  workspaceForKey,
  workspaceOfRoute,
  workspaceShortcuts,
} from "./workspaces-core.js";

const key = (code, mods = {}) => ({ code, key: "!", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, repeat: false, ...mods });

describe("the six workspaces", () => {
  it("are keyed Shift+1 to Shift+6 in the terminal's order", () => {
    expect(WORKSPACES.map((w) => [w.key, w.id])).toEqual([[1, "scalper"], [2, "trader"], [3, "stocks"], [4, "seller"], [5, "watch"], [6, "switcher"]]);
    expect(WORKSPACES.filter((w) => w.route?.startsWith("workspaces/")).map((w) => w.id)).toEqual(["scalper", "trader", "watch"]);
    expect(WORKSPACES.find((w) => w.id === "seller").route).toBe("strategy");
    expect(WORKSPACES.find((w) => w.id === "stocks").route).toBe("screeners/depth");
    expect(WORKSPACES.find((w) => w.id === "switcher").action).toBe("switcher");
  });

  it("reads Shift plus a digit by the physical key, and nothing with another modifier", () => {
    expect(workspaceForKey(key("Digit1"))?.id).toBe("scalper");
    expect(workspaceForKey(key("Digit5"))?.id).toBe("watch");
    expect(workspaceForKey(key("Digit6"))?.id).toBe("switcher");
    expect(workspaceForKey(key("Digit7"))).toBeNull();
    expect(workspaceForKey(key("Digit1", { shiftKey: false }))).toBeNull();
    expect(workspaceForKey(key("Digit1", { ctrlKey: true }))).toBeNull();
    expect(workspaceForKey(key("Digit1", { altKey: true }))).toBeNull();
    expect(workspaceForKey(key("Digit1", { metaKey: true }))).toBeNull();
    expect(workspaceForKey(key("Digit1", { repeat: true }))).toBeNull();
    expect(workspaceForKey(key("Numpad1"))).toBeNull();
    expect(workspaceForKey(null)).toBeNull();
  });

  it("knows which workspace a route shows", () => {
    expect(workspaceOfRoute("workspaces", "trader")?.id).toBe("trader");
    expect(workspaceOfRoute("strategy")?.id).toBe("seller");
    expect(workspaceOfRoute("screeners", "depth")?.id).toBe("stocks");
    expect(workspaceOfRoute("screeners", "options")).toBeNull();
    expect(workspaceOfRoute("home")).toBeNull();
  });

  it("lists its keys for the shortcut sheet", () => {
    const rows = workspaceShortcuts();
    expect(rows[0].keys).toEqual(["Shift", "1…6"]);
    expect(rows[1].keys).toEqual(["Ctrl", "Alt", "L"]);
  });
});

describe("Scalper layouts", () => {
  it("cleans a saved layout", () => {
    expect(scalperLayout(null)).toEqual({ view: "all", arrange: "row" });
    expect(scalperLayout({ view: "put", arrange: "stack" })).toEqual({ view: "put", arrange: "stack" });
    expect(scalperLayout({ view: "<b>", arrange: 3 })).toEqual({ view: "all", arrange: "row" });
  });
  it("shows the panes a view names", () => {
    expect(scalperPanes({ view: "all" })).toEqual(["index", "call", "put"]);
    expect(scalperPanes({ view: "call" })).toEqual(["call"]);
  });
  it("walks the five layouts with Ctrl+Alt+L and comes back round", () => {
    let l = { view: "all", arrange: "row" };
    const seen = [];
    for (let i = 0; i < SCALPER_CYCLE.length; i++) {
      l = nextScalperLayout(l);
      seen.push(`${l.view}/${l.arrange}`);
    }
    expect(seen).toEqual(["all/stack", "index/row", "call/row", "put/row", "all/row"]);
    // A single chart kept stacked from an earlier pick still moves on.
    expect(nextScalperLayout({ view: "index", arrange: "stack" })).toEqual({ view: "call", arrange: "row" });
  });
  it("reads Ctrl+Alt+L only", () => {
    expect(isLayoutKey({ ctrlKey: true, altKey: true, code: "KeyL", key: "l" })).toBe(true);
    expect(isLayoutKey({ ctrlKey: true, altKey: true, shiftKey: true, code: "KeyL", key: "L" })).toBe(false);
    expect(isLayoutKey({ ctrlKey: true, code: "KeyL", key: "l" })).toBe(false);
    expect(isLayoutKey({ altKey: true, code: "KeyL", key: "l" })).toBe(false);
  });
  it("says a layout in words", () => {
    expect(layoutText({ view: "all", arrange: "stack" })).toBe("Index, call and put, stacked");
    expect(layoutText({ view: "put" })).toBe("Put only");
  });
});

const chain = {
  underlyingLtp: 24974.1,
  atmStrike: 24950,
  rows: [
    { strike: 25000, ce: { symbol: "NFO:N-25000-CE", ltp: 185 }, pe: { symbol: "NFO:N-25000-PE", ltp: 198 } },
    { strike: 24900, ce: { symbol: "NFO:N-24900-CE", ltp: 242 }, pe: null },
    { strike: 24950, ce: { symbol: "NFO:N-24950-CE", ltp: 212 }, pe: { symbol: "NFO:N-24950-PE", ltp: 174 } },
  ],
};

describe("symbols and strikes", () => {
  it("cleans tile symbols and names their quote", () => {
    expect(cleanSymbol(" nse:reliance ")).toBe("RELIANCE");
    expect(cleanSymbol("M&M")).toBe("M&M");
    expect(cleanSymbol("<script>")).toBeNull();
    expect(cleanSymbol("")).toBeNull();
    expect(quoteSymbolOf("SENSEX")).toBe("BSE:SENSEX");
    expect(quoteSymbolOf("NIFTY")).toBe("NSE:NIFTY");
    expect(quoteSymbolOf("INFY")).toBe("NSE:INFY");
  });
  it("finds the strikes, the ATM and a window around it", () => {
    expect(chainStrikes(chain)).toEqual([24900, 24950, 25000]);
    expect(atmOf(chain)).toBe(24950);
    expect(atmOf({ ...chain, atmStrike: null, underlyingLtp: 24990 })).toBe(25000);
    expect(atmOf({ rows: [] })).toBeNull();
    const ks = [100, 200, 300, 400, 500, 600, 700];
    expect(strikeWindow(ks, 400, 2)).toEqual([200, 300, 400, 500, 600]);
    expect(strikeWindow(ks, 100, 2)).toEqual([100, 200, 300]);
    expect(strikeWindow(ks, 420, 1)).toEqual([300, 400, 500]);
    expect(strikeWindow([], 400)).toEqual([]);
  });
  it("steps a strike within the list", () => {
    const ks = [100, 200, 300];
    expect(stepStrike(ks, 200, 1)).toBe(300);
    expect(stepStrike(ks, 300, 1)).toBe(300);
    expect(stepStrike(ks, 100, -1)).toBe(100);
    expect(stepStrike(ks, 150, 1)).toBe(150);
  });
  it("finds a leg and names a contract", () => {
    expect(legOf(chain, 24950, "PE").symbol).toBe("NFO:N-24950-PE");
    expect(legOf(chain, 24900, "PE")).toBeNull();
    expect(legOf(chain, 1, "CE")).toBeNull();
    expect(contractLabel(24950, "CE")).toBe("24950 CE");
    expect(contractLabel(null, "PE")).toBe("– PE");
  });
});

describe("price and change", () => {
  it("takes the quote's own change, else works it out from the close", () => {
    expect(changeOf({ ltp: 110, change: 10, changePct: 10 })).toEqual({ ltp: 110, chg: 10, pct: 10, dir: "up" });
    const c = changeOf({ ltp: 90, close: 100 });
    expect([c.chg, c.pct, c.dir]).toEqual([-10, -10, "down"]);
    expect(changeOf({ ltp: 100, close: 100 }).dir).toBe("");
    expect(changeOf(null)).toEqual({ ltp: null, chg: null, pct: null, dir: "" });
  });
  it("writes the change with a true minus and a dash for what is missing", () => {
    const t = changeText({ ltp: 90, close: 100 });
    expect(t.price).toBe("90.00");
    expect(t.change).toBe("−10.00 (−10.00%)");
    expect(t.dir).toBe("down");
    expect(changeText({}).price).toBe("–");
    expect(changeText({}).change).toBe("–");
  });
});

describe("tiles", () => {
  it("reads history at an interval", () => {
    expect(historyPath("NSE:NIFTY", "1m")).toBe("/v1/history?symbol=NSE%3ANIFTY&interval=1m&countback=375");
    expect(historyPath("NSE:NIFTY", "nope")).toContain("interval=5m");
    expect(INTERVALS.map((i) => i.id)).toEqual(["1m", "3m", "5m", "15m", "30m", "60m", "1d"]);
  });
  it("draws candles, or says plainly that there are none", () => {
    const answer = { data: { candles: [{ time: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 }, { time: 40, open: 1, high: 1, low: 1, close: 1, volume: 0 }] } };
    const s = tileSpec({ name: "NIFTY", answer, interval: "1m" });
    expect(s.label).toBe("NIFTY: 1-minute candles");
    expect(s.series[0].data.map((c) => c.t)).toEqual([40_000, 100_000]);
    expect(s.series[0].volume).toBe(false);
    expect(tileSpec({ name: "X", answer: { data: { candles: [] } }, interval: "1d" }).empty.title).toBe("No candles for X yet");
  });
  it("moves the last candle with a live price and opens the next bar after its interval", () => {
    const bars = [{ t: 0, open: 10, high: 12, low: 9, close: 11, volume: 5 }];
    const a = applyTick(bars, 13, 30_000, 60_000);
    expect(a[0]).toEqual({ t: 0, open: 10, high: 13, low: 9, close: 13, volume: 5 });
    expect(bars[0].close).toBe(11); // untouched
    const b = applyTick(bars, 8, 150_000, 60_000);
    expect(b).toHaveLength(2);
    expect(b[1]).toEqual({ t: 120_000, open: 8, high: 8, low: 8, close: 8, volume: 0 });
    expect(applyTick(bars, null, 30_000, 60_000)).toBe(bars);
    expect(applyTick(bars, 11, 30_000, 60_000)).toBe(bars);
    expect(applyTick(bars, 11, -5, 60_000)).toBe(bars);
    expect(applyTick(bars, 20, 90_000_000, 86_400_000)).toBe(bars);
    expect(applyTick([], 1, 0, 60_000)).toEqual([]);
  });
});

describe("Market Watch", () => {
  it("reads saved tiles strictly and keeps the default for anything bad", () => {
    expect(readWatch(null)).toEqual({ count: 6, tiles: WATCH_DEFAULT.tiles.map((t) => ({ ...t })) });
    expect(readWatch("{not json")).toEqual(readWatch(null));
    const r = readWatch(JSON.stringify({ count: 4, tiles: [{ symbol: "nse:tcs", interval: "1m" }, { symbol: "<x>", interval: "1m" }, { symbol: "INFY", interval: "2h" }] }));
    expect(r.count).toBe(4);
    expect(r.tiles[0]).toEqual({ symbol: "TCS", interval: "1m" });
    expect(r.tiles[1]).toEqual(WATCH_DEFAULT.tiles[1]);
    expect(r.tiles[2]).toEqual({ symbol: "INFY", interval: WATCH_DEFAULT.tiles[2].interval });
    expect(r.tiles).toHaveLength(6);
    expect(readWatch(JSON.stringify({ count: 5 })).count).toBe(6);
    expect(readWatch(null, WATCH_DEMO_DEFAULT).tiles[0].symbol).toBe("NIFTY");
  });
  it("changes one tile in place", () => {
    const s = readWatch(null);
    const t = setTile(s, 2, { symbol: "tcs" });
    expect(t.tiles[2]).toEqual({ symbol: "TCS", interval: s.tiles[2].interval });
    expect(t.tiles[1]).toBe(s.tiles[1]);
    expect(setTile(s, 0, { interval: "1d" }).tiles[0].interval).toBe("1d");
    expect(setTile(s, 0, { symbol: "??", interval: "7m" }).tiles[0]).toEqual(s.tiles[0]);
    expect(setTile(s, 9, { symbol: "TCS" })).toBe(s);
  });
  it("lays out 1, 2, 4 or 6 tiles", () => {
    expect(watchGrid(1)).toEqual({ cols: 1, rows: 1 });
    expect(watchGrid(4)).toEqual({ cols: 2, rows: 2 });
    expect(watchGrid(6)).toEqual({ cols: 3, rows: 2 });
  });
});

describe("the order ticket", () => {
  it("Buy and Sell on an option chart open that contract's ticket", () => {
    expect(tradeLeg({ underlying: "NIFTY", strike: 24950, right: "PE", side: "SELL" })).toEqual({ kind: "leg", underlying: "NIFTY", strike: 24950, right: "PE", side: "SELL", lots: 1 });
    expect(tradeLeg({ underlying: "NIFTY", strike: null, right: "CE", side: "BUY" })).toBeNull();
    expect(tradeLeg({ underlying: "NIFTY", strike: 1, right: "XX", side: "BUY" })).toBeNull();
  });
  it("on the index chart, Buy buys the ATM call and Sell buys the ATM put", () => {
    expect(tradeLeg({ underlying: "NIFTY", strike: 24950, side: "BUY", pane: "index" })).toMatchObject({ right: "CE", side: "BUY" });
    expect(tradeLeg({ underlying: "NIFTY", strike: 24950, side: "SELL", pane: "index" })).toMatchObject({ right: "PE", side: "BUY" });
  });
});

describe("house rules", () => {
  it("is pure (no DOM, fetch or clock) and served", () => {
    const src = readFileSync(new URL("./workspaces-core.js", import.meta.url), "utf8");
    const { code } = scanJs(src);
    const bare = code.replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
    expect(bare).not.toMatch(/\b(document|window|navigator|localStorage|sessionStorage|requestAnimationFrame|HTMLElement)\b/);
    expect(bare).not.toMatch(/\bfetch\s*\(|\bWebSocket\b|\bDate\.now\s*\(|\bnew Date\s*\(\s*\)|\bperformance\.now\s*\(/);
    for (const m of code.matchAll(/\bfrom\s*"([^"]+)"/g)) expect(["./chart-specs.js", "./format.js"]).toContain(m[1]);
    expect(Object.hasOwn(DASHBOARD_FILES, "workspaces-core.js")).toBe(true);
    expect(Object.hasOwn(DASHBOARD_FILES, "workspaces.js")).toBe(true);
  });
});
