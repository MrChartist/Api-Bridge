/**
 * Broker facts come only from each broker's official documentation, SDKs and Postman collections. This test keeps
 * names of third-party projects out of the repository (code, comments, docs, fixtures and scripts).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const SKIP_DIRS = new Set(["node_modules", ".git", "coverage", ".cache", "data", "build", "__pycache__", "screenshots"]);
const TEXT = /\.(mjs|js|ts|json|md|yaml|yml|py|afl|gs|html|css|txt|toml|bat|command|ya?ml)$|^(Dockerfile|LICENSE)$/;
// Built from pieces so this file does not match itself.
const BANNED = new RegExp(["open" + "algo", "open " + "algo", "market" + "calls", "AG" + "PL"].join("|"), "i");

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* files(p);
    else if (TEXT.test(name) && st.size < 5_000_000) yield p;
  }
}

describe("sources", () => {
  it("names no third-party broker-integration project anywhere in the repository", () => {
    const hits = [];
    for (const p of files(ROOT)) {
      if (p === import.meta.filename) continue;
      const text = readFileSync(p, "utf8");
      if (BANNED.test(text)) hits.push(p.slice(ROOT.length + 1));
    }
    expect(hits).toEqual([]);
  });
});
