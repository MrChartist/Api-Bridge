import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { keylessApiAllowed, loadConfig } from "../core/config.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { LOCAL_ACCESS_LABEL, LOCAL_ACCESS_SCOPES, mayActAsThisComputer } from "./localAccess.mjs";
import authModule from "./module.mjs";

const audit = { ...notImplementedService("audit"), append: async (input) => ({ ...input, seq: 1 }) };

async function bridge(server = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-keyless-"));
  const { config } = loadConfig({ raw: { server: { port: 0, ...server }, dataDir }, env: {} });
  const app = await createApp({ config, modules: [authModule], overrides: { audit }, logger: createNullLogger() });
  const { port } = await app.listen();
  const request = (path, { method = "GET", headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const extra = payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) };
      const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...extra, ...headers } }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = JSON.parse(raw);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, json });
        });
      });
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  return { app, port, request };
}

describe("keyless access on this computer (server.keylessApi: true)", () => {
  let b;
  beforeAll(async () => {
    b = await bridge({ keylessApi: true });
  });
  afterAll(async () => b.app.close());

  it("a tool that sends no key reads, and does admin work, as This computer", async () => {
    expect((await b.request("/v1/meta")).status).toBe(200);
    const keys = await b.request("/v1/keys");
    expect(keys.status).toBe(200);
    const mine = keys.json.data.filter((k) => k.label === LOCAL_ACCESS_LABEL);
    expect(mine).toHaveLength(1);
    expect([...mine[0].scopes].sort()).toEqual([...LOCAL_ACCESS_SCOPES].sort());
    expect(mine[0].accounts).toBe("*");
    // Many calls, one record: the Keys page does not fill up.
    for (let i = 0; i < 5; i += 1) await b.request("/v1/meta");
    expect((await b.request("/v1/keys")).json.data.filter((k) => k.label === LOCAL_ACCESS_LABEL)).toHaveLength(1);
  });

  it("never carries the live scope, and cannot make a key that does", async () => {
    expect(LOCAL_ACCESS_SCOPES).not.toContain("live");
    const made = await b.request("/v1/keys", { method: "POST", body: { label: "wants live", scopes: ["live"] } });
    expect(made.status).toBeGreaterThanOrEqual(400);
    const paper = await b.request("/v1/keys", { method: "POST", body: { label: "a tool", scopes: ["paper"] } });
    expect(paper.status).toBe(201);
  });

  it("a key that is sent is judged alone: a wrong key is refused, a smaller key stays smaller", async () => {
    expect((await b.request("/v1/meta", { headers: { authorization: "Bearer mcb_nope_nope" } })).status).toBe(401);
    const { key } = await b.app.deps.keyStore.create({ label: "reader", scopes: ["read"] });
    expect((await b.request("/v1/meta", { headers: { authorization: `Bearer ${key}` } })).status).toBe(200);
    expect((await b.request("/v1/keys", { headers: { authorization: `Bearer ${key}` } })).status).toBe(403);
  });

  it("is only for this computer: a proxy, a tunnel host, another site and a cross-site browser request get nothing", async () => {
    expect((await b.request("/v1/meta", { headers: { "x-forwarded-for": "203.0.113.9" } })).status).toBe(401);
    expect((await b.request("/v1/meta", { headers: { host: "bridge.example.com" } })).status).toBeGreaterThanOrEqual(400);
    expect((await b.request("/v1/meta", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await b.request("/v1/meta", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(401);
    expect((await b.request("/v1/meta", { headers: { "sec-fetch-site": "same-origin", origin: `http://127.0.0.1:${b.port}` } })).status).toBe(200);
  });

  it("revoking This computer on the Keys page does not lock the computer out: the next call makes it again", async () => {
    const before = (await b.request("/v1/keys")).json.data.find((k) => k.label === LOCAL_ACCESS_LABEL);
    await b.app.deps.keyStore.revoke(before.id);
    expect((await b.request("/v1/meta")).status).toBe(200);
    const after = (await b.request("/v1/keys")).json.data.filter((k) => k.label === LOCAL_ACCESS_LABEL && !k.revokedAt);
    expect(after).toHaveLength(1);
    expect(after[0].id).not.toBe(before.id);
  });
});

describe("switching keyless access off", () => {
  it("server.keylessApi: false asks every tool for a key", async () => {
    const b = await bridge({ keylessApi: false });
    try {
      expect((await b.request("/v1/meta")).status).toBe(401);
      expect((await b.request("/v1/keys")).status).toBe(401);
    } finally {
      await b.app.close();
    }
  });

  it("the default follows keyless sign-in, the environment can turn it off, and the config has the last word", () => {
    expect(keylessApiAllowed({ server: {} }, {})).toBe(true);
    expect(keylessApiAllowed({ server: {} }, { MCB_KEYLESS: "0" })).toBe(false);
    expect(keylessApiAllowed({ server: { keylessApi: true } }, { MCB_KEYLESS: "0" })).toBe(true);
    expect(keylessApiAllowed({ server: { keylessSignIn: false } }, {})).toBe(false);
    expect(keylessApiAllowed({ server: { localPeers: ["172.17.0.1"] } }, {})).toBe(false);
    expect(keylessApiAllowed({ server: { remoteDashboard: true } }, {})).toBe(false);
    expect(keylessApiAllowed({ server: { keylessApi: false } }, {})).toBe(false);
  });

  it("the public listener and a non-loopback peer are never this computer", () => {
    const req = (o = {}) => ({ socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:4300" }, ...o });
    const cfg = { server: { keylessApi: true } };
    expect(mayActAsThisComputer(req(), cfg)).toBe(true);
    expect(mayActAsThisComputer(req(), cfg, { publicListener: true })).toBe(false);
    expect(mayActAsThisComputer(req({ socket: { remoteAddress: "192.168.1.20" } }), cfg)).toBe(false);
    expect(mayActAsThisComputer(req({ headers: { host: "127.0.0.1:4300", "sec-fetch-site": "same-site" } }), cfg)).toBe(false);
  });
});
