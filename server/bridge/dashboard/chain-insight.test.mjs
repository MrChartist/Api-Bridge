// The chain's insight cards and help (chain-insight-core.js, chain-help.js): cell parsing, card placement, the fact
// rows' fallback, the card content, the cell index search and the self-check scoring. Pure: no DOM.
import { describe, expect, it } from "vitest";
import { buildupMoves, cardModel, cellRanks, factsFor, placeCard, readCell, theorPrice } from "./chain-insight-core.js";
import { CELL_INDEX, FAMILIES, QUIZ, READING_ORDER, cellHelp, quizSummary, scoreQuiz, searchCells } from "./chain-help.js";
import { checkCopy } from "./copyRules.mjs";

// views.js imports desk.js (the router): load it first so the circular import settles as in the browser.
await import("./views.js");
const { CHAIN_COLUMNS, chainConfig } = await import("./desk.js");

const leg = (o) => ({ symbol: "NFO:NIFTY-X", ltp: 64, close: 72.4, change: -8.4, bid: 63.95, ask: 64.35, oi: 9061130, oiChange: 2537990, volume: 120000, iv: 12.4, delta: 0.42, gamma: 0.0018, theta: -10.4, vega: 9.5, greeksSource: "broker", ...o });
const row = { strike: 23400, ce: leg(), pe: leg({ ltp: 110, close: 100, change: 10, bid: 109.5, ask: 110.5, oi: 4000000, oiChange: -100000, iv: 13.1, delta: -0.58, greeksSource: "computed" }) };
const x = {
  c: { rows: [{ strike: 23350, ce: leg(), pe: leg() }, row], underlyingLtp: 23346.4 },
  F: 23353.75,
  spot: 23346.4,
  years: 4 / 365,
  lot: 65,
  sm: { atmIv: 12.0, maxOi: 12000000, maxOiChange: 3000000 },
  maxVol: 240000,
  winQ: (q) => q,
  ranks: { ce: new Map([[23400, 0.73]]), pe: new Map() },
  topOi: { ce: new Map([[23400, 1]]), pe: new Map() },
  hot: new Set(),
  syn: new Map([[23400, { mid: 23360, buy: 23361, sell: 23359 }]]),
  edge: new Map(),
  ref: 23355,
  refKind: "fut",
};

describe("readCell", () => {
  it("reads the column and the part from the chain's cell classes", () => {
    expect(readCell("num c-oi s-ce")).toEqual({ key: "oi", part: "ce" });
    expect(readCell("num c-thetaLot s-pe fside")).toEqual({ key: "thetaLot", part: "pe" });
    expect(readCell("num c-syn mid-col")).toEqual({ key: "syn", part: "mid" });
    expect(readCell("strike-col")).toEqual({ key: "strike", part: "strike" });
  });
  it("ignores cells that are not chain columns", () => {
    expect(readCell("sh-ce")).toBeNull();
    expect(readCell("")).toBeNull();
    expect(readCell(undefined)).toBeNull();
    expect(readCell("num c-oi")).toBeNull();
  });
});

describe("placeCard", () => {
  const view = { w: 1200, h: 800 };
  const card = { w: 300, h: 200 };
  it("goes below the cell, left-aligned, when there is room", () => {
    expect(placeCard({ left: 100, top: 100, right: 160, bottom: 130 }, card, view)).toEqual({ left: 100, top: 136, place: "below" });
  });
  it("goes above when below is short, and right-aligns in the right half of the view", () => {
    expect(placeCard({ left: 900, top: 700, right: 960, bottom: 730 }, card, view)).toEqual({ left: 660, top: 494, place: "above" });
  });
  it("stays inside the viewport margin on every edge", () => {
    const p = placeCard({ left: 2, top: 300, right: 20, bottom: 330 }, { w: 300, h: 790 }, view);
    expect(p.left).toBe(8);
    expect(p.top).toBe(8);
    const q = placeCard({ left: 1190, top: 10, right: 1199, bottom: 30 }, card, view);
    expect(q.left).toBe(1200 - 8 - 300);
  });
  it("picks the side with more room when neither fits", () => {
    expect(placeCard({ left: 10, top: 600, right: 50, bottom: 620 }, { w: 300, h: 700 }, view).place).toBe("above");
    expect(placeCard({ left: 10, top: 100, right: 50, bottom: 120 }, { w: 300, h: 700 }, view).place).toBe("below");
  });
});

