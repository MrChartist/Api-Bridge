/**
 * Reads docs/openapi.yaml into a flat list of operations that the generators (collections, endpoint pages, tests)
 * share, and builds minimal valid example values from the schemas. Everything here is pure and deterministic.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml } from "./yaml-lite.mjs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const BASE_URL = "http://127.0.0.1:4300";

const METHODS = ["get", "post", "put", "patch", "delete"];

export function loadSpec(root = REPO_ROOT) {
  return parseYaml(readFileSync(resolve(root, "docs/openapi.yaml"), "utf8"));
}

/** Follow `$ref` (local only) until a concrete node is reached. */
export function deref(spec, node, seen = 0) {
  if (node && typeof node === "object" && typeof node.$ref === "string") {
    if (seen > 20) throw new Error(`reference loop at ${node.$ref}`);
    if (!node.$ref.startsWith("#/")) throw new Error(`only local references are supported: ${node.$ref}`);
    let cur = spec;
    for (const part of node.$ref.slice(2).split("/")) cur = cur?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (cur === undefined) throw new Error(`unresolved reference ${node.$ref}`);
    return deref(spec, cur, seen + 1);
  }
  return node;
}

export const refName = (node) => (typeof node?.$ref === "string" ? node.$ref.split("/").pop() : null);

export const slug = (s) => String(s).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * Every operation in the spec, in file order.
 * @returns {Array<{
 *   id: string, method: string, path: string, tag: string, tagIndex: number, summary: string, description: string,
 *   scope: string|null, loopbackOnly: boolean, noAuth: boolean, queryKey: boolean, bodyKey: boolean, publicIngress: boolean,
 *   demoOnly: boolean, websocket: boolean, module: string|null,
 *   parameters: Array<{ name: string, in: string, required: boolean, description: string, schema: any, ref: string|null }>,
 *   requestBody: null|{ required: boolean, contentType: string, schema: any, schemaRef: string|null },
 *   responses: Array<{ status: string, description: string, contentType: string|null, schema: any, schemaRef: string|null }>,
 *   idempotent: boolean, html: boolean }>}
 */
export function operations(spec) {
  const tagNames = (spec.tags ?? []).map((t) => t.name);
  const out = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) => {
        const r = deref(spec, p);
        return { name: r.name, in: r.in, required: Boolean(r.required), description: r.description ?? "", schema: r.schema ?? {}, ref: refName(p) };
      });
      let requestBody = null;
      if (op.requestBody) {
        const rb = deref(spec, op.requestBody);
        const [contentType, media] = Object.entries(rb.content ?? {})[0] ?? ["application/json", {}];
        requestBody = { required: Boolean(rb.required), contentType, schema: media?.schema ?? {}, schemaRef: refName(media?.schema) };
      }
      const responses = Object.entries(op.responses ?? {}).map(([status, r]) => {
        const rr = deref(spec, r);
        const [contentType, media] = Object.entries(rr.content ?? {})[0] ?? [null, null];
        return { status: String(status), description: rr.description ?? "", contentType, schema: media?.schema ?? null, schemaRef: refName(media?.schema) };
      });
      const tag = op.tags?.[0] ?? "Other";
      const security = op.security;
      const o = {
        id: op.operationId,
        method: method.toUpperCase(),
        path,
        tag,
        tagIndex: Math.max(0, tagNames.indexOf(tag)),
        summary: op.summary ?? op.operationId,
        description: op.description ?? "",
        scope: op["x-scope"] ?? null,
        loopbackOnly: op["x-loopback-only"] === true,
        noAuth: Array.isArray(security) && security.length === 0,
        queryKey: Array.isArray(security) && security.some((s) => "apiKeyQuery" in s),
        bodyKey: tag === "Compat REST",
        publicIngress: op["x-public"] === true,
        demoOnly: op["x-demo-only"] === true,
        websocket: op["x-websocket"] === true,
        module: op["x-module"] ?? null,
        parameters: params,
        requestBody,
        responses,
        idempotent: params.some((p) => p.in === "header" && p.name === "Idempotency-Key"),
        html: responses.some((r) => r.contentType === "text/html") || responses.some((r) => r.status === "302"),
      };
      if (!o.id) throw new Error(`${o.method} ${path} has no operationId`);
      out.push(o);
    }
  }
  const ids = new Set();
  for (const o of out) {
    if (ids.has(o.id)) throw new Error(`duplicate operationId ${o.id}`);
    ids.add(o.id);
  }
  return out;
}

