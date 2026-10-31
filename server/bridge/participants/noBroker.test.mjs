/** participants/* makes no broker call and has no order path (docs/spec/p1-12-guard-participants.md §2.2 rules). */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = import.meta.dirname;
const files = readdirSync(dir).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));

describe("participants never reaches a broker or the order path", () => {
  it.each(files)("%s", (f) => {
    const src = readFileSync(join(dir, f), "utf8");
    expect(src).not.toMatch(/from "\.\.\/(orders|paper|brokers|accounts|market|stream|safety)\//);
    expect(src).not.toMatch(/\.(place|modify|cancel|cancelAll)\(/);
    expect(src).not.toMatch(/\bfetch\(/);
  });
});
