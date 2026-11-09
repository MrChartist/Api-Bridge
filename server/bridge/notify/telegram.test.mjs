import { describe, expect, it } from "vitest";
import { MAX_TEXT, TELEGRAM_HOST, TelegramError, classify, createTelegramClient, isChatRef, looksLikeToken, maskId, maskToken } from "./telegram.mjs";
import { TOKEN, bootNotify, createFakeTelegram } from "./testkit.mjs";

const reply = (status, body, headers = {}) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const clientWith = (fetchImpl) => createTelegramClient({ token: TOKEN, fetchImpl });

describe("classify: Telegram answers become a small set of kinds", () => {
  it.each([
    [429, { error_code: 429, parameters: { retry_after: 3 } }, "rate_limited"],
    [401, { error_code: 401, description: "Unauthorized" }, "token_invalid"],
    [404, { error_code: 404, description: "Not Found" }, "token_invalid"],
    [403, { error_code: 403, description: "Forbidden: bot was blocked by the user" }, "blocked"],
    [403, { error_code: 403, description: "Forbidden: user is deactivated" }, "blocked"],
    [403, { error_code: 403, description: "Forbidden: bot can't send messages to the group" }, "forbidden"],
    [400, { error_code: 400, description: "Bad Request: chat not found" }, "chat_not_found"],
    [400, { error_code: 400, description: "Bad Request: message is too long" }, "too_long"],
    [400, { error_code: 400, description: "Bad Request: can't parse entities" }, "bad_request"],
    [400, { error_code: 400, description: "x", parameters: { migrate_to_chat_id: -100123 } }, "migrated"],
    [409, { error_code: 409, description: "Conflict: terminated by other getUpdates request" }, "conflict"],
    [502, { error_code: 502, description: "Bad Gateway" }, "server"],
    [418, { error_code: 418 }, "unknown"],
  ])("%s %j -> %s", (status, body, kind) => {
    expect(classify(status, body)).toBe(kind);
  });
});

describe("the client", () => {
  it("posts JSON to the one fixed host with the token in the path, and sends plain text with no link preview", async () => {
    let seen;
    const c = clientWith(async (url, init) => ((seen = { url, init }), new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))));
    await c.sendMessage("42", "hello");
    expect(seen.url).toBe(`${TELEGRAM_HOST}/bot${TOKEN}/sendMessage`);
    expect(seen.init.method).toBe("POST");
    expect(JSON.parse(seen.init.body)).toEqual({ chat_id: "42", text: "hello", link_preview_options: { is_disabled: true } });
    expect(seen.init.redirect).toBe("error");
  });

  it("keeps text under Telegram's 4096-character limit", async () => {
    let body;
    const c = clientWith(async (_u, init) => ((body = JSON.parse(init.body)), new Response(JSON.stringify({ ok: true, result: {} }))));
    await c.sendMessage("1", "x".repeat(9000));
    expect(body.text.length).toBe(MAX_TEXT);
    expect(MAX_TEXT).toBeLessThanOrEqual(4096);
  });

  it("getUpdates asks for message updates only, with the long-poll timeout and offset", async () => {
    let body;
    let init2;
    const c = clientWith(async (_u, init) => ((body = JSON.parse(init.body)), (init2 = init), new Response(JSON.stringify({ ok: true, result: [] }))));
    await c.getUpdates({ offset: 1234, timeout: 25 });
    expect(body).toEqual({ offset: 1234, timeout: 25, limit: 20, allowed_updates: ["message"] });
    expect(init2.signal).toBeTruthy();
  });

  it("reads retry_after from the body, falling back to the Retry-After header, and never puts the token in an error", async () => {
    const e1 = await clientWith(reply(429, { ok: false, error_code: 429, description: `Too Many Requests: retry after 12 ${TOKEN}`, parameters: { retry_after: 12 } })).sendMessage("1", "x").catch((e) => e);
    expect(e1).toBeInstanceOf(TelegramError);
    expect(e1).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 12, retryable: true });
    expect(JSON.stringify([e1.message, e1.description])).not.toContain(TOKEN);
    const e2 = await clientWith(reply(429, { ok: false, error_code: 429 }, { "retry-after": "9" })).sendMessage("1", "x").catch((e) => e);
    expect(e2.retryAfterSeconds).toBe(9);
    const e3 = await clientWith(reply(429, { ok: false, error_code: 429 })).sendMessage("1", "x").catch((e) => e);
    expect(e3.retryAfterSeconds).toBe(5);
  });

  it("a network failure and a timeout are retryable kinds; a non-JSON answer is not trusted", async () => {
    const down = await clientWith(async () => { throw new TypeError("fetch failed: connect ECONNREFUSED https://api.telegram.org/bot" + TOKEN); }).sendMessage("1", "x").catch((e) => e);
    expect(down).toMatchObject({ kind: "network", retryable: true });
    expect(down.message).not.toContain(TOKEN);
    const slow = await clientWith(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }).sendMessage("1", "x").catch((e) => e);
    expect(slow.kind).toBe("timeout");
    const html = await clientWith(async () => new Response("<html>502</html>", { status: 502 })).sendMessage("1", "x").catch((e) => e);
    expect(html.kind).toBe("server");
    const odd = await clientWith(async () => new Response("<html>ok</html>", { status: 200 })).sendMessage("1", "x").catch((e) => e);
    expect(odd).toBeInstanceOf(TelegramError);
  });

  it("only plain method names are accepted", async () => {
    await expect(clientWith(async () => new Response("{}")).call("send/../x")).rejects.toThrow(TypeError);
  });

  it("the fake Telegram refuses anything but api.telegram.org: the tests cannot reach a real host", async () => {
    const tg = createFakeTelegram();
    await expect(tg.fetch("https://example.com/bot1/getMe")).rejects.toThrow(/unexpected URL/);
  });
});

