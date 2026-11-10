import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeSecretStore } from "../auth/fake.mjs";
import { backoffMs } from "./webhooks.mjs";
import { SECRET, URL_OK, bootWebhooks, createClock, createFakeReceiver, tmpDir } from "./testkit.mjs";

const SUB = { url: URL_OK, topics: ["order.*"], secret: SECRET };
const order = (b, n = 1, extra = {}) => b.eventLog.record("order.updated", { orderId: `o${n}`, accountId: "paper", status: "filled", ...extra });
const allFilesText = (dir) => {
  let text = "";
  const walk = (d) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) walk(join(d, f.name));
      else text += readFileSync(join(d, f.name), "utf8");
    }
  };
  walk(dir);
  return text;
};

describe("subscriptions", () => {
  it("creates, lists, reads, patches and deletes; the answer never has the secret or the URL path", async () => {
    const b = bootWebhooks();
    const s = await b.svc.create({ ...SUB, label: "my receiver" });
    expect(s).toMatchObject({ label: "my receiver", target: "https://hooks.example.test/…", host: "hooks.example.test", topics: ["order.*"], accounts: "*", active: true });
    expect(s.id).toMatch(/^sub_[a-z2-7]{8}$/);
    expect(s.health.state).toBe("unverified");
    const text = JSON.stringify([s, b.svc.list(), b.svc.get(s.id)]);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("abc123");
    expect(Object.keys(s)).not.toContain("secret");
    const p = await b.svc.update(s.id, { topics: ["order.*", "download.*"], active: false, label: null });
    expect(p).toMatchObject({ topics: ["order.*", "download.*"], active: false, label: null });
    await b.svc.remove(s.id);
    expect(b.svc.list()).toEqual([]);
    expect(() => b.svc.get(s.id)).toThrowError(/No webhook subscription/);
    expect(await b.secrets.list()).toEqual([]);
  });

  it("keeps the URL and the secret only in the encrypted store, not in any file of the events folder", async () => {
    const b = bootWebhooks();
    const s = await b.svc.create(SUB);
    order(b);
    await b.svc.pump();
    expect(await b.secrets.get(`subscription:${s.id}`)).toEqual({ url: URL_OK, secret: SECRET });
    const files = allFilesText(b.dir);
    expect(files).not.toContain(SECRET);
    expect(files).not.toContain("abc123");
    expect(files).toContain("hooks.example.test");
  });

  it("validates everything on the way in", async () => {
    const b = bootWebhooks();
    const bad = async (input, path) => {
      const err = await b.svc.create({ ...SUB, ...input }).catch((e) => e);
      expect(err.code, JSON.stringify(input)).toBe("VALIDATION_FAILED");
      expect(err.errors[0].path).toBe(path);
    };
    await bad({ url: "http://hooks.example.test/x" }, "url");
    await bad({ url: "https://127.0.0.1/x" }, "url");
    await bad({ url: "https://localhost/x" }, "url");
    await bad({ url: "https://169.254.169.254/latest" }, "url");
    await bad({ topics: [] }, "topics");
    await bad({ topics: ["tick"] }, "topics");
    await bad({ topics: ["order.*", "confirm.*"] }, "topics");
    await bad({ secret: "short" }, "secret");
    await bad({ secret: "x".repeat(300) }, "secret");
    await bad({ secret: undefined }, "secret");
    await bad({ accounts: [] }, "accounts");
    await bad({ accounts: ["Not Valid"] }, "accounts");
    await bad({ label: "x".repeat(61) }, "label");
    expect(b.svc.list()).toEqual([]);
    expect((await b.svc.update((await b.svc.create(SUB)).id, { url: "ftp://x.example.test" }).catch((e) => e)).errors[0].path).toBe("url");
  });

  it("limits how many there can be, and can be switched off in the config", async () => {
    const b = bootWebhooks({ config: { webhooks: { maxSubscriptions: 2 } } });
    await b.svc.create(SUB);
    await b.svc.create(SUB);
    await expect(b.svc.create(SUB)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const off = bootWebhooks({ config: { webhooks: { enabled: false } } });
    await expect(off.svc.create(SUB)).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  });

  it("changes the target or the secret with PATCH, and the next delivery uses the new ones", async () => {
    const b = bootWebhooks();
    const s = await b.svc.create(SUB);
    const NEW_SECRET = "a-completely-new-secret-0123456789";
    await b.svc.update(s.id, { secret: NEW_SECRET, url: "https://other.example.test/new" });
    b.receiver.secret = NEW_SECRET;
    order(b);
    await b.svc.pump();
    expect(b.receiver.calls[0]).toMatchObject({ url: "https://other.example.test/new", signatureOk: true });
    expect(await b.secrets.get(`subscription:${s.id}`)).toEqual({ url: "https://other.example.test/new", secret: NEW_SECRET });
    expect(JSON.stringify(b.svc.get(s.id))).not.toContain(NEW_SECRET);
  });

  it("refuses to patch the URL when the stored secret is gone, instead of signing with nothing", async () => {
    const secrets = createFakeSecretStore();
    const b = bootWebhooks({ secrets });
    const s = await b.svc.create(SUB);
    await secrets.delete(`subscription:${s.id}`);
    const b2 = bootWebhooks({ secrets, dir: b.dir });
    const err = await b2.svc.update(s.id, { url: "https://other.example.test/x" }).catch((e) => e);
    expect(err.code).toBe("VALIDATION_FAILED");
    await b2.svc.update(s.id, { url: "https://other.example.test/x", secret: SECRET });
    expect(await secrets.get(`subscription:${s.id}`)).toEqual({ url: "https://other.example.test/x", secret: SECRET });
  });
});

describe("delivery", () => {
  it("queues one delivery per matching subscription and sends a signed envelope", async () => {
    const b = bootWebhooks();
    const a = await b.svc.create(SUB);
    await b.svc.create({ ...SUB, topics: ["download.*"] });
    await b.svc.create({ ...SUB, topics: ["*"], active: false });
    const e = order(b, 7, { confirmToken: "mct_shouldneverleaveabc" });
    expect(b.svc._outbox()).toHaveLength(1);
    await b.svc.pump();
    expect(b.receiver.calls).toHaveLength(1);
    const call = b.receiver.calls[0];
    expect(call.signatureOk).toBe(true);
    expect(call.headers).toMatchObject({ "X-Bridge-Event-Id": String(e.seq), "X-Bridge-Event-Topic": "order.updated", "X-Bridge-Attempt": "1" });
    expect(call.headers["X-Bridge-Delivery"]).toMatch(/^dlv_[0-9a-f]{12}$/);
    expect(JSON.parse(call.body)).toEqual({ id: String(e.seq), topic: "order.updated", time: new Date(e.at).toISOString(), apiVersion: "v1", data: { orderId: "o7", accountId: "paper", status: "filled" } });
    expect(call.body).not.toContain("mct_");
    expect(b.svc._outbox()).toHaveLength(0);
    expect(b.svc.get(a.id).health).toMatchObject({ state: "ok", delivered: 1, failed: 0, consecutiveFailures: 0 });
    expect(b.svc.deliveries(a.id)).toMatchObject([{ outcome: "delivered", ok: true, status: 200, attempt: 1, eventId: String(e.seq) }]);
  });

  it("respects topic filters and the subscription's account list", async () => {
    const b = bootWebhooks();
    await b.svc.create({ ...SUB, topics: ["order.updated"], accounts: ["dhan-main"] });
    order(b, 1, { accountId: "kite-main" });
    order(b, 2, { accountId: "dhan-main" });
    b.eventLog.record("download.done", { id: "d1" });
    await b.svc.pump();
    expect(b.receiver.bodies().map((x) => x.data.orderId)).toEqual(["o2"]);
  });

  it("an admin-only topic reaches a webhook (an admin made it), but a confirm token never does", async () => {
    const b = bootWebhooks();
    await b.svc.create({ ...SUB, topics: ["ticket.*"] });
    b.eventLog.record("ticket.prepared", { ticketId: "tkt_1", accountId: "paper", symbol: "NSE:X", side: "BUY", quantity: 1, confirmToken: "mct_abcdefabcdefabcdef", confirmExpiresAt: "x" });
    await b.svc.pump();
    expect(b.receiver.calls).toHaveLength(1);
    expect(b.receiver.calls[0].body).toContain("tkt_1");
    expect(b.receiver.calls[0].body).not.toMatch(/mct_|confirm/i);
  });

  it("retries with growing waits, then delivers, and logs each attempt", async () => {
    const b = bootWebhooks({ config: { webhooks: { retry: { baseMs: 1000, maxMs: 60_000, jitter: 0 } } } });
    const s = await b.svc.create(SUB);
    b.receiver.script({ status: 503, times: 2 });
    order(b);
    await b.svc.pump();
    expect(b.svc._outbox()[0]).toMatchObject({ attempts: 1, nextAttemptAt: b.clock.now() + 1000 });
    await b.svc.pump(); // not due yet: nothing happens
    expect(b.receiver.calls).toHaveLength(1);
    b.clock.advance(1000);
    await b.svc.pump();
    expect(b.svc._outbox()[0]).toMatchObject({ attempts: 2, nextAttemptAt: b.clock.now() + 2000 });
    b.clock.advance(2000);
    await b.svc.pump();
    expect(b.svc._outbox()).toHaveLength(0);
    expect(b.receiver.calls.map((c) => c.headers["X-Bridge-Attempt"])).toEqual(["1", "2", "3"]);
    // the same bytes every time, a fresh signature each time
    expect(new Set(b.receiver.calls.map((c) => c.body)).size).toBe(1);
    expect(new Set(b.receiver.calls.map((c) => c.headers["X-Bridge-Signature"])).size).toBe(3);
    expect(b.receiver.calls.every((c) => c.signatureOk)).toBe(true);
    const log = b.svc.deliveries(s.id);
    expect(log.map((r) => [r.attempt, r.outcome, r.status])).toEqual([[3, "delivered", 200], [2, "retry", 503], [1, "retry", 503]]);
    expect(log[1].nextAttemptAt).toBeTruthy();
    expect(b.svc.get(s.id).health).toMatchObject({ delivered: 1, failed: 2, consecutiveFailures: 0 });
  });

  it("follows the documented backoff: base, doubling, capped, with jitter", () => {
    const r = { baseMs: 5000, maxMs: 3_600_000, jitter: 0.2 };
    expect([1, 2, 3, 4, 5].map((n) => backoffMs(n, r, () => 0.5))).toEqual([5000, 10_000, 20_000, 40_000, 80_000]);
    expect(backoffMs(20, r, () => 0.5)).toBe(3_600_000);
    expect(backoffMs(1, r, () => 0)).toBe(4000);
    expect(backoffMs(1, r, () => 1)).toBe(6000);
  });

  it("waits at least as long as the receiver's Retry-After (up to maxMs)", async () => {
    const b = bootWebhooks({ config: { webhooks: { retry: { baseMs: 1000, maxMs: 600_000, jitter: 0 } } } });
    await b.svc.create(SUB);
    b.receiver.script({ status: 429, retryAfter: "90" });
    order(b);
    await b.svc.pump();
    expect(b.svc._outbox()[0].nextAttemptAt).toBe(b.clock.now() + 90_000);
    b.receiver.script({ status: 429, retryAfter: "99999" });
    b.clock.advance(90_000);
    await b.svc.pump();
    expect(b.svc._outbox()[0].nextAttemptAt).toBe(b.clock.now() + 600_000);
  });

  it("sets the event aside as a dead letter after the last attempt, and lists it", async () => {
    const b = bootWebhooks({ config: { webhooks: { retry: { maxAttempts: 3, baseMs: 100, maxMs: 1000, jitter: 0 } } } });
    const s = await b.svc.create(SUB);
    b.receiver.always({ status: 500 });
    const e = order(b);
    for (let i = 0; i < 3; i += 1) {
      await b.svc.pump();
      b.clock.advance(1000);
    }
    expect(b.receiver.calls).toHaveLength(3);
    expect(b.svc._outbox()).toEqual([]);
    const dl = b.svc.deadLetters(s.id);
    expect(dl).toHaveLength(1);
    expect(dl[0]).toMatchObject({ eventId: String(e.seq), topic: "order.updated", attempts: 3, reason: "http_5xx", status: 500 });
    expect(dl[0].message).toMatch(/5xx/);
    expect(JSON.stringify(dl)).not.toContain("o1"); // the body is kept for a resend, not shown in the list
    expect(b.svc.deliveries(s.id)[0]).toMatchObject({ outcome: "dead", attempt: 3 });
    expect(b.svc.get(s.id)).toMatchObject({ deadLetters: 1, pending: 0, health: { deadLettered: 1, state: "failing", consecutiveFailures: 3 } });
  });

  it("does not retry what a retry cannot fix: a 4xx, a redirect, a refused target", async () => {
    const b = bootWebhooks();
    const s = await b.svc.create(SUB);
    b.receiver.script({ status: 400 });
    b.receiver.script({ status: 301, hasLocation: true });
    order(b, 1);
    order(b, 2);
    await b.svc.pump();
    expect(b.receiver.calls).toHaveLength(2);
    expect(b.svc.deadLetters(s.id).map((d) => d.reason).sort()).toEqual(["http_4xx", "redirect_refused"]);
    // DNS now points somewhere private: permanent
    b.dns.set("hooks.example.test", ["10.0.0.9"]);
    order(b, 3);
    await b.svc.pump();
    expect(b.receiver.calls).toHaveLength(2);
    expect(b.svc.deadLetters(s.id).some((d) => d.reason === "blocked_address")).toBe(true);
  });

  it("gives up on events that are too old, even with attempts left", async () => {
    const b = bootWebhooks({ config: { webhooks: { retry: { maxAttempts: 50, baseMs: 600_000, maxMs: 600_000, jitter: 0, maxAgeSec: 3600 } } } });
    const s = await b.svc.create(SUB);
    b.receiver.always({ status: 503 });
    order(b);
    await b.svc.pump();
    b.clock.advance(3_601_000);
    await b.svc.pump();
    expect(b.svc.deadLetters(s.id)[0]).toMatchObject({ reason: "expired" });
  });

  it("sends a dead letter again on request, and can clear the list", async () => {
    const b = bootWebhooks();
    const s = await b.svc.create(SUB);
    b.receiver.script({ status: 400 });
    order(b);
    await b.svc.pump();
    const [d] = b.svc.deadLetters(s.id);
    expect(await b.svc.retryDead(s.id, d.id)).toEqual({ id: d.id, status: "queued" });
    expect(b.svc.deadLetters(s.id)).toEqual([]);
    await b.svc.pump();
    expect(b.receiver.calls).toHaveLength(2);
    expect(b.svc._outbox()).toEqual([]);
    expect(b.svc.deliveries(s.id)[0]).toMatchObject({ outcome: "delivered", attempt: 1 });
    await expect(b.svc.retryDead(s.id, "dlv_000000000000")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.svc.retryDead(s.id, "nonsense")).rejects.toMatchObject({ code: "NOT_FOUND" });
    b.receiver.script({ status: 400, times: 2 });
    order(b, 2);
    order(b, 3);
    await b.svc.pump();
    expect(b.svc.clearDead(s.id)).toEqual({ removed: 2 });
    expect(b.svc.deadLetters(s.id)).toEqual([]);
  });

  it("holds events for a paused subscription and sends them when it is switched on again", async () => {
    const b = bootWebhooks();
    const s = await b.svc.create(SUB);
    b.receiver.script({ status: 503 });
    order(b, 1);
    await b.svc.pump();
    await b.svc.update(s.id, { active: false });
    order(b, 2); // not queued: the subscription is off
    b.clock.advance(3_600_000);
    await b.svc.pump();
    expect(b.receiver.calls).toHaveLength(1); // the retry waits while paused
    await b.svc.update(s.id, { active: true });
    await b.svc.pump();
    expect(b.receiver.bodies().map((x) => x.data.orderId)).toEqual(["o1", "o1"]);
  });

  it("limits the queue per subscription: the oldest event is set aside when it is full", async () => {
    const b = bootWebhooks({ config: { webhooks: { maxPendingPerSubscription: 10 } } });
    const s = await b.svc.create(SUB);
    for (let i = 1; i <= 12; i += 1) order(b, i);
    expect(b.svc._outbox()).toHaveLength(10);
    const dead = b.svc.deadLetters(s.id);
    expect(dead).toHaveLength(2);
    expect(dead.every((d) => d.reason === "overflow")).toBe(true);
    expect(dead[0].message).toMatch(/queue/);
  });

  it("runs at most `concurrency` deliveries at once", async () => {
    const clock = createClock();
    let running = 0;
    let peak = 0;
    const rx = createFakeReceiver({ clock });
    const slow = async (req) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setImmediate(r));
      running -= 1;
      return rx.transport(req);
    };
    const b = bootWebhooks({ clock, config: { webhooks: { concurrency: 2 } }, receiver: { transport: slow, calls: rx.calls, script: rx.script, bodies: rx.bodies, secret: SECRET } });
    await b.svc.create(SUB);
    for (let i = 1; i <= 6; i += 1) order(b, i);
    await b.svc.pump();
    expect(peak).toBe(2); // never more than `concurrency` at once, and slots are refilled as attempts end
    expect(rx.calls).toHaveLength(6);
  });

  it("schedules a timer for the next due item and pumps when it fires", async () => {
    const b = bootWebhooks({ config: { webhooks: { retry: { baseMs: 5000, jitter: 0 } } } });
    b.svc.start();
    await b.svc.create(SUB);
    b.receiver.script({ status: 500 });
    order(b);
    expect(b.scheduled.at(-1).ms).toBe(0); // due at once
    await b.svc.pump();
    expect(b.scheduled.at(-1).ms).toBe(5000); // the retry
    b.clock.advance(5000);
    b.scheduled.at(-1).fn();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(b.svc._outbox()).toEqual([]);
    b.svc.stop();
  });
});

