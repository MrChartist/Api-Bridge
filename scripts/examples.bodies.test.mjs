/**
 * The request bodies that the docs, Postman and Bruno ship must work as delivered.
 *   1. Every example body validates against its request schema (the few that hold a placeholder only you can fill in are named).
 *   2. Every example in docs/openapi.yaml (request and response) validates against its schema.
 *   3. The calls a demo Bridge can answer are replayed in collection order, the way Postman and Bruno run them: a call that
 *      creates something stores its id (CAPTURES in scripts/lib/examples.mjs) and the calls after it read it. All must succeed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootDemoBridge } from "../server/bridge/core/__fixtures__/demoBridge.mjs";
import { CAPTURES, requestExample, queryString } from "./lib/examples.mjs";
import { validate } from "./lib/json-schema-lite.mjs";
import { isCallable, loadSpec, operations } from "./lib/openapi-model.mjs";

const spec = loadSpec();
const ops = operations(spec).filter(isCallable);
const byId = new Map(ops.map((o) => [o.id, o]));

/** Bodies that hold a value only you have (a code from the dashboard, a broker key) or that change nothing yet; each says why. */
const PLACEHOLDER_BODY = {
  signIn: "the one-time code comes from `mc-bridge open`",
};

describe("example request bodies", () => {
  for (const op of ops.filter((o) => o.requestBody && !o.requestBody.schema?.$ref?.endsWith("Compat"))) {
    it(`${op.id}: the body in the docs, Postman and Bruno is valid`, () => {
      const ex = requestExample(spec, op);
      if (PLACEHOLDER_BODY[op.id]) return;
      const errors = validate(spec, op.requestBody.schema, ex.body, { maxErrors: 5 });
      expect(errors, `${op.id} body ${ex.bodyText}\n${errors.map((e) => `${e.path}: ${e.message}`).join("\n")}`).toEqual([]);
    });
  }

  it("names no placeholder body that is not there any more", () => {
    for (const id of Object.keys(PLACEHOLDER_BODY)) expect(byId.has(id), id).toBe(true);
  });
});

describe("examples written in docs/openapi.yaml", () => {
  const all = operations(spec);
  it("there are request examples and response examples for the main operations", () => {
    const withReq = all.filter((o) => o.requestBody?.example !== undefined).map((o) => o.id);
    const withRes = all.filter((o) => o.responses.some((r) => r.example !== undefined)).map((o) => o.id);
    for (const id of ["placeOrder", "previewOrder", "createDownload", "createRecording", "createCollection", "createSubscription", "placeOrderToTarget", "placeOrderBatch"]) expect(withReq, id).toContain(id);
    for (const id of ["getLtp", "getQuotes", "getHistory", "getExpiries", "placeOrder", "createDownload", "createCollection"]) expect(withRes, id).toContain(id);
  });

  for (const op of all) {
    if (op.requestBody?.example !== undefined) {
      it(`${op.id}: the request example matches its schema`, () => {
        const errors = validate(spec, op.requestBody.schema, op.requestBody.example, { maxErrors: 5 });
        expect(errors.map((e) => `${e.path}: ${e.message}`)).toEqual([]);
      });
    }
    for (const r of op.responses.filter((x) => x.example !== undefined && x.schema)) {
      it(`${op.id}: the ${r.status} answer example matches its schema`, () => {
        const errors = validate(spec, r.schema, r.example, { maxErrors: 5 });
        expect(errors.map((e) => `${e.path}: ${e.message}`)).toEqual([]);
      });
    }
  }
});

const getPath = (obj, path) =>
  path.split(/[.[\]]+/).filter(Boolean).reduce((acc, k) => (acc === undefined || acc === null ? undefined : acc[k]), obj);

describe("a demo Bridge accepts the examples when they are run in collection order", () => {
  let b;
  const vars = {};
  const ran = [];
  beforeAll(async () => {
    b = await bootDemoBridge({ raw: { events: { webhooks: { allowPrivateTargets: true } } } });
  });
  afterAll(() => b?.close());

  /** The order a person works through: reads that find values, creates that store ids, then the calls that use them. */
  const FLOW = [
    "getExpiries", "getOptionChain", "xlChain",
    "placeOrder", "getOrder", "previewOrder", "placeOrderToTarget", "placeOrderBatch", "marginBasket",
    "createCollection", "getCollection", "updateCollection", "duplicateCollection", "importCollections", "resolveCollection",
    "createDownload", "updateDownload", "getDownload",
    "createRecording", "pauseRecording", "resumeRecording", "stopRecording",
    "createRecordingRule", "patchRecordingRule", "getRecordingRule",
    "createHook", "testHook",
    "createKey", "setQuota",
    "createSubscription", "updateSubscription",
  ];

  for (const id of FLOW) {
    it(`${id}`, async () => {
      const op = byId.get(id);
      expect(op, `${id} is not an operation any more: update FLOW`).toBeTruthy();
      const ex = requestExample(spec, op);
      let path = op.path;
      for (const p of ex.pathParams) path = path.replace(`{${p.name}}`, encodeURIComponent(p.var && vars[p.var] !== undefined ? vars[p.var] : p.value));
      const withVars = { ...ex, query: ex.query.map((q) => (q.var && vars[q.var] !== undefined ? { ...q, value: vars[q.var], var: null } : q)) };
      const qs = queryString(withVars);
      const headers = {};
      for (const h of ex.headers) headers[h.name] = h.name === "Idempotency-Key" ? `flow-${id}-${Math.random().toString(36).slice(2, 10)}` : h.value;
      const res = await b.call(op.method, `${path}${qs ? `?${qs}` : ""}`, { body: ex.bodyText ?? undefined, headers });
      expect(res.status, `${op.method} ${path}: ${res.text.slice(0, 300)}`).toBeLessThan(300);
      for (const [name, where] of Object.entries(CAPTURES[id] ?? {})) {
        const v = getPath(res.json, where);
        expect(v, `${id} should give ${name} at ${where}`).toBeTruthy();
        vars[name] = v;
      }
      ran.push(id);
    });
  }

  it("every call that stores a variable was run, so the variables the collections use all get filled", () => {
    for (const id of Object.keys(CAPTURES)) expect(ran, id).toContain(id);
  });

  it("the ids the later calls used came from the earlier ones", () => {
    expect(Object.keys(vars).sort()).toEqual(Object.values(CAPTURES).flatMap((c) => Object.keys(c)).sort());
    expect(vars.orderId).toMatch(/^PAPER-/);
  });
});
