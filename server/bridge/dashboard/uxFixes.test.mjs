// Guards for the small layout and wording fixes from the UX audit that cannot be seen in the pure helpers.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("./", import.meta.url);
const css = readFileSync(new URL("app.css", dir), "utf8");

describe("toolbar on a phone", () => {
  it("no toolbar button can shrink below its touch target", () => {
    expect(css).toMatch(/\.toolbar button, \.toolbar \.toolbar-budget, \.toolbar \.toolbar-ready \{ flex: none; min-width: var\(--ctl-h\); \}/);
  });
  it("the budget capsule collapses to its dot on phones and gives way on the narrowest", () => {
    expect(css).toMatch(/@media \(max-width: 430px\) \{\s*\.toolbar-budget \.bud-num \{ position: absolute/);
    expect(css).toMatch(/@media \(max-width: 379px\) \{ \.toolbar-budget \{ display: none; \} \}/);
  });
});
