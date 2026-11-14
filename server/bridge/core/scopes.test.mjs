/**
 * T-sec-7: for every route with a scope, a key holding only a LOWER scope
 * (read < paper < live; admin separate) is refused with 403 SCOPE_REQUIRED before the handler runs. Generic: covers
 * every new write endpoint now and later (demo-only routes included).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootSecurityApp, samplePath } from "./__fixtures__/securityApp.mjs";

/** The strongest key that still lacks `scope`. */
const LOWER = { paper: ["read"], live: ["paper"], admin: ["live"] };

const apps = [];
beforeAll(async () => {
  for (const demo of [false, true]) {
    const b = await bootSecurityApp({ demo });
    b.keys = { read: await b.keyOf(["read"]), paper: await b.keyOf(["paper"]), live: await b.keyOf(["live"]) };
    apps.push(b);
  }
});
afterAll(async () => {
  for (const b of apps) await b.close();
});

describe("T-sec-7: scope enforcement on every route", () => {
  it("a lower-scoped key gets 403 SCOPE_REQUIRED (and nothing changes)", async () => {
    const bad = [];
    let checked = 0;
    for (const b of apps) {
      for (const r of b.app.router.list()) {
        const lower = LOWER[r.options.scope];
        if (!lower || (r.options.auth ?? "key") !== "key") continue;
        for (const scope of lower) {
          checked += 1;
          const res = await b.request({ method: r.method, path: samplePath(r.pattern), headers: { authorization: `Bearer ${b.keys[scope]}`, ...(r.method === "GET" ? {} : { "content-type": "application/json" }) }, body: r.method === "GET" || r.options.body === "none" ? undefined : "{}" });
          if (res.status !== 403 || res.json?.code !== "SCOPE_REQUIRED") bad.push(`${r.method} ${r.pattern} with ${scope} → ${res.status} ${res.json?.code}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(30);
    expect(bad).toEqual([]);
    expect(apps[0].app.deps.safety.killSwitchStatus().engaged).toBe(false);
  });
});
