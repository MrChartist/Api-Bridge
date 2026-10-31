/** Option chain settings (desk.js): saved shapes migrate, presets are recognised, the strikes window migrates. */
import { describe, expect, it } from "vitest";

// views.js imports desk.js (the router): load it first so the circular import settles as in the browser.
await import("./views.js");
const { CHAIN_COLUMNS, CHAIN_PRESETS, COL_MIN, PHONE_MIN, chainConfig, coarseMin, dropOrder, fitColumns, presetOf, strikesPref } = await import("./desk.js");

describe("chain settings", () => {
  it("fills defaults for an empty or broken save", () => {
    for (const saved of [undefined, null, "x", {}]) {
      const c = chainConfig(saved);
      expect(c.cols).toEqual(CHAIN_PRESETS.core);
      expect(c.side).toBe("both");
      expect(c.phoneSide).toBe("ce");
      expect(c.preset).toBe("core");
      expect(c.mode).toBe("advanced");
      expect(c.tags).toEqual({ mp: true, walls: true, em: true, em2: false });
    }
  });

  it("migrates an older saved shape and drops unknown columns", () => {
    const old = { cols: ["ltp", "nope", "iv", "ltp"], side: "pe", quotes: false, bars: { oi: false }, tags: { mp: false } };
    const c = chainConfig(old);
    expect(c.cols).toEqual(["ltp", "iv"]);
    expect(c.side).toBe("pe");
    expect(c.phoneSide).toBe("ce");
    expect(c.quotes).toBe(false);
    expect(c.bars).toEqual({ oi: false, chg: true, vol: true });
    expect(c.tags).toEqual({ mp: false, walls: true, em: true, em2: false });
    expect(c.preset).toBe("custom");
  });

  it("knows the persona presets; Arb always shows bid and ask", () => {
    for (const p of Object.keys(CHAIN_PRESETS)) expect(presetOf(CHAIN_PRESETS[p])).toBe(p);
    const known = new Set(CHAIN_COLUMNS.map((c) => c[0]));
    for (const cols of Object.values(CHAIN_PRESETS)) for (const k of cols) expect(known.has(k), k).toBe(true);
    expect(chainConfig({ cols: CHAIN_PRESETS.arb, quotes: false }).quotes).toBe(true);
    expect(chainConfig({ cols: CHAIN_PRESETS.buyer, quotes: false }).quotes).toBe(false);
  });

  it("migrates the strikes window: ±8 and ±12 become ±10; the stepper's steps are kept", () => {
    expect(strikesPref("8")).toBe("10");
    expect(strikesPref("12")).toBe("10");
    expect(strikesPref("20")).toBe("20");
    expect(strikesPref("all")).toBe("all");
    expect(strikesPref(undefined)).toBe("10");
    for (const v of ["5", "15", "30", "40"]) expect(strikesPref(v)).toBe(v);
  });

  it("fills the Customise defaults: market line, view, display", () => {
    const c = chainConfig({});
    expect(c).toMatchObject({ straddle: false, contracts: "all", priceLine: "spot", greeks: false, pinLtp: false });
    expect(c.line).toEqual({ straddle: true, em: true, iv: false, range: false, pcr: false, mp: false, walls: false });
    expect(c.insight).toBe(true);
    expect(chainConfig({ insight: false }).insight).toBe(false);
    // Highlights: on by default, each kind its own switch; a broken save falls back per key.
    expect(c.hl).toEqual({ oi: true, vol: true, chg: true, bu: true });
    expect(chainConfig({ hl: { vol: false, bu: "x" } }).hl).toEqual({ oi: true, vol: false, chg: true, bu: true });
    expect(c.itm).toBe(false);
    expect(chainConfig({ mode: "simple" }).mode).toBe("simple");
    expect(chainConfig({ mode: "x" }).mode).toBe("advanced");
    const s = chainConfig({ straddle: true, contracts: "itm", priceLine: "fut", line: { pcr: true, em: false }, greeks: true, pinLtp: true });
    expect(s).toMatchObject({ straddle: true, contracts: "itm", priceLine: "fut", greeks: true, pinLtp: true });
    expect(s.line).toMatchObject({ straddle: true, em: false, pcr: true, range: false });
    expect(chainConfig({ contracts: "deep", priceLine: "x" })).toMatchObject({ contracts: "all", priceLine: "spot" });
  });
});