describe("factsFor (the fallback fact rows)", () => {
  it("gives label / value rows for every column the index knows", () => {
    for (const e of CELL_INDEX) {
      const side = e.key === "strike" ? null : "ce";
      const f = factsFor(e.key, side ? row.ce : null, row, side, x);
      expect(Array.isArray(f), e.key).toBe(true);
      expect(f.length, e.key).toBeGreaterThan(0);
      for (const r of f) {
        expect(typeof r.label, e.key).toBe("string");
        expect(typeof r.value, `${e.key} ${r.label}`).toBe("string");
      }
    }
  });
  it("works the OI baseline from today's OI less the change, with direction in the tone", () => {
    const f = factsFor("chg", row.pe, row, "pe", x);
    expect(f.find((r) => r.label === "At the baseline").value).toBe("41.00L");
    expect(f.find((r) => r.label === "Change").tone).toBe("down");
    expect(factsFor("oi", row.ce, row, "ce", x).find((r) => r.label === "Change").tone).toBe("up");
  });
  it("colours the bid red and the ask green", () => {
    const f = factsFor("bid", row.ce, row, "ce", x);
    expect(f.find((r) => r.label === "Bid").tone).toBe("down");
    expect(f.find((r) => r.label === "Ask").tone).toBe("up");
  });
  it("prints dashes, not zeros, for a leg with nothing to show", () => {
    const f = factsFor("ext", {}, { strike: 23400 }, "ce", { ...x, F: null });
    expect(f.find((r) => r.label === "Time value").value).toBe("–");
    expect(factsFor("no-such-column", row.ce, row, "ce", x)).toEqual([]);
  });
});

