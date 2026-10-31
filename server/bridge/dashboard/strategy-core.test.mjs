/** Strategy Builder helpers (strategy-core.js): templates and Spacing, search, Width / Wings, copy / share / paste, sizing. */
import { describe, expect, it } from "vitest";
import * as O from "./options.js";
import * as S from "./strategy-core.js";

const q = (ltp, extra = {}) => ({ symbol: "X", ltp, bid: ltp - 0.5, ask: ltp + 0.5, iv: 12, ...extra });
const STRIKES = Array.from({ length: 41 }, (_, i) => 25000 + i * 50);
const chain = {
  underlying: "NIFTY",
  expiry: "2026-11-03",
  underlyingLtp: 26010,
  atmStrike: 26000,
  lotSize: 75,
  // Convex premiums: intrinsic plus a time value that fades away from the money.
  rows: STRIKES.map((k) => ({ strike: k, ce: q(Math.max(0, 26010 - k) + 2 + 120 * Math.exp(-Math.abs(k - 26010) / 250)), pe: q(Math.max(0, k - 26010) + 2 + 120 * Math.exp(-Math.abs(k - 26010) / 250)) })),
};
const ks = () => STRIKES;
const L = (right, strike, side, lots = 1, extra = {}) => ({ kind: "OPT", right, strike, side, lots, expiry: "2026-11-03", on: true, ...extra });

