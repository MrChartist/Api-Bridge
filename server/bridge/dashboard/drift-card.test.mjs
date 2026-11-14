import { describe, expect, it } from "vitest";
import { clockOf, driftModel, kindWord } from "./drift-card.js";

const base = { state: "ok", summary: "The Bridge's live orders match the broker's order book.", checkedAt: "2026-10-19T09:35:00.000+05:30", nextCheckAt: "2026-10-19T09:40:00.000+05:30", intervalMinutes: 5, differences: [], note: "The Bridge only compares and reports." };

describe("Order book card: the model", () => {
  it("a match is calm and says when it was checked", () => {
    const m = driftModel(base);
    expect(m).toMatchObject({ tone: "ok", word: "Matches", headline: base.summary, rows: [] });
    expect(m.detail).toBe("Checked 09:35 IST · next about 09:40 · every 5 minutes while the market is open");
  });

  it("differences become rows with a plain kind word and the broker's matching orders", () => {
    const m = driftModel({
      ...base,
      state: "drift",
      summary: "2 differences",
      differences: [
        { kind: "closed_at_broker", side: "BUY", symbol: "NSE:RELIANCE", orderId: "ord_1", message: "The Bridge still has it open." },
        { kind: "outcome_unknown", side: "SELL", symbol: "NFO:NIFTY", orderId: "ord_2", message: "Unknown.", brokerMatches: [{ brokerOrderId: "Z-7", status: "open", quantity: 65 }] },
      ],
    });
    expect(m).toMatchObject({ tone: "bad", word: "Differs" });
    expect(m.rows[0]).toEqual({ title: "BUY NSE:RELIANCE", kind: "Finished at the broker", sub: "The Bridge still has it open.", extra: [] });
    expect(m.rows[1].extra).toEqual(["Broker order Z-7, open, quantity 65"]);
  });

  it("other states have their own words and never claim a match", () => {
    expect(driftModel({ ...base, state: "unavailable" })).toMatchObject({ tone: "warn", word: "Cannot read" });
    expect(driftModel({ state: "idle", summary: "The market is closed.", intervalMinutes: 5 })).toMatchObject({ tone: "", word: "Not checking now", detail: "every 5 minutes while the market is open" });
    expect(driftModel({ state: "off", summary: "The order-book check is off." })).toMatchObject({ word: "Off", detail: "" });
    expect(driftModel(null).word).toBe("Off");
  });

  it("names every kind the Bridge reports", () => {
    for (const k of ["closed_at_broker", "missing_at_broker", "status_mismatch", "quantity_mismatch", "fill_mismatch", "unknown_at_broker", "outcome_unknown"]) {
      expect(kindWord(k)).not.toMatch(/_/);
    }
    expect(kindWord("something_new")).toBe("something new");
    expect(clockOf("2026-10-19T09:35:00.000+05:30")).toBe("09:35");
    expect(clockOf(null)).toBe("");
  });
});
