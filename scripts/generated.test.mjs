/**
 * The generated developer files (collections, per-endpoint pages, llms files, search index) must match what the
 * generators write from docs/openapi.yaml and the guides, and must hold their promises: one request and one page per
 * operation, no real keys, paper-mode order examples, links that resolve, the llms.txt layout.
 *
 * When this fails after you changed docs/openapi.yaml or a guide: run `npm run docs:generate` and commit the result.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCollections } from "./gen-collections.mjs";
import { OWNED, buildDocs, guideRows } from "./gen-docs-index.mjs";
import { helperMethods, pagePath } from "./lib/endpoint-docs.mjs";
import { REPO_ROOT, isCallable, loadSpec, operations } from "./lib/openapi-model.mjs";
import { syncOutputs } from "./lib/outputs.mjs";

const spec = loadSpec();
const ops = operations(spec);
const callable = ops.filter(isCallable);
const collections = buildCollections(spec);
const docs = buildDocs(REPO_ROOT, spec);
const all = new Map([...collections, ...docs]);

const stale = (files, owned) => {
  const r = syncOutputs(REPO_ROOT, files, { owned, check: true });
  return [...r.changed.map((f) => `differs: ${f}`), ...r.removed.map((f) => `stale: ${f}`)];
};

describe("generated files are in sync", () => {
  it("docs/collections matches scripts/gen-collections.mjs (run: npm run docs:generate)", () => {
    expect(stale(collections, ["docs/collections"])).toEqual([]);
  });

  it("docs/api, llms.txt, llms-full.txt and search-index.json match scripts/gen-docs-index.mjs (run: npm run docs:generate)", () => {
    expect(stale(docs, OWNED)).toEqual([]);
  });

  it("the generators are deterministic", () => {
    expect([...buildCollections(loadSpec())]).toEqual([...collections]);
    expect([...buildDocs(REPO_ROOT, loadSpec())]).toEqual([...docs]);
  });

  it("no generated file holds a timestamp, a machine path or a key that looks real", () => {
    for (const [path, text] of all) {
      expect(text, path).not.toMatch(/"generatedAt"\s*:|Generated on|\/home\/user|\/tmp\/claude/);
      expect(text, path).not.toMatch(/mcb_[a-z0-9]{8,}_[A-Za-z0-9]{12,}/);
    }
  });
});

describe("collections", () => {
  const postman = JSON.parse(collections.get("docs/collections/postman/mr-chartist-bridge.postman_collection.json"));
  const requests = postman.item.flatMap((f) => f.item);

  it("is a Postman v2.1 collection with baseUrl and an empty apiKey variable", () => {
    expect(postman.info.schema).toBe("https://schema.getpostman.com/json/collection/v2.1.0/collection.json");
    expect(postman.variable.slice(0, 2)).toEqual([
      { key: "baseUrl", value: "http://127.0.0.1:4300", type: "string" },
      { key: "apiKey", value: "", type: "string" },
    ]);
    // The rest are the ids and the expiry that one call stores for the next (CAPTURES in scripts/lib/examples.mjs).
    expect(postman.variable.slice(2).map((v) => v.key).sort()).toEqual(["downloadId", "expiry", "hookId", "keyId", "orderId", "recordingId", "ruleId", "subscriptionId"]);
    expect(postman.auth.bearer[0].value).toBe("{{apiKey}}");
    const env = JSON.parse(collections.get("docs/collections/postman/local.postman_environment.json"));
    expect(env.values.find((v) => v.key === "apiKey")).toMatchObject({ value: "", type: "secret" });
  });

  it("has one request per HTTP operation, in a folder per tag", () => {
    expect(requests).toHaveLength(callable.length);
    expect(callable.length).toBeGreaterThan(100);
    expect(postman.item.map((f) => f.name)).toEqual([...new Set(callable.map((o) => o.tag))].sort((a, b) => spec.tags.findIndex((t) => t.name === a) - spec.tags.findIndex((t) => t.name === b)));
    const byRequest = new Set(requests.map((r) => `${r.request.method} ${r.request.url.raw.replace("{{baseUrl}}", "").split("?")[0]}`));
    for (const op of callable) {
      const path = op.path.replace(/\{(\w+)\}/g, ":$1");
      expect(byRequest.has(`${op.method} ${path}`), `${op.method} ${op.path}`).toBe(true);
    }
  });

  it("has a Bruno file per request and a collection file and environment", () => {
    const bru = [...collections.keys()].filter((k) => k.endsWith(".bru") && !k.includes("/environments/"));
    expect(bru).toHaveLength(callable.length);
    expect(JSON.parse(collections.get("docs/collections/bruno/bruno.json")).type).toBe("collection");
    expect(collections.get("docs/collections/bruno/environments/local.bru")).toMatch(/vars:secret \[\n {2}apiKey\n\]/);
    for (const k of bru) {
      const t = collections.get(k);
      expect(t, k).toMatch(/^meta \{\n {2}name: .+\n {2}type: http\n {2}seq: \d+\n\}\n/);
      expect(t, k).toMatch(/\n(get|post|put|patch|delete) \{\n {2}url: \{\{baseUrl\}\}\//);
      expect((t.match(/^\S.*\{$/gm) ?? []).length, k).toBe((t.match(/^\}$/gm) ?? []).length);
    }
  });

  it("orders are paper in every example and no example asks for live", () => {
    const orderOps = callable.filter((o) => ["placeOrder", "previewOrder", "cancelAllOrders", "compatPlaceorder"].includes(o.id));
    expect(orderOps.length).toBe(4);
    // Only request bodies: the descriptions legitimately explain what `"mode": "live"` does.
    const bodies = [
      ...requests.map((r) => r.request.body?.raw ?? ""),
      ...[...all].filter(([k]) => k.endsWith(".bru")).flatMap(([, t]) => [...t.matchAll(/^body:json \{\n([\s\S]*?)\n\}$/gm)].map((m) => m[1])),
      ...[...all].filter(([k]) => k.startsWith("docs/api/")).flatMap(([, t]) => [...t.matchAll(/^ {2}-d '(.*)'$/gm)].map((m) => m[1])),
    ];
    expect(bodies.length).toBeGreaterThan(100);
    for (const b of bodies) expect(b).not.toMatch(/"mode":\s*"live"/);
    for (const id of ["placeOrder", "previewOrder"]) {
      const r = requests.find((x) => x.request.description.includes(`docs/api/orders/${id}.md`));
      expect(JSON.parse(r.request.body.raw)).toMatchObject({ account: "demo-paper", mode: "paper" });
    }
  });

  it("operations that need a key use the bearer variable; the ones that do not say so", () => {
    for (const op of callable) {
      const r = requests.find((x) => x.request.description.includes(`docs/api/${op.tag.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}/${op.id}.md`));
      expect(r, op.id).toBeTruthy();
      if (op.noAuth || op.bodyKey) expect(r.request.auth, op.id).toEqual({ type: "noauth" });
      else expect(r.request.auth, op.id).toBeUndefined();
      if (op.loopbackOnly) expect(r.request.description, op.id).toMatch(/This computer only/);
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
    expect(full.length).toBeLessThan(500_000);
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
    for (const need of ["docs/README.md", "docs/guides/quickstart.md", "docs/guides/safety.md", "docs/api/errors.md", "docs/collections/README.md"]) expect(paths).toContain(need);
    expect(docs.get("docs/search-index.json").length).toBeLessThan(200_000);
  });
});