describe("Customise helpers", () => {
  it("COLUMN_GROUPS lists every chain column in exactly one group", async () => {
    const { COLUMN_GROUPS } = await import("./desk.js");
    expect(COLUMN_GROUPS.map((g) => g.id)).toEqual(["price", "depth", "greeks", "oi", "other"]);
    const listed = COLUMN_GROUPS.flatMap((g) => g.keys);
    expect(new Set(listed).size).toBe(listed.length);
    for (const [k] of CHAIN_COLUMNS) expect(listed, k).toContain(k);
  });
  it("the strikes stepper moves one step and stops at the ends", async () => {
    const { STRIKE_STEPS, stepStrikes } = await import("./desk.js");
    expect(STRIKE_STEPS).toEqual(["3", "5", "10", "15", "20", "25", "30", "40", "all"]);
    expect(stepStrikes("10", 1)).toBe("15");
    expect(stepStrikes("10", -1)).toBe("5");
    expect(stepStrikes("3", -1)).toBe("3");
    expect(stepStrikes("40", 1)).toBe("all");
    expect(stepStrikes("all", 1)).toBe("all");
    expect(stepStrikes("12", 1)).toBe("15");
  });
  it("effective columns: Show all Greeks appends the missing ones, Pin LTP puts LTP first", async () => {
    const { effectiveCols } = await import("./desk.js");
    const has = (k) => CHAIN_COLUMNS.some(([x]) => x === k);
    expect(effectiveCols({ cols: ["iv", "ltp", "delta"] }, has)).toEqual(["iv", "ltp", "delta"]);
    expect(effectiveCols({ cols: ["ltp", "delta"], greeks: true }, has)).toEqual(["ltp", "delta", "iv", "gamma", "theta", "vega", "rho"]);
    expect(effectiveCols({ cols: ["iv", "oi", "ltp"], pinLtp: true }, has)).toEqual(["ltp", "iv", "oi"]);
    // Every Greek column, Rho included.
    expect(effectiveCols({ cols: ["ltp"], greeks: true }, () => true)).toEqual(["ltp", "iv", "delta", "gamma", "theta", "vega", "rho"]);
  });
  it("the contracts filter keeps ITM or OTM per side against spot", async () => {
    const { contractShown } = await import("./desk.js");
    expect(contractShown(23000, "ce", 23050, "itm")).toBe(true);
    expect(contractShown(23000, "pe", 23050, "itm")).toBe(false);
    expect(contractShown(23100, "pe", 23050, "itm")).toBe(true);
    expect(contractShown(23100, "ce", 23050, "otm")).toBe(true);
    expect(contractShown(23000, "ce", 23050, "otm")).toBe(false);
    expect(contractShown(23000, "ce", 23050, "all")).toBe(true);
    expect(contractShown(23000, "ce", null, "itm")).toBe(true);
  });
  it("a straddle row adds the two legs; a missing leg leaves the figure empty", async () => {
    const { straddleRow } = await import("./desk.js");
    const r = straddleRow({ strike: 23000, ce: { ltp: 120, change: 10, oi: 1000, oiChange: 100, iv: 12, volume: 5 }, pe: { ltp: 80, change: -30, oi: 3000, oiChange: -50, iv: 14, volume: 7 } });
    expect(r).toMatchObject({ strike: 23000, ltp: 200, ceLtp: 120, peLtp: 80, prev: 220, change: -20, oi: 4000, oiChange: 50, volume: 12, iv: 13, be: [22800, 23200], bu: "SB" });
    expect(r.changePct).toBeCloseTo((-20 / 220) * 100, 6);
    // The legs' own previous closes win over LTP less change (the guide's worked row: 172.70 against 94.60 + 133.10).
    const g = straddleRow({ strike: 23350, ce: { ltp: 88.05, close: 94.6 }, pe: { ltp: 84.65, close: 133.1 } });
    expect(g.ltp).toBeCloseTo(172.7, 6);
    expect(g.change).toBeCloseTo(-55, 6);
    expect(g.changePct).toBeCloseTo(-24.15, 2);
    const one = straddleRow({ strike: 23000, ce: { ltp: 120, iv: 12 }, pe: null });
    expect(one).toMatchObject({ ltp: null, change: null, changePct: null, oi: null, iv: null, be: null, bu: null });
  });
  it("market line: the strip's parts around the price, switched on and with a figure; directions in their colour", async () => {
    const { lineChips } = await import("./desk.js");
    const x = { spot: 23346.4, sm: { atm: 23350, straddle: 172.7, atmIv: 8.85, pcr: 1.41, maxPain: 23000, support: { strike: 22000 }, resistance: { strike: 23500 } }, indexQuote: { low: 23289.55, high: 23386.85 } };
    const four = lineChips(x, { straddle: true, em: true, iv: true, range: true });
    expect(four.map((c) => [c[0], c[4]])).toEqual([["straddle", "pre"], ["lo", "pre"], ["hi", "post"], ["em", "post"]]);
    // The straddle carries its IV note; the expected move is 0.85 × the straddle, then strike ± straddle.
    expect(four[0][2][0]).toBe("172.70");
    expect(four[0][2][1][0]).toContain("IV 8.9%");
    expect(four.find((c) => c[0] === "em")[2]).toBe("±146.80 · 23177 – 23523");
    expect(four.find((c) => c[0] === "lo")[5]).toBeCloseTo(0.584, 3);
    expect(four.find((c) => c[0] === "lo")[2][0][1]).toBe("down");
    expect(four.find((c) => c[0] === "hi")[2][0][1]).toBe("up");
    // The IV stands alone as ATM IV with the straddle off.
    expect(lineChips(x, { iv: true }).map((c) => c[0])).toEqual(["iv"]);
    const extra = lineChips(x, { pcr: true, mp: true, walls: true });
    expect(extra.map((c) => c[0])).toEqual(["pcr", "mp", "walls"]);
    expect(extra[0][2][0][1]).toBe("up");
    expect(lineChips({ ...x, sm: { ...x.sm, pcr: 0.6 } }, { pcr: true })[0][2][0][1]).toBe("down");
    expect(lineChips({ sm: {} }, { straddle: true, em: true, iv: true, range: true })).toEqual([]);
  });
  it("days to expiry count from the data's date, never below zero, and colour as the day nears", async () => {
    const { dteOf, dteTone } = await import("./desk.js");
    expect(dteOf("2026-09-22", "2026-09-18")).toBe(4);
    expect(dteOf("2026-09-22", "2026-09-22")).toBe(0);
    expect(dteOf("2026-09-22", "2026-09-25")).toBe(0);
    expect(dteOf("x", "2026-09-22")).toBe(null);
    expect([dteTone(4), dteTone(3), dteTone(2), dteTone(1), dteTone(0)]).toEqual(["", "", "near", "near", "today"]);
  });
  it("Simple draws plain figures: no bars, no market line extras, no straddle table, no pinning", async () => {
    const { viewCfg } = await import("./desk.js");
    const a = chainConfig({ straddle: true, pinLtp: true });
    expect(viewCfg(a)).toBe(a);
    const s = viewCfg(chainConfig({ mode: "simple", straddle: true, pinLtp: true, barStyle: "fill" }));
    expect(s).toMatchObject({ straddle: false, pinLtp: false, barStyle: "bar", bars: { oi: false, chg: false, vol: false } });
    expect(Object.values(s.line).some(Boolean)).toBe(false);
  });
  it("a preset sets its columns and its display switches", async () => {
    const { presetPatch, MAIN_PRESETS, PRESET_NAMES } = await import("./desk.js");
    expect(MAIN_PRESETS.map((p) => PRESET_NAMES[p])).toEqual(["Core", "Buyer", "Seller", "Hedger", "Other"]);
    const h = presetPatch("hedger", chainConfig({ tags: { em: false } }));
    expect(h).toMatchObject({ cols: CHAIN_PRESETS.hedger, pct: false, quotes: true, tags: { mp: false, walls: false, em: false } });
    expect(chainConfig({ ...chainConfig({}), ...presetPatch("buyer") })).toMatchObject({ preset: "buyer", itm: true });
    expect(presetPatch("arb").cols).toEqual(CHAIN_PRESETS.arb);
  });
  it("the five layouts follow the guide's columns, and each drop list names only its own preset's columns", async () => {
    const { PRESET_DROP } = await import("./desk.js");
    expect(CHAIN_PRESETS.core).toEqual(["ltp", "delta", "iv", "oi", "vol", "bu"]);
    expect(CHAIN_PRESETS.buyer).toEqual(["ltp", "ltpChg", "ext", "delta", "iv", "theta", "oi", "vol", "bu", "be", "bePct"]);
    expect(CHAIN_PRESETS.seller).toEqual(["ltp", "iv", "theta", "vega", "oi", "vol", "volOi", "bu5", "bu", "be"]);
    expect(CHAIN_PRESETS.hedger).toEqual(["ltp", "spreadAbs", "dist", "relDist", "delta", "gamma", "iv", "theta", "vega", "oi"]);
    expect(CHAIN_PRESETS.other).toEqual(["ltp", "oi", "vol", "bu"]);
    expect(CHAIN_PRESETS.greeks).toContain("rho");
    for (const [p, cols] of Object.entries(CHAIN_PRESETS)) {
      const drop = PRESET_DROP[p];
      expect(drop, p).toBeTruthy();
      for (const k of drop) expect(k === "quotes" || cols.includes(k), `${p}: ${k}`).toBe(true);
      for (const k of cols) if (k !== "ltp") expect(drop, `${p}: ${k}`).toContain(k);
    }
  });
});

