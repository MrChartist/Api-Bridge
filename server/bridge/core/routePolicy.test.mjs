/**
 * T-sec-2 and T-sec-4 (docs/spec/p1-05-readiness.md §3.9 F1, F4, F5; §10.2). From the real route table:
 *  - every route authenticates with a key AND names a scope, or is on an explicit allowlist (auth "none": health,
 *    the OpenAPI file, the dashboard pages, and the loopback-only sign-in; auth "custom": webhooks, the compat REST
 *    API and the SSE stream). A new `auth: "none"` write route fails here.
 *  - no non-GET route accepts ?key=; every admin route is this-computer-only except GET /v1/notify (read-only);
 *  - no route authenticates from a cookie: a request carrying only Cookie gets 401 on a route of every module, and no
 *    file under server/bridge reads headers.cookie.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootSecurityApp, samplePath } from "./__fixtures__/securityApp.mjs";

const NONE_ALLOWED = new Set(["GET /v1/health", "GET /openapi.yaml", "GET /", "GET /dashboard", "GET /dashboard/:file", "POST /v1/sign-in", "POST /v1/sign-in/local"]);
const CUSTOM_ALLOWED = [/^POST \/hooks\/:source\/:token$/, /^POST \/api\/v1\/[a-z]+(\/[a-z]+)?$/, /^GET \/v1\/stream\/sse$/];
const ADMIN_NOT_LOOPBACK = new Set(["GET /v1/notify"]);

let b;
let routes;
beforeAll(async () => {
  b = await bootSecurityApp({ demo: false });
  const demo = await bootSecurityApp({ demo: true });
  const seen = new Set();
  routes = [...b.app.router.list(), ...demo.app.router.list()].filter((r) => {
    const k = `${r.method} ${r.pattern}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  await demo.close();
});
afterAll(async () => b?.close());

describe("T-sec-2: route policy", () => {
  it("every route has auth key + scope, or is on the explicit allowlist", () => {
    const bad = [];
    for (const r of routes) {
      const k = `${r.method} ${r.pattern}`;
      const auth = r.options.auth ?? "key";
      if (auth === "key" && typeof r.options.scope !== "string") bad.push(`${k}: key auth without a scope`);
      if (auth === "none" && !NONE_ALLOWED.has(k)) bad.push(`${k}: auth "none" is not allowlisted`);
      if (auth === "custom" && !CUSTOM_ALLOWED.some((re) => re.test(k))) bad.push(`${k}: auth "custom" is not allowlisted`);
    }
    expect(bad).toEqual([]);
  });

  it("the only auth-none writes are the two loopback-only sign-ins (a one-time code, or the dashboard page on this computer)", () => {
    const writes = routes.filter((r) => r.method !== "GET" && r.options.auth === "none");
    expect(writes.map((r) => `${r.method} ${r.pattern}`).sort()).toEqual(["POST /v1/sign-in", "POST /v1/sign-in/local"]);
    for (const r of writes) expect(r.options.loopbackOnly, r.pattern).toBe(true);
  });

  it("no non-GET route accepts ?key=", () => {
    expect(routes.filter((r) => r.method !== "GET" && r.options.allowQueryKey).map((r) => `${r.method} ${r.pattern}`)).toEqual([]);
  });

  it("every admin route is this-computer-only, except GET /v1/notify (read-only)", () => {
    const bad = routes.filter((r) => r.options.scope === "admin" && !r.options.loopbackOnly && !ADMIN_NOT_LOOPBACK.has(`${r.method} ${r.pattern}`));
    expect(bad.map((r) => `${r.method} ${r.pattern}`)).toEqual([]);
  });

  it("the readiness routes are read-scoped key routes", () => {
    const rd = routes.filter((r) => r.pattern.includes("readiness")).map((r) => [r.method, r.pattern, r.options.scope, r.options.auth ?? "key"]);
    expect(rd).toEqual(
      expect.arrayContaining([
        ["GET", "/v1/readiness", "read", "key"],
        ["POST", "/v1/readiness/check", "read", "key"],
        ["GET", "/v1/readiness/history", "read", "key"],
        ["POST", "/v1/demo/readiness", "read", "key"],
      ]),
    );
  });
});

describe("T-sec-4: no cookie authentication", () => {
  it("a request carrying only a cookie gets 401 on a route of every module", async () => {
    const byModule = new Map();
    for (const r of b.app.router.list()) {
      if ((r.options.auth ?? "key") !== "key" || byModule.has(r.module)) continue;
      byModule.set(r.module, r);
    }
    expect(byModule.size).toBeGreaterThan(10);
    const bad = [];
    for (const r of byModule.values()) {
      const res = await b.request({ method: r.method, path: samplePath(r.pattern), headers: { cookie: "mcb=mcb_aaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; session=1", "content-type": "application/json" }, body: r.method === "GET" ? undefined : "{}" });
      if (res.status !== 401) bad.push(`${r.module} ${r.method} ${r.pattern} → ${res.status}`);
    }
    expect(bad).toEqual([]);
  });

  it("no file under server/bridge reads headers.cookie (tests excluded)", () => {
    const root = join(import.meta.dirname, "..");
    const hits = [];
    const walk = (dir) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) {
          if (f !== "node_modules") walk(p);
        } else if (/\.(mjs|js)$/.test(f) && !/\.test\.mjs$/.test(f) && !p.includes("__fixtures__")) {
          // Node lower-cases inbound header names, so reading a request cookie means headers.cookie / headers["cookie"].
          // (An outbound client that SENDS a Cookie header, such as backup/httpClient.mjs for NSE, writes headers.Cookie.)
          if (/headers\s*(\.\s*cookie\b|\[\s*["']cookie["']\s*\])/.test(readFileSync(p, "utf8"))) hits.push(relative(root, p));
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
