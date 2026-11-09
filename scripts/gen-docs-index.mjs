#!/usr/bin/env node
/**
 * Builds the generated documentation from docs/openapi.yaml and the hand-written guides:
 *   docs/api/                 one Markdown page per operation, an index by area (README.md) and the error codes
 *   docs/llms.txt             a short index for AI assistants (the llms.txt convention: H1, summary, H2 link lists)
 *   docs/llms-full.txt        the API overview and every guide in one file
 *   docs/search-index.json    title, path, headings and a short text per page, for a future search box
 * Deterministic: no dates, sorted output. scripts/generated.test.mjs fails when the committed files are out of date.
 *
 *   node scripts/gen-docs-index.mjs           write
 *   node scripts/gen-docs-index.mjs --check   exit 1 when the committed files are out of date
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, byTag, loadSpec, operations, slug, stableJson } from "./lib/openapi-model.mjs";
import { apiIndexPage, endpointPage, errorsPage, pagePath } from "./lib/endpoint-docs.mjs";
import { headingsOf, plainText, snippetOf, titleOf } from "./lib/docs-text.mjs";
import { runCli } from "./lib/outputs.mjs";
import { buildCollections } from "./gen-collections.mjs";

const REPO_URL = "https://github.com/MrChartist/api-bridge-v2";
const RAW = "https://raw.githubusercontent.com/MrChartist/api-bridge-v2/main";
const raw = (p) => `${RAW}/${p}`;
const read = (root, rel) => readFileSync(join(root, rel), "utf8");

/** Rows of the table in docs/guides/README.md: [{ file, title, about }]. */
export function guideRows(root) {
  const rows = [];
  for (const line of read(root, "docs/guides/README.md").split("\n")) {
    const m = /^\| \[([^\]]+)\]\(([^)]+\.md)\) \| (.*) \|\s*$/.exec(line);
    if (m && !m[2].includes("/")) rows.push({ file: m[2], label: m[1], about: plainText(m[3]) });
  }
  return rows;
}

function llmsTxt(spec, ops, root) {
  const guides = guideRows(root);
  const guideTitle = (file) => titleOf(read(root, `docs/guides/${file}`), file);
  const link = (title, path, note) => `- [${title}](${raw(path)}): ${note}`;
  const lines = [
    "# Mr. Chartist API Bridge",
    "",
    "> One local API (REST, WebSocket and MCP) in front of your Indian broker accounts. It runs on the user's own computer, keeps one connection per broker, shares it between all of the user's tools and stays inside each broker's rate limits. Orders are paper by default; live orders need several explicit opt-ins. MIT licensed, personal use.",
    "",
    "Facts that help when writing code against it:",
    "",
    "- Base URL: `http://127.0.0.1:4300` (this computer only). `mc-bridge start --demo` serves sample data with no broker, for trying things out.",
    "- Authentication: `Authorization: Bearer mcb_<keyId>_<secret>`. Scopes: `read`, `paper` (read plus paper orders), `live`, `admin` (this computer only). Keys come from `mc-bridge keys create`; never put one in a URL, except `?key=` on `/xl/*` for read-only keys.",
    "- Symbols: `EXCHANGE:UNDERLYING[-YYYY-MM-DD(-FUT | -STRIKE-CE | -STRIKE-PE)]`, for example `NSE:RELIANCE`, `NSE:NIFTY`, `NFO:NIFTY-2026-10-27-25000-CE`.",
    "- Answers under `/v1` are `{ \"data\": ..., \"meta\": { \"requestId\": ... } }`. Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Send an `Idempotency-Key` with every order write.",
    "- Every market-data item has a `freshness` block (source, age, `class` realtime, delayed or eod). Delayed and end-of-day data is never used for orders, risk checks, paper fills or alerts.",
    "- Orders are paper unless the request says `\"mode\": \"live\"` and every live opt-in is in place. Approving an order always happens on the computer running the Bridge, never through a spreadsheet, chart alert or chat message.",
    "",
    "## Start here",
    "",
    link("Docs home", "docs/README.md", "where to begin, by what you want to do"),
    link("Quickstart", "docs/guides/quickstart.md", "clone, start in demo mode, make a key, get a price, place a paper order, read a stream"),
    link("Connect a tool", "docs/guides/mcp.md", "Claude Desktop, Claude Code and Cursor over MCP; other tools are listed in the docs home"),
    link("Safety", "docs/guides/safety.md", "paper and live modes, keys, limits, kill switch, audit"),
    "",
    "## API reference",
    "",
    link("OpenAPI 3.1 description", "docs/openapi.yaml", `all ${ops.length} operations with schemas, scopes and error codes`),
    link("AsyncAPI description", "docs/asyncapi.yaml", "WebSocket and SSE message formats"),
    link("Endpoint pages", "docs/api/README.md", `one Markdown page per operation (${ops.length}), grouped by area, each with curl and Python examples`),
    link("Error codes", "docs/api/errors.md", "every stable error code with its HTTP status and whether a retry is safe"),
    link("Postman and Bruno collections", "docs/collections/README.md", "import every request, with paper-mode examples and no real keys"),
    "",
    "## Guides",
    "",
    ...guides.map((g) => link(guideTitle(g.file), `docs/guides/${g.file}`, g.about)),
    "",
    "## Reference",
    "",
    link("Architecture", "docs/ARCHITECTURE.md", "how the Bridge is built"),
    link("Brokers", "docs/BROKERS.md", "supported brokers and what each can do"),
    link("Data source contract", "docs/source-contract.md", "writing a data source or plugin"),
    link("Sources architecture", "docs/sources-architecture.md", "how sources, routing and quotas fit together"),
    link("Broker contract", "docs/broker-contract.md", "what a broker adapter must provide"),
    "",
    "## Optional",
    "",
    link("Full text of the guides", "docs/llms-full.txt", "the API overview and every guide in one file"),
    link("Search index", "docs/search-index.json", "title, path, headings and a short text for each page"),
    link("README", "README.md", "project overview"),
    link("Changelog", "CHANGELOG.md", "what changed in each release"),
    link("Roadmap", "ROADMAP.md", "what is planned"),
    link("Security policy", "SECURITY.md", `how to report a problem (${REPO_URL}/security)`),
    "",
  ];
  return lines.join("\n");
}

