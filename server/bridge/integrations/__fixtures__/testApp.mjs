/**
 * Boots the real core app with only the integrations module and the fakes, on an ephemeral loopback port.
 * Used by the route, conformance and no-orders tests.
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../core/app.mjs";
import { loadConfig } from "../../core/config.mjs";
import { createNullLogger } from "../../core/logger.mjs";
import integrations from "../module.mjs";
import { NOW_MS, createFakeKeyStore, createFakeMarketData, createFakeSymbols } from "./fakes.mjs";

/**
 * @param {{ integrations?: object, overrides?: Record<string, object>, now?: number }} [opts]
 */
export async function startTestApp({ integrations: section, overrides = {}, now = NOW_MS } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-s10-"));
  const raw = { server: { port: 0 }, dataDir };
  if (section !== undefined) raw.integrations = section;
  const { config } = loadConfig({ raw, env: {} });
  const marketData = overrides.marketData ?? createFakeMarketData({ now: () => now });
  const symbols = overrides.symbols ?? createFakeSymbols();
  const app = await createApp({
    config,
    modules: [integrations],
    overrides: { keyStore: createFakeKeyStore(), ...overrides, marketData, symbols },
    logger: createNullLogger(),
    clock: { now: () => now },
  });
  const { port } = await app.listen();

  /** GET (or another method) returning { status, headers, raw, json }. */
  const request = (path, { method = "GET", headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const h = { host: `127.0.0.1:${port}`, ...headers };
      if (payload !== undefined) {
        h["content-type"] = "application/json";
        h["content-length"] = Buffer.byteLength(payload);
      }
      const r = http.request({ host: "127.0.0.1", port, method, path, headers: h }, (res) => {
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

  return { app, port, marketData, symbols, request, close: () => app.close() };
}

export const bearer = (key) => ({ authorization: `Bearer ${key}` });
