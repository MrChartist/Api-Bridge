#!/usr/bin/env node
/**
 * Builds the importable API collections from docs/openapi.yaml:
 *   docs/collections/postman/   Postman collection v2.1 and an environment
 *   docs/collections/bruno/     a Bruno collection (one .bru file per request)
 *   docs/collections/README.md  how to import them
 * One folder per tag, one request per operation, variables `baseUrl` and `apiKey` (empty: you add your own key),
 * paper-mode order examples. Output is deterministic (sorted keys, no timestamps, no ids): scripts/generated.test.mjs
 * fails when the committed files differ from what this script writes.
 *
 *   node scripts/gen-collections.mjs           write
 *   node scripts/gen-collections.mjs --check   exit 1 when the committed files are out of date
 */
import { fileURLToPath } from "node:url";
import { BASE_URL, REPO_ROOT, byTag, isCallable, loadSpec, operations, slug, stableJson } from "./lib/openapi-model.mjs";
import { CAPTURES, VARIABLES, queryString, requestExample } from "./lib/examples.mjs";
import { noteBlock } from "./lib/notes.mjs";
import { runCli } from "./lib/outputs.mjs";

const OUT = "docs/collections";
const TITLE = "Mr. Chartist API Bridge";
const POSTMAN_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

/** Markdown description shown on each request in both tools. */
function requestDescription(op) {
  const parts = [op.summary, "", ...noteBlock(op).map((l) => `- ${l}`)];
  if (op.description.trim()) parts.push("", op.description.trim());
  parts.push("", `Reference: docs/api/${slug(op.tag)}/${op.id}.md in the repository.`);
  return parts.join("\n");
}

/** `/v1/orders/{orderId}` as path segments with `:orderId` variables. */
const segments = (path) => path.split("/").filter(Boolean).map((s) => s.replace(/^\{(.+)\}$/, ":$1"));

function extraHeaders(op, ex) {
  const h = ex.headers.map((x) => ({ name: x.name, value: x.name === "Idempotency-Key" ? "{{$guid}}" : x.value }));
  if (op.id === "mcp") h.push({ name: "Accept", value: "application/json, text/event-stream" });
  if (op.id === "receiveHook") h.push({ name: "X-MCB-Signature", value: "t=<unix seconds>,v1=<hex HMAC-SHA256>", disabled: true });
  return h;
}

// --- Postman --------------------------------------------------------------------------------------------------------

/** `data.expiries[0]` as a guarded JavaScript read of a parsed answer. */
const jsRead = (path) => `pm.response.json().${path}`;

function postmanItem(spec, op) {
  const ex = requestExample(spec, op);
  const segs = segments(op.path);
  const qs = queryString(ex, { vars: true });
  const url = {
    raw: `{{baseUrl}}/${segs.join("/")}${qs ? `?${qs}` : ""}`,
    host: ["{{baseUrl}}"],
    path: segs,
  };
  if (ex.query.length) {
    url.query = ex.query.map((q) => ({ key: q.name, value: q.var ? `{{${q.var}}}` : q.value, ...(q.enabled ? {} : { disabled: true }), ...(q.description ? { description: q.description } : {}) }));
  }
  if (ex.pathParams.length) url.variable = ex.pathParams.map((p) => ({ key: p.name, value: p.var ? `{{${p.var}}}` : p.value }));
  const header = extraHeaders(op, ex).map((h) => ({ key: h.name, value: h.value, type: "text", ...(h.disabled ? { disabled: true } : {}) }));
  const request = { method: op.method, header, url, description: requestDescription(op) };
  if (ex.bodyText !== null) {
    request.body = { mode: "raw", raw: ex.bodyText, options: { raw: { language: "json" } } };
    if (!header.some((h) => h.key.toLowerCase() === "content-type")) header.push({ key: "Content-Type", value: "application/json", type: "text" });
  }
  if (op.noAuth || op.bodyKey) request.auth = { type: "noauth" };
  const item = { name: op.summary, request, response: [] };
  const captures = Object.entries(CAPTURES[op.id] ?? {});
  if (captures.length) {
    // Keep what this call made (an order id, a download id, an expiry) so the calls that use it need no copying.
    const exec = ["if (pm.response.code < 300) {", "  try {", ...captures.map(([name, path]) => `    pm.collectionVariables.set(${JSON.stringify(name)}, ${jsRead(path)});`), "  } catch (e) { /* the answer had another shape: leave the variable as it was */ }", "}"];
    item.event = [{ listen: "test", script: { type: "text/javascript", exec } }];
  }
  return item;
}

