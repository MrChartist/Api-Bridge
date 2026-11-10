import { describe, expect, it } from "vitest";
import { decodeRows, encodeRow, rowOf } from "./format.mjs";
import { toCsv } from "../core/http.mjs";
import { tradesCsv } from "../dashboard/orders-core.js";
import { collectionToCsv } from "../dashboard/data-core.js";

const NASTY = ["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\tx", "\rx"];
const MS = Date.UTC(2026, 10, 10, 4);

describe("spreadsheet formula guard in recorded CSV", () => {
  it("neutralises every text cell that starts with = + - @ tab or CR", () => {
    for (const bad of NASTY) {
      const line = encodeRow(rowOf({ ms: MS, symbol: bad, ltp: 10, source: bad }), "csv");
      // The symbol is the second cell and the source the 22nd: both start with an apostrophe (inside quotes when the value has a CR).
      expect(line).toMatch(/^[^,]+,"?'[=+\-@\t\r]/);
      expect(line).toMatch(/,"?'[=+\-@\t\r][^,]*,realtime\n$/);
    }
  });

  it("leaves plain numbers (including negative ones) and ordinary symbols alone", () => {
    const line = encodeRow(rowOf({ ms: MS, symbol: "NFO:NIFTY-2026-11-12-24000-CE", ltp: 10.5, delta: -0.4, source: "stream" }), "csv");
    expect(line).toContain("NFO:NIFTY-2026-11-12-24000-CE,10.5");
    expect(line).toContain(",-0.4,");
    expect(line).not.toContain("'");
  });

  it("reads a guarded symbol back as the real value", () => {
    const row = rowOf({ ms: MS, symbol: "=EVIL", ltp: 1, source: "@x" });
    const back = decodeRows(`time,symbol\n${encodeRow(row, "csv")}`, "csv");
    expect(back[0].symbol).toBe("=EVIL");
    expect(back[0].source).toBe("@x");
  });

  it("JSONL keeps the value as it is (it is not opened as a sheet)", () => {
    expect(JSON.parse(encodeRow(rowOf({ ms: 1, symbol: "=EVIL" }), "jsonl")).symbol).toBe("=EVIL");
  });
});

describe("the same guard on the other CSV writers", () => {
  it("download and instrument CSV (core toCsv)", () => {
    for (const bad of NASTY) expect(toCsv([[bad]])).toMatch(/^"?'/);
    expect(toCsv([["-5", "2024-01-01", -5]])).toBe("-5,2024-01-01,-5\r\n");
  });

  it("trade book and collection export in the dashboard", () => {
    const csv = tradesCsv([{ tradedAt: "2026-11-10T04:00:00Z", accountId: "a", symbol: "=EVIL", side: "BUY", qty: 1, price: 2, orderId: "@o", tradeId: "t" }]);
    expect(csv).toContain(",'=EVIL,");
    expect(csv).toContain(",'@o,");
    expect(collectionToCsv({ kind: "static", symbols: ["=A", "NSE:X"] })).toBe("symbol\n'=A\nNSE:X\n");
  });
});
