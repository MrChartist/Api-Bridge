/**
 * The dashboard and the server must agree on every request. Three checks, all against docs/openapi.yaml (which the server's own
 * tests keep equal to the real routes and validators):
 *
 *   1. Every `api("/v1/...")` call in the dashboard code, and every call the Data page's client can make, names a method and a
 *      path the server has. (Found by reading the source, so a new call is covered the day it is written.)
 *   2. The request bodies the dashboard builds with its pure helpers (keys, apps, receivers, downloads, collections, recordings,
 *      orders, tickets, sign-in to a broker) are valid against the schema of the route they are sent to, and name no field it does
 *      not list. Several of these used to be written inline in a click handler; they are helpers so they can be checked here.
 *   3. The bodies still written inline in a call (`body: { reason, cancelOpenOrders }`) name only fields the route's schema
 *      lists, and leave out none that it requires.
 *
 * The same pattern as the events and recorder dashboard contract tests (a body the page built, held up to the server's rules), for
 * the rest of the page. A drift (the page sends a field the server refuses) fails here instead of when someone clicks.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deref, loadSpec, operations } from "../../../scripts/lib/openapi-model.mjs";
import { undeclaredFields, validate } from "../../../scripts/lib/json-schema-lite.mjs";
import { appBody, receiverBody, APP_PRESETS } from "./developers-core.js";
import { collectionBody, createDataClient, downloadBody, recordingBody, buildUniverse, defaultUniverse, RECORD_PRESETS } from "./data-core.js";
import { modifyChange } from "./flows.js";
import { cancelAllBody, declineBody, placeAgainBody } from "./orders-core.js";
import { KEY_PRESETS, presetKeyBody } from "./snippets.js";
import { loginBody } from "./app.js";

const DIR = import.meta.dirname;
const spec = loadSpec();
const ops = operations(spec);

// ── helpers: spec side ──

/** A spec path as a regex over concrete paths ({id} matches one segment). */
const specRoutes = ops.map((o) => ({ op: o, params: (o.path.match(/\{[^}]+\}/g) ?? []).length, re: new RegExp(`^${o.path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/]+")}$`) }));

/** The operation a concrete (method, path) reaches, preferring the route with the fewest parameters; null when the server has none. */
function opFor(method, path) {
  const clean = path.split("?")[0];
  const hits = specRoutes.filter((r) => r.op.method === method && r.re.test(clean)).sort((a, b) => a.params - b.params);
  return hits[0]?.op ?? null;
}

/** Every property name a schema lists (through $ref, allOf, oneOf, anyOf) and the ones every body must have. */
function shapeOf(schema, out = { props: new Set(), required: new Set(), open: false, branches: false }, depth = 0) {
  if (!schema || depth > 12) return out;
  const s = deref(spec, schema);
  if (!s || typeof s !== "object") return out;
  for (const k of Object.keys(s.properties ?? {})) out.props.add(k);
  for (const k of s.required ?? []) out.required.add(k);
  if (s.additionalProperties === true) out.open = true;
  for (const part of s.allOf ?? []) shapeOf(part, out, depth + 1);
  for (const key of ["oneOf", "anyOf"]) {
    if (!s[key]) continue;
    out.branches = true;
    for (const part of s[key]) shapeOf(part, out, depth + 1);
  }
  return out;
}

/** One property's schema of a route's request body. */
function shapeOfProp(method, path, prop) {
  const op = opFor(method, path);
  return deref(spec, deref(spec, op.requestBody.schema).properties[prop]);
}

/** Hold a body up to the route it is sent to: the route exists, takes a body, the body is valid and names no unknown field. */
function expectAccepted(label, method, path, body) {
  const op = opFor(method, path);
  expect(op, `${label}: the server has no ${method} ${path}`).not.toBeNull();
  expect(op.requestBody, `${label}: ${op.id} takes no body`).not.toBeNull();
  const errors = validate(spec, op.requestBody.schema, body, { maxErrors: 6 });
  expect(errors.map((e) => `${e.path}: ${e.message}`), `${label} -> ${op.id}\n${JSON.stringify(body)}`).toEqual([]);
  expect(undeclaredFields(spec, op.requestBody.schema, body), `${label}: fields ${op.id} does not list`).toEqual([]);
}

// ── helpers: source side ──

function files() {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".js"))
    .map((f) => ({ name: f, src: readFileSync(join(DIR, f), "utf8") }));
}

