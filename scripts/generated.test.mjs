/**
 * The generated developer files (per-endpoint pages, llms files, search index) must match what the
 * generators write from docs/openapi.yaml and the guides, and must hold their promises: one request and one page per
 * operation, no real keys, paper-mode order examples, links that resolve, the llms.txt layout.
 *
 * When this fails after you changed docs/openapi.yaml or a guide: run `npm run docs:generate` and commit the result.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OWNED, buildDocs, guideRows } from "./gen-docs-index.mjs";
import { helperMethods, pagePath } from "./lib/endpoint-docs.mjs";
import { REPO_ROOT, isCallable, loadSpec, operations } from "./lib/openapi-model.mjs";
import { syncOutputs } from "./lib/outputs.mjs";

const spec = loadSpec();
const ops = operations(spec);
const callable = ops.filter(isCallable);
const docs = buildDocs(REPO_ROOT, spec);
const all = docs;

const stale = (files, owned) => {
  const r = syncOutputs(REPO_ROOT, files, { owned, check: true });
  return [...r.changed.map((f) => `differs: ${f}`), ...r.removed.map((f) => `stale: ${f}`)];
};

describe("generated files are in sync", () => {
  it("docs/api, llms.txt, llms-full.txt and search-index.json match scripts/gen-docs-index.mjs (run: npm run docs:generate)", () => {
    expect(stale(docs, OWNED)).toEqual([]);
  });

  it("the generators are deterministic", () => {
    expect([...buildDocs(REPO_ROOT, loadSpec())]).toEqual([...docs]);
  });

  it("no generated file holds a timestamp, a machine path or a key that looks real", () => {
    for (const [path, text] of all) {
      expect(text, path).not.toMatch(/"generatedAt"\s*:|Generated on|\/home\/user|\/tmp\/claude/);
      expect(text, path).not.toMatch(/mcb_[a-z0-9]{8,}_[A-Za-z0-9]{12,}/);
    }
  });
});

describe("examples", () => {
  it("orders are paper in every example and no example asks for live", () => {
    const orderOps = callable.filter((o) => ["placeOrder", "previewOrder", "cancelAllOrders", "compatPlaceorder"].includes(o.id));
    expect(orderOps.length).toBe(4);
    // Only request bodies: the descriptions legitimately explain what `"mode": "live"` does.
    const bodies = [...all].filter(([k]) => k.startsWith("docs/api/")).flatMap(([, t]) => [...t.matchAll(/^ {2}-d '(.*)'$/gm)].map((m) => m[1]));
    expect(bodies.length).toBeGreaterThan(50);
    for (const b of bodies) expect(b).not.toMatch(/"mode":\s*"live"/);
    for (const id of ["placeOrder", "previewOrder"]) {
      const page = all.get(`docs/api/orders/${id}.md`);
      expect(page).toMatch(/"account": ?"demo-paper"/);
      expect(page).toMatch(/"mode": ?"paper"/);
    }
  });
});

describe("per-endpoint pages", () => {
  it("has a page for every operation, and nothing else besides the index and the error list", () => {
    const pages = [...docs.keys()].filter((k) => k.startsWith("docs/api/"));
    expect(pages.sort()).toEqual([...ops.map(pagePath), "docs/api/README.md", "docs/api/errors.md"].sort());
    expect(ops.length).toBeGreaterThan(100);
  });

  it("each page names its operation, scope and loopback flag, and the index links every page", () => {
    const index = docs.get("docs/api/README.md");
    for (const op of ops) {
      const text = docs.get(pagePath(op));
      expect(text, op.id).toContain(`\`${op.method} ${op.path}\``);
      expect(text, op.id).toContain(`| Operation | \`${op.id}\` |`);
      expect(text, op.id).toContain(`| This computer only | ${op.loopbackOnly ? "yes" : "no"} |`);
      if (op.scope) expect(text, op.id).toContain(`| Scope | \`${op.scope}\` |`);
      expect(text, op.id).toContain("```python");
      if (!op.websocket) expect(text, op.id).toContain("```bash");
      expect(index, op.id).toContain(`(${pagePath(op).replace("docs/api/", "")})`);
    }
  });

  it("the Python examples use SDK methods that exist", () => {
    const client = readFileSync(join(REPO_ROOT, "sdk/python/mrchartist_bridge/client.py"), "utf8");
    const defined = new Set([...client.matchAll(/^\s+def (\w+)\(/gm)].map((m) => m[1]));
    expect(helperMethods().filter((m) => !defined.has(m))).toEqual([]);
  });

  it("the error page lists every error code", async () => {
    const { ERROR_CODES } = await import("../server/bridge/core/errors.mjs");
    const text = docs.get("docs/api/errors.md");
    for (const c of Object.keys(ERROR_CODES)) expect(text).toContain(`| \`${c}\` |`);
  });
});

const githubSlug = (h) => h.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");

describe("links in the generated and navigation pages resolve", () => {
  const markdown = new Map();
  for (const [k, v] of all) if (k.endsWith(".md")) markdown.set(k, v);
  for (const k of ["docs/README.md", "docs/guides/README.md", "README.md"]) markdown.set(k, readFileSync(join(REPO_ROOT, k), "utf8"));

  const textOf = (rel) => (all.has(rel) ? all.get(rel) : existsSync(join(REPO_ROOT, rel)) ? readFileSync(join(REPO_ROOT, rel), "utf8") : null);

  it("every relative link points to a file (and a heading when it has an anchor)", () => {
    const problems = [];
    for (const [file, text] of markdown) {
      const body = text.replace(/```[\s\S]*?```/g, "");
      for (const m of body.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("mailto:")) continue;
        const [pathPart, anchor] = target.split("#");
        const rel = pathPart ? resolve("/", dirname(file), pathPart).slice(1) : file;
        const dest = textOf(rel);
        if (dest === null && !existsSync(join(REPO_ROOT, rel))) {
          problems.push(`${file}: ${target} -> missing ${rel}`);
          continue;
        }
        if (anchor && rel.endsWith(".md") && dest !== null) {
          const slugs = [...dest.replace(/```[\s\S]*?```/g, "").matchAll(/^#{1,6} (.+)$/gm)].map((h) => githubSlug(h[1].replace(/`/g, "")));
          if (!slugs.includes(anchor)) problems.push(`${file}: ${target} -> no heading #${anchor} in ${rel}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("llms.txt and the search index", () => {
  const llms = docs.get("docs/llms.txt");
  const lines = llms.split("\n");

  it("follows the llms.txt layout: H1, a blockquote summary, then H2 sections of `- [name](url)` links, Optional last", () => {
    expect(lines[0]).toMatch(/^# \S/);
    expect(lines.filter((l) => /^# /.test(l))).toHaveLength(1);
    expect(lines[2]).toMatch(/^> \S/);
    expect(lines.some((l) => /^#{3,} /.test(l))).toBe(false);
    const h2 = lines.filter((l) => /^## /.test(l));
    expect(h2.at(-1)).toBe("## Optional");
    expect(h2).toEqual(expect.arrayContaining(["## Start here", "## API reference", "## Guides"]));
    let inList = false;
    for (const l of lines.slice(lines.findIndex((x) => x.startsWith("## ")))) {
      if (l.startsWith("## ")) inList = true;
      else if (inList && l.trim()) expect(l).toMatch(/^- \[[^\]]+\]\(https:\/\/[^)\s]+\)(: .+)?$/);
    }
  });

  it("every link points at a file in this repository, every guide is listed, and the key facts match the spec", () => {
    const raw = "https://raw.githubusercontent.com/MrChartist/api-bridge-v2/main/";
    for (const m of llms.matchAll(/\]\((https:\/\/raw\.githubusercontent\.com\/[^)]+)\)/g)) {
      expect(m[1].startsWith(raw), m[1]).toBe(true);
      const rel = m[1].slice(raw.length);
      expect(existsSync(join(REPO_ROOT, rel)) || all.has(rel), rel).toBe(true);
    }
    for (const g of guideRows(REPO_ROOT)) expect(llms).toContain(`docs/guides/${g.file})`);
    expect(llms).toContain(`all ${ops.length} operations`);
    expect(llms).toContain(spec.servers[0].url);
  });

  it("llms-full.txt holds the API overview and every guide", () => {
    const full = docs.get("docs/llms-full.txt");
    expect(full).toContain("## API overview");
    for (const g of guideRows(REPO_ROOT)) expect(full).toContain(`<!-- docs/guides/${g.file} -->`);
    expect(full.length).toBeLessThan(700_000); // grows with the guides, and with the generated settings reference (about 70 KB)
  });

  it("the search index lists every page with title, path, headings and a short text", () => {
    const { pages } = JSON.parse(docs.get("docs/search-index.json"));
    const paths = pages.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect([...paths].sort()).toEqual(paths);
    for (const p of pages) {
      expect(Object.keys(p).sort()).toEqual(["headings", "kind", "path", "text", "title"]);
      expect(p.title.length, p.path).toBeGreaterThan(0);
      expect(p.text.length, p.path).toBeLessThanOrEqual(283);
      expect(existsSync(join(REPO_ROOT, p.path)) || all.has(p.path), p.path).toBe(true);
    }
    expect(pages.filter((p) => p.kind === "endpoint")).toHaveLength(ops.length);
    for (const need of ["docs/README.md", "docs/guides/quickstart.md", "docs/guides/safety.md", "docs/api/errors.md"]) expect(paths).toContain(need);
    expect(docs.get("docs/search-index.json").length).toBeLessThan(200_000);
  });
});
