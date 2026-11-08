/**
 * A lint-style test. `purpose` defaults to "display" in the market service, which is right for the public market routes
 * and wrong for code that prices an order, a paper fill, a risk check or an alert: such a read may come back as a
 * labelled-stale cached value. So INTERNAL callers must state their purpose. This scans the order, paper, safety and compat
 * code for market-data calls that do not, so a new call cannot slip in with the default.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const BRIDGE = resolve(import.meta.dirname, "..");
const SCANNED = ["orders", "paper", "safety", "compat"];
const METHODS = "ltp|quotes|depth|history|expiries|optionChain";
const CALL = new RegExp(`\\bmarketData\\s*\\??\\.\\s*(${METHODS})\\s*\\(`, "g");

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__fixtures__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(mjs|js)$/.test(name) && !/\.(test|spec)\.mjs$/.test(name)) yield p;
  }
}

/** The text between the parentheses of the call that opens at `open`, balanced (strings with parentheses are rare here). */
function argsAt(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth += 1;
    else if (c === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** Does the file define a helper `name` whose body states a purpose? (e.g. `const readOpts = (ctx) => ({ ..., purpose: ... })`) */
const helperStatesPurpose = (text, name) => new RegExp(`(?:const|let|function)\\s+${name}\\b[\\s\\S]{0,700}?\\bpurpose\\b`).test(text);

/** Calls in `text` that do not state a purpose: the method and the line. */
export function callsWithoutPurpose(text) {
  const bare = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:])\/\/.*$/gm, (m, a) => a + " ".repeat(m.length - a.length));
  const out = [];
  for (const m of bare.matchAll(CALL)) {
    const args = argsAt(bare, m.index + m[0].length - 1);
    if (/\bpurpose\b/.test(args)) continue;
    const helpers = [...args.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((h) => h[1]);
    if (helpers.some((h) => helperStatesPurpose(bare, h))) continue;
    out.push({ method: m[1], line: bare.slice(0, m.index).split("\n").length });
  }
  return out;
}

describe("market-data calls from internal code state their purpose", () => {
  it("the scanner itself sees a call without purpose, and accepts a direct purpose or a helper that sets one", () => {
    expect(callsWithoutPurpose("await deps.marketData.ltp([s], { maxAgeMs: 1 });")).toEqual([{ method: "ltp", line: 1 }]);
    expect(callsWithoutPurpose("await deps.marketData.quotes(list, readOpts(ctx));\nconst readOpts = (c) => ({ purpose: 'display' });")).toEqual([]);
    expect(callsWithoutPurpose("await deps.marketData.quotes(list, readOpts(ctx));\nconst readOpts = (c) => ({ signal: c.signal });")).toEqual([{ method: "quotes", line: 1 }]);
    expect(callsWithoutPurpose("await deps.marketData.depth(s, { priority: 'live', purpose: 'order' });")).toEqual([]);
    expect(callsWithoutPurpose("// deps.marketData.ltp([s], {})\n/* marketData.ltp([s]) */")).toEqual([]);
    expect(callsWithoutPurpose("await deps.marketData.optionChain(p, o)")).toEqual([{ method: "optionChain", line: 1 }]);
  });

  it("finds the call sites it is meant to guard (the scan is not vacuous)", () => {
    let calls = 0;
    for (const dir of SCANNED) for (const f of walk(join(BRIDGE, dir))) calls += [...readFileSync(f, "utf8").matchAll(CALL)].length;
    expect(calls).toBeGreaterThanOrEqual(10);
  });

  for (const dir of SCANNED) {
    it(`server/bridge/${dir} has no market-data call without a purpose`, () => {
      const offenders = [];
      for (const f of walk(join(BRIDGE, dir))) {
        for (const c of callsWithoutPurpose(readFileSync(f, "utf8"))) offenders.push(`${relative(BRIDGE, f).split(sep).join("/")}:${c.line} marketData.${c.method}()`);
      }
      expect(offenders).toEqual([]);
    });
  }
});