describe("chain round 2: presets and the fit engine", () => {
  it("the OI preset puts build-up next to OI chg; a saved round-1 OI preset migrates", () => {
    expect(CHAIN_PRESETS.oi).toEqual(["ltp", "iv", "vol", "bu", "chg", "oi"]);
    expect(chainConfig({ cols: ["ltp", "iv", "vol", "chg", "oi", "bu"] }).preset).toBe("oi");
    expect(chainConfig({}).barStyle).toBe("bar");
    expect(chainConfig({ barStyle: "fill", oiWin: "15" })).toMatchObject({ barStyle: "fill", oiWin: "15" });
    expect(chainConfig({ oiWin: "5" }).oiWin).toBe("day");
  });
  it("drop order: the preset's own, quotes before the last two, never LTP", () => {
    expect(dropOrder("oi", CHAIN_PRESETS.oi)).toEqual(["bu", "vol", "iv", "quotes", "chg", "oi"]);
    const custom = dropOrder("custom", ["ltp", "iv", "delta", "gamma"]);
    expect(custom).toEqual(["gamma", "quotes", "delta", "iv"]);
    expect(custom).not.toContain("ltp");
  });
  it("keeps everything that fits and drops in order until the minimum widths fit", () => {
    const all = fitColumns({ side: CHAIN_PRESETS.oi, quotes: true, sides: 2, avail: 1340, order: dropOrder("oi", CHAIN_PRESETS.oi) });
    expect(all.hidden).toEqual([]);
    expect(all.width).toBeLessThanOrEqual(1340);
    // A touch tablet (no bid / ask, ~788 px): OI | OI chg | IV | LTP a side.
    const tab = fitColumns({ side: CHAIN_PRESETS.oi, quotes: false, sides: 2, avail: 788, widths: coarseMin(), order: dropOrder("oi", CHAIN_PRESETS.oi), cap: 5 });
    expect(tab.side).toEqual(["ltp", "iv", "chg", "oi"]);
    expect(tab.width).toBeLessThanOrEqual(788);
    // Seller at a narrower width: Bid / Ask give way before LTP, IV and Theta.
    const sel = fitColumns({ side: CHAIN_PRESETS.seller, quotes: true, sides: 2, avail: 1000, order: dropOrder("seller", CHAIN_PRESETS.seller) });
    expect(sel.hidden).toContain("quotes");
    expect(sel.side.slice(0, 3)).toEqual(["ltp", "iv", "theta"]);
    expect(sel.width).toBeLessThanOrEqual(1000);
  });
  it("phones: one side shows LTP | OI chg | OI, Both fits in 358 px", () => {
    const one = fitColumns({ side: CHAIN_PRESETS.oi, sides: 1, avail: 358, widths: PHONE_MIN, strikeW: 68, order: dropOrder("oi", CHAIN_PRESETS.oi), cap: 3 });
    expect(one.side).toEqual(["ltp", "chg", "oi"]);
    const both = fitColumns({ side: ["ltp", "oi"], sides: 2, avail: 358, widths: PHONE_MIN, strikeW: 68, order: dropOrder("oi", CHAIN_PRESETS.oi) });
    expect(both.side).toEqual(["ltp", "oi"]);
    expect(both.width).toBeLessThanOrEqual(358);
  });
  it("extra drops one more column at a time; LTP and the strike always stay", () => {
    const f = fitColumns({ side: ["ltp", "iv"], quotes: true, sides: 2, avail: 10, order: dropOrder("custom", ["ltp", "iv"]), extra: 3 });
    expect(f.side).toEqual(["ltp"]);
    expect(f.quotes).toBe(false);
    expect(COL_MIN.ltp).toBeGreaterThan(0);
  });
  it("keeps every OI column in a 1340 px panel (the build-up card, OI and volume pairs are wider) and brings back what fits after a wider column drops", () => {
    const order = dropOrder("oi", CHAIN_PRESETS.oi);
    const wide = fitColumns({ side: CHAIN_PRESETS.oi, quotes: true, sides: 2, avail: 1340, order });
    expect(wide.side).toEqual(CHAIN_PRESETS.oi);
    expect(wide.quotes).toBe(true);
    expect(wide.side.length + 2).toBe(8);
    expect(wide.hidden).toEqual([]);
    // A 700 px panel (1024 px window): Bid / Ask go, and IV, dropped before them, comes back because it fits.
    const narrow = fitColumns({ side: CHAIN_PRESETS.oi, quotes: true, sides: 2, avail: 700, order });
    expect(narrow.quotes).toBe(false);
    expect(narrow.side).toContain("iv");
    expect(narrow.hidden).not.toContain("iv");
    expect(narrow.width).toBeLessThanOrEqual(700);
    // Measured widths replace the estimates: a much wider strike column drops Build-up first.
    const tight = fitColumns({ side: CHAIN_PRESETS.oi, quotes: true, sides: 2, avail: 1340, order, strikeW: 200 });
    expect(tight.hidden).toEqual(["bu"]);
  });
});

