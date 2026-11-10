// CSV files the SDK writes must not run as formulas when opened in a spreadsheet (same rule as the Bridge's own CSV).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safeName } from "../src/data.mjs";
import { guardFormulaText, parseTable, toCsv, unguardFormulaText } from "../src/table.mjs";

const EVIL = ['=HYPERLINK("http://evil","x")', "+cmd|calc", "-5+3", "@SUM(1)", "\tTAB", "\rCR"];

describe("toCsv guards formula cells", () => {
  it("puts an apostrophe before every text cell that starts = + - @ tab or CR", () => {
    const text = toCsv(EVIL.map((symbol) => ({ symbol, note: "ok" })));
    const lines = text.split("\n");
    assert.equal(lines[1], `"'=HYPERLINK(""http://evil"",""x"")",ok`);
    assert.equal(lines[2], "'+cmd|calc,ok");
    assert.equal(lines[3], "'-5+3,ok");
    assert.equal(lines[4], "'@SUM(1),ok");
    assert.match(text, /\n"'\tTAB"|\n'\tTAB,/); // tab and CR cells carry the apostrophe too
    assert.ok(text.includes("'\rCR") || text.includes(`"'\rCR"`));
    assert.ok(!/\n[=+\-@\t\r]/.test(text.replace(/\n(-?\d)/g, "\n$1")), "no line starts with a formula character");
  });

  it("leaves plain numbers, numeric text and ordinary text alone", () => {
    const text = toCsv([{ qty: -5, price: 12.5, txt: "-5", dec: "12.5", sym: "NSE:RELIANCE", none: null }]);
    assert.equal(text.split("\n")[1], "-5,12.5,-5,12.5,NSE:RELIANCE,");
  });

  it("reads its own file back to the same text", () => {
    const rows = EVIL.map((symbol) => ({ symbol, note: "hello" }));
    const back = parseTable(toCsv(rows));
    assert.deepEqual(back.map((r) => r.symbol), EVIL);
    assert.ok(back.every((r) => r.note === "hello"));
  });

  it("has the same guard functions as the Bridge", () => {
    assert.equal(guardFormulaText("=1+1"), "'=1+1");
    assert.equal(guardFormulaText("-5"), "-5");
    assert.equal(guardFormulaText("-5.25"), "-5.25");
    assert.equal(guardFormulaText("-5+3"), "'-5+3");
    assert.equal(guardFormulaText("abc"), "abc");
    assert.equal(unguardFormulaText("'=1+1"), "=1+1");
    assert.equal(unguardFormulaText("'abc"), "'abc");
  });
});

describe("safeName keeps a downloaded file inside the folder", () => {
  it("keeps plain names, drops folders, refuses a drive letter, a stream name and a NUL", () => {
    assert.equal(safeName("nifty-5m.csv"), "nifty-5m.csv");
    assert.equal(safeName("a/b/c.csv"), "c.csv");
    assert.equal(safeName("..\\..\\x.csv"), "x.csv");
    for (const bad of ["C:x", "a.csv:evil", "ok\u0000.csv", "..", ".", ""]) assert.throws(() => safeName(bad), TypeError, JSON.stringify(bad));
  });
});
