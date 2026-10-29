/**
 * pricing.js is the one pricing core shared by the browser and the server (docs/spec/p1-03-pricing-vol.md §9.1,
 * README §3.2): no imports, no DOM or fetch, no session literals or ACT/365 arithmetic outside the calendar-mode
 * function, importable in Node, served to the dashboard, and re-exported by options.js as the same function objects.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DASHBOARD_FILES } from "../core/app.mjs";
import { scanJs } from "./copyRules.mjs";
import * as O from "./options.js";
import * as P from "./pricing.js";

const SRC = readFileSync(new URL("./pricing.js", import.meta.url), "utf8");
const { code } = scanJs(SRC);

/** The source with the calendar-mode function (the one place ACT/365 lives) cut out. */
function outsideCalendar(src) {
  const start = src.indexOf("export function calendarYearDays(");
  const end = src.indexOf("\n}\n", start);
  return start < 0 ? src : src.slice(0, start) + src.slice(end + 3);
}

describe("pricing.js is pure and shared", () => {
  it("has no import and no DOM, fetch or clock", () => {
    expect(code).not.toMatch(/\bimport\b/);
    expect(code).not.toMatch(/\b(document|window|navigator|localStorage|fetch|XMLHttpRequest)\b/);
    expect(code).not.toMatch(/\bDate\.now\s*\(|\bnew Date\s*\(\s*\)/);
  });

  it("holds no session times, rate literal or ACT/365 arithmetic outside the calendar-mode function", () => {
    expect(SRC).not.toMatch(/"09:15"|"15:30"|'09:15'|'15:30'/);
    expect(SRC).not.toMatch(/0\.065/);
    // Comments may mention ACT/365; code may not, except inside calendarYearDays().
    const rest = scanJs(outsideCalendar(SRC)).code;
    expect(rest).not.toMatch(/365\s*\*|\/\s*365\b|\b365\b/);
    expect(code.match(/\b365\b/g) ?? []).toHaveLength(1);
  });

  it("imports cleanly in Node and is served to the dashboard", () => {
    expect(typeof P.volTime).toBe("function");
    expect(Object.hasOwn(DASHBOARD_FILES, "pricing.js")).toBe(true);
  });

  it("options.js re-exports the moved names as the same function objects", () => {
    for (const name of ["normCdf", "black76", "probItm", "sigmaMove", "impliedVol", "impliedVolB76", "b76Delta", "legPrice", "atmIvAt", "ivAtDelta", "skewMetrics", "realisedVol"]) {
      expect(O[name], name).toBe(P[name]);
    }
  });
});