describe("templates", () => {
  it("50 templates, unique ids, every group covered, extras keep the preset shape", () => {
    expect(S.TEMPLATES.length).toBe(O.PRESETS.length + S.EXTRA_PRESETS.length);
    expect(S.TEMPLATES.length).toBe(50);
    expect(new Set(S.TEMPLATES.map((p) => p.id)).size).toBe(50);
    for (const p of S.EXTRA_PRESETS) {
      expect(O.PRESET_GROUPS.some(([g]) => g === p.group)).toBe(true);
      expect(["defined", "undefined"]).toContain(p.risk);
      expect(O.PRESETS.some((x) => x.id === p.id)).toBe(false);
    }
    // grouped in PRESET_GROUPS order
    const order = S.TEMPLATES.map((p) => O.PRESET_GROUPS.findIndex(([g]) => g === p.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
  it("every extra builds listed strikes with the right sides and ratios", () => {
    const fut = { symbol: "NFO:NIFTY26NOVFUT", expiry: "2026-11-24", lotSize: 75 };
    for (const p of S.EXTRA_PRESETS) {
      const legs = S.extraLegs(p.id, chain, { unit: 1, fut, back: "2026-11-10" });
      expect(legs.length, p.id).toBeGreaterThan(0);
      for (const l of legs) if (l.kind !== "FUT") expect(STRIKES).toContain(l.strike);
    }
    const fly = S.extraLegs("bull-call-fly", chain, { unit: 1 });
    expect(fly.map((l) => [l.strike, l.side, l.lots])).toEqual([[26050, "BUY", 1], [26150, "SELL", 2], [26250, "BUY", 1]]);
    const strap = S.extraLegs("strap", chain);
    expect(strap.map((l) => [l.right, l.lots])).toEqual([["CE", 2], ["PE", 1]]);
    const diag = S.extraLegs("put-diagonal", chain, { back: "2026-11-10" });
    expect(diag.map((l) => l.expiry)).toEqual(["2026-11-03", "2026-11-10"]);
    expect(S.extraLegs("long-future", chain, { fut })[0]).toMatchObject({ kind: "FUT", side: "BUY", symbol: fut.symbol });
  });
  it("an extra is empty when a future, back expiry or strike is missing", () => {
    expect(S.extraLegs("long-future", chain)).toEqual([]);
    expect(S.extraLegs("put-diagonal", chain, { back: null })).toEqual([]);
    expect(S.extraLegs("double-plateau", chain, { unit: 5 })).toEqual([]); // ±35 strikes: beyond the 41-strike ladder
    expect(S.extraLegs("nope", chain)).toEqual([]);
  });
  it("defined-risk extras have a finite max loss; the ratio spreads are open on their sold side", () => {
    const priced = (id) => S.extraLegs(id, chain, { unit: 1 }).map((l) => ({ ...l, price: O.mid(chain.rows.find((r) => r.strike === l.strike)[l.right === "CE" ? "ce" : "pe"]), iv: 12 }));
    for (const id of ["bull-call-fly", "bull-condor", "bear-put-fly", "bear-condor", "double-plateau", "long-put-fly", "strap", "strip"]) {
      expect(O.strategyStats(priced(id), 75, { forward: 26010 }).maxLoss, id).not.toBeNull();
    }
    expect(O.strategyStats(priced("call-ratio"), 75, { forward: 26010 }).maxLoss).toBeNull();
    expect(O.strategyStats(priced("batman"), 75, { forward: 26010 }).maxLoss).toBeNull();
    expect(O.strategyStats(priced("double-plateau"), 75, { forward: 26010 }).breakevens.length).toBe(4);
  });
});

describe("spacing", () => {
  it("normSpacing, strikeStep, spacingMove and ladderUnit", () => {
    expect(S.normSpacing("3")).toBe("3");
    expect(S.normSpacing(7)).toBe("auto");
    expect(S.strikeStep([26100, 26000, 26050])).toBe(50);
    expect(S.strikeStep([26000])).toBe(50);
    expect(S.spacingMove("auto", 50, 210)).toBe(210);
    expect(S.spacingMove("2", 50, 210)).toBe(200);
    expect(S.ladderUnit("5", 50, 210)).toBe(5);
    expect(S.ladderUnit("auto", 50, 210)).toBe(2);
    expect(S.ladderUnit("auto", 50, null)).toBe(2);
    expect(S.ladderUnit("auto", 50, 20)).toBe(1);
  });
  it("templateLegs: Spacing 1 puts a bull call spread two strikes apart, Spacing 2 four", () => {
    const a = S.templateLegs("bull-call", chain, { spacing: "1", forward: 26000 });
    expect(a.map((l) => l.strike)).toEqual([26000, 26100]);
    const b = S.templateLegs("bull-call", chain, { spacing: "2", forward: 26000 });
    expect(b.map((l) => l.strike)).toEqual([26000, 26200]);
    const c = S.templateLegs("iron-condor", chain, { spacing: "1", forward: 26000 });
    expect(c.map((l) => l.strike)).toEqual([25850, 25900, 26100, 26150]);
    expect(S.templateLegs("strip", chain, { spacing: "3" }).length).toBe(2);
  });
});

describe("search", () => {
  it("matches names, aliases and hints; every word must match; empty returns the group", () => {
    expect(S.searchTemplates("iron butterfly").map((p) => p.id)).toContain("iron-fly");
    expect(S.searchTemplates("backspread").map((p) => p.id)).toEqual(["call-ratio-back", "put-ratio-back"]);
    expect(S.searchTemplates("condor bear").map((p) => p.id)).toEqual(["bear-condor"]);
    expect(S.searchTemplates("zzz")).toEqual([]);
    expect(S.searchTemplates("", "vol").every((p) => p.group === "vol")).toBe(true);
    expect(S.searchTemplates("").length).toBe(50);
  });
  it("tileMoney: compact, signed, Unlimited for no cap, dash for missing", () => {
    expect(S.tileMoney(3019)).toBe("+₹3K");
    expect(S.tileMoney(-3481)).toBe("−₹3.5K");
    expect(S.tileMoney(0.2)).toBe("₹0");
    expect(S.tileMoney(null)).toBe("Unlimited");
    expect(S.tileMoney(undefined)).toBe("–");
  });
});

describe("width and wings", () => {
  const condor = [L("PE", 25850, "BUY"), L("PE", 25900, "SELL"), L("CE", 26100, "SELL"), L("CE", 26150, "BUY")];
  it("legCentre: mean of sold strikes, else of all", () => {
    expect(S.legCentre(condor)).toBe(26000);
    expect(S.legCentre([L("CE", 26000, "BUY"), L("CE", 26100, "BUY")])).toBe(26050);
    expect(S.legCentre([])).toBeNull();
  });
  it("widenLegs moves both sides out and clears entries; narrowing stops at the centre", () => {
    const w = S.widenLegs(condor.map((l) => ({ ...l, entry: 10, entryTag: "saved", symbol: "S" })), ks, 1);
    expect(w.legs.map((l) => l.strike)).toEqual([25800, 25850, 26150, 26200]);
    expect(w.legs.every((l) => l.entry === undefined && l.symbol === null)).toBe(true);
    const straddle = [L("CE", 26000, "SELL"), L("PE", 26000, "SELL")];
    expect(S.widenLegs(straddle, ks, 1).legs.map((l) => l.strike)).toEqual([26050, 25950]);
    expect(S.widenLegs(straddle, ks, -1).error).toBe("narrowest");
    const strangle = [L("CE", 26050, "SELL"), L("PE", 25950, "SELL")];
    expect(S.widenLegs(strangle, ks, -1).legs.map((l) => l.strike)).toEqual([26000, 26000]);
  });
  it("widenLegs at the edge, with nothing to move, and futures untouched", () => {
    expect(S.widenLegs([L("CE", 27000, "SELL"), L("PE", 25000, "SELL")], ks, 1).error).toBe("edge");
    expect(S.widenLegs([L("CE", 26000, "BUY")], ks, 1).error).toBe("none");
    const fut = { kind: "FUT", side: "BUY", lots: 1, strike: null };
    const r = S.widenLegs([fut, ...condor], ks, 1);
    expect(r.legs[0]).toBe(fut);
  });
  it("wingLegs moves only the bought legs outside the sold strikes, never onto them", () => {
    const w = S.wingLegs(condor, ks, 1);
    expect(w.legs.map((l) => l.strike)).toEqual([25800, 25900, 26100, 26200]);
    expect(S.wingLegs(condor, ks, -1).error).toBe("narrowest");
    expect(S.wingLegs([L("CE", 26000, "SELL"), L("PE", 26000, "SELL")], ks, 1).error).toBe("none");
    expect(S.wingLegs([L("CE", 26000, "BUY")], ks, 1).error).toBe("none");
  });
});

describe("copy, paste and share", () => {
  const legs = [L("CE", 26000, "BUY", 2, { price: 41.55 }), L("CE", 26100, "SELL", 2, { price: 12 }), L("PE", 25900, "SELL", 1, { on: false })];
  it("dayText", () => {
    expect(S.dayText("2026-11-03")).toBe("3 Nov 2026");
    expect(S.dayText("bad")).toBe("");
  });
  it("legsText: a title and one line per enabled leg", () => {
    expect(S.legsText({ underlying: "nifty", name: "Bull call spread", legs })).toBe("Bull call spread · NIFTY\nBuy 2 lots NIFTY 26000 CE 3 Nov 2026 @ 41.55\nSell 2 lots NIFTY 26100 CE 3 Nov 2026 @ 12.00");
  });
  it("parseLegsText reads legsText back, and looser forms", () => {
    const p = S.parseLegsText(S.legsText({ underlying: "NIFTY", legs }));
    expect(p.underlying).toBe("NIFTY");
    expect(p.legs.map((l) => [l.side, l.lots, l.strike, l.right, l.expiry, l.price])).toEqual([
      ["BUY", 2, 26000, "CE", "2026-11-03", 41.55],
      ["SELL", 2, 26100, "CE", "2026-11-03", 12],
    ]);
    const loose = S.parseLegsText("sell 1 x 24500 put 2026-11-03\nB 3 lots BANKNIFTY 52000 call\nBuy 1 lot NIFTY FUT 27 Nov 2026\nhello\nbuy many 1 CE");
    expect(loose.underlying).toBe("BANKNIFTY");
    expect(loose.legs.map((l) => [l.kind, l.side, l.lots, l.strike, l.right, l.expiry])).toEqual([
      ["OPT", "SELL", 1, 24500, "PE", "2026-11-03"],
      ["OPT", "BUY", 3, 52000, "CE", null],
      ["FUT", "BUY", 1, null, null, "2026-11-27"],
    ]);
    expect(loose.skipped).toBe(1);
  });
  it("parseLegsText caps at 12 legs and rejects silly lots", () => {
    const many = Array.from({ length: 14 }, (_, i) => `Buy 1 ${26000 + i * 50} CE`).join("\n");
    const r = S.parseLegsText(many);
    expect(r.legs.length).toBe(12);
    expect(r.skipped).toBe(2);
    expect(S.parseLegsText("Buy 0 26000 CE").legs).toEqual([]);
  });
  it("shareCode round-trips the enabled legs without prices; readShareCode rejects junk", () => {
    const fut = { kind: "FUT", side: "SELL", lots: 1, expiry: "2026-11-24", symbol: "NFO:NIFTY26NOVFUT", on: true };
    const code = S.shareCode({ underlying: "NIFTY", name: "My spread", legs: [...legs, fut] });
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    const back = S.readShareCode(code);
    expect(back.underlying).toBe("NIFTY");
    expect(back.name).toBe("My spread");
    expect(back.legs).toEqual([
      { kind: "OPT", right: "CE", strike: 26000, side: "BUY", lots: 2, expiry: "2026-11-03" },
      { kind: "OPT", right: "CE", strike: 26100, side: "SELL", lots: 2, expiry: "2026-11-03" },
      { kind: "FUT", right: null, strike: null, side: "SELL", lots: 1, expiry: "2026-11-24", symbol: "NFO:NIFTY26NOVFUT" },
    ]);
    expect(S.readShareCode("")).toBeNull();
    expect(S.readShareCode("not base64!")).toBeNull();
    expect(S.readShareCode(btoa(JSON.stringify({ v: 1, u: "NIFTY", l: [["C", "B", 0, "", 26000]] })))).toBeNull();
    expect(S.readShareCode(btoa(JSON.stringify({ v: 1, u: "NIFTY", l: [["X", "B", 1, "", 26000]] })))).toBeNull();
    expect(S.readShareCode(btoa(JSON.stringify({ v: 2, u: "NIFTY", l: [] })))).toBeNull();
  });
});

describe("position sizing", () => {
  it("risk budget over the max loss, capital over the margin, the smaller binds", () => {
    expect(S.positionSizing({ capital: 500000, riskPct: 2, maxLoss: -3481, margin: 40000 })).toEqual({ budget: 10000, byLoss: 2, byMargin: 12, fits: 2, by: "loss", unlimited: false });
    expect(S.positionSizing({ capital: 100000, riskPct: 50, maxLoss: -1000, margin: 40000 })).toMatchObject({ fits: 2, by: "margin" });
    expect(S.positionSizing({ capital: 100000, riskPct: 2, maxLoss: null, margin: 150000 })).toMatchObject({ byLoss: null, fits: 0, by: "margin", unlimited: true });
    expect(S.positionSizing({})).toMatchObject({ budget: null, fits: null, by: null });
  });
});
