/**
 * Renders the Markdown page of one API operation (and the area index and error list) from the OpenAPI model.
 * Pure functions: the same spec always gives the same text.
 */
import { ERROR_CODES } from "../../server/bridge/core/errors.mjs";
import { BASE_URL, deref, refName, slug } from "./openapi-model.mjs";
import { queryString, requestExample } from "./examples.mjs";
import { noteBlock } from "./notes.mjs";

/** The guide that explains each area, relative to docs/. */
export const TAG_GUIDE = Object.freeze({
  System: "guides/quickstart.md",
  Accounts: "guides/accounts.md",
  Keys: "guides/safety.md",
  Instruments: "guides/quickstart.md",
  "Market data": "guides/quickstart.md",
  Streaming: "guides/streaming.md",
  Portfolio: "guides/safety.md",
  Orders: "guides/safety.md",
  Paper: "guides/paper-margin.md",
  Limits: "guides/rate-limits.md",
  Sources: "guides/sources.md",
  Pooling: "guides/rate-limits.md",
  Quotas: "guides/rate-limits.md",
  Safety: "guides/safety.md",
  Readiness: "guides/deployment.md",
  Spreadsheets: "guides/excel-sheets.md",
  Webhooks: "guides/webhooks.md",
  "AI (MCP)": "guides/mcp.md",
  "Compat REST": "guides/compat-api.md",
});

export const pagePath = (op) => `docs/api/${slug(op.tag)}/${op.id}.md`;

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
const code = (s) => `\`${s}\``;

// --- schema summaries -----------------------------------------------------------------------------------------------

export function typeLabel(spec, schema, depth = 0) {
  if (schema === undefined || schema === null || depth > 4) return "any";
  const name = refName(schema);
  if (name) return code(name);
  const s = schema;
  if (Array.isArray(s.enum)) {
    const vals = s.enum.map((v) => code(v === null ? "null" : v));
    return `one of ${vals.length > 8 ? `${vals.slice(0, 8).join(", ")}, ...` : vals.join(", ")}`;
  }
  if (s.const !== undefined) return code(s.const);
  if (s.oneOf || s.anyOf) return (s.oneOf ?? s.anyOf).map((a) => typeLabel(spec, a, depth + 1)).join(" or ");
  if (s.allOf) return s.allOf.map((a) => typeLabel(spec, a, depth + 1)).join(" + ");
  const types = Array.isArray(s.type) ? s.type : [s.type ?? (s.properties ? "object" : "any")];
  const parts = types.map((t) => {
    if (t === "array") return `array of ${typeLabel(spec, s.items, depth + 1)}`;
    let label = t;
    if (s.format) label += ` (${s.format})`;
    const range = [];
    if (s.minimum !== undefined) range.push(`min ${s.minimum}`);
    if (s.exclusiveMinimum !== undefined) range.push(`over ${s.exclusiveMinimum}`);
    if (s.maximum !== undefined) range.push(`max ${s.maximum}`);
    if (s.maxLength !== undefined) range.push(`up to ${s.maxLength} characters`);
    if (range.length && t !== "null") label += `, ${range.join(", ")}`;
    return label;
  });
  return parts.join(" or ");
}

/** The properties of an object schema as [name, schema, required] (allOf merged, one level). */
export function propertiesOf(spec, schema) {
  const s = deref(spec, schema);
  if (!s || typeof s !== "object") return [];
  const props = new Map();
  const required = new Set(s.required ?? []);
  for (const part of s.allOf ?? []) for (const [n, p, r] of propertiesOf(spec, part)) { props.set(n, p); if (r) required.add(n); }
  for (const [n, p] of Object.entries(s.properties ?? {})) props.set(n, p);
  return [...props].map(([n, p]) => [n, p, required.has(n)]);
}

function propertyTable(spec, schema, { max = 40 } = {}) {
  const rows = propertiesOf(spec, schema);
  if (!rows.length) return [];
  const lines = ["| Field | Type | Required | Notes |", "|---|---|---|---|"];
  for (const [name, p, req] of rows.slice(0, max)) {
    const d = deref(spec, p);
    const notes = [d.description ?? p.description ?? "", d.default !== undefined ? `Default ${code(JSON.stringify(d.default))}.` : ""].filter(Boolean).join(" ");
    lines.push(`| ${code(name)} | ${esc(typeLabel(spec, p))} | ${req ? "yes" : "no"} | ${esc(notes)} |`);
  }
  if (rows.length > max) lines.push(`| ... | | | ${rows.length - max} more fields in docs/openapi.yaml |`);
  return lines;
}

