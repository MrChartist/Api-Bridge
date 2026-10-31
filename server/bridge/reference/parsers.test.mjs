import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mwplBand, mwplRows, nseFileDate, parseCombineOi, parseNseDate, parseSecBan, readCombineOiZip } from "./parsers.mjs";

const fixture = (name, enc = "utf8") => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), enc);

describe("parseSecBan", () => {
  it("reads the trade date and symbols (trailing commas, CRLF)", () => {
    expect(parseSecBan(fixture("fo_secban.csv"))).toEqual({ forDate: "2026-10-30", symbols: ["ABC", "PQR", "XYZ"] });
  });
  it("the NIL form is an empty list", () => {
    expect(parseSecBan(fixture("fo_secban_nil.csv"))).toEqual({ forDate: "2026-11-02", symbols: [] });
  });
  it("refuses a file without the header", () => {
    expect(() => parseSecBan("1,ABC\n")).toThrow(/header/);
  });
});

describe("parseCombineOi through the zip", () => {
  it("reads the single CSV inside the zip", () => {
    const text = readCombineOiZip(fixture("combineoi.zip", null), { maxBytes: 1024 * 1024 });
    expect(text).toBe(fixture("combineoi.csv"));
    const p = parseCombineOi(text);
    expect(p.forDate).toBe("2026-10-29");
    expect(p.rows.find((r) => r.symbol === "DEF")).toMatchObject({ mwpl: 100000000, oi: 84200000, limitNextDay: 75800000 });
    expect(p.rows.find((r) => r.symbol === "ABC").limitNextDay).toBe(null);
  });
  it("refuses a zip over the size cap and a zip with two entries", () => {
    expect(() => readCombineOiZip(fixture("combineoi.zip", null), { maxBytes: 10 })).toThrow(/limit/);
    expect(() => readCombineOiZip(fixture("combineoi-two-entries.zip", null), { maxBytes: 1024 })).toThrow(/one file/);
    expect(() => readCombineOiZip(Buffer.from("not a zip"), { maxBytes: 1024 })).toThrow(/ZIP/);
  });
});

describe("MWPL % and band (§6.7)", () => {
  it("96.2 % on the ban list is ban; 84.2 % is high; 15 % is normal", () => {
    expect(mwplBand({ mwpl: 100000000, oi: 96200000 }, true)).toEqual({ mwplPct: 96.2, band: "ban" });
    expect(mwplBand({ mwpl: 100000000, oi: 84200000 }, false)).toEqual({ mwplPct: 84.2, band: "high" });
    expect(mwplBand({ mwpl: 50000000, oi: 7500000 }, false)).toEqual({ mwplPct: 15, band: "normal" });
  });
  it("the ban list is the authority, not the computed %", () => {
    const rows = mwplRows(parseCombineOi(fixture("combineoi.csv")), ["GHI"]);
    expect(rows.find((r) => r.symbol === "ABC").band).toBe("high");
    expect(rows.find((r) => r.symbol === "GHI").band).toBe("ban");
  });
  it("NSE dates", () => {
    expect(parseNseDate("29-Oct-2026")).toBe("2026-10-29");
    expect(parseNseDate("29102026")).toBe("2026-10-29");
    expect(nseFileDate("2026-10-29")).toBe("29102026");
  });
});