describe("chain, clean: defaults that fit common widths", () => {
  // The chain panel's width beside the sidebar at 1280, 1440 and 1600 px windows (measured in the demo Bridge).
  const PANEL = { 1280: 1026, 1440: 1186, 1600: 1342 };
  const fitCore = (avail, quotes) => fitColumns({ side: CHAIN_PRESETS.core, quotes, sides: 2, avail, order: dropOrder("core", CHAIN_PRESETS.core) });
  it("Core leaves Bid / Ask off by default, and picking Core turns them off; Hedger turns them on", async () => {
    const { presetPatch } = await import("./desk.js");
    expect(chainConfig({}).quotes).toBe(false);
    expect(chainConfig(undefined).quotes).toBe(false);
    expect(chainConfig({ ...chainConfig({ cols: CHAIN_PRESETS.hedger, quotes: true }), ...presetPatch("core") }).quotes).toBe(false);
    for (const p of ["core", "buyer", "seller", "other"]) expect(presetPatch(p).quotes, p).toBe(false);
    expect(presetPatch("hedger").quotes).toBe(true);
    // Still one switch away, and kept once chosen.
    expect(chainConfig({ ...chainConfig({}), quotes: true }).quotes).toBe(true);
  });
  it("a Core chain saved before revision 2 loses the Bid / Ask it had by default, once; other views keep theirs", () => {
    expect(chainConfig({ cols: CHAIN_PRESETS.core, quotes: true }).quotes).toBe(false);
    expect(chainConfig({ cols: CHAIN_PRESETS.core, quotes: true }).rev).toBe(2);
    expect(chainConfig({ cols: CHAIN_PRESETS.core, quotes: true, rev: 2 }).quotes).toBe(true);
    expect(chainConfig({ cols: CHAIN_PRESETS.buyer, quotes: true }).quotes).toBe(true);
    expect(chainConfig({ cols: CHAIN_PRESETS.arb, quotes: false }).quotes).toBe(true);
  });
  it("Core keeps every column, Build-up included, at 1280, 1440 and 1600 px", () => {
    for (const [w, avail] of Object.entries(PANEL)) {
      const f = fitCore(avail, false);
      expect(f.hidden, `${w} px`).toEqual([]);
      expect(f.side, `${w} px`).toEqual(CHAIN_PRESETS.core);
      expect(f.width).toBeLessThanOrEqual(avail);
    }
    // With Bid / Ask switched on, 1600 px still holds everything.
    expect(fitCore(PANEL[1600], true).hidden).toEqual([]);
  });
  it("the estimates are the clean cells' real widths: Build-up fits about 120 px (its full name wraps when tight), OI and volume carry no side figure", async () => {
    const { STRIKE_W } = await import("./desk.js");
    // One line, "Long unwinding" needs about 138 px; the capsule may wrap at the space, so the column needs about 120.
    expect(COL_MIN.bu).toBeGreaterThanOrEqual(116);
    expect(COL_MIN.bu).toBeLessThanOrEqual(124);
    expect(COL_MIN.oi).toBeLessThan(80);
    expect(COL_MIN.vol).toBeLessThan(80);
    expect(STRIKE_W).toBeGreaterThanOrEqual(88);
    expect(STRIKE_W).toBeLessThanOrEqual(104);
  });
  it("Other and the OI view keep Build-up at 1280 px; Hedger keeps LTP, Bid / Ask, Delta, IV and OI", () => {
    for (const p of ["other", "oi"]) {
      const f = fitColumns({ side: CHAIN_PRESETS[p], quotes: false, sides: 2, avail: PANEL[1280], order: dropOrder(p, CHAIN_PRESETS[p]) });
      expect(f.side, p).toContain("bu");
    }
    const h = fitColumns({ side: CHAIN_PRESETS.hedger, quotes: true, sides: 2, avail: PANEL[1280], order: dropOrder("hedger", CHAIN_PRESETS.hedger) });
    expect(h.quotes).toBe(true);
    for (const k of ["ltp", "delta", "iv", "oi"]) expect(h.side).toContain(k);
  });
});

