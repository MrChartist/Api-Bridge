/**
 * Static proof of the import boundary. Plugin code and the plugin host are untrusted-adjacent: nothing that places an
 * order, checks safety, fills paper orders or holds broker credentials may import them, and they import none of it.
 * This scans the source tree; a new import across the boundary fails the build.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SERVER = resolve(import.meta.dirname, "../../..");
const PLUGIN_DIR = resolve(SERVER, "bridge/sources/plugin");
const ROOT = resolve(SERVER, "..");
const rel = (p) => relative(ROOT, p).split(sep).join("/");

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__fixtures__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(mjs|js)$/.test(name)) yield p;
  }
}

const isTest = (p) => /\.(test|spec)\.mjs$/.test(p);
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;

/** Every module specifier a file imports (static, dynamic with a literal, require). */
function specifiers(file) {
  const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...text.matchAll(SPEC)].map((m) => m[1]);
}

function resolveLocal(from, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.mjs`, `${base}.js`, join(base, "index.mjs")]) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      /* try the next */
    }
  }
  return base;
}

const inside = (p, dir) => p === dir || p.startsWith(dir + sep);

describe("the plugin import boundary", () => {
  const all = [...walk(SERVER)].filter((f) => !isTest(f));

  it("only the sources area and the CLI import anything from sources/plugin", () => {
    const allowed = (f) => inside(f, resolve(SERVER, "bridge/sources")) || f === resolve(SERVER, "bridge/core/cli.mjs");
    const offenders = [];
    for (const f of all) {
      if (inside(f, PLUGIN_DIR) || allowed(f)) continue;
      for (const s of specifiers(f)) {
        const target = resolveLocal(f, s);
        if (target && inside(target, PLUGIN_DIR)) offenders.push(`${rel(f)} imports ${s}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("order, safety, paper, account, broker, risk and alert code never import a plugin or the plugin host", () => {
    const guarded = ["bridge/orders", "bridge/safety", "bridge/paper", "bridge/accounts", "bridge/readiness", "bridge/hooks", "bridge/ratelimit", "brokers"].map((d) => resolve(SERVER, d));
    const offenders = [];
    for (const f of all) {
      if (!guarded.some((d) => inside(f, d))) continue;
      for (const s of specifiers(f)) {
        if (/sources\/plugin|plugin\/(host|loader|child|protocol|netbroker)/.test(s)) offenders.push(`${rel(f)} imports ${s}`);
        const target = resolveLocal(f, s);
        if (target && inside(target, PLUGIN_DIR)) offenders.push(`${rel(f)} resolves ${s} into the plugin host`);
      }
    }
    expect(offenders).toEqual([]);
    expect(all.filter((f) => guarded.some((d) => inside(f, d))).length).toBeGreaterThan(50); // the scan really looked at them
  });

  it("the plugin host imports no order, safety, paper, account, broker, secret or auth code (checked through every import, transitively)", () => {
    const start = [...walk(PLUGIN_DIR)].filter((f) => !isTest(f));
    const seen = new Set();
    const queue = [...start];
    while (queue.length) {
      const f = queue.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      for (const s of specifiers(f)) {
        if (s.startsWith("node:") || !s.startsWith(".")) {
          if (!s.startsWith("node:") && s !== "zod") throw new Error(`${rel(f)} imports the package ${s}; the plugin host uses only Node and zod`);
          continue;
        }
        const t = resolveLocal(f, s);
        if (t && existsSync(t)) queue.push(t);
      }
    }
    const outside = [...seen].filter((f) => !inside(f, PLUGIN_DIR)).map(rel).sort();
    // The only code outside the plugin folder it may reach: the shared contract, the error taxonomy and (for
    // `plugins check`) the conformance harness, which itself imports only those two.
    expect(outside).toEqual(["server/bridge/core/errors.mjs", ...(existsSync(resolve(SERVER, "bridge/sources/conformance.mjs")) ? ["server/bridge/sources/conformance.mjs"] : []), "server/bridge/sources/contract.mjs"]);
  });

  it("the plugin runner imports only Node built-ins", () => {
    const specs = specifiers(join(PLUGIN_DIR, "child.mjs"));
    expect(specs.filter((s) => !s.startsWith("node:"))).toEqual([]);
  });

  it("nothing in the plugin folder spawns processes except the host, and nothing evaluates strings", () => {
    const files = [...walk(PLUGIN_DIR)].filter((f) => !isTest(f));
    const spawners = files.filter((f) => specifiers(f).some((s) => /^node:(child_process|worker_threads|vm|cluster)$/.test(s))).map((f) => f.split(sep).at(-1));
    expect(spawners).toEqual(["host.mjs"]);
    for (const f of files) expect(readFileSync(f, "utf8"), rel(f)).not.toMatch(/\beval\s*\(|new Function\s*\(/);
  });

  it("the loader never gives a plugin an account: provider calls take symbols, intervals and underlyings only", () => {
    const src = readFileSync(join(PLUGIN_DIR, "loader.mjs"), "utf8");
    expect(src).not.toMatch(/accountId|accounts\./);
  });
});
