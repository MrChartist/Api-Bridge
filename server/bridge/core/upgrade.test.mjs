/**
 * T-sec-3 (docs/spec/p1-05-readiness.md §3.9 F6): every registered WebSocket upgrade path refuses a foreign Origin
 * and a foreign Host (DNS rebinding) with 403, before any handler runs.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootSecurityApp } from "./__fixtures__/securityApp.mjs";

let b;
beforeAll(async () => {
  b = await bootSecurityApp({ demo: false });
});
afterAll(async () => b?.close());

/** Send an upgrade request and return the status line's code (or the upgrade's 101). */
function upgrade(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: b.port, path, agent: false, headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers } });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("T-sec-3: WebSocket upgrades", () => {
  it("has upgrade paths to check", () => {
    expect(b.app.upgradePaths().length).toBeGreaterThan(0);
  });

  it("every upgrade path refuses a foreign Origin and a foreign Host", async () => {
    const bad = [];
    for (const path of b.app.upgradePaths()) {
      const origin = await upgrade(path, { host: `127.0.0.1:${b.port}`, origin: "https://evil.example" });
      if (origin !== 403) bad.push(`${path} foreign Origin → ${origin}`);
      const nullOrigin = await upgrade(path, { host: `127.0.0.1:${b.port}`, origin: "null" });
      if (nullOrigin !== 403) bad.push(`${path} Origin null → ${nullOrigin}`);
      const host = await upgrade(path, { host: "evil.example" });
      if (host !== 403) bad.push(`${path} foreign Host → ${host}`);
    }
    expect(bad).toEqual([]);
  });
});
