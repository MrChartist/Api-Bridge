/**
 * docs/openapi.yaml and the registered routes must agree: same paths and methods, same scope, same auth mode,
 * same loopback/public flags, and the same owning stream. A stream that adds, renames or re-scopes a route without
 * the lead updating the contract fails here.
 *
 * Demo-only routes (server/bridge/demo/routes.mjs) exist only in demo mode. They are marked `x-demo-only: true` in
 * the spec and listed in DEMO_ONLY below; the non-demo app must not have them, and a demo app must have exactly the
 * non-demo routes plus these.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.mjs";
import { BUILTIN_MODULES } from "./builtinModules.mjs";
import { loadConfig } from "./config.mjs";
import { ERROR_CODES } from "./errors.mjs";
import { createNullLogger } from "./logger.mjs";
import { DEMO_ROUTES, demoRouteKeys } from "../demo/routes.mjs";

/** Demo-only operations ("METHOD /openapi/path"). Each spec that adds a demo route adds its key here. */
const DEMO_ONLY = Object.freeze(["POST /v1/demo/readiness", "PUT /v1/demo/reference"]);

const SPEC = readFileSync(resolve(import.meta.dirname, "../../../docs/openapi.yaml"), "utf8");

/** Minimal line-based reader for the disciplined layout of docs/openapi.yaml. */
function readOperations(text) {
  const ops = [];
  let path = null;
  let op = null;
  let inPaths = false;
  for (const line of text.split("\n")) {
    if (/^paths:\s*$/.test(line)) inPaths = true;
    else if (/^\S/.test(line)) inPaths = false;
    if (!inPaths) continue;
    let m;
    if ((m = /^ {2}(\/\S*):\s*$/.exec(line))) {
      path = m[1];
      op = null;
    } else if ((m = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line))) {
      op = { method: m[1].toUpperCase(), path, scope: null, noAuth: false, websocket: false, loopbackOnly: false, public: false, stream: null, demoOnly: false };
      ops.push(op);
    } else if (op && (m = /^ {6}x-scope: (\w+)\s*$/.exec(line))) op.scope = m[1];
    else if (op && /^ {6}security: \[\]\s*$/.test(line)) op.noAuth = true;
    else if (op && /^ {6}x-websocket: true\s*$/.test(line)) op.websocket = true;
    else if (op && /^ {6}x-loopback-only: true\s*$/.test(line)) op.loopbackOnly = true;
    else if (op && /^ {6}x-public: true\s*$/.test(line)) op.public = true;
    else if (op && /^ {6}x-demo-only: true\s*$/.test(line)) op.demoOnly = true;
    else if (op && (m = /^ {6}x-stream: (\S+)\s*$/.exec(line))) op.stream = m[1];
  }
  return ops;
}

const toOpenApiPath = (pattern) => pattern.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}");

describe("docs/openapi.yaml matches the registered routes", async () => {
  const { config } = loadConfig({ raw: { dataDir: mkdtempSync(join(tmpdir(), "mcb-oa-")) }, env: {} });
  const app = await createApp({ config, logger: createNullLogger() });
  const streamOf = Object.fromEntries([["core", "core"], ...BUILTIN_MODULES.map((m) => [m.name, m.stream])]);
  const routes = app.router.list().map((r) => ({ ...r, key: `${r.method} ${toOpenApiPath(r.pattern)}` }));
  const ops = readOperations(SPEC);
  const httpOps = ops.filter((o) => !o.websocket);
  const opByKey = new Map(httpOps.map((o) => [`${o.method} ${o.path}`, o]));

  it("parses the spec", () => {
    expect(SPEC).toMatch(/^openapi: 3\.1\.\d/);
    expect(httpOps.length).toBeGreaterThan(50);
  });

  it("every route is documented", () => {
    const missing = routes.filter((r) => !opByKey.has(r.key)).map((r) => r.key);
    expect(missing).toEqual([]);
  });

  it("every documented operation is registered (demo-only ones in demo mode only)", () => {
    const keys = new Set(routes.map((r) => r.key));
    const extra = httpOps.filter((o) => !o.demoOnly && !keys.has(`${o.method} ${o.path}`)).map((o) => `${o.method} ${o.path}`);
    expect(extra).toEqual([]);
    expect(routes.filter((r) => DEMO_ONLY.includes(r.key)).map((r) => r.key)).toEqual([]);
  });

  it("the demo-only list, the x-demo-only flags and demo/routes.mjs agree", () => {
    expect(httpOps.filter((o) => o.demoOnly).map((o) => `${o.method} ${o.path}`).sort()).toEqual([...DEMO_ONLY].sort());
    expect(demoRouteKeys(DEMO_ROUTES).sort()).toEqual([...DEMO_ONLY].sort());
  });

  it("a demo app serves the same routes plus exactly the demo-only ones, each documented with the same flags", async () => {
    const { config: demoConfig } = loadConfig({ raw: { dataDir: mkdtempSync(join(tmpdir(), "mcb-oa-demo-")) }, env: {}, demo: true });
    const demoApp = await createApp({ config: demoConfig, logger: createNullLogger() });
    const demoRoutes = demoApp.router.list().map((r) => ({ ...r, key: `${r.method} ${toOpenApiPath(r.pattern)}` }));
    const base = routes.map((r) => r.key).sort();
    expect(demoRoutes.map((r) => r.key).filter((k) => !DEMO_ONLY.includes(k)).sort()).toEqual(base);
    expect(demoRoutes.map((r) => r.key).filter((k) => DEMO_ONLY.includes(k)).sort()).toEqual([...DEMO_ONLY].sort());
    expect(problemsFor(demoRoutes.filter((r) => DEMO_ONLY.includes(r.key)))).toEqual([]);
  });

  function problemsFor(list) {
    const problems = [];
    for (const r of list) {
      const o = opByKey.get(r.key);
      if (!o) {
        problems.push(`${r.key}: not documented`);
        continue;
      }
      const auth = r.options.auth ?? "key";
      if ((r.options.scope ?? null) !== o.scope) problems.push(`${r.key}: scope ${r.options.scope} vs x-scope ${o.scope}`);
      if ((auth !== "key") !== o.noAuth) problems.push(`${r.key}: auth ${auth} vs security ${o.noAuth ? "[]" : "default"}`);
      if (Boolean(r.options.loopbackOnly) !== o.loopbackOnly) problems.push(`${r.key}: loopbackOnly mismatch`);
      if (Boolean(r.options.public) !== o.public) problems.push(`${r.key}: public mismatch`);
      if (streamOf[r.module] !== o.stream) problems.push(`${r.key}: module ${r.module} (${streamOf[r.module]}) vs x-stream ${o.stream}`);
      if (o.demoOnly !== DEMO_ONLY.includes(r.key)) problems.push(`${r.key}: x-demo-only mismatch`);
    }
    return problems;
  }

  it("scopes, auth, loopback, public flags and owning stream agree", () => {
    expect(problemsFor(routes)).toEqual([]);
  });

  it("the error code enum matches core/errors.mjs", () => {
    const block = SPEC.split(/\n {4}ErrorCode:\n/)[1].split(/\n {4}\w+:\n/)[0];
    const codes = [...block.matchAll(/^ {8}- ([A-Z_]+)$/gm)].map((m) => m[1]);
    expect(codes.sort()).toEqual(Object.keys(ERROR_CODES).sort());
  });
});
