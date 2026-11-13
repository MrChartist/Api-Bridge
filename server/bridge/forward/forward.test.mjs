import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../core/eventBus.mjs";
import { createForwardRuntime } from "./module.mjs";
import { createForwardSender, envelope, signBody } from "./sender.mjs";
import { createForwardStore, forwardUrlAllowed, publicForward } from "./store.mjs";

const memorySecrets = () => {
  const m = new Map();
  return { get: async (n) => m.get(n) ?? null, set: async (n, v) => void m.set(n, v), delete: async (n) => m.delete(n), size: () => m.size };
};
const okFetch = (calls, status = 200) => async (url, init) => {
  calls.push({ url, init });
  return { status, body: null };
};

let dir;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "mcb-forward-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("forward targets", () => {
  it("takes https anywhere and http only to this computer", () => {
    expect(forwardUrlAllowed("https://example.com/hook")).toBe(true);
    expect(forwardUrlAllowed("http://127.0.0.1:8000/bridge")).toBe(true);
    expect(forwardUrlAllowed("http://localhost:3000/x")).toBe(true);
    expect(forwardUrlAllowed("http://192.168.1.5/x")).toBe(false);
    expect(forwardUrlAllowed("http://example.com/x")).toBe(false);
    expect(forwardUrlAllowed("https://user:pass@example.com/x")).toBe(false);
    expect(forwardUrlAllowed("file:///etc/passwd")).toBe(false);
    expect(forwardUrlAllowed("not a url")).toBe(false);
  });

  it("creates a target, shows the secret once and keeps it out of the file and the list", async () => {
    const secrets = memorySecrets();
    const store = createForwardStore({ dataDir: dir, secrets });
    const { target, signingSecret } = await store.create({ label: "My app", url: "https://example.com/hook" });
    expect(target.events).toEqual(["order.updated"]);
    expect(signingSecret).toMatch(/^mcbfw_/);
    expect(readFileSync(join(dir, "forwards.json"), "utf8")).not.toContain(signingSecret);
    expect(JSON.stringify(publicForward(target))).not.toContain(signingSecret);
    const again = createForwardStore({ dataDir: dir, secrets });
    expect(again.list().map((t) => t.id)).toEqual([target.id]);
    expect(await again.secretFor(target.id)).toBe(signingSecret);
    expect(await again.delete(target.id)).toBe(true);
    expect(secrets.size()).toBe(0);
    expect(again.list()).toEqual([]);
  });

  it("refuses a bad URL, an unknown event and unknown fields", async () => {
    const store = createForwardStore({ dataDir: dir, secrets: memorySecrets() });
    await expect(store.create({ label: "x", url: "http://example.com/x" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(store.create({ label: "x", url: "https://example.com", events: ["tick"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(store.create({ label: "x", url: "https://example.com", secret: "mine" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(createForwardStore({ dataDir: dir }).create({ label: "x", url: "https://example.com" })).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });
});

describe("forward delivery", () => {
  it("signs the exact body the way the Bridge's own hooks are signed", () => {
    const body = envelope("order.updated", { orderId: "A1" }, { id: "dl_1", at: "2026-11-13T10:00:00.000Z" });
    expect(JSON.parse(body)).toEqual({ id: "dl_1", event: "order.updated", at: "2026-11-13T10:00:00.000Z", data: { orderId: "A1" } });
    expect(signBody("s3cret", body, 1700000000)).toBe(`t=1700000000,v1=${createHmac("sha256", "s3cret").update(`1700000000.${body}`).digest("hex")}`);
  });

  it("posts each wanted event once, in order, and counts it", async () => {
    const store = createForwardStore({ dataDir: dir, secrets: memorySecrets() });
    const { target, signingSecret } = await store.create({ label: "a", url: "https://example.com/hook" });
    const calls = [];
    const sender = createForwardSender({ store, fetchImpl: okFetch(calls), now: () => 1_700_000_000_000 });
    expect(sender.publish("order.updated", { orderId: "A1", status: "filled" })).toBe(1);
    expect(sender.publish("order.updated", { orderId: "A2", status: "rejected" })).toBe(1);
    expect(sender.publish("safety.kill_switch", { engaged: true })).toBe(0);
    await sender.idle();
    expect(calls.map((c) => JSON.parse(c.init.body).data.orderId)).toEqual(["A1", "A2"]);
    const { init } = calls[0];
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.headers["X-MCB-Event"]).toBe("order.updated");
    expect(init.headers["X-MCB-Signature"]).toBe(signBody(signingSecret, init.body, 1_700_000_000));
    expect(init.headers["X-MCB-Delivery"]).toBe(JSON.parse(init.body).id);
    expect(store.get(target.id)).toMatchObject({ delivered: 2, failed: 0, lastStatus: 200, lastError: null });
  });

  it("retries a failing project with the same delivery id, then gives up and says why", async () => {
    const store = createForwardStore({ dataDir: dir, secrets: memorySecrets() });
    const { target } = await store.create({ label: "a", url: "https://example.com/hook" });
    const calls = [];
    const sender = createForwardSender({ store, fetchImpl: okFetch(calls, 500), sleep: async () => {}, retryDelays: [1, 1] });
    sender.publish("order.updated", { orderId: "A1" });
    await sender.idle();
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.init.headers["X-MCB-Delivery"])).size).toBe(1);
    expect(store.get(target.id)).toMatchObject({ delivered: 0, failed: 1, lastStatus: 500, lastError: "the project answered 500" });
    const down = createForwardSender({ store, fetchImpl: async () => { throw new Error("ECONNREFUSED 10.0.0.1"); }, sleep: async () => {}, retryDelays: [] });
    expect(await down.test(target)).toEqual({ ok: false, status: null, error: "could not connect" });
  });

  it("treats a redirect as a failure and never follows it", async () => {
    const store = createForwardStore({ dataDir: dir, secrets: memorySecrets() });
    const { target } = await store.create({ label: "a", url: "https://example.com/hook" });
    const calls = [];
    const sender = createForwardSender({ store, fetchImpl: okFetch(calls, 302), sleep: async () => {}, retryDelays: [] });
    expect((await sender.test(target)).ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe("forward module", () => {
  const depsFor = (fetchCalls, orders) => {
    const logger = { child: () => logger, warn() {}, info() {}, error() {}, debug() {}, addSecret() {} };
    return { logger, clock: { now: () => 1_700_000_000_000 }, paths: { dataDir: dir }, secrets: memorySecrets(), bus: createEventBus({}), orders, _fetch: okFetch(fetchCalls) };
  };
  const ctx = (o = {}) => ({ requestId: "req_1", params: {}, body: undefined, principal: { kind: "local", id: "x" }, ...o });

  it("forwards order updates from the bus: the whole order for paper, the bare event for live", async () => {
    const calls = [];
    const asked = [];
    const deps = depsFor(calls, { get: async (_c, id) => (asked.push(id), { orderId: id, symbol: "NSE:RELIANCE", side: "BUY" }) });
    const rt = createForwardRuntime(deps, { fetchImpl: deps._fetch });
    rt.listen();
    const made = await rt.handlers.createForward(ctx({ body: { label: "app", url: "http://127.0.0.1:9/hook" } }));
    expect(made.status).toBe(201);
    deps.bus.emit("order.updated", { orderId: "P1", accountId: "paper", mode: "paper", status: "filled", filledQuantity: 1 });
    deps.bus.emit("order.updated", { orderId: "L1", accountId: "dhan", mode: "live", status: "open", filledQuantity: 0 });
    // The same state announced again is sent once; a new state of the same order is sent.
    deps.bus.emit("order.updated", { orderId: "L1", accountId: "dhan", mode: "live", status: "open", filledQuantity: 0 });
    await new Promise((r) => setTimeout(r, 20));
    await rt.sender.idle();
    const sent = calls.map((c) => JSON.parse(c.init.body).data);
    expect(sent.find((d) => d.orderId === "P1").order).toMatchObject({ symbol: "NSE:RELIANCE" });
    expect(sent.find((d) => d.orderId === "L1").order).toBeUndefined();
    expect(asked).toEqual(["P1"]);
    rt.stop();
    deps.bus.emit("order.updated", { orderId: "P2", mode: "paper" });
    await rt.sender.idle();
    expect(calls).toHaveLength(2);
  });

  it("lists without the secret, tests a target and deletes it", async () => {
    const calls = [];
    const deps = depsFor(calls, null);
    const rt = createForwardRuntime(deps, { fetchImpl: deps._fetch });
    const made = JSON.parse((await rt.handlers.createForward(ctx({ body: { label: "app", url: "https://example.com/h", events: ["order.updated", "safety.kill_switch"] } }))).body);
    const id = made.data.id;
    expect(made.data.signingSecret).toMatch(/^mcbfw_/);
    const list = await rt.handlers.listForwards(ctx());
    expect(JSON.stringify(list)).not.toContain(made.data.signingSecret);
    expect((await rt.handlers.testForward(ctx({ params: { forwardId: id } }))).data).toMatchObject({ ok: true, status: 200 });
    expect(JSON.parse(calls[0].init.body).event).toBe("forward.test");
    expect((await rt.handlers.deleteForward(ctx({ params: { forwardId: id } }))).data.deleted).toBe(true);
    await expect(rt.handlers.testForward(ctx({ params: { forwardId: id } }))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(rt.handlers.deleteForward(ctx({ params: { forwardId: "../x" } }))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
