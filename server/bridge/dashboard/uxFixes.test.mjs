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

describe("the palette knows the new features", () => {
  const palette = readFileSync(new URL("palette.js", dir), "utf8");
  const dataPage = readFileSync(new URL("data-page.js", dir), "utf8");
  const developers = readFileSync(new URL("developers.js", dir), "utf8");
  it("has an action for each, and the page they open understands the link", () => {
    for (const [id, link] of [["new-download", "data/downloads?new=1"], ["record-chains", "data/recordings?preset=index-chains"], ["workbook", "downloadWorkbook"], ["receiver", "developers?view=events&add=1"]]) {
      expect(palette).toContain(`id: "${id}"`);
      expect(palette).toContain(link);
    }
    expect(dataPage).toContain('pending.get("new")');
    expect(dataPage).toContain('.get("preset")');
    expect(developers).toContain('hashParams().get("add")');
  });
  it("finds order events and describes each tab", () => {
    expect(palette).toMatch(/keywords: "webhook events order events/);
    expect(palette).toContain("`${p.label} › ${t.label}: ${t.sub}`");
  });
});
