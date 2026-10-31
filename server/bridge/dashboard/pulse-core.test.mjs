import { describe, expect, it } from "vitest";
import { checkSource } from "./copyRules.mjs";
import { readFileSync } from "node:fs";
import {
  agoLabel,
  breadthParts,
  chainUnderlying,
  dayLabel,
  depthNote,
  filterHeadlines,
  filterTech,
  groupHeadlines,
  imbalanceMeter,
  istClock,
  ladderRows,
  moverRows,
  pivotLadder,
  rsiZone,
  sortTech,
  techChips,
  tickerOf,
} from "./pulse-core.js";

const NOW = Date.parse("2026-10-30T06:00:00Z"); // 11:30 IST, Fri 30 Oct

describe("movers", () => {
  it("scales bars to the largest absolute value and colours by change", () => {
    const rows = moverRows(
      [
        { symbol: "NSE:A", ltp: 110, changePct: 4, dayLow: 100, dayHigh: 120 },
        { symbol: "NSE:B", ltp: 50, changePct: -2, dayLow: 50, dayHigh: 50 },
        { symbol: "NSE:C", ltp: null, changePct: null },
      ],
      "gainers",
    );
    expect(rows.map((r) => [r.ticker, r.bar, r.tone])).toEqual([
      ["A", 1, "up"],
      ["B", 0.5, "down"],
      ["C", 0, "flat"],
    ]);
    expect(rows[0].range).toBe(0.5);
    expect(rows[1].range).toBeNull();
    expect(rows[0].metricText).toMatch(/^\+4\.00%$/);
    expect(moverRows([{ symbol: "NSE:A", volume: 2_500_000 }], "volume")[0].metricText).toBe("25.00L");
  });

  it("breadth parts add to one", () => {
    const b = breadthParts({ advances: 30, declines: 15, unchanged: 5 });
    expect(b.up + b.down + b.flat).toBeCloseTo(1);
    expect(b.text).toBe("30 up · 15 down · 5 unchanged");
    expect(breadthParts(null).text).toBe("No quotes yet");
  });
});

const T = (o) => ({ symbol: "NSE:X", trend: { above: 6, of: 6, state: "above-all" }, rsi14: 72, macd: { hist: 1.2, cross: null }, supertrend: { direction: "up" }, range52w: { complete: true, position: 0.95, fromHighPct: -1, fromLowPct: 40 }, volume: { ratio: 1 }, facts: [], price: { changePct: 1, ltp: 105 }, ...o });

describe("technicals", () => {
  it("rsiZone splits at 30 and 70", () => {
    expect([rsiZone(75), rsiZone(30), rsiZone(50), rsiZone(null)]).toEqual(["high", "low", "mid", null]);
  });

  it("chips describe and colour each readout", () => {
    const c = techChips(T());
    expect(c.map((x) => [x.id, x.tone])).toEqual([
      ["trend", "up"],
      ["rsi", "up"],
      ["macd", "up"],
      ["st", "up"],
      ["r52", "up"],
    ]);
    expect(c[0].text).toBe("Above 6 of 6 averages");
    expect(c[1].text).toBe("RSI 72, above 70");
    expect(techChips(T({ supertrend: { direction: "down" }, macd: { hist: -1 } })).find((x) => x.id === "st").tone).toBe("down");
    for (const x of c) expect(checkSource(`const s = ${JSON.stringify(x.text)};`, { allow: [] })).toEqual([]);
  });

  it("filters and sorts with missing values last", () => {
    const items = [T({ symbol: "NSE:A", rsi14: 25 }), T({ symbol: "NSE:B", rsi14: null }), T({ symbol: "NSE:C", rsi14: 80, volume: { ratio: 3 } })];
    expect(filterTech(items, "rsi-low").map((t) => t.symbol)).toEqual(["NSE:A"]);
    expect(filterTech(items, "volume").map((t) => t.symbol)).toEqual(["NSE:C"]);
    expect(filterTech(items, "near-high")).toHaveLength(3);
    expect(sortTech(items, "rsi", -1).map((t) => t.symbol)).toEqual(["NSE:C", "NSE:A", "NSE:B"]);
    expect(sortTech(items, "rsi", 1).map((t) => t.symbol)).toEqual(["NSE:A", "NSE:C", "NSE:B"]);
  });

  it("pivot ladder places the last price between levels", () => {
    const l = pivotLadder({ pivots: { r3: 130, r2: 120, r1: 110, pp: 100, s1: 90, s2: 80, s3: 70 }, price: { ltp: 105 } });
    expect(l.rows.map((r) => r.name)).toEqual(["R3", "R2", "R1", "PP", "S1", "S2", "S3"]);
    expect(l.at).toBe(3);
    expect(pivotLadder({ pivots: { r3: 130, pp: 100, s3: 70 }, price: { ltp: 60 } }).at).toBe(3);
  });
});

