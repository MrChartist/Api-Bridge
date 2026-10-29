/**
 * The dashboard's number house rule (format.js, as IPO Decode's utils/number-format.js): no grouping commas, fixed
 * decimals where asked, "--" for a missing figure (never 0), and no other dashboard file formats numbers itself.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DASH, MINUS, ageText, formatCompact, formatFixed, formatInput, formatInt, formatNumber, formatPercent, formatRupee, formatSigned, formatSignedRupee, isFigure } from "./format.js";

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
    expect(formatSigned(12.3)).toBe("+12.30");
    expect(formatSigned(-4.1)).toBe("−4.10");
    expect(formatSigned(0)).toBe("0.00");
  });

  it("signs money first, one rule everywhere", () => {
    expect(formatSignedRupee(1204.5)).toBe("+₹1204.50");
    expect(formatSignedRupee(-1204.5)).toBe("−₹1204.50");
    expect(formatSignedRupee(-0.004)).toBe("₹0.00");
    expect(formatSignedRupee(null)).toBe(DASH);
    expect(formatSignedRupee(1e7, 0)).toBe("+₹10000000");
    expect(formatRupee(-1204)).toBe("−₹1204.00");
    expect(formatRupee(-1204)).not.toMatch(/₹-/);
  });

  it("starts every negative with the true minus sign U+2212, never a hyphen (TYPE-SYSTEM.md §4)", () => {
    expect(MINUS).toBe("\u2212");
    for (const t of [formatNumber(-1.5), formatInt(-3), formatFixed(-2.35), formatPercent(-2.35, 2), formatRupee(-1235.4), formatSigned(-1), formatSignedRupee(-5), formatCompact(-150_000)]) {
      expect(t, t).toMatch(/^\u2212/);
      expect(t, t).not.toContain("-");
    }
    expect(formatCompact(-40)).toBe("\u221240");
    expect(formatCompact(-0.2)).toBe("0");
  });

  it("keeps an editable field's text parseable (ASCII hyphen, no grouping)", () => {
    expect(formatInput(-0.5)).toBe("-0.50");
    expect(Number(formatInput(-1234.5, 1))).toBe(-1234.5);
    expect(formatInput(null)).toBe("");
  });

  it("says how old data is in whole units", () => {
    expect(ageText(-500)).toBe("just now");
    expect(ageText(400)).toBe("just now");
    expect(ageText(12_400)).toBe("12 s old");
    expect(ageText(125_000)).toBe("2 min old");
    expect(ageText(3_700_000)).toBe("1 h old");
    expect(ageText(null)).toBe("just now");
  });

  it("shows -- for missing data, never 0", () => {
    for (const v of [null, undefined, "", Number.NaN, Number.POSITIVE_INFINITY, "abc", true]) {
      expect(isFigure(v)).toBe(false);
      expect(formatInt(v)).toBe(DASH);
      expect(formatFixed(v)).toBe(DASH);
      expect(formatRupee(v)).toBe(DASH);
      expect(formatSigned(v)).toBe(DASH);
    }
    expect(DASH).toBe("--");
    expect(formatInt(0)).toBe("0");
    expect(formatInt("17")).toBe("17");
  });

  it("prints big counts in Indian units", () => {
    expect(formatCompact(12_500_000)).toBe("1.25Cr");
    expect(formatCompact(1_586_850)).toBe("15.87L");
    expect(formatCompact(8_540)).toBe("8.5K");
    expect(formatCompact(950)).toBe("950");
    expect(formatCompact(-31_382)).toBe("−31.4K");
    expect(formatCompact(31_382, { signed: true })).toBe("+31.4K");
    expect(formatCompact(0, { signed: true })).toBe("0");
    expect(formatCompact(null)).toBe(DASH);
  });

  it("no other dashboard file hand-builds a hyphen sign for a figure (MINUS from format.js instead)", () => {
    for (const f of ["app.js", "views.js", "options.js", "desk.js", "chain-sheet.js", "oi.js", "strategy.js", "strategy-place.js", "payoff.js", "positions.js", "vol.js", "vol-curves.js", "arbitrage.js", "screener.js", "screens.js", "viz.js"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/\? "-" :|: "-"\)|-\$\{(?:format|fmt|rupee|money)|["`]-₹/);
    }
  });

  it("no other dashboard file formats numbers with the locale formatter", () => {
    for (const f of ["app.js", "views.js", "palette.js", "motion.js", "snippets.js", "options.js", "pricing.js", "desk.js", "chain-sheet.js", "oi.js", "oi-store.js", "oi-series.js", "strategy.js", "strategy-place.js", "payoff.js", "positions.js", "vol.js", "vol-curves.js", "arbitrage.js", "screener.js", "screens.js", "viz.js", "reference.js", "calendar.js"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/Intl\.NumberFormat|\.toLocaleString\(|toLocaleTimeString|toFixed\(/);
      expect(src, f).not.toMatch(/₹\d{1,3},\d/);
    }
  });
});
