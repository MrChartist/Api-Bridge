/** The real core app with only the library module, the fakes, real HTTP on an ephemeral loopback port. */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeKeyStore } from "../../auth/fake.mjs";
import { createApp } from "../../core/app.mjs";
import { loadConfig } from "../../core/config.mjs";
import { createNullLogger } from "../../core/logger.mjs";
import { createLibraryModule } from "../module.mjs";
import { NOW, calendarWith, fakeSymbols, standardMarket } from "./fakes.mjs";

/** @param {{ library?: object, now?: number, market?: any, holidays?: string[], overrides?: object }} [o] */
export async function startLibraryApp(o = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-libapp-"));
  const clock = { t: o.now ?? NOW, now() { return this.t; } };
  const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir, ...(o.library ? { library: o.library } : {}) }, env: {} });
  const keyStore = createFakeKeyStore();
  const market = o.market ?? standardMarket({ now: () => clock.t });
  const events = [];
  const app = await createApp({
    config,
    modules: [createLibraryModule({ calendar: calendarWith(o.holidays ?? []) })],
    overrides: { keyStore, marketData: market, symbols: fakeSymbols(), ...(o.overrides ?? {}) },
    logger: createNullLogger(),
    clock,
  });
  app.deps.bus.on("collection.changed", (p) => events.push(p));
  const { port } = await app.listen();
  const keys = {
    read: keyStore.addKey({ label: "reader", scopes: ["read"], accounts: "*" }).key,
    paper: keyStore.addKey({ label: "writer", scopes: ["paper"], accounts: "*" }).key,
    admin: keyStore.addKey({ label: "admin", scopes: ["admin"], accounts: "*" }).key,
    oneAccount: keyStore.addKey({ label: "one", scopes: ["read"], accounts: ["dhan-main"] }).key,
  };
  const request = (path, { method = "GET", key, headers = {}, body, raw, contentType } = {}) =>
    new Promise((resolve, reject) => {
      const payload = raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body);
      const h = { host: `127.0.0.1:${port}`, ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers };
      if (payload !== undefined) {
        h["content-type"] = contentType ?? "application/json";
        h["content-length"] = Buffer.byteLength(payload);
      }
      const r = http.request({ host: "127.0.0.1", port, method, path, headers: h, agent: false }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, headers: res.headers, raw: text, json });
        });
      });
      r.on("error", reject);
      if (payload !== undefined) r.write(payload);
      r.end();
    });
  return {
    app,
    port,
    keys,
    market,
    clock,
    events,
    dataDir,
    request,
    async close() {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
