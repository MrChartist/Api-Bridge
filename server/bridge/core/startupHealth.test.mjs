/**
 * GET /v1/health carries the startup jobs' progress while gated reads wait (the demo book seed), and drops it once the
 * gate opens; a gated read still waits for the whole job (no partial book).
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.mjs";
import { loadConfig } from "./config.mjs";
import { notImplementedService } from "./contracts.mjs";
import { createLogger } from "./logger.mjs";
import { defineModule } from "./modules.mjs";
import { startupJob, startupProgress, startupReady } from "./startup.mjs";

let finish;
let legs = 0;
const seed = new Promise((r) => (finish = r)).then(() => (legs = 9));
const seedModule = defineModule({
  name: "seedmod",
  stream: "S10",
  register(app, deps) {
    app.get("/t/book", async () => {
      await startupReady(deps);
      return { legs };
    }, { auth: "none" });
  },
  async start(deps) {
    startupJob(deps, "demo book seed", seed);
    startupProgress(deps, "demo book seed", { done: 6, total: 9 });
  },
});

let app;
let port;
const get = (path) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve(JSON.parse(raw)));
      })
      .on("error", reject);
  });

beforeAll(async () => {
  const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir: mkdtempSync(join(tmpdir(), "mcb-starthealth-")) }, env: {} });
  app = await createApp({ config, modules: [seedModule], overrides: { keyStore: notImplementedService("keyStore"), scheduler: notImplementedService("scheduler") }, logger: createLogger({ level: "error", write: () => {} }) });
  ({ port } = await app.listen());
});

afterAll(async () => {
  finish?.();
  await app?.close();
});

describe("startup progress on /v1/health", () => {
  it("says how far the seed is while book reads wait, and nothing once they answer", async () => {
    const h1 = await get("/v1/health");
    expect(h1.startup).toEqual({ ready: false, jobs: [{ name: "demo book seed", done: 6, total: 9 }] });
    let answered = null;
    const book = get("/t/book").then((b) => (answered = b));
    await new Promise((r) => setTimeout(r, 50));
    expect(answered).toBeNull();
    finish();
    expect(await book).toEqual({ legs: 9 });
    for (let i = 0; i < 20 && (await get("/v1/health")).startup; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect((await get("/v1/health")).startup).toBeUndefined();
  });
});
