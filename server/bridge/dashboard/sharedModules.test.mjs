/**
 * Shared dashboard modules (docs/spec/README.md §3.1 and §3.2): pure maths used by pages AND by the server (alerts,
 * guards, strategy, margin). Each one must stay importable from Node without a browser:
 *  - imports only other shared modules (relative "./x.js");
 *  - no DOM (document, window, navigator, storage, animation frames), no fetch, no clock (Date.now, new Date());
 *    time and prices come in as arguments;
 *  - listed in DASHBOARD_FILES (core/app.mjs), so pages can load it.
 * A module enters this list in the step that creates it (README §3.2 owners); until then its row is skipped.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DASHBOARD_FILES } from "../core/app.mjs";
import { scanJs } from "./copyRules.mjs";

/** file -> the step that creates it (README §3.2). */
export const SHARED_MODULES = Object.freeze({
  "pricing.js": "P1-3a",
  "oi-series.js": "P1-1a",
  "ts-chart.js": "P1-3c",
  "marks.js": "P1-11a",
  "scenario.js": "P1-9a",
  "margin-core.js": "P1-10a",
  "expiry-costs.js": "P1-6a",
  "span-margin.js": "paper-margin",
  "guard-core.js": "P1-12a",
  "book-core.js": "P1-13b",
});

/** ts-chart.js draws SVG, so it may use the DOM; it still may not fetch or read the clock. */
const DOM_ALLOWED = new Set(["ts-chart.js"]);

const FORBIDDEN = [
  { what: "DOM", re: /\b(document|window|navigator|localStorage|sessionStorage|requestAnimationFrame|customElements|HTMLElement)\b/ },
  { what: "fetch", re: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b/ },
  { what: "clock", re: /\bDate\.now\s*\(|\bnew Date\s*\(\s*\)|\bperformance\.now\s*\(/ },
];

/** Problems in one shared module's source (exported for this test's own checks). */
export function sharedModuleProblems(name, src) {
  const problems = [];
  // Strings stay in `code`, so blank them out before looking for forbidden identifiers.
  const { code } = scanJs(src);
  const bare = code.replace(/(["'])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
  // import ... from, bare import, import(), and re-exports (export { x } from / export * from) all load a module.
  const IMPORT_RE = /\bimport\s*(?:[\w$*{}\s,]+from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\bexport\s*[\w$*{}\s,]*\bfrom\s*["']([^"']+)["']/g;
  for (const m of code.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    const sibling = /^\.\/([\w.-]+\.js)$/.exec(spec)?.[1];
    if (!sibling || !Object.hasOwn(SHARED_MODULES, sibling)) problems.push(`imports ${spec}`);
  }
  // Import specifiers were checked above; look for forbidden names in the code with strings blanked.
  for (const { what, re } of FORBIDDEN) {
    if (what === "DOM" && DOM_ALLOWED.has(name)) continue;
    if (re.test(bare)) problems.push(`uses ${what}`);
  }
  return problems;
}

describe("shared module rules", () => {
  it("flags non-sibling imports, DOM, fetch and clock use; allows sibling shared imports", () => {
    expect(sharedModuleProblems("marks.js", 'import { black76 } from "./pricing.js";\nexport const f = (now) => now + 1;')).toEqual([]);
    expect(sharedModuleProblems("marks.js", 'import { formatInt } from "./format.js";')).toEqual(["imports ./format.js"]);
    expect(sharedModuleProblems("marks.js", 'import x from "node:fs";')).toEqual(["imports node:fs"]);
    expect(sharedModuleProblems("marks.js", 'export { formatInt } from "./format.js";')).toEqual(["imports ./format.js"]);
    expect(sharedModuleProblems("marks.js", 'export * from "node:fs";')).toEqual(["imports node:fs"]);
    expect(sharedModuleProblems("marks.js", 'export * as p from "./pricing.js";\nexport { black76 as b } from "./pricing.js";')).toEqual([]);
    expect(sharedModuleProblems("marks.js", "const el = document.createElement('div');")).toEqual(["uses DOM"]);
    expect(sharedModuleProblems("marks.js", "await fetch('/v1/x');")).toEqual(["uses fetch"]);
    expect(sharedModuleProblems("marks.js", "const t = Date.now();")).toEqual(["uses clock"]);
    expect(sharedModuleProblems("marks.js", "// Date.now() in a comment\nconst s = 'window';")).toEqual([]);
    expect(sharedModuleProblems("ts-chart.js", "document.createElementNS(ns, 'svg');")).toEqual([]);
  });
});

describe("shared dashboard modules", () => {
  for (const [name, step] of Object.entries(SHARED_MODULES)) {
    const url = new URL(`./${name}`, import.meta.url);
    it.skipIf(!existsSync(url))(`${name} (${step}) is pure and served`, () => {
      expect(sharedModuleProblems(name, readFileSync(url, "utf8"))).toEqual([]);
      expect(Object.hasOwn(DASHBOARD_FILES, name), `${name} must be in DASHBOARD_FILES`).toBe(true);
    });
  }
});
