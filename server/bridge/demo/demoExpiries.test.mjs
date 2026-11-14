import { describe, expect, it } from "vitest";
import { expiriesFor, monthlyExpiries } from "./demoAdapter.mjs";

const at = (iso) => Date.parse(`${iso}T10:00:00+05:30`);
const weekday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();

describe("demo expiry cycle", () => {
  it("a monthly-only NSE underlying expires on the last Tuesday, a BSE one on the last Thursday", () => {
    const nse = monthlyExpiries({ deriv: "NFO" }, at("2026-11-10"), 3);
    const bse = monthlyExpiries({ deriv: "BFO" }, at("2026-11-10"), 3);
    // 24 Nov 2026 is a Tuesday and a holiday (Guru Nanak): it shifts to the previous trading day, Mon 23 Nov.
    expect(nse).toEqual(["2026-11-23", "2026-12-29", "2027-01-26"]);
    expect(bse).toEqual(["2026-11-26", "2026-12-31", "2027-01-28"]);
    expect(bse.every((d) => weekday(d) === 4)).toBe(true);
  });

  it("the monthly branch of expiriesFor uses the same rule (a stock lists last Tuesdays)", () => {
    expect(expiriesFor("RELIANCE", at("2026-11-10"), 2)).toEqual(["2026-11-23", "2026-12-29"]);
    expect(expiriesFor("BANKNIFTY", at("2026-11-10"), 3)).toEqual(monthlyExpiries({ deriv: "NFO" }, at("2026-11-10"), 3));
  });

  it("weekly cycles are unchanged: NIFTY on Tuesdays, SENSEX on Thursdays", () => {
    // 24 Nov is a holiday, so the NIFTY expiry after 17 Nov moves to Mon 23 Nov.
    expect(expiriesFor("NIFTY", at("2026-11-11"), 2)).toEqual(["2026-11-17", "2026-11-23"]);
    expect(expiriesFor("SENSEX", at("2026-11-11"), 2)).toEqual(["2026-11-12", "2026-11-19"]);
  });
});