export function postmanCollection(spec, ops) {
  const item = [...byTag(ops)].map(([tag, list]) => {
    const tagDef = (spec.tags ?? []).find((t) => t.name === tag);
    return { name: tag, ...(tagDef?.description ? { description: tagDef.description } : {}), item: list.map((op) => postmanItem(spec, op)) };
  });
  return {
    info: {
      name: TITLE,
      description: [
        "Every HTTP operation of the Bridge, one folder per area. Set `baseUrl` (default http://127.0.0.1:4300) and `apiKey` (a key from `mc-bridge keys create`) in the environment.",
        "Order examples are paper orders on the demo paper account. Nothing here contains a real key.",
        `Generated from docs/openapi.yaml (${spec.info?.version ?? ""}). Do not edit by hand: run node scripts/gen-collections.mjs.`,
      ].join("\n\n"),
      schema: POSTMAN_SCHEMA,
    },
    auth: { type: "bearer", bearer: [{ key: "token", value: "{{apiKey}}", type: "string" }] },
    variable: [
      { key: "baseUrl", value: BASE_URL, type: "string" },
      { key: "apiKey", value: "", type: "string" },
      ...Object.entries(VARIABLES).map(([key, value]) => ({ key, value, type: "string" })),
    ],
    item,
  };
}

export const postmanEnvironment = () => ({
  name: "Local Bridge",
  values: [
    { key: "baseUrl", value: BASE_URL, type: "default", enabled: true },
    { key: "apiKey", value: "", type: "secret", enabled: true },
  ],
  _postman_variable_scope: "environment",
});

// --- Bruno ----------------------------------------------------------------------------------------------------------