/** Index after the string, template or comment that starts at i (src[i] is its opening quote); handles `${ ... }` nesting. */
function skipQuoted(src, i) {
  const q = src[i];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") j += 2;
    else if (c === q) return j + 1;
    else if (q === "`" && c === "$" && src[j + 1] === "{") j = skipBraces(src, j + 1);
    else j += 1;
  }
  return j;
}

/** Index after the {...} / (...) / [...] group that opens at i. */
function skipBraces(src, i) {
  const open = src[i];
  const close = { "{": "}", "(": ")", "[": "]" }[open];
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'" || c === "`") j = skipQuoted(src, j);
    else if (c === "/" && src[j + 1] === "/") j = src.indexOf("\n", j);
    else if (c === "/" && src[j + 1] === "*") j = src.indexOf("*/", j) + 2;
    else {
      if (c === open) depth += 1;
      else if (c === close) {
        depth -= 1;
        if (depth === 0) return j + 1;
      }
      j += 1;
    }
    if (j < 0) return src.length;
  }
  return j;
}

/** Split the text of an argument list or object literal at its top-level commas. */
function topLevelParts(text) {
  const parts = [];
  let start = 0;
  let j = 0;
  while (j < text.length) {
    const c = text[j];
    if (c === '"' || c === "'" || c === "`") j = skipQuoted(text, j);
    else if (c === "{" || c === "(" || c === "[") j = skipBraces(text, j);
    else if (c === ",") {
      parts.push(text.slice(start, j));
      start = j + 1;
      j += 1;
    } else j += 1;
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** The path a string or template literal argument names, with each `${...}` as one segment (or dropped after a segment: a query). */
function literalPath(arg) {
  const t = arg.trim();
  if (!/^["'`]/.test(t) || !t.endsWith(t[0])) return null;
  let body = t.slice(1, -1);
  if (t[0] === "`") {
    let out = "";
    for (let i = 0; i < body.length; ) {
      if (body[i] === "$" && body[i + 1] === "{") {
        const end = skipBraces(body, i + 1);
        out += out.endsWith("/") || out === "" ? "x" : "";
        i = end;
      } else out += body[i++];
    }
    body = out;
  }
  return body.startsWith("/v1/") ? body : null;
}

/** Every api("/v1/...", { method, body }) call in the dashboard code: { file, line, method, path, body } (body: the literal's text or null). */
function apiCalls() {
  const calls = [];
  for (const { name, src } of files()) {
    for (const m of src.matchAll(/(?<![\w.$])api\(/g)) {
      const open = m.index + m[0].length - 1;
      const argsText = src.slice(open + 1, skipBraces(src, open) - 1);
      const [first, second] = topLevelParts(argsText);
      const path = first ? literalPath(first) : null;
      if (!path) continue;
      let method = "GET";
      let body = null;
      if (second?.startsWith("{")) {
        const props = topLevelParts(second.slice(1, -1));
        for (const p of props) {
          const mm = /^method:\s*["'](\w+)["']/.exec(p);
          if (mm) method = mm[1].toUpperCase();
          const bm = /^body:\s*([\s\S]*)$/.exec(p);
          if (bm) body = bm[1].trim();
        }
      }
      calls.push({ file: name, line: src.slice(0, m.index).split("\n").length, method, path, body });
    }
  }
  return calls;
}

/** The keys of an object literal's text, and whether it spreads something (so its keys are not all known). */
function literalKeys(text) {
  if (!text.startsWith("{")) return null;
  const keys = [];
  let spread = false;
  for (const p of topLevelParts(text.slice(1, -1))) {
    if (p.startsWith("...")) spread = true;
    else {
      const m = /^(?:["']([\w-]+)["']|([A-Za-z_$][\w$]*))\s*(?::|$)/.exec(p);
      if (m) keys.push(m[1] ?? m[2]);
    }
  }
  return { keys, spread };
}

const CALLS = apiCalls();

// ── 1. every call names a route the server has ──

describe("every request the dashboard code makes names a route the server has", () => {
  it("the scan reads the calls it should (a number far below this means the scan broke)", () => {
    expect(CALLS.length).toBeGreaterThan(100);
    expect(CALLS.filter((c) => c.method !== "GET").length).toBeGreaterThan(30);
  });

  it("api(\"/v1/...\") calls: method and path exist in docs/openapi.yaml", () => {
    const missing = CALLS.filter((c) => !opFor(c.method, c.path)).map((c) => `${c.file}:${c.line} ${c.method} ${c.path}`);
    expect(missing).toEqual([]);
  });

  it("the Data page client: every route it can call exists, with the methods and paths it uses", () => {
    const seen = [];
    const client = createDataClient(async (method, path, body) => {
      seen.push({ method, path, body });
      return { data: {} };
    });
    const walk = async (node) => {
      for (const v of Object.values(node)) {
        if (typeof v === "function") {
          await v("x", {});
          await v({}, {});
        } else if (v && typeof v === "object") await walk(v);
      }
    };
    return walk(client).then(() => {
      expect(seen.length).toBeGreaterThan(30);
      const missing = [...new Set(seen.map((s) => `${s.method} ${s.path.replace(/\/x(?=\/|$|\?)/g, "/{}").split("?")[0]}`))].filter((k) => {
        const [method, path] = k.split(" ");
        return !opFor(method, path.replace(/\{\}/g, "x"));
      });
      expect(missing).toEqual([]);
    });
  });

  it("every spec operation a dashboard call reaches is one a browser may call (not a demo-only or websocket route)", () => {
    const bad = CALLS.map((c) => ({ c, op: opFor(c.method, c.path) })).filter(({ op }) => op && op.websocket);
    expect(bad.map(({ c }) => `${c.file}:${c.line}`)).toEqual([]);
  });
});

// ── 2. the bodies the pure helpers build ──

describe("request bodies built by the dashboard helpers are accepted by the server's schemas", () => {
  it("keys for each integration preset, and the Excel panel's variants", () => {
    const now = new Date("2026-11-10T06:00:00Z");
    for (const [id, preset] of Object.entries(KEY_PRESETS)) expectAccepted(`key preset ${id}`, "POST", "/v1/keys", presetKeyBody(preset, { now }));
    for (const [urlKey, accounts, days] of [[true, "*", 7], [false, ["demo-paper"], 30], [true, ["a1", "b2"], 90]]) {
      expectAccepted("excel key", "POST", "/v1/keys", presetKeyBody(KEY_PRESETS.excel, { label: "Excel prices · 10 Nov", accounts, expiresDays: days, allowQuery: urlKey, now }));
    }
    // The body's shape matches the long-standing inline version: scopes and kind from the preset, expiry only when it has one.
    expect(presetKeyBody(KEY_PRESETS.python, { now })).toEqual({ label: "Python scripts", scopes: ["paper"], accounts: "*", clientKind: "script" });
    expect(presetKeyBody(KEY_PRESETS.excel, { now }).expiresAt).toBe("2027-02-08T06:00:00.000Z");
  });

  it("keys for each app preset on the Developers page, for every account choice and expiry", () => {
    const now = new Date("2026-11-10T06:00:00Z");
    for (const p of APP_PRESETS) {
      for (const [account, expiresDays] of [["*", undefined], ["demo-paper", ""], ["*", "30"]]) {
        const { body, error } = appBody(p.id, { name: `${p.id} app`, account, expiresDays, now });
        expect(error, p.id).toBeUndefined();
        expectAccepted(`app preset ${p.id}`, "POST", "/v1/keys", body);
      }
    }
  });

  it("webhook receivers, for all topics and for chosen ones", () => {
    const every = ["order.updated", "order.placed", "download.done", "download.failed", "safety.kill_switch"]; // `allTopics` is the list the Bridge offers
    const secret = "a-secret-that-is-long-enough";
    expectAccepted("receiver, every topic", "POST", "/v1/subscriptions", receiverBody({ url: "https://example.org/hook", label: "My receiver", topics: every, allTopics: every, secret }));
    expectAccepted("receiver, one family", "POST", "/v1/subscriptions", receiverBody({ url: "https://example.org/hook", label: "", topics: ["order.updated", "order.placed"], allTopics: every, secret }));
    expectAccepted("receiver, single topics", "POST", "/v1/subscriptions", receiverBody({ url: " https://example.org/hook ", label: "x".repeat(80), topics: ["order.updated", "download.done"], allTopics: every, secret }));
  });

  it("downloads: every shape the wizard can produce", () => {
    const base = { collection: "", symbols: ["NSE:RELIANCE", "NSE:INFY"], intervals: ["5m"], range: "1m", format: "csv", layout: "per-symbol", name: "", keep: false, dataset: "" };
    const dates = { from: "2026-10-10", to: "2026-11-10" };
    const states = {
      "plain": base,
      "named, combined, jsonl": { ...base, name: " Large caps ", layout: "combined", format: "jsonl", intervals: ["1d", "15m"] },
      "from a collection": { ...base, collection: "nifty-50", symbols: [] },
      "kept as a dataset": { ...base, keep: true, dataset: "nifty-5m" },
      "custom dates": { ...base, range: "custom" },
      "amibroker": { ...base, format: "amibroker" },
    };
    for (const [what, st] of Object.entries(states)) expectAccepted(`download ${what}`, "POST", "/v1/downloads", downloadBody(st, dates));
    expect(downloadBody({ ...base, range: "1m" }, dates)).not.toHaveProperty("to"); // a preset range runs to now
    expect(downloadBody({ ...base, range: "custom" }, dates).to).toBe("2026-11-10");
    expect(downloadBody({ ...base, keep: true, dataset: "" }, dates)).not.toHaveProperty("dataset");
  });

  it("collections: a static list and an option universe, to create and to change", () => {
    const form = { name: "my-list", description: " big ones ", tags: "index, weekly", kind: "static", symbols: "NSE:RELIANCE\nNSE:INFY", u: defaultUniverse("NIFTY") };
    const universes = [
      buildUniverse({ underlying: "banknifty", expiries: "next-weekly", strikes: { around: "atm", count: 5 }, sides: ["CE"] }),
      buildUniverse({ underlying: "NIFTY", expiries: ["2026-11-24"], strikes: { from: 24000, to: 25000 }, includeFuture: true }),
      buildUniverse({}),
    ];
    const staticBody = collectionBody(form);
    expect(staticBody.error).toBeUndefined();
    expectAccepted("static collection", "POST", "/v1/collections", staticBody.body);
    const { name: _name, kind: _kind, ...patch } = staticBody.body;
    expectAccepted("static collection, change", "PATCH", "/v1/collections/my-list", patch);
    for (const u of universes) {
      const made = collectionBody({ ...form, kind: "option-universe", u });
      expect(made.error, JSON.stringify(u)).toBeUndefined();
      expectAccepted("option universe", "POST", "/v1/collections", made.body);
      expectAccepted("option universe, dry run", "POST", "/v1/collections/resolve", { kind: "option-universe", universe: u });
      const { name: _n, kind: _k, ...p2 } = made.body;
      expectAccepted("option universe, change", "PATCH", "/v1/collections/my-list", p2);
    }
    // Whatever name the form lets through, the server must accept: the form's check and the server's pattern cannot disagree
    // (the form once allowed spaces, which the server refuses).
    const pattern = new RegExp(shapeOfProp("POST", "/v1/collections", "name").pattern);
    for (const name of ["Nifty 50", "my list", "nifty-50", "a_b.c", "-x", ".x", "x/y", "x".repeat(40), "é", "a b-c", "123"]) {
      const allowed = collectionBody({ ...form, name }).error === undefined;
      expect(allowed, `name ${JSON.stringify(name)}: form says ${allowed ? "ok" : "no"}, server pattern says ${pattern.test(name) ? "ok" : "no"}`).toBe(allowed && pattern.test(name));
    }
    expect(collectionBody({ ...form, name: "" }).error).toBeTruthy();
    expect(collectionBody({ ...form, symbols: "" }).error?.title).toMatch(/at least one symbol/);
  });

  it("recordings and auto-record rules: every preset and form the page makes (also checked against the recorder's own schemas)", () => {
    const base = { name: "", everySec: 30, format: "csv", expiries: "current-weekly", count: 10, keepDays: "", custom: false, days: ["Mon", "Tue", "Wed", "Thu", "Fri"], start: "", end: "" };
    const forms = [
      { ...base, kind: "chain", source: "index", underlying: "nifty" },
      { ...base, kind: "chain", source: "collection", collection: "nifty-chain", custom: true, start: "09:15", end: "15:30", keepDays: "30" },
      { ...base, kind: "quotes", source: "symbols", symbols: ["NSE:RELIANCE"], everySec: 5, format: "jsonl" },
      { ...base, kind: "quotes", source: "collection", collection: "watchlist", everySec: 5 },
    ];
    for (const f of forms) {
      expectAccepted(`rule ${f.kind}/${f.source}`, "POST", "/v1/recordings/rules", recordingBody(f, "rule"));
      expectAccepted(`recording ${f.kind}/${f.source}`, "POST", "/v1/recordings", recordingBody(f, "once"));
    }
    for (const preset of RECORD_PRESETS) for (const body of preset.build({ collection: "watchlist" })) expectAccepted(`preset ${preset.id}`, "POST", "/v1/recordings/rules", body);
  });

  it("orders: modify (limit, stop-loss, quantity only), place again after an undo, cancel all, decline a ticket", () => {
    const order = { quantity: 50, filledQuantity: 0, price: 100, triggerPrice: 99, side: "BUY" };
    for (const arg of [
      { lots: "2", lotSize: 25, order, price: "101.5", limit: true },
      { lots: "40", lotSize: 1, order, price: "", limit: false },
      { lots: "3", lotSize: 25, order, price: "102", limit: true, trigger: "100.5", stop: true },
    ]) {
      const c = modifyChange(arg);
      expect(c.error, JSON.stringify(arg)).toBeUndefined();
      expectAccepted("modify", "PATCH", "/v1/orders/ord_1", c.body);
    }
    expectAccepted("place again", "POST", "/v1/orders", placeAgainBody({ accountId: "demo-paper", symbol: "NSE:RELIANCE", side: "BUY", product: "CNC", orderType: "LIMIT", price: 1400, tag: "t1" }, 3));
    expectAccepted("place again, stop-loss", "POST", "/v1/orders", placeAgainBody({ accountId: "demo-paper", symbol: "NSE:RELIANCE", side: "SELL", product: "INTRADAY", orderType: "SL", price: 1400, triggerPrice: 1405, validity: "IOC" }, 1));
    expectAccepted("cancel all", "POST", "/v1/orders/cancel-all", cancelAllBody(false));
    expectAccepted("cancel all, also outside orders", "POST", "/v1/orders/cancel-all", cancelAllBody(true));
    expectAccepted("cancel all, dry run", "POST", "/v1/orders/cancel-all", { dryRun: true });
    expectAccepted("decline with a reason", "POST", "/v1/tickets/tkt_1/reject", declineBody("  wrong   quantity "));
    expectAccepted("decline without one", "POST", "/v1/tickets/tkt_1/reject", declineBody(""));
  });

  it("signing in to a broker: with and without secrets", () => {
    const spec2 = { fields: [{ key: "clientId", group: "values" }, { key: "pin", group: "secrets" }, { key: "totp", group: "secrets" }] };
    const answers = { clientId: " A123 ", pin: "1234", totp: "" };
    expectAccepted("sign in", "POST", "/v1/accounts/dhan-main/session", loginBody(spec2, (f) => answers[f.key]));
    expectAccepted("sign in, no secrets", "POST", "/v1/accounts/dhan-main/session", loginBody({ fields: [{ key: "clientId", group: "values" }] }, () => "A123"));
  });
});

// ── 3. bodies still written inline in a call ──

describe("bodies written inline in a call use only fields the route lists, and leave out none it requires", () => {
  const inline = CALLS.map((c) => ({ ...c, lit: c.body ? literalKeys(c.body) : null })).filter((c) => c.lit);

  it("there are inline bodies to check (the scan reads them)", () => {
    expect(inline.length).toBeGreaterThan(15);
  });

  it("every key an inline body names is listed by its route's schema", () => {
    const problems = [];
    for (const c of inline) {
      const op = opFor(c.method, c.path);
      if (!op?.requestBody) {
        if (op) problems.push(`${c.file}:${c.line} ${c.method} ${c.path} sends a body but ${op.id} takes none`);
        continue;
      }
      const shape = shapeOf(op.requestBody.schema);
      if (shape.open) continue;
      const unknown = c.lit.keys.filter((k) => !shape.props.has(k));
      if (unknown.length) problems.push(`${c.file}:${c.line} ${c.method} ${c.path} sends ${unknown.join(", ")}, which ${op.id} does not list`);
    }
    expect(problems).toEqual([]);
  });

  it("every field a route requires is in the inline body (when the body spreads nothing and the route has no alternative shapes)", () => {
    const problems = [];
    for (const c of inline) {
      const op = opFor(c.method, c.path);
      if (!op?.requestBody || c.lit.spread) continue;
      const shape = shapeOf(op.requestBody.schema);
      if (shape.branches) continue;
      const lacking = [...shape.required].filter((k) => !c.lit.keys.includes(k));
      if (lacking.length) problems.push(`${c.file}:${c.line} ${c.method} ${c.path} leaves out ${lacking.join(", ")}, which ${op.id} requires`);
    }
    expect(problems).toEqual([]);
  });
});

describe("the scan itself", () => {
  it("reads strings, templates with nested braces and comments without losing its place", () => {
    const src = 'api(`/v1/x/${f({ a: "}" })}/y`, { method: "POST", body: { a: 1, "b-c": `}`, ...rest } }) // api("/v1/zzz")';
    const open = src.indexOf("(");
    const [first, second] = topLevelParts(src.slice(open + 1, skipBraces(src, open) - 1));
    expect(literalPath(first)).toBe("/v1/x/x/y");
    expect(literalKeys(/body:\s*([\s\S]*?)\s*}$/.exec(second)[1])).toEqual({ keys: ["a", "b-c"], spread: true });
  });
});
