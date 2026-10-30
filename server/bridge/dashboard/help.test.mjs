import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PAGE_CODES } from "./workspace.js";
import { PAGE_HELP, helpFor } from "./help.js";

describe("page help", () => {
  it("has an entry for every page code and none for pages that do not exist", () => {
    expect(Object.keys(PAGE_HELP).sort()).toEqual(Object.keys(PAGE_CODES).sort());
  });
  it("every entry says what the page is, explains its fields and names a guide", () => {
    for (const [id, h] of Object.entries(PAGE_HELP)) {
      expect(h.what.length, id).toBeGreaterThan(20);
      expect(h.fields.length, id).toBeGreaterThan(0);
      for (const [k, v] of h.fields) expect([k.length > 0, v.length > 5], id).toEqual([true, true]);
      expect(h.doc, id).toMatch(/^docs\/guides\/[A-Za-z-]+\.md$/);
      expect(existsSync(resolve(import.meta.dirname, "../../..", h.doc)), `${id}: ${h.doc} exists`).toBe(true);
    }
  });
  it("every analytics page links to the analytics guide", () => {
    for (const id of ["chain", "oi", "gex", "skew", "payoff", "futures", "tide", "exposure", "screener"]) expect(PAGE_HELP[id].doc).toBe("docs/guides/analytics.md");
  });
  it("is plain text only and looks up safely", () => {
    expect(JSON.stringify(PAGE_HELP)).not.toMatch(/<[a-z]/i);
    expect(helpFor("chain")).toBe(PAGE_HELP.chain);
    expect(helpFor("constructor")).toBeNull();
    expect(helpFor("__proto__")).toBeNull();
  });
});