const indent = (text, n = 2) => text.split("\n").map((l) => (l ? " ".repeat(n) + l : l)).join("\n");
const folderName = (tag) => tag.replace(/[()/\\:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();

function brunoRequest(spec, op, seq) {
  const ex = requestExample(spec, op);
  const segs = segments(op.path).join("/");
  const qs = queryString(ex, { vars: true });
  const hasKey = !op.noAuth && !op.bodyKey;
  const out = [];
  out.push(`meta {\n  name: ${op.summary.replace(/\n/g, " ")}\n  type: http\n  seq: ${seq}\n}\n`);
  out.push(`${op.method.toLowerCase()} {\n  url: {{baseUrl}}/${segs}${qs ? `?${qs}` : ""}\n  body: ${ex.bodyText !== null ? "json" : "none"}\n  auth: ${hasKey ? "bearer" : "none"}\n}\n`);
  if (ex.query.length) out.push(`params:query {\n${ex.query.map((q) => `  ${q.enabled ? "" : "~"}${q.name}: ${q.var ? `{{${q.var}}}` : q.value}`).join("\n")}\n}\n`);
  if (ex.pathParams.length) out.push(`params:path {\n${ex.pathParams.map((p) => `  ${p.name}: ${p.var ? `{{${p.var}}}` : p.value}`).join("\n")}\n}\n`);
  const headers = extraHeaders(op, ex);
  if (headers.length) out.push(`headers {\n${headers.map((h) => `  ${h.disabled ? "~" : ""}${h.name}: ${h.value}`).join("\n")}\n}\n`);
  if (hasKey) out.push("auth:bearer {\n  token: {{apiKey}}\n}\n");
  if (ex.bodyText !== null) out.push(`body:json {\n${indent(ex.bodyText)}\n}\n`);
  const captures = Object.entries(CAPTURES[op.id] ?? {});
  if (captures.length) out.push(`vars:post-response {\n${captures.map(([name, path]) => `  ${name}: res.body.${path}`).join("\n")}\n}\n`);
  out.push(`docs {\n${indent(requestDescription(op))}\n}\n`);
  return out.join("\n");
}

// --- README ---------------------------------------------------------------------------------------------------------

function readme(spec, ops, groups) {
  const lines = [
    "# API collections",
    "",
    "Import these into Postman or Bruno to try every call of the Bridge without writing code. They are generated from",
    "[`docs/openapi.yaml`](../openapi.yaml), so they list exactly the operations the Bridge serves.",
    "",
    `- **${ops.length} requests** in ${groups.length} folders (one folder per area: ${groups.join(", ")}).`,
    "- Two variables: `baseUrl` (default `http://127.0.0.1:4300`) and `apiKey`. The key is empty in the files: make one with",
    "  `mc-bridge keys create --label postman --scope read,paper` and paste it into your own environment, never into the collection.",
    "- Every request says in its description which scope it needs and whether it works only from this computer.",
    "- Order examples are **paper orders** on the demo paper account (`demo-paper`, from `mc-bridge start --demo`).",
    "  A live order needs the opt-ins in [safety.md](../guides/safety.md); nothing here turns them on.",
    "- Calls that act on something you create (an order, a download, a recording, a hook, a key, a subscription) read its id from a variable",
    "  (`orderId`, `downloadId`, `recordingId`, `ruleId`, `hookId`, `keyId`, `subscriptionId`) that the call which made it fills in: send the",
    "  create call first. A ticket id has no such call (it comes from a pending confirmation): paste it.",
    "- `expiry` is a variable too. Send **Expiries** first: it stores the first date the Bridge returns, and the option chain calls use it. Until",
    "  then it holds a sample date, which a Bridge may not have.",
    "",
    "## Postman",
    "",
    "1. Import `postman/mr-chartist-bridge.postman_collection.json` and `postman/local.postman_environment.json`.",
    "2. Pick the **Local Bridge** environment and set `apiKey` (a secret variable).",
    "3. Start the Bridge (`npm run dev` for demo mode) and send **Health** first.",
    "",
    "## Bruno",
    "",
    "1. Open the `bruno/` folder as a collection (Open Collection).",
    "2. Choose the **local** environment and fill `apiKey` (a secret variable).",
    "",
    "## Regenerating",
    "",
    "```bash",
    "node scripts/gen-collections.mjs           # rewrite the files",
    "node scripts/gen-collections.mjs --check   # exit 1 when they are out of date (CI runs this)",
    "```",
    "",
    "Do not edit the generated files by hand. Change the OpenAPI document (or the examples in `scripts/lib/examples.mjs`) and regenerate.",
    "",
  ];
  return lines.join("\n");
}

/** @returns {Map<string, string>} path relative to the repository root -> file text */
export function buildCollections(spec = loadSpec()) {
  const ops = operations(spec).filter(isCallable);
  const files = new Map();
  files.set(`${OUT}/postman/mr-chartist-bridge.postman_collection.json`, `${stableJson(postmanCollection(spec, ops))}\n`);
  files.set(`${OUT}/postman/local.postman_environment.json`, `${stableJson(postmanEnvironment())}\n`);
  files.set(`${OUT}/bruno/bruno.json`, `${stableJson({ version: "1", name: TITLE, type: "collection", ignore: ["node_modules", ".git"] })}\n`);
  files.set(`${OUT}/bruno/environments/local.bru`, `vars {\n  baseUrl: ${BASE_URL}\n}\nvars:secret [\n  apiKey\n]\n`);
  const groups = byTag(ops);
  for (const [tag, list] of groups) list.forEach((op, i) => files.set(`${OUT}/bruno/${folderName(tag)}/${op.id}.bru`, brunoRequest(spec, op, i + 1)));
  files.set(`${OUT}/README.md`, readme(spec, ops, [...groups.keys()]));
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runCli("gen-collections", REPO_ROOT, buildCollections(), [OUT]);
