/**
 * Test fixture for the hooks and MCP module: a real Bridge app (core pipeline, real HTTP on 127.0.0.1, port 0) with only the hooks
 * and mcp modules, and every other service replaced by the published fakes. No broker calls, no network beyond
 * loopback, a temp data directory per bridge.
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAccountManager } from "../../accounts/fake.mjs";
import { createFakeKeyStore, createFakeSecretStore } from "../../auth/fake.mjs";
import { createApp } from "../../core/app.mjs";
import { loadConfig } from "../../core/config.mjs";
import { createLogger } from "../../core/logger.mjs";
import { createFakeMarketData } from "../../market/fake.mjs";
import { createFakeOrderService } from "../../orders/fake.mjs";
import { createFakeAuditLog, createFakeSafetyGuard } from "../../safety/fake.mjs";
import { createFakeSymbolService } from "../../symbols/fake.mjs";
import hooksModule from "../module.mjs";
import mcpModule from "../../mcp/module.mjs";

export const PRICES = Object.freeze({ "NSE:RELIANCE": 1402.5, "NSE:NIFTY": 25010, "NSE:INFY": 1500, "NFO:NIFTY-2026-10-27-25000-CE": 120.5 });

/**
 * @param {{ config?: object, accounts?: string[], liveAccounts?: string[], listen?: boolean }} [opts]
 */
export async function startTestBridge({ config = {}, accounts = ["paper", "dhan-main"], liveAccounts = [], listen = true, readiness = null } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-s11-"));
  const logLines = [];
  const logger = createLogger({ level: "debug", write: (l) => logLines.push(l) });
  const { config: cfg } = loadConfig({ raw: { dataDir, logging: { level: "debug" }, ...config, server: { port: 0, ...(config.server ?? {}) } }, env: {} });
  const keyStore = createFakeKeyStore();
  const secrets = createFakeSecretStore({ logger });
  const audit = createFakeAuditLog();
  const safety = createFakeSafetyGuard();
  const orders = createFakeOrderService({ accounts, liveAccounts, lotSizes: { "NFO:NIFTY-2026-10-27-25000-CE": 65, "NFO:NIFTY-2026-10-27-FUT": 65 }, prices: { ...PRICES } });
  const marketData = createFakeMarketData({ prices: { ...PRICES } });
  marketData.setExpiries?.("NIFTY", ["2026-10-20", "2026-10-27"]);
  const symbols = createFakeSymbolService();
  const accountsSvc = createFakeAccountManager({ accounts: accounts.map((id) => ({ id, broker: id === "paper" ? "paper" : "dhan" })) });
  const app = await createApp({
    config: cfg,
    modules: [hooksModule, mcpModule],
    logger,
    overrides: { keyStore, secrets, audit, safety, orders, marketData, symbols, accounts: accountsSvc, ...(readiness ? { readiness } : {}) },
  });
  let port = null;
  if (listen) ({ port } = await app.listen());
  const keys = {
    admin: keyStore.addKey({ label: "admin", scopes: ["admin"], accounts: "*" }).key,
    adminLive: keyStore.addKey({ label: "owner", scopes: ["admin", "live"], accounts: "*" }).key,
    read: keyStore.addKey({ label: "reader", scopes: ["read"], accounts: "*" }).key,
    paper: keyStore.addKey({ label: "ai-paper", scopes: ["paper"], accounts: "*" }).key,
    live: keyStore.addKey({ label: "ai-live", scopes: ["live"], accounts: "*" }).key,
    paperOther: keyStore.addKey({ label: "other", scopes: ["paper"], accounts: ["dhan-main"] }).key,
  };

  /**
   * @param {{ method?: string, path: string, headers?: Record<string, string>, body?: unknown, raw?: string }} r
   * @returns {Promise<{ status: number, headers: any, raw: string, json: any, ms: number }>}
   */
  const request = ({ method = "GET", path, headers = {}, body, raw }) => {
    const payload = raw !== undefined ? raw : body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const t0 = performance.now();
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method, path, agent: false, headers: { host: `127.0.0.1:${port}`, ...(payload !== undefined ? { "content-length": Buffer.byteLength(payload) } : {}), ...headers } },
        (res) => {
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
            resolve({ status: res.statusCode, headers: res.headers, raw: text, json, ms: performance.now() - t0 });
          });
        },
      );
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  };

  return {
    app,
    port,
    dataDir,
    logLines,
    keys,
    keyStore,
    secrets,
    audit,
    safety,
    orders,
    marketData,
    symbols,
    accounts: accountsSvc,
    request,
    auth: (key) => ({ authorization: `Bearer ${key}` }),
    async close() {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