describe("durability", () => {
  it("keeps the queue, the dead letters, the log and the subscriptions across a restart; an in-flight item is sent again", async () => {
    const dir = tmpDir();
    const secrets = createFakeSecretStore();
    const clock = createClock();
    const first = bootWebhooks({ dir, clock, secrets, config: { webhooks: { retry: { baseMs: 1000, jitter: 0, maxAttempts: 3 } } } });
    const s = await first.svc.create(SUB);
    first.receiver.script({ status: 503 });
    first.receiver.script({ status: 400 });
    order(first, 1);
    order(first, 2);
    order(first, 3);
    // o1 fails (retry), o2 dies (400), o3 is delivered by the default 200
    await first.svc.pump();
    expect(first.svc._outbox().map((i) => i.attempts)).toEqual([1]);
    expect(first.svc.deadLetters(s.id)).toHaveLength(1);
    // an item that was queued but never attempted before the stop
    order(first, 4);
    first.svc.stop();

    // restart: a new service on the same folder and the same secret store
    const second = bootWebhooks({ dir, clock, secrets, config: { webhooks: { retry: { baseMs: 1000, jitter: 0, maxAttempts: 3 } } } });
    expect(second.svc.list()).toHaveLength(1);
    expect(second.svc.get(s.id)).toMatchObject({ pending: 2, deadLetters: 1, health: { delivered: 1, failed: 2 } });
    expect(second.svc.deliveries(s.id).length).toBe(first.svc.deliveries(s.id).length);
    await second.svc.pump(); // o4 is due; o1 waits for its backoff
    expect(second.receiver.bodies().map((b) => b.data.orderId)).toEqual(["o4"]);
    clock.advance(1000);
    await second.svc.pump();
    expect(second.receiver.bodies().map((b) => b.data.orderId)).toEqual(["o4", "o1"]);
    expect(second.receiver.calls.every((c) => c.signatureOk)).toBe(true);
    expect(second.svc._outbox()).toEqual([]);
    const text = allFilesText(dir);
    expect(text).not.toContain(SECRET);
  });

  it("notices a lost secret at start and says so in plain words; deliveries wait in the queue (not the dead letters) until it is set again", async () => {
    const dir = tmpDir();
    const secrets = createFakeSecretStore();
    const a = bootWebhooks({ dir, secrets });
    const s = await a.svc.create(SUB);
    // the Bridge restarts and the secrets store has lost the entry (demo mode keeps secrets in memory only)
    const b = bootWebhooks({ dir, secrets: createFakeSecretStore() });
    b.svc.start();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(b.svc.get(s.id).health.state).toBe("needs-secret");
    expect(b.logLines.join("\n")).toMatch(/no stored signing secret/);
    order(b);
    await b.svc.pump();
    expect(b.receiver.calls).toEqual([]);
    // OPS-15: the delivery is held, not thrown away
    expect(b.svc.deadLetters(s.id)).toEqual([]);
    expect(b.svc.get(s.id)).toMatchObject({ pending: 1, health: { state: "needs-secret" } });
    await expect(b.svc.test(s.id)).rejects.toMatchObject({ code: "STATE_CONFLICT" });
    // set it again: the held delivery goes out
    await b.svc.update(s.id, { secret: SECRET, url: URL_OK });
    expect(b.svc.get(s.id).health.state).not.toBe("needs-secret");
    await b.svc.pump();
    expect(b.receiver.calls).toHaveLength(1);
    expect(b.receiver.calls[0].signatureOk).toBe(true);
    b.svc.stop();
  });

  it("starts empty and works when its files are damaged", async () => {
    const dir = tmpDir();
    const secrets = createFakeSecretStore();
    const a = bootWebhooks({ dir, secrets });
    await a.svc.create(SUB);
    const { writeFileSync, appendFileSync } = await import("node:fs");
    writeFileSync(join(dir, "outbox.jsonl"), "garbage\n");
    appendFileSync(join(dir, "subscriptions.jsonl"), '{"op":"put","r":{"id":"sub_tor');
    const b = bootWebhooks({ dir, secrets });
    expect(b.svc.list()).toHaveLength(1);
    expect(b.svc._outbox()).toEqual([]);
  });

  it("keeps the delivery log and dead-letter list to their limits", async () => {
    const b = bootWebhooks({ config: { webhooks: { deliveryLogMax: 50, deadLetterMax: 10 } } });
    const s = await b.svc.create(SUB);
    b.receiver.always({ status: 400 });
    for (let i = 1; i <= 60; i += 1) order(b, i);
    await b.svc.pump();
    for (let i = 0; i < 20; i += 1) await b.svc.pump();
    expect(b.svc.deliveries(s.id, { limit: 500 }).length).toBeLessThanOrEqual(50);
    expect(b.svc.deadLetters(s.id).length).toBeLessThanOrEqual(10);
    expect(b.svc.deadLetters(s.id)[0].eventId).toBe(String(60)); // newest first
  });
});