describe("strike tags in a chain cell", () => {
  it("shows ATM + Max Pain + a wall in short forms, two at most, full names kept in titles", async () => {
    const { strikeTagsShown, heldTitle } = await import("./desk.js");
    const tags = [["atm", "ATM", "At the money"], ["mp", "Max Pain", "Settlement"], ["cw", "Call wall", "Most call OI"]];
    const shown = strikeTagsShown(tags, false);
    expect(shown.map((t) => t[1])).toEqual(["ATM", "MP"]);
    expect(shown[1][2]).toBe("Max Pain: Settlement");
    expect(strikeTagsShown([["mp", "Max Pain", "x"], ["cw", "Call wall", "y"]]).map((t) => t[1])).toEqual(["MP", "CW"]);
    // One tag keeps its full name on a desktop; a phone shows one, in its phone form.
    expect(strikeTagsShown([["cw", "Call wall", "y"]]).map((t) => t[1])).toEqual(["Call wall"]);
    expect(strikeTagsShown(tags.slice(1), true).map((t) => t[1])).toEqual(["MP"]);
    expect(strikeTagsShown(null)).toEqual([]);
    expect(heldTitle(-1)).toBe("Your position: short 1 lot in this contract");
    expect(heldTitle(3)).toBe("Your position: long 3 lots in this contract");
  });
});

