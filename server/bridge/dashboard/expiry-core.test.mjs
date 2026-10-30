import { describe, expect, it } from "vitest";
import { closeMs, countdownText, decayLeft, deskExpiry, gammaByStrike, nextSessionDay, pinRisk, settlementRisk } from "./expiry-core.js";

const at = (s) => Date.parse(`${s}+05:30`);
const leg = (strike, right, q, extra = {}) => ({ kind: "OPT", symbol: `NFO:NIFTY-2026-11-03-${strike}-${right}`, strike, right, q, expiry: "2026-11-03", mark: 20, greeks: { gamma: 0.002 }, ...extra });

describe("which expiry the desk shows", () => {
  const legs = [leg(26000, "CE", -65), { ...leg(26000, "PE", -65), expiry: "2026-11-10" }];
  it("today before the close, or the next session", () => {
    expect(deskExpiry(legs, at("2026-11-03T10:00:00"))).toEqual({ expiry: "2026-11-03", when: "today" });
    expect(deskExpiry(legs, at("2026-11-03T15:31:00"))).toBeNull();
    expect(deskExpiry(legs, at("2026-11-02T10:00:00"))).toEqual({ expiry: "2026-11-03", when: "next" });
    expect(deskExpiry(legs, at("2026-10-30T10:00:00"))).toBeNull();
    // Friday's next session is Monday.
    expect(nextSessionDay("2026-10-30")).toBe("2026-11-02");
    expect(deskExpiry([{ ...legs[0], expiry: "2026-11-02" }], at("2026-10-30T12:00:00"))?.when).toBe("next");
  });
  it("counts down to the close", () => {
    expect(countdownText(closeMs("2026-11-03") - at("2026-11-03T12:18:00"))).toBe("3 h 12 min");
    expect(countdownText(45_000)).toBe("45 s");
    expect(countdownText((94 * 60 + 1) * 60_000)).toBe("3 d 22 h");
    expect(countdownText(-1)).toBe("closed");
  });
});

describe("gamma, pin and decay", () => {
  const legs = [leg(26000, "CE", -65), leg(26000, "PE", -65), leg(26300, "CE", 65, { greeks: { gamma: 0.001 } })];
  it("gamma by strike, signed by the quantity", () => {
    const g = gammaByStrike(legs, 26000);
    expect(g.map((r) => r.strike)).toEqual([26000, 26300]);
    expect(g[0].gamma).toBeCloseTo(-0.26, 6);
    expect(g[0].deltaPer1pct).toBeCloseTo(-0.26 * 260, 6);
    expect(g[0].pnlPer1pct).toBeCloseTo(0.5 * -0.26 * 260 ** 2, 4);
    expect(g[1]).toMatchObject({ ce: 65, pe: 0 });
  });
  it("pin risk lists short strikes nearest spot first and flags spot, max pain and walls", () => {
    const p = pinRisk(legs, { spot: 26050, maxPain: 26000, walls: [26500] });
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ strike: 26000, atSpot: true, atMaxPain: true, atWall: false });
    expect(p[0].distPct).toBeCloseTo((-50 / 26050) * 100, 6);
    expect(pinRisk(legs, { spot: null })).toEqual([]);
  });
  it("time value left: shorts against longs", () => {
    const d = decayLeft(legs, 26050);
    // 26000 CE: mark 20, intrinsic 50 → no time value; 26000 PE: 20; 26300 CE long: 20.
    expect(d).toEqual({ total: 0, short: 20 * 65, long: 20 * 65 });
  });
});

describe("settlement", () => {
  it("index: ITM longs are exercised (STT), ITM shorts assigned; stocks: ITM or near the strike settle by delivery", () => {
    const idx = settlementRisk([leg(26000, "CE", 65), leg(26000, "PE", -65), leg(26500, "CE", -65)], { spot: 26100, underlying: "NIFTY" });
    expect(idx.map((r) => [r.strike, r.right, r.kind])).toEqual([[26000, "CE", "exercise"]]);
    const idx2 = settlementRisk([leg(26200, "PE", -65)], { spot: 26100, underlying: "NIFTY" });
    expect(idx2[0]).toMatchObject({ kind: "assigned", intrinsic: 100 * 65 });
    const stk = settlementRisk([{ ...leg(1400, "CE", -500), symbol: "NFO:RELIANCE-2026-11-24-1400-CE" }, { ...leg(1500, "CE", 500) }], { spot: 1395, underlying: "RELIANCE" });
    expect(stk).toHaveLength(1);
    expect(stk[0]).toMatchObject({ kind: "physical", itm: false, near: true });
  });
});
