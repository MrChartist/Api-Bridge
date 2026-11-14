/**
 * The dashboard's number house rule (format.js): no grouping commas, fixed decimals where asked, an en dash "–" (DASH)
 * for a missing figure (never 0, never "--"), and no other dashboard file formats numbers itself.
 */
import { readFileSync as read, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DASH, MINUS, formatDayMonth, formatFixed, formatInt, formatNumber, formatPercent, formatRupee, formatRupeeGrouped, formatSignedRupee, isFigure, plural, pluralWord } from "./format.js";

describe("plurals", () => {
  it("says one only for exactly 1", () => {
    expect(plural(1, "broker call")).toBe("1 broker call");
    expect(plural(0, "call")).toBe("0 calls");
    expect(plural(2, "call")).toBe("2 calls");
    expect(plural(3000, "call")).toBe("3000 calls");
    expect(plural(2, "futures and options fill")).toBe("2 futures and options fills");
    expect(plural(2, "person", "people")).toBe("2 people");
    expect(pluralWord(1, "account")).toBe("account");
    expect(pluralWord("1", "account")).toBe("account");
    expect(pluralWord(0, "account")).toBe("accounts");
  });
});

describe("dashboard number format", () => {
  it("prints figures without grouping commas", () => {
    expect(formatInt(3000)).toBe("3000");
    expect(formatInt(1234567)).toBe("1234567");
    expect(formatFixed(125000.5)).toBe("125000.50");
    expect(formatRupee(125000.5)).toBe("₹125000.50");
    expect(formatRupee(1000000, 0)).toBe("₹1000000");
    expect(formatNumber(1234.5678)).toBe("1234.568");
    expect(formatPercent(12.345)).toBe("12.3%");
  });

  it("keeps signs and never prints a negative zero", () => {
    expect(formatRupee(-42)).toBe("−₹42.00");
    expect(formatRupee(-724, 0)).toBe("−₹724");
    expect(formatRupee(-0.001, 0)).toBe("₹0");
    expect(formatFixed(-0.004)).toBe("0.00");
  });

  it("signs money first, one rule everywhere", () => {
    expect(formatSignedRupee(1204.5)).toBe("+₹1204.50");
    expect(formatSignedRupee(-1204.5)).toBe("−₹1204.50");
    expect(formatSignedRupee(-0.004)).toBe("₹0.00");
    expect(formatSignedRupee(null)).toBe(DASH);
    expect(formatSignedRupee(1e7, 0)).toBe("+₹10000000");
    expect(formatRupeeGrouped(1750)).toBe("₹1,750");
    expect(formatRupeeGrouped(10000)).toBe("₹10,000");
    expect(formatRupeeGrouped(125000)).toBe("₹1,25,000");
    expect(formatRupeeGrouped(999.6)).toBe("₹1,000");
    expect(formatRupeeGrouped(-500)).toBe("−₹500");
    expect(formatRupeeGrouped(0)).toBe("₹0");
    expect(formatRupeeGrouped(null)).toBe(DASH);
    expect(formatRupeeGrouped(10000, 2)).toBe("₹10,000.00");
    expect(formatRupeeGrouped(170626, 2)).toBe("₹1,70,626.00");
    expect(formatRupeeGrouped(-0.001, 2)).toBe("₹0.00");
    expect(formatRupee(-1204)).toBe("−₹1204.00");
    expect(formatRupee(-1204)).not.toMatch(/₹-/);
  });

  it("starts every negative with the true minus sign U+2212, never a hyphen", () => {
    expect(MINUS).toBe("\u2212");
    for (const t of [formatNumber(-1.5), formatInt(-3), formatFixed(-2.35), formatPercent(-2.35, 2), formatRupee(-1235.4), formatSignedRupee(-5)]) {
      expect(t, t).toMatch(/^\u2212/);
      expect(t, t).not.toContain("-");
    }
  });

  it("prints a calendar day as day and short month", () => {
    expect(formatDayMonth("2026-11-03")).toBe("3 Nov");
    expect(formatDayMonth("2026-12-31")).toBe("31 Dec");
    expect(formatDayMonth("weekly")).toBe("weekly");
    expect(formatDayMonth(null)).toBe("");
  });

  it("shows an en dash for missing data, never 0 and never --", () => {
    for (const v of [null, undefined, "", Number.NaN, Number.POSITIVE_INFINITY, "abc", true]) {
      expect(isFigure(v)).toBe(false);
      expect(formatInt(v)).toBe(DASH);
      expect(formatFixed(v)).toBe(DASH);
      expect(formatRupee(v)).toBe(DASH);
      expect(formatSignedRupee(v)).toBe(DASH);
    }
    expect(DASH).toBe("\u2013");
    expect(formatInt(0)).toBe("0");
    expect(formatInt("17")).toBe("17");
  });

  it("no other dashboard file hand-builds a hyphen sign for a figure (MINUS from format.js instead)", () => {
    for (const f of sourceFiles()) {
      expect(read(new URL(`./${f}`, import.meta.url), "utf8"), f).not.toMatch(/\? "-" :|: "-"\)|-\$\{(?:format|fmt|rupee|money)|["`]-₹/);
    }
  });

  it("no other dashboard file formats numbers with the locale formatter", () => {
    for (const f of sourceFiles(["format.js"])) {
      const src = read(new URL(`./${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/Intl\.NumberFormat|\.toLocaleString\(|toLocaleTimeString|toFixed\(/);
      expect(src, f).not.toMatch(/₹\d{1,3},\d/);
    }
  });
});

/** Every dashboard script, minus `except`. */
function sourceFiles(except = []) {
  return readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".js") && !except.includes(f));
}
