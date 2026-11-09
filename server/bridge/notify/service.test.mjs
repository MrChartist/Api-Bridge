import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOKEN, TOKEN2, bootNotify, createFakeTelegram } from "./testkit.mjs";

const secretsFile = (dir) => readFileSync(join(dir, "secrets.enc"), "utf8");
const allFiles = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const f of readdirSync(d, { withFileTypes: true })) (f.isDirectory() ? walk(join(d, f.name)) : out.push(join(d, f.name)));
  };
  walk(dir);
  return out;
};

describe("setup: token, chats, test message", () => {
  it("checks the token with Telegram, stores it encrypted and returns only masked hints", async () => {
    const n = bootNotify();
    const { target, replaced } = await n.svc.addTarget({ token: TOKEN, label: "Mine" });
    expect(replaced).toBe(false);
    expect(target.id).toMatch(/^tg_[a-z2-7]{8}$/);
    expect(target.bot).toEqual({ username: "my_bridge_bot", tokenHint: "••••0000" });
    expect(JSON.stringify(target)).not.toContain(TOKEN);
    expect(JSON.stringify(target)).not.toContain("123456789");
    expect(secretsFile(n.dataDir)).not.toContain(TOKEN);
    expect(secretsFile(n.dataDir)).not.toContain("AAH-fake");
    expect(n.tg.calls.map((c) => c.method)).toEqual(["getMe"]);
  });

  it("refuses a malformed token without calling Telegram, and a rejected token with a plain message", async () => {
    const n = bootNotify();
    await expect(n.svc.addTarget({ token: "not a token" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(n.tg.calls).toHaveLength(0);
    const err = await n.svc.addTarget({ token: "111111111:AAH-unknown_token_value_for_tests_xxxx" }).catch((e) => e);
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.detail ?? err.message).toMatch(/does not accept this bot token/);
    expect(JSON.stringify(err)).not.toContain("AAH-unknown");
  });

  it("the same bot with a new token replaces the token and keeps the chats", async () => {
    const n = bootNotify({ tg: createFakeTelegram({ bots: { [TOKEN]: { id: 1, username: "b" }, [TOKEN2]: { id: 1, username: "b" } } }) });
    const { target } = await n.withChat();
    const again = await n.svc.addTarget({ token: TOKEN2 });
    expect(again.replaced).toBe(true);
    expect(again.target.id).toBe(target.id);
    expect(again.target.chats).toHaveLength(1);
    expect((await n.svc.listTargets())).toHaveLength(1);
  });

  it("find my chat: a message from an unknown chat is offered once, never answered, and counted", async () => {
    const n = bootNotify();
    const { target } = await n.svc.addTarget({ token: TOKEN });
    n.tg.receive(TOKEN, { chatId: 777001, text: "hello", name: "Ravi" });
    await n.svc.pollOnce(target.id, { timeout: 0 });
    const found = await n.svc.findChats(target.id);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "Ravi", type: "private", idHint: "••••7001" });
    expect(JSON.stringify(found)).not.toContain("777001");
    expect(n.tg.sent()).toHaveLength(0);
    const st = await n.svc.status();
    expect(st.counters.ignoredMessages).toBe(1);
    const chat = await n.svc.addChat(target.id, { ref: found[0].ref });
    expect(chat.commands).toBe(true);
    expect(await n.svc.findChats(target.id)).toEqual([]);
  });

  it("a group chat is added with commands OFF by default", async () => {
    const n = bootNotify();
    const { target } = await n.svc.addTarget({ token: TOKEN });
    n.tg.receive(TOKEN, { chatId: -100200300, type: "supergroup", name: "Desk", text: "hi" });
    await n.svc.pollOnce(target.id, { timeout: 0 });
    const [f] = await n.svc.findChats(target.id);
    const chat = await n.svc.addChat(target.id, { ref: f.ref });
    expect(chat).toMatchObject({ type: "supergroup", commands: false });
  });

  it("the test message reports delivery per chat, and names a blocked chat in plain words", async () => {
    const n = bootNotify();
    const { target } = await n.withChat();
    const ok = await n.svc.testTarget(target.id);
    expect(ok).toMatchObject({ ok: true, delivered: 1 });
    expect(n.tg.texts()[0]).toMatch(/This is a test from your Bridge/);
    n.tg.script("sendMessage", { status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } });
    const bad = await n.svc.testTarget(target.id);
    expect(bad.ok).toBe(false);
    expect(bad.results[0].error.kind).toBe("blocked");
    expect(bad.message).toMatch(/blocked the bot/);
    const [t] = await n.svc.listTargets();
    expect(t.health.state).toBe("blocked");
    expect(t.chats[0].state.kind).toBe("blocked");
  });

  it("a wrong token later is reported as 'token wrong', and a rate limit as 'slow down' with the wait", async () => {
    const n = bootNotify();
    const { target } = await n.withChat();
    n.tg.script("sendMessage", { status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } });
    expect((await n.svc.testTarget(target.id)).results[0].error.message).toMatch(/does not accept this bot token/);
    n.tg.script("sendMessage", { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 7", parameters: { retry_after: 7 } } });
    const r = await n.svc.testTarget(target.id);
    expect(r.results[0].error).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 7 });
    // while Telegram says wait, a second test does not even call it
    const calls = n.tg.calls.length;
    const again = await n.svc.testTarget(target.id);
    expect(again.results[0].error.kind).toBe("rate_limited");
    expect(n.tg.calls.length).toBe(calls);
  });

  it("removing a target forgets the token, the chats and the queued messages", async () => {
    const n = bootNotify();
    const { target } = await n.withChat();
    await n.svc.publish({ key: "order.filled", text: "x" });
    await n.svc.removeTarget(target.id);
    expect(await n.svc.listTargets()).toEqual([]);
    expect(n.svc.outbox.list()).toEqual([]);
    expect(await n.secrets.list()).toEqual([]);
  });
});

describe("secrets never leak", () => {
  it("the token appears in no log line, no response, no status and no file under the notify folder", async () => {
    const n = bootNotify();
    const { target } = await n.withChat();
    n.tg.script("sendMessage", { status: 500, body: { ok: false, error_code: 500, description: `boom ${TOKEN}` } });
    await n.svc.publish({ key: "order.filled", text: `Filled: token ${TOKEN} and mcb_abcdef123456_secretsecretsecret` });
    await n.settle();
    await n.advance(60_000);
    const status = JSON.stringify(await n.svc.status());
    const targets = JSON.stringify(await n.svc.listTargets());
    const events = JSON.stringify(n.svc.events());
    const test = JSON.stringify(await n.svc.testTarget(target.id));
    for (const blob of [status, targets, events, test, n.logs.join("\n"), n.tg.texts().join("\n")]) {
      expect(blob).not.toContain(TOKEN);
      expect(blob).not.toContain("AAH-fake");
      expect(blob).not.toContain("mcb_abcdef123456_secretsecretsecret");
    }
    for (const f of allFiles(join(n.dataDir, "notify"))) {
      const text = readFileSync(f, "utf8");
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("555");
    }
    expect(secretsFile(n.dataDir)).not.toContain("555");
  });
});

describe("start-up with an unreadable secrets file", () => {
  it("logs that Telegram is off and still starts, so the rest of the Bridge keeps running", async () => {
    const n = bootNotify();
    n.secrets.list = async () => {
      throw new Error("secrets.enc is not a valid secrets file");
    };
    await expect(n.svc.start()).resolves.toBeUndefined();
    expect(n.logs.some((l) => /Telegram is off/.test(String(l)))).toBe(true);
    await n.svc.stop();
  });
});
