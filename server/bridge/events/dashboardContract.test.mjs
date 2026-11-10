/**
 * The Events tab on the Developers page builds its request bodies and groups the topics with the pure helpers in
 * dashboard/developers-core.js. This test runs those helpers against the real routes (subscriptions and topics), so a new
 * topic with no group, or a body the Bridge refuses, fails here instead of in somebody's browser.
 */
import http from "node:http";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeKeyStore, createFakeSecretStore } from "../auth/fake.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { collapseTopics, deliveryLine, eventLine, groupTopics, receiverBody, receiverProblem, receiverView, secretFromBytes, topicsText } from "../dashboard/developers-core.js";
import { createFakeAuditLog } from "../safety/fake.mjs";
import { createEventsModule } from "./module.mjs";
import { URL_OK, createFakeReceiver, publicDns, tmpDir } from "./testkit.mjs";

const open = [];
afterEach(async () => {
  for (const b of open.splice(0)) await b.close();
});

async function boot() {
  const dir = tmpDir("mcb-events-dash-");
  const receiver = createFakeReceiver({ clock: { now: () => Date.now() } });
  const keyStore = createFakeKeyStore();
  const { config } = loadConfig({ raw: { dataDir: dir, logging: { level: "silent" }, server: { port: 0 }, events: { heartbeatMs: 60_000 } }, env: {} });
  const app = await createApp({ config, modules: [createEventsModule({ transport: receiver.transport, resolve: publicDns().resolve })], logger: createNullLogger(), overrides: { keyStore, secrets: createFakeSecretStore(), audit: createFakeAuditLog() } });
  const { port } = await app.listen();
  const admin = keyStore.addKey({ label: "admin", scopes: ["admin"], accounts: "*" }).key;
  const request = ({ method = "GET", path, body }) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ host: "127.0.0.1", port, method, path, agent: false, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${admin}`, ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) } }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : undefined }));
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  const b = { request, async close() { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
  open.push(b);
  return b;
}

describe("the Events tab and the Bridge agree", () => {
  it("every topic the Bridge offers is in a named group (a new topic needs a place in the form)", async () => {
    const b = await boot();
    const topics = (await b.request({ path: "/v1/events/topics" })).json.data;
    expect(topics.length).toBeGreaterThan(10);
    const groups = groupTopics(topics);
    expect(groups.find((g) => g.id === "other")?.topics.map((t) => t.topic) ?? []).toEqual([]);
    expect(groups.flatMap((g) => g.topics).length).toBe(topics.length);
  });

  it("the body the form sends is accepted for any choice of topics, and the secret is write-only", async () => {
    const b = await boot();
    const all = (await b.request({ path: "/v1/events/topics" })).json.data.map((t) => t.topic);
    const choices = [all.filter((t) => t.startsWith("order.")), all.filter((t) => t.startsWith("download.")), ["recording.gap", "order.updated"], all];
    const secret = secretFromBytes(new Uint8Array(32).fill(171));
    for (const topics of choices) {
      expect(receiverProblem({ url: URL_OK, topics })).toBe("");
      const body = receiverBody({ url: ` ${URL_OK} `, label: " Order logger ", topics, allTopics: all, secret });
      const r = await b.request({ method: "POST", path: "/v1/subscriptions", body });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      expect(JSON.stringify(r.json)).not.toContain(secret);
      const view = receiverView(r.json.data);
      expect(view.title).toBe("Order logger");
      expect(view.state.word).toBe("Not tested yet");
      const test = await b.request({ method: "POST", path: `/v1/subscriptions/${r.json.data.id}/test` });
      expect(test.status).toBe(200);
      const log = (await b.request({ path: `/v1/subscriptions/${r.json.data.id}/deliveries` })).json.data;
      expect(deliveryLine(log[0]).word).toBe("Delivered");
    }
    expect((await b.request({ path: "/v1/subscriptions" })).json.data).toHaveLength(choices.length);
  });
});

describe("the receiver helpers", () => {
  const all = ["order.updated", "order.outcome_unknown", "download.done", "download.failed", "safety.kill_switch"];
  it("collapses whole families and everything", () => {
    expect(collapseTopics(["order.updated", "order.outcome_unknown"], all)).toEqual(["order.*"]);
    expect(collapseTopics(["order.updated"], all)).toEqual(["order.updated"]);
    expect(collapseTopics(["safety.kill_switch"], all)).toEqual(["safety.kill_switch"]);
    expect(collapseTopics(all, all)).toEqual(["*"]);
    expect(collapseTopics([], all)).toEqual([]);
  });
  it("says what is wrong with the form in plain words", () => {
    expect(receiverProblem({ url: "", topics: ["a"] })).toMatch(/Type the address/);
    expect(receiverProblem({ url: "example.com/x", topics: ["a"] })).toMatch(/must start with https/);
    expect(receiverProblem({ url: "https://example.com/x", topics: [] })).toMatch(/at least one/);
  });
  it("makes a 64 character secret from random bytes", () => {
    expect(secretFromBytes(new Uint8Array([0, 15, 255]))).toBe("000fff");
    expect(secretFromBytes(new Uint8Array(32))).toHaveLength(64);
  });
  it("names topics, health and failures in words", () => {
    expect(topicsText(["*"])).toBe("Everything");
    expect(topicsText(["order.*"])).toBe("all order events");
    expect(topicsText(["a.b", "c.d", "e.f", "g.h"])).toBe("a.b, c.d and 2 more");
    const now = Date.parse("2026-11-09T06:30:00Z");
    expect(receiverView({ id: "s", host: "h.test", topics: ["order.*"], health: { state: "failing", failed: 3, lastFailure: { message: "The receiver timed out." } } }, now)).toMatchObject({ title: "h.test", topics: "All order events", state: { word: "Failing", tone: "bad" }, last: "Last problem: The receiver timed out.", counts: "3 failed" });
    expect(receiverView({ health: { state: "ok", delivered: 12, lastDeliveredAt: "2026-11-09T06:00:00Z" } }, now)).toMatchObject({ state: { word: "Working" }, last: "Last delivery 30 min ago", counts: "12 delivered" });
    expect(deliveryLine({ ok: false, outcome: "dead", message: "Gave up.", at: "2026-11-09T06:29:50Z" }, now)).toMatchObject({ word: "Gave up", tone: "bad", when: "just now" });
    expect(eventLine({ id: "5", topic: "order.updated", time: "2026-11-09T06:29:00Z", data: { orderId: "o1", status: "filled", nested: { a: 1 } } }, now)).toMatchObject({ topic: "order.updated", facts: "orderId o1 · status filled", when: "1 min ago" });
  });
});
