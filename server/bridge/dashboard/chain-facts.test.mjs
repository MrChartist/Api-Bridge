/** Cell facts (chain-facts.js): every column's formula inputs and result, in plain words. */
import { describe, expect, it } from "vitest";
import { cellFacts, FACT_KEYS, ivSourceText } from "./chain-facts.js";
import { checkSource } from "./copyRules.mjs";
import { readFileSync } from "node:fs";

await import("./views.js");
const { CHAIN_COLUMNS } = await import("./desk.js");

const row = { strike: 23_400, ce: null, pe: null };
const leg = { ltp: 64, close: 72.4, bid: 64, ask: 64.35, bidQty: 2015, askQty: 325, oi: 9_061_130, oiChange: 2_537_990, volume: 1000, iv: 8.74, delta: 0.42, gamma: 0.0018, theta: -10.43, vega: 9.52, greeksSource: "computed", high: 76, low: 61.5 };
const ctx = { spot: 23_346.4, F: 23_360, years: 4 / 252, tcal: 0.010921, df: 0.9993, sm: { atmIv: 9.1 }, lot: 65, buWin: "day" };
const value = (facts, label) => facts.find((x) => x.label === label)?.value;

describe("cellFacts", () => {
  it("covers every side column of the chain, and every fact has a label and a value", () => {
    const side = CHAIN_COLUMNS.filter((c) => c[2] !== "row").map((c) => c[0]);
    for (const k of side) expect(FACT_KEYS, k).toContain(k);
    for (const k of [...side, "syn", "pcrK"]) {
      const facts = cellFacts(k, leg, row, "ce", ctx);
      expect(facts.length, k).toBeGreaterThan(0);
      for (const x of facts) {
        expect(typeof x.label, k).toBe("string");
        expect(typeof x.value, k).toBe("string");
      }
    }
  });
  it("works the guide's 23400 Call figures", () => {
    expect(value(cellFacts("ltpChg", leg, row, "ce", ctx), "LTP change")).toBe("−8.40");
    expect(value(cellFacts("spreadAbs", leg, row, "ce", ctx), "Spread")).toBe("0.35");
    expect(value(cellFacts("spreadAbs", leg, row, "ce", ctx), "Per lot")).toBe("₹22.75");
    expect(value(cellFacts("bidPct", leg, row, "ce", ctx), "Bid % of spot")).toBe("0.27%");
    expect(value(cellFacts("bidPctAnn", leg, row, "ce", ctx), "Days to expiry")).toBe("4");
    expect(value(cellFacts("bidPctAnn", leg, row, "ce", ctx), "Annualised")).toBe("25.0%");
    expect(value(cellFacts("bu", leg, row, "ce", ctx), "Reading")).toBe("Short build-up");
    expect(value(cellFacts("relDist", leg, row, "ce", ctx), "Relative distance")).toBe("+0.23%");
    expect(value(cellFacts("intrinsic", leg, row, "ce", ctx), "Intrinsic value")).toBe("0.00");
  });
  it("missing inputs read as a dash with the reason, never an invented 0", () => {
    const bare = { ltp: 10 };
    expect(value(cellFacts("ltpChg", bare, row, "ce", ctx), "LTP change")).toBe("–");
    expect(value(cellFacts("bu", bare, row, "ce", ctx), "Reading")).toBe("–");
    expect(cellFacts("bu", bare, row, "ce", ctx)[0].note).toMatch(/No baseline/);
    expect(value(cellFacts("theo", bare, row, "ce", { spot: 23_346.4 }), "Theoretical price")).toBe("–");
    expect(value(cellFacts("gamma", { ...bare, gamma: 0, iv: 9 }, row, "ce", ctx), "Gamma")).toBe("–");
    expect(cellFacts("gamma", { ...bare, gamma: 0, iv: 9 }, row, "ce", ctx)[0].note).toBe("Exactly zero");
    expect(cellFacts("delta", { ...bare, ivReason: "INTRINSIC" }, row, "ce", ctx)[0].note).toMatch(/Greek unavailable: no IV/);
  });
  it("names where an IV came from, and why there is none", () => {
    expect(ivSourceText({ iv: 9, greeksSource: "computed" })).toMatch(/solved/);
    expect(ivSourceText({ iv: 9, greeksSource: "broker" })).toMatch(/data source/);
    expect(ivSourceText({ ivReason: "SETTLED" })).toMatch(/expired/);
    expect(ivSourceText({})).toMatch(/none/);
  });
  it("plain, neutral copy", () => {
    expect(checkSource(readFileSync(new URL("./chain-facts.js", import.meta.url), "utf8"))).toEqual([]);
  });
});
