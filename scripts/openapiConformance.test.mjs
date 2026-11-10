/**
 * Real answers must match docs/openapi.yaml. This boots a demo Bridge (sample data, paper account, nothing leaves
 * 127.0.0.1), puts a little of everything in it (a paper order, a download and its dataset, a recording and a rule, a
 * collection, a hook, a webhook subscription), then calls every GET operation that a client can call with a plain
 * request and checks:
 *   - the status is the documented success status;
 *   - the content type is the documented one;
 *   - a JSON body validates against the documented response schema (scripts/lib/json-schema-lite.mjs);
 *   - the same call without a key is a 401 problem+json that validates against the Problem schema.
 * A new GET route that this cannot call (it needs something the seed does not make) must be listed in NEEDS_STATE with
 * the reason, so nothing is skipped by accident; the count of calls made is asserted to stay high.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootDemoBridge } from "../server/bridge/core/__fixtures__/demoBridge.mjs";
import { HINTS, isCallable, loadSpec, operations, sample } from "./lib/openapi-model.mjs";
import { validate } from "./lib/json-schema-lite.mjs";

const spec = loadSpec();
const ops = operations(spec).filter((o) => o.method === "GET" && isCallable(o));

/** GET operations that are not plain requests, with the reason. */
const NOT_PLAIN = {
  openSse: "event stream, needs a one-time token",
  openEventStream: "event stream, needs a one-time token",
  getOpenApi: "the spec itself (YAML)",
};
/** GET operations the seed cannot reach with a valid request; each says what it would need. */
const NEEDS_STATE = {
  getRecordingFile: "a recording only has day files after a trading session",
};