describe("cardModel", () => {
  it("titles the card with the strike, the side and the column", () => {
    expect(cardModel("bu", row.ce, row, "ce", x).title).toBe("23400 Call · Build-up");
    expect(cardModel("syn", null, row, null, x).title).toBe("23400 · Synthetic");
    expect(cardModel("strike", null, row, null, x).title).toBe("23400 strike");
  });
  it("names the build-up from the premium and OI moves, coloured by the premium", () => {
    const m = cardModel("bu", row.ce, row, "ce", x);
    expect(m.headline).toMatch(/^Short build-up\./);
    expect(m.tone).toBe("down");
    expect(m.visual.kind).toBe("buildup");
    expect(m.visual.price.from).toBeCloseTo(72.4, 6);
    expect(m.visual.oi.pct).toBeCloseTo((2537990 / (9061130 - 2537990)) * 100, 6);
    expect(m.visual.strength).toBeCloseTo(2537990 / 3000000, 6);
    expect(cardModel("bu", row.pe, row, "pe", x).headline).toMatch(/^Short covering\./);
    // A premium move inside its floor (0.5 %) names neither side (chain-metrics.js classifyBuildup).
    expect(cardModel("bu", leg({ change: 0, close: 64 }), row, "ce", x).headline).toMatch(/^Neutral/);
  });
  it("reads the build-up over the OI window when the chain has one", () => {
    const w = { ...x, windowed: true, winLabel: "1h", winQ: (q) => ({ change: q.winChange, oiChange: q.oiChange }) };
    const m = buildupMoves(leg({ winChange: 2, oiChange: 500 }), w);
    expect(m.tag).toBe("LB");
    expect(m.price.from).toBe(62);
    expect(cardModel("bu", leg({ winChange: 2, oiChange: 500 }), row, "ce", w).sub).toMatch(/^1h/);
  });
  it("says where an IV came from and how it sits against ATM and the other leg", () => {
    const m = cardModel("iv", row.ce, row, "ce", x);
    expect(m.visual).toMatchObject({ kind: "iv", source: "feed", other: "Put" });
    expect(m.visual.vsAtm).toBeCloseTo(0.4, 6);
    expect(m.visual.vsOther).toBeCloseTo(-0.7, 6);
    expect(cardModel("iv", row.pe, row, "pe", x).visual.source).toBe("solved");
    expect(cardModel("iv", leg({ iv: null }), row, "ce", x).headline).toMatch(/not zero volatility/);
  });
  it("turns Greeks into a point, a day and a vol point, per unit and per lot", () => {
    const m = cardModel("theta", row.ce, row, "ce", x);
    expect(m.visual.kind).toBe("greeks");
    expect(m.visual.focus).toBe("theta");
    expect(m.visual.rows.find((r) => r.id === "theta").lot).toBeCloseTo(-10.4 * 65, 6);
    expect(m.tone).toBe("down");
    const gm = cardModel("gamma", row.ce, row, "ce", x).visual.gamma;
    expect(gm.up).toBeCloseTo(0.438, 6);
    expect(gm.down).toBeCloseTo(0.402, 6);
    expect(cardModel("delta", leg({ delta: null, gamma: null, theta: null, vega: null }), row, "ce", x).headline).toMatch(/no Greeks/);
  });
  it("sets LTP against the model price at the leg's own IV", () => {
    const m = cardModel("ltp", row.ce, row, "ce", x);
    const th = theorPrice(x, 23400, "ce", 12.4);
    expect(m.visual).toEqual({ kind: "gap", ltp: 64, theor: th, gap: 64 - th });
    expect(m.tone).toBe("down");
    expect(theorPrice(x, 23400, "ce", null)).toBeNull();
  });
  it("draws the quote with the spread and the share of spot", () => {
    const m = cardModel("spread", row.ce, row, "ce", x);
    expect(m.visual.kind).toBe("quote");
    expect(m.visual.spread).toBeCloseTo(0.4, 6);
    expect(m.headline).toMatch(/above the bid/);
  });
  it("uses the columns' own fact rows when they are given, and a header label for an unknown column", () => {
    const facts = [{ label: "Own", value: "1" }];
    expect(cardModel("oi", row.ce, row, "ce", x, { facts }).facts).toBe(facts);
    const m = cardModel("newcol", row.ce, row, "ce", x, { label: "New col" });
    expect(m.title).toBe("23400 Call · New col");
    expect(m.facts).toEqual([]);
  });
  it("writes card copy without advice words", () => {
    const texts = [];
    for (const e of CELL_INDEX) {
      for (const [q, side] of [[row.ce, "ce"], [row.pe, "pe"], [null, null]]) {
        if ((e.key === "strike" || ["syn", "dev", "edge", "ivskew", "pcrK", "strad"].includes(e.key)) !== (side === null)) continue;
        const m = cardModel(e.key, q, row, side, x);
        texts.push(m.title, m.headline, m.sub, ...m.facts.flatMap((f) => [f.label, f.value, f.note ?? ""]));
      }
    }
    expect(checkCopy(texts.filter(Boolean), { allow: ["POP buy", "POP sell", "23400 Call · POP buy", "23400 Put · POP buy", "23400 Call · POP sell", "23400 Put · POP sell"] })).toEqual([]);
  });
});

describe("chain help", () => {
  it("explains every chain column, Strike, Bid and Ask, once each", () => {
    const keys = CELL_INDEX.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const [k] of CHAIN_COLUMNS) expect(cellHelp(k), k).not.toBeNull();
    for (const k of ["strike", "bid", "ask"]) expect(cellHelp(k), k).not.toBeNull();
    for (const e of CELL_INDEX) {
      expect(FAMILIES.some(([id]) => id === e.family), e.key).toBe(true);
      for (const f of ["shows", "how", "empty"]) expect(e[f].length, `${e.key}.${f}`).toBeGreaterThan(10);
    }
  });
  it("points the reading order at columns the index explains", () => {
    expect(READING_ORDER.map((s) => s.step)).toEqual(["Price", "Positions", "Balance", "Price of uncertainty", "Cost and distance"]);
    for (const s of READING_ORDER) for (const k of s.keys) expect(cellHelp(k), k).not.toBeNull();
  });
  it("searches labels first, then names, aliases and the text", () => {
    expect(searchCells("")).toHaveLength(CELL_INDEX.length);
    expect(searchCells("IV")[0].key).toBe("iv");
    expect(searchCells("vega")[0].key).toBe("vega");
    expect(searchCells("short covering")[0].key).toBe("bu");
    expect(searchCells("  Spread ")[0].key).toBe("spread");
    expect(searchCells("open interest").map((e) => e.key)).toContain("oi");
    expect(searchCells("zzzz")).toEqual([]);
    // Every word must match somewhere.
    expect(searchCells("theta lot")[0].key).toBe("thetaLot");
  });
  it("scores the self-check and counts only real answers", () => {
    expect(QUIZ).toHaveLength(5);
    for (const q of QUIZ) expect(q.answer).toBeLessThan(q.options.length);
    expect(scoreQuiz({})).toMatchObject({ right: 0, answered: 0, total: 5 });
    const all = Object.fromEntries(QUIZ.map((q) => [q.id, q.answer]));
    expect(scoreQuiz(all)).toMatchObject({ right: 5, answered: 5 });
    const s = scoreQuiz({ atm: 1, spread: 0, vega: 9, tv: 1.5 });
    expect(s).toMatchObject({ right: 1, answered: 2 });
    expect(s.results.find((r) => r.id === "spread")).toEqual({ id: "spread", answered: true, ok: false, answer: 1 });
    expect(quizSummary(scoreQuiz({}))).toMatch(/^5 questions/);
    expect(quizSummary(s)).toBe("1 of 2 right so far, 3 to go.");
    expect(quizSummary(scoreQuiz(all))).toBe("All 5 right.");
  });
  it("keeps the hover-card switch in the chain's settings (on by default)", () => {
    expect(chainConfig({}).insight).toBe(true);
    expect(chainConfig({ insight: false }).insight).toBe(false);
    expect(chainConfig({ insight: "no" }).insight).toBe(true);
  });
});