function llmsFull(spec, ops, root, errors) {
  const guides = guideRows(root);
  const out = [
    "# Mr. Chartist API Bridge: full text",
    "",
    "The API overview and every guide, in one file for AI assistants. Generated by scripts/gen-docs-index.mjs; the short index is llms.txt. Links inside the text are relative to the repository.",
    "",
    `Operations: ${ops.length}. Per-endpoint pages: docs/api/README.md.`,
    "",
    "---",
    "",
    "## API overview (from docs/openapi.yaml)",
    "",
    (spec.info?.description ?? "").trim().replace(/^## /gm, "### "),
    "",
  ];
  for (const g of guides) {
    out.push("---", "", `<!-- docs/guides/${g.file} -->`, "", read(root, `docs/guides/${g.file}`).trim(), "");
  }
  out.push("---", "", "<!-- docs/api/errors.md -->", "", errors.trim(), "");
  return out.join("\n");
}

/** Hand-written pages that go into the search index (paths relative to the repository). */
function docPages(root) {
  const files = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "ROADMAP.md"];
  for (const dir of ["docs", "docs/guides"]) {
    for (const f of readdirSync(join(root, dir)).sort()) if (f.endsWith(".md")) files.push(`${dir}/${f}`);
  }
  return files.filter((f) => existsSync(join(root, f)));
}

function searchIndex(root, ops, pages) {
  const entries = [];
  for (const rel of docPages(root)) {
    const md = read(root, rel);
    entries.push({ title: titleOf(md, rel), path: rel, kind: rel.startsWith("docs/guides/") ? "guide" : "doc", headings: headingsOf(md), text: snippetOf(md) });
  }
  for (const [rel, md] of pages) entries.push({ title: titleOf(md, rel), path: rel, kind: "doc", headings: headingsOf(md), text: snippetOf(md) });
  for (const op of ops) {
    const rel = pagePath(op);
    const first = (op.description || "").trim().split(/(?<=[.!?])\s/)[0] ?? "";
    entries.push({
      title: op.summary,
      path: rel,
      kind: "endpoint",
      headings: [`${op.method} ${op.path}`],
      text: plainText(`${op.method} ${op.path}. ${first}`).slice(0, 280),
    });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

/** @returns {Map<string, string>} path relative to the repository root -> file text */
export function buildDocs(root = REPO_ROOT, spec = loadSpec(root)) {
  const ops = operations(spec);
  const groups = byTag(ops);
  const files = new Map();
  for (const op of ops) files.set(pagePath(op), endpointPage(spec, op));
  files.set("docs/api/README.md", apiIndexPage(spec, ops, groups));
  files.set("docs/api/errors.md", errorsPage());
  const apiPages = new Map([["docs/api/README.md", files.get("docs/api/README.md")], ["docs/api/errors.md", files.get("docs/api/errors.md")]]);
  // The collections' README comes from its own generator, in memory, so this output never depends on the disk state.
  const collections = buildCollections(spec).get("docs/collections/README.md");
  apiPages.set("docs/collections/README.md", collections);
  files.set("docs/llms.txt", llmsTxt(spec, ops, root));
  files.set("docs/llms-full.txt", llmsFull(spec, ops, root, files.get("docs/api/errors.md")));
  files.set("docs/search-index.json", `${stableJson({ generatedBy: "scripts/gen-docs-index.mjs", pages: searchIndex(root, ops, apiPages) })}\n`);
  return files;
}

export const OWNED = ["docs/api", "docs/llms.txt", "docs/llms-full.txt", "docs/search-index.json"];

if (process.argv[1] === fileURLToPath(import.meta.url)) runCli("gen-docs-index", REPO_ROOT, buildDocs(), OWNED);
