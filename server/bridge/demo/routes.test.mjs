import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { DEMO_ROUTES, demoRouteKeys, registerDemoRoutes } from "./routes.mjs";

const probe = Object.freeze({
  module: "market",
  method: "POST",
  path: "/v1/demo/probe/:id",
  options: { scope: "read", loopbackOnly: true, summary: "test" },
  handler: () => (ctx) => ({ data: { id: ctx.params.id } }),
});

function fakeFacade() {
  const added = [];
  return { added, facadeFor: (module) => ({ route: (method, path, handler, options) => added.push({ module, method, path, handler, options }) }) };
}

describe("demo-only routes", () => {
  it("ships the demo controls each step added, all under /v1/demo/ (readiness failure)", () => {
    expect(demoRouteKeys(DEMO_ROUTES)).toEqual(["POST /v1/demo/readiness"]);
    expect(DEMO_ROUTES.every((r) => r.path.startsWith("/v1/demo/") && !r.options.public)).toBe(true);
    expect(demoRouteKeys([probe])).toEqual(["POST /v1/demo/probe/{id}"]);
  });

  it("registers nothing outside demo mode", () => {
    const f = fakeFacade();
    expect(registerDemoRoutes({ config: { demo: false }, facadeFor: f.facadeFor, deps: {}, modules: [{ name: "market" }], routes: [probe] })).toBe(0);
    expect(registerDemoRoutes({ config: {}, facadeFor: f.facadeFor, deps: {}, modules: [{ name: "market" }], routes: [probe] })).toBe(0);
    expect(f.added).toEqual([]);
  });

  it("registers each route under its owning module in demo mode, and skips modules that are not loaded", () => {
    const f = fakeFacade();
    expect(registerDemoRoutes({ config: { demo: true }, facadeFor: f.facadeFor, deps: {}, modules: [{ name: "market" }], routes: [probe, { ...probe, module: "recorder" }] })).toBe(1);
    expect(f.added).toHaveLength(1);
    expect(f.added[0]).toMatchObject({ module: "market", method: "POST", path: "/v1/demo/probe/:id", options: { scope: "read", loopbackOnly: true } });
  });

  it("refuses routes outside /v1/demo/ and public demo routes", () => {
    const f = fakeFacade();
    const run = (r) => registerDemoRoutes({ config: { demo: true }, facadeFor: f.facadeFor, deps: {}, modules: [{ name: "market" }], routes: [r] });
    expect(() => run({ ...probe, path: "/v1/orders" })).toThrow(/\/v1\/demo\//);
    expect(() => run({ ...probe, options: { ...probe.options, public: true } })).toThrow(/never public/);
    expect(() => run({ ...probe, method: "TRACE" })).toThrow(/method/);
  });

  it("a demo app serves an injected demo route; a normal app does not", async () => {
    const boot = async (demo) => {
      const { config } = loadConfig({ raw: { dataDir: mkdtempSync(join(tmpdir(), "mcb-demo-routes-")) }, env: {}, demo });
      const app = await createApp({ config, logger: createNullLogger(), demoRoutes: [probe] });
      return app.router.list().filter((r) => r.pattern.startsWith("/v1/demo/"));
    };
    expect(await boot(false)).toEqual([]);
    expect((await boot(true)).map((r) => [r.method, r.pattern, r.module])).toEqual([["POST", "/v1/demo/probe/:id", "market"]]);
  });
});