describe("insight on the merged chain (columns and customise rounds)", () => {
  it("skips the straddle table's cells and reads the new columns' cells", () => {
    expect(readCell("num c-sdOi mid-col")).toBeNull();
    expect(readCell("num c-sdBu mid-col")).toBeNull();
    expect(readCell("num c-bu5 s-ce")).toEqual({ key: "bu5", part: "ce" });
    expect(readCell("num c-askPctAnn s-pe")).toEqual({ key: "askPctAnn", part: "pe" });
  });
  it("gives every new column a card with fact rows", () => {
    for (const k of ["ltpChg", "prevClose", "avgPx", "high", "low", "prevVol", "volOi", "bidPx", "bidQty", "askPx", "askQty", "rho", "bu5", "bu15", "intrinsic", "bePct", "spreadAbs", "theo", "relDist", "bidPct", "askPct", "bidPctAnn", "askPctAnn"]) {
      const m = cardModel(k, row.ce, row, "ce", x);
      expect(cellHelp(k), k).not.toBeNull();
      expect(m.facts.length, k).toBeGreaterThan(0);
    }
  });
  it("reads the 5 min build-up's window state instead of a pattern when no snapshot is stored", () => {
    const m = cardModel("bu5", row.ce, row, "ce", { ...x, bu5: { state: "warming", win: "5", waitMs: 60_000 } });
    expect(m.headline).toMatch(/^Warming up/);
    expect(m.sub).toMatch(/^5 min/);
  });
});

describe("highlight ranks on the card", () => {
  const hl = { ce: { oi: new Map([[23400, 1]]), vol: new Map([[23400, 2]]), add: new Map([[23400, 1]]), cut: new Map(), bu: new Map() }, pe: { oi: new Map(), vol: new Map(), add: new Map(), cut: new Map([[23400, 3]]), bu: new Map([[23400, 1]]) } };
  const hx = { ...x, hl };
  it("each cell names its own ranks; LTP names every rank the leg holds", () => {
    expect(cellRanks("oi", row, "ce", hx).map((r) => r.text)).toEqual(["#1 open interest on the call side: the call wall", "#1 OI added on the call side"]);
    expect(cellRanks("vol", row, "ce", hx)).toEqual([{ kind: "vol", rank: 2, text: "#2 volume on the call side" }]);
    expect(cellRanks("chg", row, "pe", hx).map((r) => r.kind)).toEqual(["cut"]);
    expect(cellRanks("ltp", row, "pe", hx).map((r) => r.kind)).toEqual(["cut", "bu"]);
    expect(cellRanks("iv", row, "ce", hx)).toEqual([]);
    expect(cellRanks("oi", row, "ce", x)).toEqual([]);
    expect(cardModel("oi", row.ce, row, "ce", hx).ranks).toHaveLength(2);
  });
  it("the minute build-ups read their own window's ranks", () => {
    expect(cellRanks("bu5", row, "ce", { ...hx, bu5: { top: { ce: new Map([[23400, 2]]) } } })).toEqual([{ kind: "bu", rank: 2, text: "#2 build-up strength on the call side" }]);
  });
});