describe("real answers match docs/openapi.yaml", () => {
  let b;
  const seed = {};
  const calls = [];
  /** The writes the seed made, checked below against their documented answers too. */
  const writes = [];

  beforeAll(async () => {
    b = await bootDemoBridge({ raw: { events: { webhooks: { allowPrivateTargets: true } } } });
    const ok = async (method, path, body, want) => {
      const r = await b.call(method, path, { body, headers: path === "/v1/orders" ? { "Idempotency-Key": `conformance-${Math.random().toString(36).slice(2, 12)}` } : {} });
      expect(want, `${method} ${path}: ${r.text.slice(0, 300)}`).toContain(r.status);
      writes.push({ method, path, status: r.status, json: r.json });
      return r.json?.data;
    };
    const ex = await b.call("GET", "/v1/expiries?underlying=NIFTY");
    seed.expiry = ex.json?.data?.expiries?.[0] ?? ex.json?.data?.[0];
    const q = await b.call("GET", "/v1/ltp?symbols=NSE:RELIANCE");
    const price = Math.round((q.json.data[0].ltp * 0.99) / 0.1) * 0.1;
    const order = await ok("POST", "/v1/orders", { account: "demo-paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: Number(price.toFixed(1)), clientOrderId: "conformance-1" }, [200, 201]);
    seed.orderId = order.orderId;
    seed.clientOrderId = "conformance-1";
    const job = await ok("POST", "/v1/downloads", { symbols: ["NSE:RELIANCE"], intervals: ["1d"], from: "2026-10-01", to: "2026-10-30", dataset: "conf-ds" }, [202]);
    seed.downloadId = job.id;
    for (let i = 0; i < 100; i += 1) {
      const j = (await b.call("GET", `/v1/downloads/${job.id}`)).json.data;
      if (["done", "failed", "cancelled"].includes(j.status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    seed.fileName = (await b.call("GET", `/v1/downloads/${job.id}/files`)).json?.data?.[0]?.name;
    seed.recordingId = (await ok("POST", "/v1/recordings", { kind: "quotes", symbols: ["NSE:RELIANCE"], everySec: 5 }, [201])).id;
    seed.ruleId = (await ok("POST", "/v1/recordings/rules", { name: "conf-rule", kind: "quotes", symbols: ["NSE:INFY"], everySec: 5 }, [201])).id;
    await ok("POST", "/v1/collections", { name: "conf-col", symbols: ["NSE:RELIANCE", "NSE:INFY"], tags: ["conf"] }, [201]);
    seed.hookId = (await ok("POST", "/v1/hooks", { source: "generic", label: "conf-hook", account: "demo-paper" }, [201])).id;
    seed.subscriptionId = (await ok("POST", "/v1/subscriptions", { url: "http://127.0.0.1:9/in", topics: ["order.*"], secret: "0123456789abcdef-secret" }, [201])).id;
    await ok("PATCH", "/v1/sources/settings", { autoFallback: false }, [200]);
  });
  afterAll(async () => {
    await b?.close();
    console.info(`openapi conformance: ${calls.length} GET operations called and validated`);
  });

  /** The value for one path or query parameter. */
  function valueFor(op, p) {
    const byOp = {
      getCollection: { name: "conf-col" },
      resolveCollection: { name: "conf-col" },
      exportCollection: { name: "conf-col" },
      getCollectionUsage: { name: "conf-col" },
      estimateCollection: { name: "conf-col", intervals: "1d", days: 30 },
      getDataset: { name: "conf-ds" },
      getDownloadFile: { name: seed.fileName },
      getDatasetFile: { name: "conf-ds", file: seed.fileName },
      getRecordingFile: { name: "none.csv" },
    }[op.id];
    if (byOp && Object.hasOwn(byOp, p.name)) return byOp[p.name];
    const fromSeed = { orderId: seed.orderId, clientOrderId: seed.clientOrderId, downloadId: seed.downloadId, recordingId: seed.recordingId, ruleId: seed.ruleId, hookId: seed.hookId, subscriptionId: seed.subscriptionId, expiry: seed.expiry };
    if (fromSeed[p.name] !== undefined) return fromSeed[p.name];
    if (p.name === "symbol" && op.id === "getInstrument") return "NSE:RELIANCE";
    if (p.name === "interval") return "1d";
    if (Object.hasOwn(HINTS, p.name)) return HINTS[p.name];
    return sample(spec, p.schema, p.name);
  }

  function urlFor(op) {
    let path = op.path;
    const query = new URLSearchParams();
    for (const p of op.parameters) {
      if (p.in === "path") path = path.replace(`{${p.name}}`, encodeURIComponent(String(valueFor(op, p))));
      else if (p.in === "query" && p.required) query.set(p.name, String(valueFor(op, p)));
    }
    if (op.id === "getHistory") query.set("countback", "5");
    if (op.id === "xlQuotes") query.set("symbols", "NSE:RELIANCE,NSE:INFY");
    const qs = query.toString();
    return qs ? `${path}?${qs}` : path;
  }

  const callable = ops.filter((o) => !NOT_PLAIN[o.id] && !NEEDS_STATE[o.id]);

  it("skips only what it says it skips", () => {
    for (const id of [...Object.keys(NOT_PLAIN), ...Object.keys(NEEDS_STATE)]) expect(ops.some((o) => o.id === id), `${id} is not a GET operation any more: remove it from the skip list`).toBe(true);
    expect(callable.length).toBeGreaterThan(70);
  });

  for (const op of callable) {
    const documented = op.responses.find((r) => r.status === "200");
    it(`${op.id}: GET ${op.path}`, async () => {
      const url = urlFor(op);
      expect(url, "an unfilled placeholder").not.toMatch(/<[A-Za-z]/);
      const res = await b.call("GET", url, { auth: op.noAuth ? null : b.key });
      expect(res.status, `${url}: ${res.text.slice(0, 300)}`).toBe(200);
      calls.push(op.id);
      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
      if (documented?.contentType) expect(type, `${url} content type`).toBe(documented.contentType);
      if (documented?.contentType === "application/json" && documented.schema) {
        const errors = validate(spec, documented.schema, res.json, { maxErrors: 8 });
        expect(errors, `${op.id} (${url}) does not match its documented schema:\n${errors.map((e) => `  ${e.path}: ${e.message}`).join("\n")}\nbody: ${res.text.slice(0, 400)}`).toEqual([]);
      }
    });
  }

  it("the writes that seeded the Bridge answer as documented too", () => {
    const all = operations(spec);
    expect(writes.length).toBeGreaterThanOrEqual(8);
    for (const w of writes) {
      const op = all.find((o) => o.method === w.method && o.path === w.path);
      expect(op, `${w.method} ${w.path} is documented`).toBeTruthy();
      const documented = op.responses.find((r) => r.status === String(w.status));
      expect(documented, `${w.method} ${w.path} documents a ${w.status} answer`).toBeTruthy();
      if (documented.schema) {
        const errors = validate(spec, documented.schema, w.json, { maxErrors: 8 });
        expect(errors, `${w.method} ${w.path} (${w.status}) does not match its schema:\n${errors.map((e) => `  ${e.path}: ${e.message}`).join("\n")}\nbody: ${JSON.stringify(w.json).slice(0, 400)}`).toEqual([]);
      }
    }
  });

  it("a call without a key is a 401 problem that matches the Problem schema (every key-protected GET)", async () => {
    const problem = spec.components.schemas.Problem;
    const bad = [];
    let n = 0;
    for (const op of callable.filter((o) => !o.noAuth && !o.queryKey)) {
      const res = await b.call("GET", urlFor(op), { auth: null });
      n += 1;
      const errors = res.json ? validate(spec, problem, res.json, { maxErrors: 3 }) : [{ path: "", message: "not JSON" }];
      if (res.status !== 401 || !res.headers.get("content-type")?.startsWith("application/problem+json") || errors.length) bad.push(`${op.id}: ${res.status} ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
    }
    expect(bad).toEqual([]);
    expect(n).toBeGreaterThan(50);
  });
});