/** "Send exactly one of ..." for a oneOf made of bare `required` lists. */
function oneOfNote(spec, schema) {
  const s = deref(spec, schema);
  if (!Array.isArray(s?.oneOf) || !s.oneOf.length || !s.oneOf.every((o) => Array.isArray(o.required) && !o.properties && !o.type)) return null;
  return `Send exactly one of: ${s.oneOf.map((o) => o.required.map(code).join(" + ")).join(" or ")}.`;
}

// --- examples -------------------------------------------------------------------------------------------------------

const compactJson = (v) => JSON.stringify(v).replace(/\{\{apiKey\}\}/g, "YOUR_API_KEY");

/** The curl command of an example (placeholders: $MCB_API_KEY, or YOUR_API_KEY inside a body). */
export function curlFor(op, ex) {
  const qs = queryString(ex);
  const url = `${BASE_URL}${ex.path}${qs ? `?${qs}` : ""}`;
  const parts = [`curl -s${op.method === "GET" ? "" : ` -X ${op.method}`} "${url}"`];
  if (!op.noAuth && !op.bodyKey) parts.push('-H "Authorization: Bearer $MCB_API_KEY"');
  if (ex.bodyText !== null) parts.push(`-H "Content-Type: ${ex.contentType}"`);
  for (const h of ex.headers) parts.push(`-H "${h.name}: ${h.value}"`);
  if (op.id === "mcp") parts.push('-H "Accept: application/json, text/event-stream"');
  if (op.id === "receiveHook") parts.push('-H "X-MCB-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>"');
  if (ex.bodyText !== null) parts.push(`-d '${compactJson(ex.body)}'`);
  return parts.join(" \\\n  ");
}

/** Python value literal for JSON data, with {{apiKey}} turned into the environment lookup. */
export function pyLiteral(v, indent = 0) {
  const pad = (n) => "    ".repeat(n);
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v === "{{apiKey}}" ? 'os.environ["MCB_API_KEY"]' : JSON.stringify(v);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    const flat = `[${v.map((x) => pyLiteral(x, indent)).join(", ")}]`;
    if (flat.length <= 72 && !flat.includes("\n")) return flat;
    return `[\n${v.map((x) => `${pad(indent + 1)}${pyLiteral(x, indent + 1)},`).join("\n")}\n${pad(indent)}]`;
  }
  const entries = Object.entries(v);
  if (!entries.length) return "{}";
  const flat = `{${entries.map(([k, x]) => `${JSON.stringify(k)}: ${pyLiteral(x, indent)}`).join(", ")}}`;
  if (flat.length <= 72 && !flat.includes("\n")) return flat;
  return `{\n${entries.map(([k, x]) => `${pad(indent + 1)}${JSON.stringify(k)}: ${pyLiteral(x, indent + 1)},`).join("\n")}\n${pad(indent)}}`;
}

/**
 * SDK helper calls (sdk/python/mrchartist_bridge/client.py) for the common operations; `$BODY` is the request body.
 * Anything not listed uses the client's generic `request()`. scripts/generated.test.mjs checks the method names exist.
 */
export const PY_HELPERS = Object.freeze({
  getHealth: "bridge.health()",
  getMeta: "bridge.meta()",
  listBrokers: "bridge.brokers()",
  listAccounts: "bridge.accounts()",
  getAccount: 'bridge.account("demo-paper")',
  testAccount: 'bridge.test_account("demo-paper")',
  getLimits: "bridge.limits()",
  getUsage: "bridge.usage()",
  searchInstruments: 'bridge.search_instruments("RELIANCE")',
  getInstrument: 'bridge.instrument("NSE:RELIANCE")',
  convertSymbolGet: 'bridge.convert_symbol("NSE:RELIANCE")',
  convertSymbols: 'bridge.convert_symbols(["NSE:RELIANCE"])',
  getLtp: 'bridge.ltp(["NSE:RELIANCE", "NSE:NIFTY"])',
  getQuotes: 'bridge.quotes(["NSE:RELIANCE", "NSE:NIFTY"])',
  getDepth: 'bridge.depth("NSE:RELIANCE")',
  getHistory: 'bridge.history("NSE:RELIANCE", "5m", countback=50)',
  getExpiries: 'bridge.expiries("NIFTY")',
  getOptionChain: 'bridge.option_chain("NIFTY", "2026-11-24", strikes=5)',
  createStreamToken: "bridge.stream_token()",
  getStreamStats: "bridge.stream_stats()",
  getPositions: 'bridge.positions("demo-paper")',
  getHoldings: 'bridge.holdings("demo-paper")',
  getFunds: 'bridge.funds("demo-paper")',
  listOrders: 'bridge.orders(account="demo-paper", limit=20)',
  getOrder: 'bridge.order("<orderId>")',
  getOrderByClientId: 'bridge.order_by_client_id("<clientOrderId>")',
  listTrades: 'bridge.trades(account="demo-paper")',
  previewOrder: "bridge.preview_order(order)",
  placeOrder: "bridge.place_order(order)",
  modifyOrder: 'bridge.modify_order("<orderId>", {"price": 1450})',
  cancelOrder: 'bridge.cancel_order("<orderId>")',
  cancelAllOrders: 'bridge.cancel_all_orders(account="demo-paper", mode="paper")',
  getPaperAccount: 'bridge.paper_account("demo-paper")',
  resetPaperAccount: 'bridge.reset_paper_account("demo-paper", starting_capital=1000000)',
  getSafety: "bridge.safety()",
  engageKillSwitch: 'bridge.engage_kill_switch("Stopping for the day")',
});

