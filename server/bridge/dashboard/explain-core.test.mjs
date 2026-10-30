import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXPLAIN_NOTE, explainOi, explainVol } from "./explain-core.js";
import { checkCopy, checkSource } from "./copyRules.mjs";

describe("Explain this: OI", () => {
  const out = explainOi({ spot: 26300, pcr: 1.35, pcrRef: 1.2, callWall: 26500, putWall: 26000, maxPain: 26200, sessionsLeft: 1, buildup: { tone: "range", short: "Short build-up both sides", empty: false } });
  it("reads each figure in plain words", () => {
    expect(out.map((x) => x.key)).toEqual(["pcr", "walls", "maxpain", "buildup"]);
    expect(out[0].text).toMatch(/^PCR 1\.35: more put open interest/);
    expect(out[0].text).toContain("It was 1.20 at the start of the window");
    expect(out[1].text).toContain("26500 (+0.8% from spot)");
    expect(out[2].text).toContain("−100 points from spot");
    expect(out[2].text).toContain("not a forecast");
  });
  it("skips what it does not have", () => {
    expect(explainOi({})).toEqual([]);
    expect(explainOi({ pcr: 1 }).map((x) => x.key)).toEqual(["pcr"]);
  });
});

describe("Explain this: volatility", () => {
  it("IV against HV, rank, skew and term structure", () => {
    const out = explainVol({ atmIv: 14.2, hv20: 11, ivr: 75, ivp: 80, put25: 16, call25: 12.5, term: [{ atmIv: 15 }, { atmIv: 13 }] });
    expect(out.map((x) => x.key)).toEqual(["ivhv", "rank", "skew", "term"]);
    expect(out[0].text).toContain("above");
    expect(out[1].text).toContain("near the top");
    expect(out[3].text).toContain("inverted");
    expect(explainVol({ atmIv: 15.87 })[0].text).toContain("about 1.00% a day");
  });
});

describe("neutral copy", () => {
  it("every sentence it can write passes the banned-word list", () => {
    const all = [
      ...explainOi({ spot: 26300, pcr: 1.35, pcrRef: 1.2, callWall: 26500, putWall: 26000, maxPain: 26200, sessionsLeft: 5, buildup: { tone: "up", short: "x" } }),
      ...explainOi({ pcr: 0.6, buildup: { tone: "down", short: "x" } }),
      ...explainVol({ atmIv: 10, hv20: 14, ivr: 20, put25: 12, call25: 14, term: [{ atmIv: 12 }, { atmIv: 14 }] }),
    ].map((x) => x.text);
    expect(checkCopy([...all, EXPLAIN_NOTE])).toEqual([]);
    expect(checkSource(readFileSync(new URL("./explain-core.js", import.meta.url), "utf8"))).toEqual([]);
  });
});
