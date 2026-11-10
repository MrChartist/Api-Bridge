/**
 * `mc-bridge subscriptions ...` against a real Bridge on 127.0.0.1 (the events module with a fake receiver behind it).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeKeyStore, createFakeSecretStore } from "../auth/fake.mjs";
import { createApp } from "../core/app.mjs";
import { runCli } from "../core/cli.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createFakeAuditLog } from "../safety/fake.mjs";
import { formatSubscriptions } from "./cli.mjs";
import { createEventsModule } from "./module.mjs";
import { URL_OK, createFakeReceiver, publicDns } from "./testkit.mjs";

const cleanups = [];
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});

async function bridge() {
  const dir = mkdtempSync(join(tmpdir(), "mcb-events-cli-"));
  const receiver = createFakeReceiver({ clock: { now: () => Date.now() } });
  const keyStore = createFakeKeyStore();
  const { config } = loadConfig({ raw: { dataDir: join(dir, "data"), logging: { level: "silent" }, server: { port: 0 } }, env: {} });
  const app = await createApp({
    config,
    modules: [createEventsModule({ transport: receiver.transport, resolve: publicDns().resolve })],
    logger: createNullLogger(),
    overrides: { keyStore, secrets: createFakeSecretStore(), audit: createFakeAuditLog() },
  });
  const { port } = await app.listen();
  writeFileSync(join(dir, "bridge.config.json"), JSON.stringify({ dataDir: join(dir, "data"), logging: { level: "silent" } }));
  cleanups.push(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const admin = keyStore.addKey({ label: "cli", scopes: ["admin"], accounts: "*" }).key;
  const out = [];
  const err = [];
  const io = (extra = {}) => ({ out: (s) => out.push(s), err: (s) => err.push(s), env: { MCB_ADMIN_KEY: admin }, cwd: dir, sleep: async () => {}, ...extra });
  const run = (args, flags = {}, ioExtra) => runCli(["subscriptions", ...args], { url: `http://127.0.0.1:${port}`, config: join(dir, "bridge.config.json"), ...flags }, io(ioExtra));
  return { app, receiver, out, err, run, text: () => [...out, ...err].join("\n") };
}

const idOf = (b) => /(sub_[a-z2-7]{8})/.exec(b.text())[1];

describe("mc-bridge subscriptions", () => {
  it("adds a webhook, prints the secret once, and the receiver can verify what it is sent", async () => {
    const b = await bridge();
    const SECRET = "ab".repeat(32);
    expect(await b.run(["add", URL_OK], { topics: "order.*,download.*", label: "my receiver" }, { randomSecret: () => SECRET })).toBe(0);
    expect(b.out.join("\n")).toContain(SECRET);
    expect(b.out.join("\n")).toMatch(/shown once/);
    expect(b.out.join("\n")).toContain("Created sub_");
    expect(b.out.join("\n")).not.toContain("abc123"); // the URL path is not echoed back
    const id = idOf(b);
    b.receiver.secret = SECRET;
    b.out.length = 0;
    expect(await b.run(["test", id])).toBe(0);
    expect(b.out.join("\n")).toMatch(/Delivered: the receiver answered 200/);
    expect(b.receiver.calls[0].signatureOk).toBe(true);
    b.out.length = 0;
    expect(await b.run(["list"])).toBe(0);
    expect(b.out.join("\n")).toContain("hooks.example.test");
    expect(b.out.join("\n")).not.toContain(SECRET);
    expect(b.out.join("\n")).toContain("order.*,download.*");
  });

  it("warns when a webhook names an admin topic, and says nothing for read topics (audit S11)", async () => {
    const b = await bridge();
    expect(await b.run(["add", URL_OK], { topics: "order.*,ticket.prepared" }, { randomSecret: () => "cd".repeat(32) })).toBe(0);
    expect(b.out.join("\n")).toMatch(/Warning: ticket\.prepared is an admin topic .*sent to https:\/\/hooks\.example\.test/);
    b.out.length = 0;
    expect(await b.run(["add", URL_OK], { topics: "*" }, { randomSecret: () => "ef".repeat(32) })).toBe(0);
    expect(b.out.join("\n")).not.toMatch(/Warning/);
  });

  it("refuses a secret on the command line, a missing URL or topics, and a bad target", async () => {
    const b = await bridge();
    expect(await b.run(["add", URL_OK], { topics: "order.*", secret: "hunter2hunter2hunter2" })).toBe(1);
    expect(b.text()).toMatch(/never taken from the command line/);
    expect(b.text()).not.toContain("hunter2");
    expect(await b.run(["add"], { topics: "order.*" })).toBe(1);
    expect(b.text()).toMatch(/needs the https URL/);
    expect(await b.run(["add", URL_OK, "typed-a-secret-here-0123456789"], { topics: "order.*" })).toBe(1);
    expect(b.text()).toMatch(/shell history/);
    expect(b.text()).not.toContain("typed-a-secret");
    expect(await b.run(["add", URL_OK], {})).toBe(1);
    expect(b.text()).toMatch(/--topics/);
    expect(await b.run(["add", "http://hooks.example.test/x"], { topics: "order.*" })).toBe(1);
    expect(b.text()).toMatch(/https/);
    expect(await b.run(["show"])).toBe(1);
    expect(await b.run(["nonsense"])).toBe(1);
  });

  it("reads your own secret from standard input with --secret-stdin and never prints it", async () => {
    const b = await bridge();
    const mine = "my-own-signing-secret-0123456789";
    expect(await b.run(["add", URL_OK], { topics: "order.*", "secret-stdin": true }, { readStdin: async () => `${mine}\n` })).toBe(0);
    expect(b.text()).not.toContain(mine);
    b.receiver.secret = mine;
    const id = idOf(b);
    expect(await b.run(["test", id])).toBe(0);
    expect(b.receiver.calls[0].signatureOk).toBe(true);
    const next = "a-newer-signing-secret-0123456789";
    expect(await b.run(["rotate-secret", id], { "secret-stdin": true }, { readStdin: async () => next })).toBe(0);
    expect(b.text()).not.toContain(next);
    b.receiver.secret = next;
    b.receiver.calls.length = 0;
    await new Promise((r) => setTimeout(r, 2100)); // one test every two seconds
    expect(await b.run(["test", id])).toBe(0);
    expect(b.receiver.calls[0].signatureOk).toBe(true);
    expect(await b.run(["add", URL_OK], { topics: "order.*", "secret-stdin": true }, { readStdin: async () => "" })).toBe(1);
  });

  it("rotates a generated secret and prints it once", async () => {
    const b = await bridge();
    await b.run(["add", URL_OK], { topics: "order.*" });
    const id = idOf(b);
    b.out.length = 0;
    expect(await b.run(["rotate-secret", id])).toBe(0);
    expect(b.out.join("\n")).toMatch(/\n? {2}[0-9a-f]{64}/);
  });

  it("pauses, resumes, shows deliveries and dead letters, retries, and removes", async () => {
    const b = await bridge();
    await b.run(["add", URL_OK], { topics: "order.*" });
    const id = idOf(b);
    b.out.length = 0;
    expect(await b.run(["pause", id])).toBe(0);
    expect(b.out.join("\n")).toMatch(/paused/);
    expect(await b.run(["resume", id])).toBe(0);
    expect(b.out.join("\n")).toMatch(/is on/);
    b.receiver.script({ status: 400 });
    b.app.deps.bus.emit("order.updated", { orderId: "o1", accountId: "p", status: "filled" });
    for (let i = 0; i < 100 && b.receiver.calls.length < 1; i += 1) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    b.out.length = 0;
    expect(await b.run(["dead-letters", id])).toBe(1);
    expect(b.out.join("\n")).toMatch(/dlv_[0-9a-f]{12}\s+event 1\s+order\.updated/);
    b.out.length = 0;
    expect(await b.run(["deliveries", id], { outcome: "dead" })).toBe(0);
    expect(b.out.join("\n")).toMatch(/dead\s+event 1/);
    expect(await b.run(["status"])).toBe(1); // a dead letter is something to look at
    expect(await b.run(["dead-letters", id], { "retry-all": true })).toBe(0);
    for (let i = 0; i < 100 && b.receiver.calls.length < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    b.out.length = 0;
    expect(await b.run(["dead-letters", id])).toBe(0);
    expect(b.out.join("\n")).toMatch(/No dead letters/);
    expect(await b.run(["dead-letters", id], { clear: true })).toBe(0);
    expect(await b.run(["remove", id])).toBe(0);
    b.out.length = 0;
    await b.run(["list"]);
    expect(b.out.join("\n")).toMatch(/No webhook subscriptions/);
  });

  it("lists topics and prints the status", async () => {
    const b = await bridge();
    expect(await b.run(["topics"])).toBe(0);
    expect(b.out.join("\n")).toMatch(/order\.updated\s+read/);
    expect(b.out.join("\n")).toMatch(/ticket\.prepared\s+admin/);
    b.out.length = 0;
    expect(await b.run(["status"])).toBe(0);
    expect(b.out.join("\n")).toMatch(/Event log: 0 kept/);
    b.out.length = 0;
    expect(await b.run(["status"], { json: true })).toBe(0);
    expect(JSON.parse(b.out.join("\n")).webhooks.subscriptions).toBe(0);
  });

  it("tails events from now on, and from the start with --since 0", async () => {
    const b = await bridge();
    const bus = b.app.deps.bus;
    bus.emit("order.updated", { orderId: "old", accountId: "p" });
    let polls = 0;
    const sleep = async () => {
      polls += 1;
      if (polls === 1) bus.emit("order.updated", { orderId: "new", accountId: "p" });
    };
    expect(await b.run(["tail"], { topics: "order.*" }, { maxPolls: 2, sleep })).toBe(0);
    const printed = b.out.join("\n");
    expect(printed).toMatch(/order\.updated\s+\{"orderId":"new"/);
    expect(printed).not.toContain('"old"');
    b.out.length = 0;
    expect(await b.run(["tail"], { since: "0", json: true }, { maxPolls: 1 })).toBe(0);
    expect(b.out.map((l) => JSON.parse(l).data.orderId)).toEqual(["old", "new"]);
  });

  it("says what to do when the Bridge is not running or needs an admin key", async () => {
    const b = await bridge();
    const code = await runCli(["subscriptions", "list"], { url: "http://127.0.0.1:1", config: join(tmpdir(), "nothing.json") }, { out: () => {}, err: (s) => b.err.push(s), env: {}, cwd: tmpdir() });
    expect(code).toBeGreaterThan(0);
  });
});

describe("formatSubscriptions", () => {
  it("is plain and short", () => {
    expect(formatSubscriptions([])).toMatch(/No webhook subscriptions/);
    const line = formatSubscriptions([{ id: "sub_abcdefgh", target: "https://h.example/…", topics: ["order.*"], active: true, label: "x", pending: 2, deadLetters: 1, health: { state: "failing", delivered: 3, lastFailure: { message: "The receiver had an error (a 5xx answer)." } } }]);
    expect(line).toContain("failing");
    expect(line).toContain("2 waiting");
    expect(line).toContain("1 dead");
  });
});
