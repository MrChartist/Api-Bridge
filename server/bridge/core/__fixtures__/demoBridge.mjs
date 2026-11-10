/**
 * A demo Bridge on an ephemeral port with an admin + paper key, for tests that call the real HTTP routes (idempotency,
 * the OpenAPI conformance test). No network beyond 127.0.0.1. The clock sits on a Monday 10:30 IST and advances on every
 * read, so paper MARKET orders fill whenever the test runs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.mjs";
import { loadConfig } from "../config.mjs";
import { createNullLogger } from "../logger.mjs";

/** @param {{ raw?: object, scopes?: string[], start?: number }} [opts] */
export async function bootDemoBridge({ raw = {}, scopes = ["admin", "paper"], start = Date.UTC(2026, 10, 9, 5, 0, 0) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mcb-demo-bridge-"));
  const { config } = loadConfig({ raw: { dataDir: dir, server: { port: 0 }, logging: { level: "silent" }, ...raw }, env: {}, demo: true });
  let t = start;
  const app = await createApp({ config, logger: createNullLogger(), clock: { now: () => (t += 50) } });
  const { port } = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  const { key } = await app.deps.keyStore.create({ label: "test-admin", scopes, accounts: "*" });
  /** @returns {Promise<{ status: number, headers: Headers, text: string, json: any }>} */
  async function call(method, path, { body, headers = {}, auth = key } = {}) {
    const h = { ...headers };
    if (auth) h.Authorization = `Bearer ${auth}`;
    if (body !== undefined) h["Content-Type"] = "application/json";
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), redirect: "manual" });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, headers: res.headers, text, json };
  }
  return {
    app,
    base,
    key,
    dir,
    call,
    async close() {
      await app.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}