describe("chain columns: Customise groups and the extra columns", () => {
  it("every CHAIN_COLUMNS key sits in exactly one COLUMN_GROUPS group, and every group key is a column", async () => {
    const { COLUMN_GROUPS } = await import("./desk.js");
    const keys = CHAIN_COLUMNS.map((c) => c[0]);
    const grouped = COLUMN_GROUPS.flatMap((g) => g.keys);
    expect(COLUMN_GROUPS.map((g) => g.id)).toEqual(["price", "depth", "greeks", "oi", "other"]);
    for (const k of keys) expect(grouped.filter((x) => x === k).length, k).toBe(1);
    for (const k of grouped) expect(keys.includes(k), k).toBe(true);
    // The new columns, each in its group.
    const at = (k) => COLUMN_GROUPS.find((g) => g.keys.includes(k))?.id;
    for (const k of ["ltpChg", "prevClose", "avgPx", "high", "low", "prevVol", "volOi"]) expect(at(k), k).toBe("price");
    for (const k of ["bidPx", "bidQty", "askPx", "askQty"]) expect(at(k), k).toBe("depth");
    expect(at("rho")).toBe("greeks");
    for (const k of ["bu5", "bu15", "prevOi"]) expect(at(k), k).toBe("oi");
    for (const k of ["intrinsic", "bePct", "spreadAbs", "theo", "relDist", "bidPct", "askPct", "bidPctAnn", "askPctAnn"]) expect(at(k), k).toBe("other");
  });
  it("new columns are per side (not per strike), have a width, and keep clear of the Bid and ask switch's keys", () => {
    const added = CHAIN_COLUMNS.slice(CHAIN_COLUMNS.findIndex((c) => c[0] === "ltpChg"));
    // 23 from the columns round, then Previous OI (the OI baseline as its own column).
    expect(added.length).toBe(24);
    for (const [k, , scope] of added) {
      expect(scope, k).toBeUndefined();
      expect(COL_MIN[k], k).toBeGreaterThan(0);
    }
    const keys = CHAIN_COLUMNS.map((c) => c[0]);
    expect(keys).not.toContain("bid");
    expect(keys).not.toContain("ask");
  });
});

