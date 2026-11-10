/**
 * Every relative link in the guides, the docs home and the READMEs points at a file that exists, and every `#anchor` at a
 * heading that exists (GitHub's way of turning a heading into an anchor). The guides send people to each other a lot,
 * and the troubleshooting page and the FAQ link into other guides' headings, so a renamed heading must not go unnoticed.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, readText, repoFiles } from "./lib/repo-files.mjs";

const files = repoFiles().filter((f) => /^(docs\/guides\/[^/]+|docs\/README|README|integrations\/[^/]+\/README|sdk\/(node|python)\/README)\.md$/.test(f));

/** GitHub's anchor for a heading: lower case, no punctuation except `-` and `_`, spaces to hyphens. */
export const slug = (h) => h.trim().toLowerCase().replace(/`/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

function anchorsOf(text) {
  const out = new Set();
  let fence = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) fence = !fence;
    if (fence) continue;
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (m) out.add(slug(m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")));
  }
  return out;
}

describe("links in the guides", () => {
  it("the anchor rule matches GitHub's for the headings these guides use", () => {
    expect(slug("SYMBOL_NOT_FOUND (404, or an entry in `errors[]`)")).toBe("symbol_not_found-404-or-an-entry-in-errors");
    expect(slug("3. Sessions")).toBe("3-sessions");
    expect(slug("Running mc-bridge")).toBe("running-mc-bridge");
  });

  it("every relative link and anchor resolves", () => {
    const bad = [];
    for (const f of files) {
      const text = readText(f) ?? "";
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const href = m[1];
        if (/^(https?:|mailto:)/.test(href) || href === "#") continue;
        const [path, frag] = href.split("#");
        const target = path ? resolve(dirname(join(ROOT, f)), path) : join(ROOT, f);
        if (!existsSync(target)) {
          bad.push(`${f}: ${href} (no such file)`);
          continue;
        }
        if (frag && target.endsWith(".md") && statSync(target).isFile()) {
          const rel = target.slice(ROOT.length + 1).split("\\").join("/");
          if (!anchorsOf(readText(rel) ?? "").has(frag)) bad.push(`${f}: ${href} (no such heading)`);
        }
      }
    }
    expect(bad).toEqual([]);
    expect(files.length).toBeGreaterThan(30);
  });
});