describe("masks and shape checks", () => {
  it("hints show at most four characters", () => {
    expect(maskToken(TOKEN)).toBe("••••0000");
    expect(maskToken("")).toBe("••••");
    expect(maskId("123456789")).toBe("••••6789");
    expect(maskId("12")).toBe("••••");
  });
  it("recognises a bot token and a chat id", () => {
    expect(looksLikeToken(TOKEN)).toBe(true);
    expect(looksLikeToken("abc")).toBe(false);
    expect(looksLikeToken("123456789:short")).toBe(false);
    expect(isChatRef("123456789")).toBe(true);
    expect(isChatRef("-1001234567890")).toBe(true);
    expect(isChatRef("@mychannel")).toBe(true);
    expect(isChatRef("abc")).toBe(false);
    expect(isChatRef("12 34")).toBe(false);
  });
});

describe("the inbound loop (long polling) runs by itself once started, and stops cleanly", () => {
  it("answers an allowed chat without anyone calling poll, then stops on stop()", async () => {
    const n = bootNotify({ config: { coalesceSeconds: 0, inbound: { pollSeconds: 0 } } });
    // use real time for the loop and the pump timers, with the fake clock only for message dates
    n.tg.setClock(() => Date.now());
    n.clock.t = Date.now();
    const { target } = await n.withChat();
    await n.svc.start();
    n.tg.receive(TOKEN, { chatId: 555, text: "/help", date: Math.floor(Date.now() / 1000) });
    const until = Date.now() + 4000;
    while (!n.tg.texts().some((t) => /I can read, not trade/.test(t)) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    expect(n.tg.texts().some((t) => /I can read, not trade/.test(t))).toBe(true);
    const status = await n.svc.status();
    expect(status.targets[0].inbound.state).toBe("listening");
    await n.svc.stop();
    const calls = n.tg.calls.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(n.tg.calls.length).toBe(calls);
    void target;
  });

  it("a second program reading the same bot (HTTP 409) is reported in plain words, not retried in a tight loop", async () => {
    const n = bootNotify({ config: { inbound: { pollSeconds: 0 } } });
    const { target } = await n.withChat();
    n.tg.script("getUpdates", { status: 409, body: { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" } });
    const r = await n.svc.pollOnce(target.id, { timeout: 0 });
    expect(r.ok).toBe(false);
    const st = await n.svc.status();
    expect(st.targets[0].inbound).toMatchObject({ state: "conflict" });
    expect(st.targets[0].inbound.message).toMatch(/Another program is already reading this bot/);
  });
});
