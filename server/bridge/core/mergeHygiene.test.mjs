/**
 * Duplicates that a hand merge leaves behind and that a later edit to one copy would silently lose to the other:
 * event topics, imports from one module in two lines, and option names in the CLI's parseArgs table.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TOPICS } from "./eventBus.mjs";

const root = resolve(import.meta.dirname, "../../..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const dupes = (list) => [...new Set(list.filter((x, i) => list.indexOf(x) !== i))];

describe("merge leftovers", () => {
  it("every event topic is listed once", () => {
    expect(dupes([...TOPICS])).toEqual([]);
  });

  it("the event bus doc block describes each topic once", () => {
    const doc = read("server/bridge/core/eventBus.mjs").split("export const TOPICS")[0];
    const names = [...doc.matchAll(/^ \*  ([a-z]+\.[a-z_]+(?:\|[a-z_]+)*)\s{2,}/gm)].map((m) => m[1]);
    expect(dupes(names)).toEqual([]);
  });

  it("app.mjs imports from one module in one line", () => {
    const froms = [...read("server/bridge/core/app.mjs").matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(dupes(froms)).toEqual([]);
  });

  it("the CLI's parseArgs table names each option once", () => {
    const src = read("bin/mc-bridge.mjs");
    const block = src.slice(src.indexOf("options: {"), src.indexOf("help: { type"));
    const keys = [...block.matchAll(/^\s+"?([\w-]+)"?: \{ type:/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(30);
    expect(dupes(keys)).toEqual([]);
  });
});
