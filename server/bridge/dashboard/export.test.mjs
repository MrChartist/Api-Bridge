import { describe, expect, it } from "vitest";
import { exportName, safeCell, toCsv, toTsv } from "./export.js";

describe("table export", () => {
  it("prefixes cells that start with = + - @ (or a tab or CR) with a quote", () => {
    for (const c of ["=1+1", "+SUM(A1)", "-2+3", "@cmd", "-5"]) expect(safeCell(c)).toBe(`'${c}`);
    expect(safeCell("\tx")).toBe("x"); // leading white space is trimmed first, so nothing can hide a formula behind it
    expect(safeCell("=HYPERLINK(\"http://x\")")).toBe("'=HYPERLINK(\"http://x\")");
    expect(safeCell("  =x ")).toBe("'=x");
    expect(safeCell("NIFTY")).toBe("NIFTY");
    expect(safeCell("12.5")).toBe("12.5");
    expect(safeCell(null)).toBe("");
    expect(safeCell(0)).toBe("0");
    expect(safeCell("a=b")).toBe("a=b");
  });
  it("writes RFC 4180 CSV: quotes commas, quotes and line breaks, CRLF, BOM", () => {
    const csv = toCsv([["Strike", "Note"], ["24,500", 'say "hi"'], ["x\ny", "=bad"]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.slice(1)).toBe('Strike,Note\r\n"24,500","say ""hi"""\r\n"x\ny",\'=bad\r\n');
    expect(toCsv([["a"]], { bom: false })).toBe("a\r\n");
  });
  it("writes TSV with tabs and newlines inside cells flattened, and the same injection guard", () => {
    expect(toTsv([["a\tb", "c\nd"], ["=1", "ok"]])).toBe("a b\tc d\n'=1\tok\n");
  });
  it("names files from the title and the day", () => {
    expect(exportName("Option chain · NIFTY!", "csv", "2026-11-01")).toBe("option-chain-nifty-2026-11-01.csv");
    expect(exportName("", "tsv", "2026-11-01")).toBe("table-2026-11-01.tsv");
  });
});