describe("depth", () => {
  const profile = {
    bids: [
      { price: 100, qty: 10, cum: 10, cumShare: 0.25, share: 0.5, level: 1 },
      { price: 99, qty: 30, cum: 40, cumShare: 1, share: 1, large: true, level: 2 },
    ],
    asks: [
      { price: 101, qty: 20, cum: 20, cumShare: 0.5, share: 0.66, level: 1 },
      { price: 102, qty: 20, cum: 40, cumShare: 1, share: 0.66, level: 2 },
    ],
    levels: { bids: 2, asks: 2 },
  };
  it("puts asks on top, highest first, then bids", () => {
    const rows = ladderRows(profile);
    expect(rows.map((r) => `${r.side}${r.price}`)).toEqual(["ask102", "ask101", "bid100", "bid99"]);
    expect(rows[3]).toMatchObject({ large: true, heat: 1, bar: 1 });
    expect(ladderRows(profile, { rows: 1 }).map((r) => r.price)).toEqual([101, 100]);
  });

  it("imbalance meter and the note on shallow books", () => {
    expect(imbalanceMeter(0.2)).toMatchObject({ bidShare: 0.6, text: "Bid side 60% of the book", tone: "up" });
    expect(imbalanceMeter(-0.5)).toMatchObject({ text: "Ask side 75% of the book", tone: "down" });
    expect(imbalanceMeter(null).text).toBe("No depth yet");
    expect(depthNote(profile, 20)).toMatch(/sends 2 levels/);
    expect(depthNote(profile, 2)).toBe("");
    expect(depthNote({ levels: { bids: 0, asks: 0 } }, 5)).toMatch(/No depth/);
  });
});

describe("headlines", () => {
  const items = [
    { id: "1", kind: "market", title: "a", publishedAt: "2026-10-30T05:30:00Z", symbols: ["TCS"] },
    { id: "2", kind: "filing", title: "b", publishedAt: "2026-10-30T01:00:00Z", symbols: ["INFY"] },
    { id: "3", kind: "regulator", title: "c", publishedAt: "2026-10-29T10:00:00Z", symbols: [] },
    { id: "4", kind: "market", title: "d", publishedAt: "2026-10-26T10:00:00Z", symbols: [] },
  ];
  it("labels days in IST and groups newest first", () => {
    expect(dayLabel("2026-10-30T05:30:00Z", NOW)).toBe("Today");
    expect(dayLabel("2026-10-29T10:00:00Z", NOW)).toBe("Yesterday");
    expect(dayLabel("2026-10-26T10:00:00Z", NOW)).toBe("Mon 26 Oct");
    expect(groupHeadlines(items, NOW).map((g) => [g.label, g.items.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
      ["Mon 26 Oct", 1],
    ]);
  });
  it("ago text", () => {
    expect(agoLabel("2026-10-30T05:30:00Z", NOW)).toBe("30 min ago");
    expect(agoLabel("2026-10-30T01:00:00Z", NOW)).toBe("5 h ago");
    expect(agoLabel("2026-10-26T10:00:00Z", NOW)).toBe("");
    expect(istClock("2026-10-26T10:00:00Z")).toBe("15:30");
    expect(istClock(null)).toBe("");
  });
  it("filters by kind and symbols", () => {
    expect(filterHeadlines(items, { kind: "market" }).map((i) => i.id)).toEqual(["1", "4"]);
    expect(filterHeadlines(items, { symbols: ["NSE:INFY"] }).map((i) => i.id)).toEqual(["2"]);
  });
});

describe("misc", () => {
  it("tickers and chain underlyings", () => {
    expect(tickerOf("NSE:RELIANCE")).toBe("RELIANCE");
    expect(tickerOf(" tcs ")).toBe("TCS");
    expect(chainUnderlying("NSE:NIFTY")).toBe("NIFTY");
    expect(chainUnderlying("NSE:RELIANCE")).toBeNull();
  });
  it("the pulse files use neutral copy", () => {
    for (const f of ["pulse.js", "pulse-core.js"]) expect(checkSource(readFileSync(new URL(`./${f}`, import.meta.url), "utf8"), { allow: [] }), f).toEqual([]);
  });
});