describe("chain cell shapes: build-up meter, OI and volume bars", () => {
  it("strength meter: 10 ticks by |OI change| ÷ the largest, at least one for any change, null without data", async () => {
    const { strengthTicks } = await import("./chain-metrics.js");
    expect(strengthTicks(500, 1000)).toBe(5);
    expect(strengthTicks(-1000, 1000)).toBe(10);
    expect(strengthTicks(2000, 1000)).toBe(10);
    expect(strengthTicks(1, 1000)).toBe(1);
    expect(strengthTicks(0, 1000)).toBe(0);
    expect(strengthTicks(null, 1000)).toBeNull();
    expect(strengthTicks(500, 0)).toBeNull();
  });
  it("OI bar: solid previous OI + striped add, or solid today + striped cut ghost; one bar without a change", async () => {
    const { oiBarSplit } = await import("./chain-metrics.js");
    expect(oiBarSplit(800, 200, 1000)).toEqual({ solid: 0.6, outer: 0.8, kind: "add" });
    expect(oiBarSplit(600, -200, 1000)).toEqual({ solid: 0.6, outer: 0.8, kind: "cut" });
    expect(oiBarSplit(600, null, 1000)).toEqual({ solid: 0.6, outer: 0.6, kind: null });
    // A cut from above the chain's largest OI clamps to the track.
    expect(oiBarSplit(900, -400, 1000)).toEqual({ solid: 0.9, outer: 1, kind: "cut" });
    // OI added from nothing: no solid part.
    expect(oiBarSplit(300, 300, 1000)).toEqual({ solid: 0, outer: 0.3, kind: "add" });
    expect(oiBarSplit(null, 200, 1000)).toBeNull();
    expect(oiBarSplit(800, 200, 0)).toBeNull();
  });
  it("volume: change and the two-tone bar need the previous session's volume; nothing invented without it", async () => {
    const { volBarSplit, volumeChange } = await import("./chain-metrics.js");
    expect(volumeChange(1500, 1000)).toBe(500);
    expect(volumeChange(800, 1000)).toBe(-200);
    expect(volumeChange(800, null)).toBeNull();
    expect(volumeChange(null, 1000)).toBeNull();
    expect(volBarSplit(500, 1000, 1000)).toEqual({ today: 0.5, prev: 1 });
    expect(volBarSplit(500, undefined, 1000)).toEqual({ today: 0.5, prev: null });
    expect(volBarSplit(null, 1000, 1000)).toBeNull();
    expect(volBarSplit(500, 1000, 0)).toBeNull();
  });
});
