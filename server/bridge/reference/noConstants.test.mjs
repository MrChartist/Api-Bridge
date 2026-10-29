/**
 * No hard-coded reference constants (BRD P1-2 acceptance criterion 2; docs/spec/p1-02-reference.md §9.2). The rate, the
 * session times, the default brokerage and lot sizes come from the reference store (`deps.reference`, the dashboard's
 * reference bundle). Only these files may hold the S5 default literals:
 *  - reference/defaults.mjs (server) and dashboard/reference.js (the dashboard fallback, REF_DEFAULTS);
 *  - reference/data/* (the shipped tables) and __fixtures__ (parser fixtures);
 *  - tests.
 * Known exemptions, each with its reason:
 *  - server/brokers/*: adapters format broker request times; that is wire format, not policy (outside server/bridge
 *    anyway, listed so nobody widens the scan to it by accident);
 *  - server/lib/marketHours.mjs: legacy proxy code outside server/bridge (see p1-02 §9.2);
 *  - symbols/fake.mjs: the symbols test double's fixture contracts (a test fixture with lot sizes by design);
 *  - lot literals in demo/demoAdapter.mjs's demo underlying table (the one demo lot table besides DEMO_STOCK_LOT).
 * Prints file:line for each hit.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(here, "..");

/** [name, regex] — the BRD grep criterion. */
export const PATTERNS = [
  ["RISK_FREE", /\bRISK_FREE\b/],
  ["RATE = 0.0x", /\bRATE\s*=\s*0\.0\d+/],
  ["0.065", /0\.065\b/],
  ["brokeragePerOrder: n", /brokeragePerOrder\s*:\s*\d/],
  ['"09:15"', /["'`]0?9:15/],
  ['"15:30"', /["'`]15:30/],
  ["9 * 60 + 15", /9 \* 60 \+ 15/],
  ["15 * 60 + 30", /15 \* 60 \+ 30/],
  ["lot: nn", /\blot(Size)?\s*:\s*\d{2,}/],
  ["6.50 %", /\b6\.50?\s*%/],
];

/** Files (relative to server/bridge, "/" separated) that may hold the literals. */
const ALLOWED = [/^reference\/defaults\.mjs$/, /^reference\/data\//, /^dashboard\/reference\.js$/, /(^|\/)__fixtures__\//, /\.test\.m?js$/, /^symbols\/fake\.mjs$/];
/** Per-file exemptions for one pattern: the demo underlying table's lots. */
const PATTERN_EXEMPT = { "demo/demoAdapter.mjs": ["lot: nn"] };

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(mjs|js)$/.test(name) && !name.endsWith(".min.js")) out.push(p);
  }
  return out;
}

/** Hits in one source text: [{ line, pattern, text }]. Comment-only lines are skipped (they explain, not set). */
export function scanText(src, { skip = [] } = {}) {
  const hits = [];
  src.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    for (const [name, re] of PATTERNS) if (!skip.includes(name) && re.test(line)) hits.push({ line: i + 1, pattern: name, text: t.slice(0, 140) });
  });
  return hits;
}

describe("no reference constants outside the reference store (acceptance criterion 2)", () => {
  it("the patterns catch what they are meant to", () => {
    const src = ["export const RISK_FREE = 0.065;", "const RATE = 0.065;", "  brokeragePerOrder: 20,", 'const open = "09:15";', "const close = '15:30';", "const m = 15 * 60 + 30;", "{ lotSize: 75 }", "const note = `the pages use 6.50 % then`;", "// a comment about 0.065 and \"15:30\"", "const rate = 0.06;"].join("\n");
    expect(scanText(src).map((h) => h.pattern)).toEqual(["RISK_FREE", "0.065", "RATE = 0.0x", "0.065", "brokeragePerOrder: n", '"09:15"', '"15:30"', "15 * 60 + 30", "lot: nn", "6.50 %"]);
  });

  it("server/bridge holds none of them outside the allowed files", () => {
    const hits = [];
    for (const file of walk(BRIDGE)) {
      const rel = relative(BRIDGE, file).split(sep).join("/");
      if (ALLOWED.some((re) => re.test(rel))) continue;
      for (const h of scanText(readFileSync(file, "utf8"), { skip: PATTERN_EXEMPT[rel] ?? [] })) hits.push(`${rel}:${h.line} [${h.pattern}] ${h.text}`);
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });

  it("the allowed files still hold the defaults (so the fallback is labelled in one place)", () => {
    expect(readFileSync(join(BRIDGE, "reference/defaults.mjs"), "utf8")).toMatch(/DEFAULT_RATE = 0\.065/);
    expect(readFileSync(join(BRIDGE, "dashboard/reference.js"), "utf8")).toMatch(/REF_DEFAULTS = Object\.freeze/);
  });
});
