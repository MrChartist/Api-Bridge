/** Option chain settings (desk.js): saved shapes migrate, presets are recognised, the strikes window migrates. */
import { describe, expect, it } from "vitest";

// views.js imports desk.js (the router): load it first so the circular import settles as in the browser.
await import("./views.js");
const { CHAIN_COLUMNS, CHAIN_PRESETS, COL_MIN, PHONE_MIN, chainConfig, coarseMin, dropOrder, fitColumns, presetOf, strikesPref } = await import("./desk.js");

describe("chain settings", () => {
  it("fills defaults for an empty or broken save", () => {
    for (const saved of [undefined, null, "x", {}]) {
      const c = chainConfig(saved);
      expect(c.cols).toEqual(CHAIN_PRESETS.oi);
      expect(c.side).toBe("both");
      expect(c.phoneSide).toBe("ce");
      expect(c.preset).toBe("oi");
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

  it("migrates the strikes window: ±8 and ±12 become ±10", () => {
    expect(strikesPref("8")).toBe("10");
    expect(strikesPref("12")).toBe("10");
    expect(strikesPref("20")).toBe("20");
    expect(strikesPref("all")).toBe("all");
    expect(strikesPref(undefined)).toBe("10");
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
    const all = fitColumns({ side: CHAIN_PRESETS.oi, quotes: true, sides: 2, avail: 1120, order: dropOrder("oi", CHAIN_PRESETS.oi) });
    expect(all.hidden).toEqual([]);
    expect(all.width).toBeLessThanOrEqual(1120);
    // A touch tablet (no bid / ask, ~788 px): OI | OI chg | IV | LTP a side.
    const tab = fitColumns({ side: CHAIN_PRESETS.oi, quotes: false, sides: 2, avail: 788, widths: coarseMin(), order: dropOrder("oi", CHAIN_PRESETS.oi), cap: 5 });
    expect(tab.side).toEqual(["ltp", "iv", "chg", "oi"]);
    expect(tab.width).toBeLessThanOrEqual(788);
    // Seller at desktop width: θ/lot first, then OI.
    const sel = fitColumns({ side: CHAIN_PRESETS.seller, quotes: true, sides: 2, avail: 1120, order: dropOrder("seller", CHAIN_PRESETS.seller) });
    expect(sel.hidden[0]).toBe("thetaLot");
    expect(sel.width).toBeLessThanOrEqual(1120);
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
});
