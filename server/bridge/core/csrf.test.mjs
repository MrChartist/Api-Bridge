/**
 * T-sec-1 (docs/spec/p1-05-readiness.md §3.9, §10.2): every state-changing route refuses cross-site browser requests.
 * Boots the real app (every module, compat on) and, in a second app, demo mode (for the demo-only routes). For EVERY
 * route with a method other than GET:
 *  (a) a foreign Origin with a valid admin+live key → 403 ORIGIN_NOT_ALLOWED, and the handler is not reached;
 *  (b) Origin: null → 403;
 *  (c) no Origin but Sec-Fetch-Site: cross-site (or same-site) → 403 (the new guard);
 *  (d) Sec-Fetch-Site: same-origin with the same-origin Origin → passes the transport stage (401 without a key);
 *  (e) JSON-body routes refuse text/plain, form-urlencoded and multipart bodies with 415 (hooks excluded: json-or-text
 *      by design, token-protected);
 *  (f) an OPTIONS preflight from a foreign origin → 403 and no Access-Control-Allow-Origin.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootSecurityApp, samplePath } from "./__fixtures__/securityApp.mjs";

const EVIL = "https://evil.example";
const apps = [];
let routes = [];
let full;

beforeAll(async () => {
  for (const demo of [false, true]) {
    const b = await bootSecurityApp({ demo });
    b.key = await b.keyOf(["admin", "live"]);
    apps.push(b);
  }
  // Every non-GET route of the normal app, plus the demo-only ones from the demo app.
  const base = apps[0].app.router.list().filter((r) => r.method !== "GET");
  const baseKeys = new Set(base.map((r) => `${r.method} ${r.pattern}`));
  const demoOnly = apps[1].app.router.list().filter((r) => r.method !== "GET" && !baseKeys.has(`${r.method} ${r.pattern}`));
  routes = [...base.map((r) => ({ ...r, b: apps[0] })), ...demoOnly.map((r) => ({ ...r, b: apps[1] }))];
  full = apps[0];
});

afterAll(async () => {
  for (const b of apps) await b.close();
});

describe("T-sec-1: CSRF over every state-changing route", () => {
  it("covers every non-GET route, demo-only ones included", () => {
    expect(routes.length).toBeGreaterThan(40);
    expect(routes.some((r) => r.pattern === "/v1/demo/readiness")).toBe(true);
    expect(routes.some((r) => r.pattern === "/v1/readiness/check")).toBe(true);
  });

  it("(a) a foreign Origin is refused before the handler, even with a valid admin key", async () => {
    const auditBefore = (await full.app.deps.audit.query({ limit: 500 })).items.length;
    const keysBefore = (await full.app.deps.keyStore.list()).length;
    const bad = [];
    for (const r of routes) {
      const res = await r.b.request({ method: r.method, path: samplePath(r.pattern), headers: { origin: EVIL, authorization: `Bearer ${r.b.key}`, "content-type": "application/json" }, body: "{}" });
      if (res.status !== 403 || res.json?.code !== "ORIGIN_NOT_ALLOWED") bad.push(`${r.method} ${r.pattern} → ${res.status} ${res.json?.code}`);
    }
    expect(bad).toEqual([]);
    expect(full.app.deps.safety.killSwitchStatus().engaged).toBe(false);
    expect((await full.app.deps.keyStore.list()).length).toBe(keysBefore);
    expect((await full.app.deps.audit.query({ limit: 500 })).items.length).toBe(auditBefore);
  });

  it("(b) Origin: null is refused", async () => {
    const bad = [];
    for (const r of routes) {
      const res = await r.b.request({ method: r.method, path: samplePath(r.pattern), headers: { origin: "null", authorization: `Bearer ${r.b.key}` } });
      if (res.status !== 403) bad.push(`${r.method} ${r.pattern} → ${res.status}`);
    }
    expect(bad).toEqual([]);
  });

  it("(c) no Origin with Sec-Fetch-Site cross-site or same-site is refused (Sec-Fetch-Site guard)", async () => {
    const bad = [];
    for (const r of routes) {
      for (const site of ["cross-site", "same-site"]) {
        const res = await r.b.request({ method: r.method, path: samplePath(r.pattern), headers: { "sec-fetch-site": site, authorization: `Bearer ${r.b.key}`, "content-type": "application/json" }, body: "{}" });
        if (res.status !== 403 || res.json?.code !== "ORIGIN_NOT_ALLOWED") bad.push(`${r.method} ${r.pattern} ${site} → ${res.status} ${res.json?.code}`);
      }
    }
    expect(bad).toEqual([]);
    expect(full.app.deps.safety.killSwitchStatus().engaged).toBe(false);
  });

  it("(d) the dashboard's own origin passes the transport stage (then 401 without a key)", async () => {
    const bad = [];
    for (const r of routes) {
      const res = await r.b.request({ method: r.method, path: samplePath(r.pattern), headers: { "sec-fetch-site": "same-origin", origin: r.b.origin } });
      if (res.json?.code === "ORIGIN_NOT_ALLOWED" || res.json?.code === "HOST_NOT_ALLOWED") bad.push(`${r.method} ${r.pattern} → ${res.json?.code}`);
      if ((r.options.auth ?? "key") === "key" && res.status !== 401) bad.push(`${r.method} ${r.pattern} → ${res.status} (expected 401)`);
    }
    expect(bad).toEqual([]);
  });

  it("(e) JSON-body routes refuse form and text bodies with 415", async () => {
    const bad = [];
    const bodies = [
      ["text/plain", '{"a":1}'],
      ["application/x-www-form-urlencoded", "a=1"],
      ["multipart/form-data; boundary=x", "--x\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\n1\r\n--x--\r\n"],
    ];
    const jsonRoutes = routes.filter((r) => (r.options.body ?? "json") === "json");
    expect(jsonRoutes.length).toBeGreaterThan(30);
    for (const r of jsonRoutes) {
      for (const [ct, body] of bodies) {
        const res = await r.b.request({ method: r.method, path: samplePath(r.pattern), headers: { authorization: `Bearer ${r.b.key}`, "content-type": ct }, body });
        if (res.status !== 415) bad.push(`${r.method} ${r.pattern} ${ct} → ${res.status} ${res.json?.code}`);
      }
    }
    expect(bad).toEqual([]);
    expect(full.app.deps.safety.killSwitchStatus().engaged).toBe(false);
  });

  it("(f) a preflight from a foreign origin is refused without CORS headers", async () => {
    const bad = [];
    for (const r of routes) {
      const res = await r.b.request({ method: "OPTIONS", path: samplePath(r.pattern), headers: { origin: EVIL, "access-control-request-method": r.method } });
      if (res.status !== 403 || res.headers["access-control-allow-origin"] !== undefined) bad.push(`${r.pattern} → ${res.status}`);
    }
    expect(bad).toEqual([]);
  });
});
