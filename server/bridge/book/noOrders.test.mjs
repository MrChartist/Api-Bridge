/**
 * The book reads; it never trades (docs/spec/p1-12-guard-participants.md §2.2 rules, §10.1 noOrders). book/* never
 * imports orderService internals, the order gate, an adapter or the paper engine, and never calls place, modify or
 * cancel. The one exception is demoBook.mjs, which seeds the demo paper book through the public orders.place (the
 * same path a person's paper order takes) and runs only in demo mode.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = new URL("./", import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));

describe("book never places, modifies or cancels orders", () => {
  it("has source files to check", () => {
    expect(files).toEqual(expect.arrayContaining(["bookService.mjs", "family.mjs", "routes.mjs", "pricing.mjs", "holderStore.mjs", "module.mjs"]));
  });
  for (const f of files) {
    it(f, () => {
      const src = readFileSync(new URL(f, DIR), "utf8");
      expect(src).not.toMatch(/orders\/orderService\.mjs|brokers\/orderGate\.mjs|\.\.\/paper\/|\/brokers\//);
      const calls = [...src.matchAll(/\.(place|modify|cancel|cancelAll)\s*\(/g)].map((m) => m[1]);
      if (f === "demoBook.mjs") {
        expect(calls).toEqual(["place"]);
        expect(src).toMatch(/mode: "paper"/);
      } else expect(calls).toEqual([]);
    });
  }
});
