import { describe, expect, it } from "vitest";
import { intentLabel, parseTradeIntent, pickExpiry } from "./trade-intent.js";

describe("typed trades", () => {
  it("one leg: side, lots, underlying, strike and right in any order", () => {
    expect(parseTradeIntent("buy 2 nifty 26000 ce")).toEqual({ kind: "leg", side: "BUY", lots: 2, underlying: "NIFTY", strike: 26000, right: "CE", date: null });
    expect(parseTradeIntent("s banknifty 58000pe 3 lots 25 nov")).toMatchObject({ side: "SELL", lots: 3, underlying: "BANKNIFTY", strike: 58000, right: "PE", date: { md: [11, 25] } });
    expect(parseTradeIntent("Sell 1 BN 57500 put")).toMatchObject({ underlying: "BANKNIFTY", right: "PE", lots: 1 });
    expect(parseTradeIntent("buy nifty 26000 ce 2026-11-03")).toMatchObject({ date: { iso: "2026-11-03" } });
  });

  it("structures: the preset by side, short when no side is typed", () => {
    expect(parseTradeIntent("sell nifty straddle 3 nov")).toEqual({ kind: "structure", side: "SELL", lots: 1, underlying: "NIFTY", preset: "short-straddle", structure: "straddle", date: { md: [11, 3] } });
    expect(parseTradeIntent("buy 2 nifty strangle")).toMatchObject({ preset: "long-strangle", lots: 2 });
    expect(parseTradeIntent("nifty iron condor")).toMatchObject({ preset: "iron-condor", side: "SELL" });
    expect(parseTradeIntent("sensex bull call nov 5")).toMatchObject({ preset: "bull-call", date: { md: [11, 5] } });
  });

  it("anything else is a search, not a trade", () => {
    for (const q of ["rate limits", "option chain", "buy", "buy nifty", "nifty 26000", "sell 2 nifty 26000", "buy 2 apples 26000 ce", "", "keys"]) expect(parseTradeIntent(q), q).toBeNull();
  });

  it("picks the listed expiry a date names, else the nearest; a date not listed gives none", () => {
    const ex = ["2026-10-27", "2026-11-03", "2026-11-10", "2026-11-24"];
    expect(pickExpiry(ex, null, "2026-10-30")).toBe("2026-11-03");
    expect(pickExpiry(ex, { md: [11, 10] }, "2026-10-30")).toBe("2026-11-10");
    expect(pickExpiry(ex, { md: [11, 11] }, "2026-10-30")).toBeNull();
    expect(pickExpiry(ex, { iso: "2026-11-24" }, "2026-10-30")).toBe("2026-11-24");
  });

  it("labels what will open", () => {
    expect(intentLabel(parseTradeIntent("buy 2 nifty 26000 ce"))).toBe("Buy 2 lots NIFTY 26000 CE · nearest expiry");
    expect(intentLabel(parseTradeIntent("sell nifty straddle 3 nov"))).toBe("Short straddle · 1 lot NIFTY · 3 Nov");
    expect(intentLabel(parseTradeIntent("buy nifty iron condor"))).toBe("Reverse iron condor · 1 lot NIFTY · nearest expiry");
  });
});