describe("test send", () => {
  it("makes one signed delivery that is not queued, not retried, and is in the log", async () => {
    const b = bootWebhooks();
    const s = await b.svc.create(SUB);
    const r = await b.svc.test(s.id);
    expect(r).toMatchObject({ ok: true, status: 200, code: null, willRetry: false });
    const call = b.receiver.calls[0];
    expect(call.signatureOk).toBe(true);
    expect(call.headers["X-Bridge-Event-Topic"]).toBe("subscription.test");
    expect(JSON.parse(call.body)).toMatchObject({ id: "test", topic: "subscription.test", data: { subscriptionId: s.id } });
    expect(b.svc._outbox()).toEqual([]);
    expect(b.svc.deliveries(s.id)[0]).toMatchObject({ test: true, outcome: "delivered", topic: "subscription.test" });
    expect(b.svc.get(s.id).health.state).toBe("ok");
    expect(b.svc.get(s.id).health.delivered).toBe(0); // a test is not a delivery
  });

  it("reports a failure in plain words without queueing a retry", async () => {
    const b = bootWebhooks();
    const s = await b.svc.create(SUB);
    b.receiver.script({ status: 401 });
    const r = await b.svc.test(s.id);
    expect(r).toMatchObject({ ok: false, status: 401, code: "http_4xx", willRetry: false });
    expect(r.message).toMatch(/refused/);
    expect(b.svc._outbox()).toEqual([]);
    expect(b.svc.deliveries(s.id)[0]).toMatchObject({ outcome: "failed", test: true });
  });

  it("is limited to one test every two seconds per subscription", async () => {
    const b = bootWebhooks();
    const s = await b.svc.create(SUB);
    await b.svc.test(s.id);
    const err = await b.svc.test(s.id).catch((e) => e);
    expect(err).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 2000 });
    b.clock.advance(2000);
    await expect(b.svc.test(s.id)).resolves.toMatchObject({ ok: true });
  });
});

describe("no secrets in logs, answers or records", () => {
  it("never logs the secret or the URL, even when delivery fails and files are damaged", async () => {
    const b = bootWebhooks();
    const s = await b.svc.create(SUB);
    b.receiver.script({ throws: "ECONNREFUSED", times: 2 });
    order(b);
    await b.svc.pump();
    await b.svc.test(s.id).catch(() => {});
    b.logger.info("a url in a message", { note: `calling ${URL_OK} with ${SECRET}` });
    b.logger.error("failed", { err: new Error(`could not reach ${URL_OK}`) });
    const all = b.logLines.join("\n");
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("abc123");
    const records = JSON.stringify([b.svc.list(), b.svc.deliveries(s.id), b.svc.deadLetters(s.id), b.svc.status()]);
    expect(records).not.toContain(SECRET);
    expect(records).not.toContain("abc123");
    expect(records).not.toMatch(/v1=[0-9a-f]{16}/);
  });
});
