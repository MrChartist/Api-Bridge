import { describe, expect, it } from "vitest";
import { bookRow } from "./__fixtures__/helpers.mjs";
import { CLOCK_SKEW_MS, findLegInBook } from "./reconcile.mjs";

const sentAt = Date.parse("2026-10-19T09:30:00+05:30");
const leg = { ref: { token: "738561", exchange: "NSE", tradingSymbol: "RELIANCE" }, side: "BUY", quantity: 10, orderType: "LIMIT", price: 1400, sentAt, tickSize: 0.1 };

describe("findLegInBook", () => {
  it("matches on instrument, side, quantity, price and time", () => {
    const book = [bookRow({ orderId: "A", placedAt: "2026-10-19T09:30:01+05:30" })];
    expect(findLegInBook(leg, book, new Set())).toEqual({ match: book[0], candidates: 1 });
  });

  it("matches by trading symbol when the token differs", () => {
    const book = [bookRow({ orderId: "A", token: "other" })];
    expect(findLegInBook(leg, book, new Set()).match?.orderId).toBe("A");
  });

  it("ignores rows that differ, are claimed or are too old", () => {
    const book = [
      bookRow({ orderId: "side", side: "SELL" }),
      bookRow({ orderId: "qty", qty: 20 }),
      bookRow({ orderId: "price", price: 1401 }),
      bookRow({ orderId: "exch", exchange: "BSE" }),
      bookRow({ orderId: "old", placedAt: new Date(sentAt - CLOCK_SKEW_MS - 1000).toISOString() }),
      bookRow({ orderId: "claimed" }),
    ];
    expect(findLegInBook(leg, book, new Set(["claimed"]))).toEqual({ match: null, candidates: 0 });
  });

  it("reports ambiguity instead of guessing", () => {
    const book = [bookRow({ orderId: "A" }), bookRow({ orderId: "B" })];
    expect(findLegInBook(leg, book, new Set())).toEqual({ match: null, candidates: 2 });
  });

  it("does not compare price for MARKET orders", () => {
    const book = [bookRow({ orderId: "M", price: 0, orderType: "MARKET" })];
    expect(findLegInBook({ ...leg, orderType: "MARKET", price: null }, book, new Set()).match?.orderId).toBe("M");
  });
});
