import { describe, expect, it } from "vitest";
import { exitTicket, holdingRows, openPositions, positionTotals } from "./positions.js";

const rows = [
  { accountId: "p", symbol: "NSE:RELIANCE", product: "CNC", netQty: 2, unrealisedPnl: 10, realisedPnl: 0, dayPnl: 10 },
  { accountId: "p", symbol: "NFO:NIFTY-2026-11-26-FUT", product: "MARGIN", netQty: -75, unrealisedPnl: -40, realisedPnl: 5, dayPnl: -35 },
  { accountId: "p", symbol: "NSE:INFY", product: "INTRADAY", netQty: 0, unrealisedPnl: 0, realisedPnl: 25, dayPnl: 25 },
];

describe("positions page", () => {
  it("separates open positions from squared-off ones and adds up the P&L", () => {
    expect(openPositions(rows).map((p) => p.symbol)).toEqual(["NSE:RELIANCE", "NFO:NIFTY-2026-11-26-FUT"]);
    expect(positionTotals(rows)).toEqual({ open: 2, closed: 1, unrealised: -30, realised: 30, day: 0 });
    expect(positionTotals(null)).toEqual({ open: 0, closed: 0, unrealised: 0, realised: 0, day: 0 });
  });

  it("fills the exit ticket with the opposite side for the whole quantity", () => {
    expect(exitTicket(rows[0])).toEqual({ account: "p", symbol: "NSE:RELIANCE", side: "SELL", quantity: 2, product: "CNC" });
    expect(exitTicket(rows[1])).toEqual({ account: "p", symbol: "NFO:NIFTY-2026-11-26-FUT", side: "BUY", quantity: 75, product: "MARGIN" });
    expect(exitTicket(rows[2])).toBeNull();
  });

  it("reads holdings whatever a broker's adapter called the fields", () => {
    expect(holdingRows([{ accountId: "d", symbol: "NSE:TCS", qty: 4, averagePrice: 100, ltp: 110 }])).toEqual([{ accountId: "d", symbol: "NSE:TCS", quantity: 4, avgPrice: 100, ltp: 110, value: 440, pnl: 40 }]);
    expect(holdingRows([{ accountId: "d", symbol: "NSE:TCS", quantity: 1, avgPrice: 100, ltp: null }])[0]).toMatchObject({ value: null, pnl: null });
    expect(holdingRows(undefined)).toEqual([]);
  });
});
