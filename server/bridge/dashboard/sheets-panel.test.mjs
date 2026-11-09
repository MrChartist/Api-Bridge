import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CAPACITY, SAMPLE_SYMBOLS } from "./workbook-core.js";
import { APPS_SCRIPT } from "./sheets-script.js";
import { TEST_COLUMNS, freshnessWord, parseSymbols, quotesPath, testSummary } from "./sheets-panel.js";

describe("Excel and Sheets panel helpers", () => {
  it("symbols: one per line or comma separated, blanks and repeats dropped, capped to the sheet's room", () => {
    expect(parseSymbols("NSE:RELIANCE\n\n nse:tcs , NSE:RELIANCE;BSE:SENSEX\r\n")).toEqual(["NSE:RELIANCE", "nse:tcs", "BSE:SENSEX"]);
    expect(parseSymbols("")).toEqual([]);
    expect(parseSymbols(Array.from({ length: 90 }, (_, i) => `NSE:S${i}`).join("\n"))).toHaveLength(CAPACITY.quotes);
    expect(parseSymbols(SAMPLE_SYMBOLS.join("\n"))).toEqual([...SAMPLE_SYMBOLS]);
  });

  it("the test request is the batch route with the symbols encoded and ':' kept readable", () => {
    expect(quotesPath(["NSE:RELIANCE", "NSE:M&M", "NFO:NIFTY-2026-11-24-FUT"])).toBe("/xl/quotes?format=json&symbols=NSE:RELIANCE,NSE:M%26M,NFO:NIFTY-2026-11-24-FUT");
  });

  it("one word per row says how far to trust it", () => {
    expect(freshnessWord({ class: "realtime", stale: false })).toBe("Live");
    expect(freshnessWord({ class: "realtime", stale: true })).toBe("Stale");
    expect(freshnessWord({ class: "delayed", stale: false })).toBe("Delayed");
    expect(freshnessWord({ class: "eod" })).toBe("End of day");
    expect(freshnessWord({ error: "SYMBOL_NOT_FOUND: x", class: null })).toBe("Error");
  });

  it("the summary says what happened in plain words", () => {
    const rows = [
      { symbol: "A", ltp: 1, as_of: "2026-11-09 11:00:27", class: "realtime", stale: false },
      { symbol: "B", ltp: 2, as_of: "2026-11-09 11:00:20", class: "delayed", stale: true },
      { symbol: "C", ltp: null, error: "SYMBOL_NOT_FOUND: c" },
    ];
    expect(testSummary(rows)).toBe("3 symbols in one request, 2 priced, 1 could not be priced, newest price 2026-11-09 11:00:27 IST, 1 stale, 1 not real-time.");
    expect(testSummary([{ symbol: "A", ltp: 1, as_of: "2026-11-09 11:00:27", class: "realtime", stale: false }])).toBe("1 symbol in one request, 1 priced, newest price 2026-11-09 11:00:27 IST.");
  });

  it("the test table shows the freshness labels", () => {
    expect(TEST_COLUMNS.map((c) => c.label)).toEqual(["Symbol", "Last", "Change %", "As of (IST)", "Age (s)", "Class", "Source", "Label", "Error"]);
  });

  it("the copied Apps Script is the shipped file (run scripts/sync-sheets-script.mjs after editing bridge.gs)", () => {
    expect(APPS_SCRIPT).toBe(readFileSync(new URL("../../../integrations/google-sheets/bridge.gs", import.meta.url), "utf8"));
  });
});
