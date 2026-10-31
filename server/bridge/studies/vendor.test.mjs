/**
 * The vendored ChartistScript core (server/vendor/chartist-core): it loads as plain ES modules, it is exactly what
 * scripts/vendor-chartist-core.mjs produced (every file matches the sha256 in VENDOR.json, so a hand edit fails here),
 * it keeps the owner's copyright and provenance files, it names its source commit, and it imports nothing outside
 * itself. When a scanner checkout is at hand (CHARTIST_SCANNER_DIR, or ../scanner), the copy is also rebuilt and compared.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const VENDOR = join(ROOT, "server/vendor/chartist-core");
/** The scanner checkout to rebuild from: CHARTIST_SCANNER_DIR, or ../scanner next to this repository. */
const SCANNER = resolve(process.env.CHARTIST_SCANNER_DIR ?? resolve(ROOT, "../scanner"));
const LOCK = JSON.parse(readFileSync(join(VENDOR, "VENDOR.json"), "utf8"));

const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const files = walk(VENDOR);
const rel = (f) => relative(VENDOR, f).split("\\").join("/");
const SPEC_RE = /^\s*(?:import|export)\b[^;'"]*?\bfrom\s*(['"])([^'"\n]+)\1|^\s*import\s*(['"])([^'"\n]+)\3/gm;

describe("vendored ChartistScript core", () => {
  it("loads, with its public entry, kernel and convert entries", async () => {
    const core = await import("../../vendor/chartist-core/index.js");
    expect(typeof core.compileSource).toBe("function");
    expect(typeof core.runIndicator).toBe("function");
    expect(core.STDLIB_VERSION).toMatch(/^1\.0\.0/);
    expect(core.FUNCTIONS.filter((f) => f.name.startsWith("ind."))).toHaveLength(88);
    expect(core.PATTERN_IDS).toHaveLength(24);
    const kernel = await import("../../vendor/chartist-core/kernel/index.js");
    expect(typeof kernel.calcSuperTrend).toBe("function");
    const convert = await import("../../vendor/chartist-core/convert/index.js");
    expect(typeof convert.convert).toBe("function");
  });

  it("every file matches VENDOR.json (nothing edited by hand, nothing added or missing)", () => {
    const listed = Object.keys(LOCK.files).sort();
    const present = files.map(rel).filter((f) => f !== "VENDOR.json").sort();
    expect(present).toEqual(listed);
    for (const f of files) {
      const r = rel(f);
      if (r === "VENDOR.json") continue;
      expect(createHash("sha256").update(readFileSync(f)).digest("hex"), r).toBe(LOCK.files[r]);
    }
  });

  it("keeps the owner's copyright, provenance and notices, and says where it came from", () => {
    for (const f of ["COPYRIGHT", "PROVENANCE.md", "THIRD_PARTY_NOTICES.md", "VENDORED.md"]) expect(existsSync(join(VENDOR, f)), f).toBe(true);
    expect(readFileSync(join(VENDOR, "COPYRIGHT"), "utf8")).toMatch(/All rights reserved/);
    expect(LOCK.source).toMatchObject({ repo: "MrChartist/scanner", path: "packages/chartist-core", dirty: false });
    expect(LOCK.source.commit).toMatch(/^c2ac504/);
    const note = readFileSync(join(VENDOR, "VENDORED.md"), "utf8");
    expect(note).toContain("c2ac504");
    expect(note).toMatch(/not\*\* covered by this repository's MIT LICENSE/);
    expect(JSON.parse(readFileSync(join(VENDOR, "package.json"), "utf8"))).toMatchObject({ private: true, license: "UNLICENSED", type: "module" });
  });

  it("imports only its own files, each by its full name; no eval, no network, no process", () => {
    const js = files.filter((f) => f.endsWith(".js"));
    expect(js.length).toBeGreaterThan(100);
    for (const f of js) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(SPEC_RE)) {
        const spec = m[2] ?? m[4];
        expect(spec.startsWith("./") || spec.startsWith("../"), `${rel(f)}: ${spec}`).toBe(true);
        expect(spec, rel(f)).toMatch(/\.js$/);
        expect(existsSync(resolve(f, "..", spec)), `${rel(f)}: ${spec}`).toBe(true);
        expect(resolve(f, "..", spec).startsWith(VENDOR), `${rel(f)}: ${spec}`).toBe(true);
      }
      // Calls only (`import(`, no space): comments such as "Script import (2026-10-25)" are prose.
      expect(text, rel(f)).not.toMatch(/(^|[^\w.])import\(|\brequire\(|\beval\(|new Function\(|\bfetch\(|process\.env/);
    }
  });

  it.runIf(existsSync(join(SCANNER, "packages/chartist-core/src/index.ts")))("rebuilding from the scanner checkout gives the same files (when it is at the vendored commit)", () => {
    const scanner = SCANNER;
    const head = execFileSync("git", ["-C", scanner, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (head !== LOCK.source.commit) return; // another commit: a rebuild would differ on purpose
    const out = execFileSync(process.execPath, [join(ROOT, "scripts/vendor-chartist-core.mjs"), "--core", scanner, "--check"], { encoding: "utf8" });
    expect(out).toMatch(/matches/);
  });
});
