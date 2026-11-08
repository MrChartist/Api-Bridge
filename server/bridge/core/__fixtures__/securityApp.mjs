/**
 * Security-test fixture: boot the REAL app with every built-in module (compat on, a generous
 * per-key client limit so a test can walk every route) on 127.0.0.1:<ephemeral>, and send raw HTTP requests with any
 * header (node:http, so Origin, Host, Cookie and Sec-Fetch-* go out exactly as given).
 */
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.mjs";
import { loadConfig } from "../config.mjs";
import { createNullLogger } from "../logger.mjs";

/** @param {{ demo?: boolean, raw?: object }} [opts] */
export async function bootSecurityApp({ demo = false, raw = {} } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-sec-"));
  const { config } = loadConfig({
    raw: { dataDir, logging: { level: "silent" }, server: { port: 0 }, compat: { enabled: true }, ratelimit: { client: { perSecond: 10_000 } }, ...raw },
    env: {},
    demo,
  });
  const app = await createApp({ config, logger: createNullLogger() });
  const { port } = await app.listen();
  const keyOf = async (scopes, label = scopes.join("-")) => (await app.deps.keyStore.create({ label, scopes, accounts: "*", expiresAt: null, allowQuery: false, clientKind: "other" })).key;
  /**
   * @param {{ method?: string, path: string, headers?: Record<string, string>, body?: string }} r
   * @returns {Promise<{ status: number, headers: import("node:http").IncomingHttpHeaders, text: string, json: any }>}
   */
  const request = ({ method = "GET", path, headers = {}, body }) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method, path, agent: false, headers: { host: `127.0.0.1:${port}`, ...(body !== undefined ? { "content-length": Buffer.byteLength(body) } : {}), ...headers } },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (text += c));
          res.on("end", () => {
            let json = null;
            try {
              json = text ? JSON.parse(text) : null;
            } catch {
              /* not JSON */
            }
            resolve({ status: res.statusCode, headers: res.headers, text, json });
          });
        },
      );
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  return { app, port, origin: `http://127.0.0.1:${port}`, request, keyOf, close: () => app.close() };
}

/** A concrete path for a route pattern (":param" → a harmless sample value). */
export const samplePath = (pattern) => pattern.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_, n) => (n === "token" ? "tok_sample_000000000000" : n === "source" ? "generic" : `sample-${n.toLowerCase().slice(0, 12)}`));