/** The operations the collections and per-endpoint examples cover: HTTP calls a person can make with a client. */
export const isCallable = (o) => !o.websocket && !o.html && o.path !== "/dashboard/{file}";

/** Operations grouped by tag, in the tag order of the spec. */
export function byTag(ops) {
  const groups = new Map();
  for (const o of [...ops].sort((a, b) => a.tagIndex - b.tagIndex)) {
    if (!groups.has(o.tag)) groups.set(o.tag, []);
    groups.get(o.tag).push(o);
  }
  return groups;
}

// --- example values -------------------------------------------------------------------------------------------------

/** Values that make examples runnable in demo mode and safe anywhere: a paper account and well-known symbols. */
export const HINTS = Object.freeze({
  account: "demo-paper",
  accountId: "demo-paper",
  symbol: "NSE:RELIANCE",
  symbols: "NSE:RELIANCE,NSE:NIFTY",
  underlying: "NIFTY",
  expiry: "2026-11-24",
  interval: "5m",
  q: "RELIANCE",
  input: "NSE:RELIANCE",
  side: "BUY",
  product: "CNC",
  orderType: "MARKET",
  mode: "paper",
  from: "2026-11-02",
  to: "2026-11-06",
  day: "2026-11-06",
  keyId: "<keyId>",
  orderId: "<orderId>",
  clientOrderId: "<clientOrderId>",
  ticketId: "<ticketId>",
  hookId: "<hookId>",
  id: "demo",
  source: "generic",
  token: "<hook token>",
  field: "ltp",
  capability: "quotes",
});

const fmtSamples = { "date-time": "2026-10-19T10:00:00+05:30", date: "2026-10-27", uri: "https://example.com/", email: "me@example.com" };

/** A minimal valid value for `schema`: required properties only, first enum value, defaults and examples first. */
export function sample(spec, schema, hint = null, depth = 0) {
  if (depth > 6 || schema === undefined || schema === null) return null;
  const s = deref(spec, schema);
  if (s === true || s === false) return null;
  if (hint && Object.hasOwn(HINTS, hint) && (s.type === "string" || (s.enum && typeof s.enum[0] === "string") || s.$ref || !s.type)) {
    const h = HINTS[hint];
    if (!s.enum || s.enum.includes(h)) return h;
  }
  if (s.example !== undefined) return s.example;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (s.const !== undefined) return s.const;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum)) return s.enum.find((v) => v !== null) ?? null;
  if (s.allOf) return s.allOf.reduce((acc, part) => ({ ...acc, ...(sample(spec, part, hint, depth + 1) ?? {}) }), {});
  const alt = s.oneOf ?? s.anyOf;
  if (alt && !s.properties) {
    const pick = alt.find((a) => deref(spec, a).type !== "null") ?? alt[0];
    return sample(spec, pick, hint, depth + 1);
  }
  const type = Array.isArray(s.type) ? (s.type.find((t) => t !== "null") ?? "null") : s.type ?? (s.properties ? "object" : undefined);
  switch (type) {
    case "object": {
      const out = {};
      const required = new Set(s.required ?? []);
      // A oneOf of bare `required` lists (send this or that): take the first alternative's fields.
      const first = Array.isArray(s.oneOf) ? s.oneOf[0] : null;
      for (const r of first?.required ?? []) required.add(r);
      for (const [name, prop] of Object.entries(s.properties ?? {})) if (required.has(name)) out[name] = sample(spec, prop, name, depth + 1);
      return out;
    }
    case "array": {
      const n = Math.max(s.minItems ?? 0, depth === 0 ? 0 : 1);
      return Array.from({ length: n }, () => sample(spec, s.items ?? {}, hint, depth + 1));
    }
    case "integer":
    case "number":
      if (typeof s.minimum === "number") return s.minimum;
      if (typeof s.exclusiveMinimum === "number") return s.exclusiveMinimum + 1;
      return 1;
    case "boolean":
      return false;
    case "string": {
      if (s.format && fmtSamples[s.format]) return fmtSamples[s.format];
      const min = s.minLength ?? 1;
      if (min <= 1) return hint ? `<${hint}>` : "string";
      return "x".repeat(Math.min(min, 40));
    }
    default:
      return null;
  }
}

/** Order-stable JSON (object keys sorted, two-space indent): the same input always gives the same text. */
export function stableJson(value, indent = 2) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    return v;
  };
  return JSON.stringify(sort(value), null, indent);
}