/** Names of the SDK methods PY_HELPERS uses. */
export const helperMethods = () => [...new Set(Object.values(PY_HELPERS).flatMap((c) => [...c.matchAll(/bridge\.(\w+)\(/g)].map((m) => m[1])))].sort();

export function pythonFor(op, ex) {
  const usesOrderVar = ["placeOrder", "previewOrder"].includes(op.id);
  const lines = [];
  const needsOs = ex.bodyText !== null && ex.bodyText.includes("{{apiKey}}");
  if (needsOs) lines.push("import os", "");
  lines.push("from mrchartist_bridge import BridgeClient", "", "bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment", "");
  if (op.websocket) {
    lines.push('with bridge.stream(["NSE:RELIANCE"], mode="ltp") as s:', "    for msg in s:", '        if msg["type"] == "tick":', '            print(msg["symbol"], msg["ltp"])');
    return lines.join("\n");
  }
  const helper = PY_HELPERS[op.id];
  if (helper) {
    if (usesOrderVar) lines.push(`order = ${pyLiteral(ex.body)}`, "");
    lines.push(`result = ${helper}`);
    lines.push("print(result)");
    return lines.join("\n");
  }
  const args = [`"${op.method}"`, `"${ex.path}"`];
  const q = ex.query.filter((x) => x.enabled);
  if (q.length) args.push(`query=${pyLiteral(Object.fromEntries(q.map((x) => [x.name, x.value])))}`);
  if (ex.bodyText !== null) args.push(`body=${pyLiteral(ex.body)}`);
  const key = ex.headers.find((h) => h.name === "Idempotency-Key");
  if (key) args.push(`idempotency_key="${key.value}"`);
  const call = `bridge.request(${args.join(", ")})`;
  lines.push(call.length > 90 && args.length > 2 ? `response = bridge.request(\n${args.map((a) => `    ${a},`).join("\n")}\n)` : `response = ${call}`);
  lines.push("print(response.body)");
  return lines.join("\n");
}

// --- errors ---------------------------------------------------------------------------------------------------------

const ORDER_ERRORS = ["INVALID_ORDER", "PAPER_ONLY", "ORDER_GATE_CLOSED", "KILL_SWITCH_ACTIVE", "DAILY_LIMIT_REACHED", "MARKET_CLOSED", "CANNOT_TRADE", "CONFIRMATION_REQUIRED", "ORDER_RATE_LIMITED", "DUPLICATE_CLIENT_ORDER_ID", "OUTCOME_UNKNOWN"];
const UPSTREAM_ERRORS = ["UPSTREAM_ERROR", "BROKER_UNAVAILABLE", "UPSTREAM_TIMEOUT", "UPSTREAM_RATE_LIMITED", "SESSION_EXPIRED"];

/** Error codes this operation can answer with, derived from its flags and parameters (see docs/api/errors.md for all). */
export function errorCodesFor(op) {
  const codes = new Set();
  const needsKey = !op.noAuth && !op.bodyKey;
  if (needsKey) { codes.add("UNAUTHENTICATED"); codes.add("RATE_LIMITED"); }
  if (needsKey && op.scope && op.scope !== "read") codes.add("SCOPE_REQUIRED");
  if (op.loopbackOnly) codes.add("LOOPBACK_ONLY");
  if (op.parameters.length || op.requestBody) codes.add("VALIDATION_FAILED");
  if (op.requestBody) { codes.add("INVALID_JSON"); codes.add("UNSUPPORTED_MEDIA_TYPE"); }
  const names = new Set(op.parameters.map((p) => p.name));
  if (names.has("account") || names.has("accountId")) { codes.add("ACCOUNT_FORBIDDEN"); }
  if (names.has("accountId")) codes.add("ACCOUNT_NOT_FOUND");
  if (names.has("orderId") || names.has("clientOrderId")) codes.add("ORDER_NOT_FOUND");
  if (names.has("symbol") || names.has("symbols")) codes.add("SYMBOL_NOT_FOUND");
  if (op.idempotent) { codes.add("IDEMPOTENCY_KEY_REUSED"); codes.add("IDEMPOTENCY_IN_PROGRESS"); }
  if (["placeOrder", "modifyOrder", "cancelOrder", "cancelAllOrders"].includes(op.id)) for (const c of ORDER_ERRORS) codes.add(c);
  if (op.id === "previewOrder") for (const c of ["INVALID_ORDER", "CANNOT_TRADE"]) codes.add(c);
  if (["Market data", "Portfolio", "Orders", "Instruments"].includes(op.tag) && op.module !== "core") for (const c of UPSTREAM_ERRORS) codes.add(c);
  if (op.id === "confirmTicket" || op.id === "rejectTicket") { codes.add("STATE_CONFLICT"); codes.add("NOT_FOUND"); }
  return [...codes].filter((c) => ERROR_CODES[c]).sort((a, b) => ERROR_CODES[a].status - ERROR_CODES[b].status || a.localeCompare(b));
}

// --- pages ----------------------------------------------------------------------------------------------------------

function firstSuccess(op) {
  return op.responses.find((r) => /^2\d\d$/.test(r.status) && r.schema) ?? null;
}

/** The expected status of the example call: the first numeric status the spec documents. */
export const expectedStatus = (op) => Number(op.responses.find((r) => /^\d{3}$/.test(r.status))?.status ?? 200);

export function endpointPage(spec, op) {
  const ex = requestExample(spec, op);
  const guide = TAG_GUIDE[op.tag];
  const out = [];
  out.push(`# ${op.summary}`, "", `${code(`${op.method} ${op.path}`)}`, "");
  out.push("| | |", "|---|---|");
  out.push(`| Area | [${op.tag}](../README.md#${slug(op.tag)}) |`);
  out.push(`| Operation | ${code(op.id)} |`);
  out.push(`| Scope | ${op.bodyKey ? "`apikey` in the body (read for data, paper or live for orders)" : op.noAuth ? "none (no API key)" : code(op.scope ?? "read")} |`);
  out.push(`| This computer only | ${op.loopbackOnly ? "yes" : "no"} |`);
  if (op.demoOnly) out.push("| Demo mode only | yes |");
  if (op.idempotent) out.push("| Idempotency-Key | send one on every write |");
  if (guide) out.push(`| Guide | [${guide.replace("guides/", "")}](../../${guide}) |`);
  out.push("");
  out.push(...noteBlock(op).map((l) => `- ${l}`), "");
  if (op.description.trim()) out.push(op.description.trim().replace(/^#+ (.*)$/gm, "**$1**"), "");

  if (op.parameters.length) {
    out.push("## Parameters", "", "| Name | In | Type | Required | Notes |", "|---|---|---|---|---|");
    for (const p of op.parameters) {
      const notes = [p.description, p.schema?.default !== undefined ? `Default ${code(JSON.stringify(p.schema.default))}.` : ""].filter(Boolean).join(" ");
      out.push(`| ${code(p.name)} | ${p.in} | ${esc(typeLabel(spec, p.schema))} | ${p.required ? "yes" : "no"} | ${esc(notes)} |`);
    }
    out.push("");
  }

  if (op.requestBody) {
    out.push("## Request body", "");
    const rb = op.requestBody;
    const note = oneOfNote(spec, rb.schema);
    out.push(`${rb.required ? "Required" : "Optional"}, \`${rb.contentType}\`${rb.schemaRef ? `, schema ${code(rb.schemaRef)}` : ""}.${note ? ` ${note}` : ""}`, "");
    const table = propertyTable(spec, rb.schema);
    if (table.length) out.push(...table, "");
    else out.push("A JSON object.", "");
    out.push("Example:", "", "```json", ex.bodyText.replace(/\{\{apiKey\}\}/g, "YOUR_API_KEY"), "```", "");
  }

  out.push("## Responses", "", "| Status | Meaning | Body |", "|---|---|---|");
  for (const r of op.responses) {
    out.push(`| ${r.status} | ${esc(r.description)} | ${r.contentType ? `${r.contentType}${r.schema ? `: ${esc(typeLabel(spec, r.schema))}` : ""}` : ""} |`);
  }
  out.push("");
  const ok = firstSuccess(op);
  if (ok) {
    const top = propertiesOf(spec, ok.schema);
    const data = top.find(([n]) => n === "data");
    if (top.length) {
      out.push(`### Fields of the ${ok.status} answer`, "", ...propertyTable(spec, ok.schema), "");
      if (data) {
        const d = deref(spec, data[1]);
        const item = d.type === "array" ? d.items : data[1];
        const inner = propertyTable(spec, item);
        if (inner.length) out.push(`#### ${d.type === "array" ? "Each item of `data`" : "Fields of `data`"}${refName(item) ? ` (${code(refName(item))})` : ""}`, "", ...inner, "");
      }
    } else if (refName(ok.schema)) {
      out.push(`### Fields of the ${ok.status} answer (${code(refName(ok.schema))})`, "", ...propertyTable(spec, ok.schema), "");
    }
  }

  const codes = errorCodesFor(op);
  if (codes.length) {
    out.push("## Errors", "", "Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).", "", "| Code | HTTP | Retryable |", "|---|---|---|");
    for (const c of codes) out.push(`| ${code(c)} | ${ERROR_CODES[c].status} | ${ERROR_CODES[c].retryable ? "yes" : "no"} |`);
    out.push("");
  }

  out.push("## Examples", "");
  if (op.websocket) {
    out.push("A WebSocket upgrade, not a plain request. Get a single-use token first (`POST /v1/stream/token`), then connect to `ws://127.0.0.1:4300/v1/stream?token=<token>`. Message formats: docs/asyncapi.yaml and [streaming.md](../../guides/streaming.md).", "");
  } else {
    out.push("curl (set `MCB_API_KEY` to your key first" + (op.bodyKey ? "; replace `YOUR_API_KEY` in the body" : "") + "):", "", "```bash", curlFor(op, ex), "```", "");
  }
  out.push("Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):", "", "```python", pythonFor(op, ex), "```", "");
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

const needs = (op) => {
  if (op.bodyKey) return "`apikey` in body";
  if (op.noAuth) return "no key";
  return `${code(op.scope ?? "read")}${op.loopbackOnly ? ", this computer only" : ""}`;
};

export function apiIndexPage(spec, ops, groups) {
  const out = ["# API reference: one page per endpoint", ""];
  out.push(`${ops.length} operations, generated from [openapi.yaml](../openapi.yaml). Each page lists the scope, whether it works only from this computer, parameters, request and response fields, error codes, and a curl and Python example. Streams are in [asyncapi.yaml](../asyncapi.yaml); error codes in [errors.md](errors.md).`, "");
  out.push("Every call except `/v1/health`, inbound webhooks and the streaming endpoints needs an API key (`Authorization: Bearer mcb_<keyId>_<secret>`). Scopes: `read`, `paper` (read plus paper orders), `live`, `admin` (this computer only). Orders are paper unless a request says `\"mode\": \"live\"` and every live opt-in is in place ([safety.md](../guides/safety.md)).", "");
  out.push("Try the calls without code: [Postman and Bruno collections](../collections/README.md).", "");
  for (const [tag, list] of groups) {
    const t = (spec.tags ?? []).find((x) => x.name === tag);
    out.push(`## ${tag}`, "");
    if (t?.description) out.push(t.description.replace(/\s+/g, " ").trim(), "");
    out.push("| Call | What it does | Needs |", "|---|---|---|");
    for (const op of list) out.push(`| [${op.method} ${op.path}](${slug(op.tag)}/${op.id}.md) | ${esc(op.summary)} | ${needs(op)} |`);
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

const MEANING = Object.freeze({});

export function errorsPage() {
  const out = ["# Error codes", "", "Every error is `application/problem+json` with `code`, `status`, `detail`, `retryable` and `requestId`. The `code` is stable (codes are added, never renamed); `detail` is for people. `retryable` answers one question: is it safe to send exactly this request again? A write whose outcome is unknown is never retryable: check the order book first.", ""];
  out.push("Rate-limit refusals (429) also say whose limit was hit: `scope` (`client`, `upstream`, `queue`, `consumer-cap`), `retryAfterMs` and `limit`. Read those fields, not `detail`. See [rate-limits.md](../guides/rate-limits.md).", "");
  out.push("Generated from `server/bridge/core/errors.mjs`.", "", "| Code | HTTP | Retryable | Meaning |", "|---|---|---|---|");
  for (const [c, e] of Object.entries(ERROR_CODES).sort((a, b) => a[1].status - b[1].status || a[0].localeCompare(b[0]))) {
    out.push(`| ${code(c)} | ${e.status} | ${e.retryable ? "yes" : "no"} | ${esc(MEANING[c] ?? e.title)} |`);
  }
  return `${out.join("\n")}\n`;
}
