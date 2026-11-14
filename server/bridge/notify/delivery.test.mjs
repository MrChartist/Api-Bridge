import { describe, expect, it } from "vitest";
import { EVENT_CATALOG, defaultEventFlags } from "./events.mjs";
import { TOKEN, bootNotify } from "./testkit.mjs";

const msg = (text, key = "order.filled", group) => ({ key, text, group });

describe("outbox: durability across a restart", () => {
  it("a message queued while Telegram is down is still there after a restart, and is sent then", async () => {
    const n = bootNotify({ config: { coalesceSeconds: 0 } });
    await n.withChat();
    n.tg.script("sendMessage", { throws: true, times: 1 });
    await n.svc.publish(msg("Filled: BUY 10 RELIANCE at ₹2,431.50 (paper, Paper)."));
    await n.settle();
    expect(n.svc.outbox.list()).toHaveLength(1);
    expect(n.svc.outbox.list()[0].attempts).toBe(1);
    // "restart": a new service on the same folder, secrets and clock
    const again = bootNotify({ dir: n.dataDir, now: n.clock, tg: n.tg, masterKey: n.key });
    expect(again.svc.outbox.list()).toHaveLength(1);
    await again.advance(10_000);
    expect(n.tg.texts().at(-1)).toMatch(/^Filled: BUY 10 RELIANCE/);
    expect(again.svc.outbox.list()).toHaveLength(0);
  });

  it("the file is the old version or the new one: no temp files are left behind", async () => {
    const n = bootNotify({ config: { coalesceSeconds: 0 } });
    await n.withChat();
    n.tg.script("sendMessage", { throws: true, times: 3 });
    for (let i = 0; i < 3; i += 1) await n.svc.publish(msg(`m${i}`, "order.rejected", `g${i}`));
    const { readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    expect(readdirSync(join(n.dataDir, "notify")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("is bounded: when full, the oldest message that is not critical goes first, and the drop is counted", async () => {
    const n = bootNotify({ config: { coalesceSeconds: 0, queue: { max: 10 } } });
    await n.withChat();
    n.tg.script("sendMessage", { throws: true, times: 1000 });
    for (let i = 0; i < 15; i += 1) await n.svc.publish(msg(`m${i}`, "order.rejected", `g${i}`));
    const stats = n.svc.outbox.stats();
    expect(stats.depth).toBe(10);
    expect(stats.dropped).toBe(5);
    expect(n.svc.outbox.list()[0].text).toBe("m5");
  });

  it("an unreadable outbox file is moved aside and the service starts empty", async () => {
    const { mkdirSync, writeFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const n = bootNotify();
    mkdirSync(join(n.dataDir, "notify"), { recursive: true });
    writeFileSync(join(n.dataDir, "notify", "outbox.json"), "{ not json");
    const again = bootNotify({ dir: n.dataDir, now: n.clock, tg: n.tg, masterKey: n.key });
    expect(again.svc.outbox.list()).toEqual([]);
    expect(readdirSync(join(n.dataDir, "notify")).some((f) => f.startsWith("outbox.json.corrupt"))).toBe(true);
  });
});

describe("retry, backoff and retry_after", () => {
  it("retries a network failure with exponential backoff, then gives up and counts it", async () => {
    const n = bootNotify({ config: { coalesceSeconds: 0, retry: { maxAttempts: 4, baseMs: 2000, maxMs: 300_000, maxAgeMinutes: 60 } } });
    await n.withChat();
    n.tg.script("sendMessage", { throws: true, times: 100 });
    await n.svc.publish(msg("hello"));
    await n.settle();
    const at = [];
    for (let i = 0; i < 6; i += 1) {
      const item = n.svc.outbox.list()[0];
      if (!item) break;
      at.push(item.nextAttemptAt - n.clock.t);
      await n.advance(Math.max(1, item.nextAttemptAt - n.clock.t));
    }
    // random() is 0.5, so jitter is exactly 1.0: 2 s, 4 s, 8 s
    expect(at.slice(0, 3)).toEqual([2000, 4000, 8000]);
    expect(n.svc.outbox.list()).toEqual([]);
    expect((await n.svc.status()).counters.failed).toBe(1);
    expect(n.tg.sent()).toHaveLength(4);
  });

  it("waits exactly as long as Telegram's retry_after says, without using up attempts, for every chat of that bot", async () => {
    const n = bootNotify({ config: { coalesceSeconds: 0 } });
    await n.withChat();
    n.tg.script("sendMessage", { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 30", parameters: { retry_after: 30 } } });
    await n.svc.publish(msg("one"));
    await n.settle();
    const item = n.svc.outbox.list()[0];
    expect(item.attempts).toBe(0);
    expect(item.nextAttemptAt - n.clock.t).toBeGreaterThanOrEqual(30_000);
    expect(item.nextAttemptAt - n.clock.t).toBeLessThanOrEqual(31_000);
    const sentBefore = n.tg.sent().length;
    await n.advance(29_000);
    expect(n.tg.sent().length).toBe(sentBefore);
    await n.advance(2_000);
    expect(n.tg.texts().at(-1)).toBe("one");
    expect(n.svc.outbox.list()).toEqual([]);
  });

  it("a bad token drops the queue and says so; it does not hammer Telegram", async () => {
    const n = bootNotify({ config: { coalesceSeconds: 0 } });
    await n.withChat();
    n.tg.script("sendMessage", { status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" }, times: 1 });
    await n.svc.publish(msg("a", "order.filled", "g1"));
    await n.svc.publish(msg("b", "order.filled", "g2"));
    await n.settle();
    expect(n.svc.outbox.list()).toEqual([]);
    const [t] = await n.svc.listTargets();
    expect(t.health).toMatchObject({ state: "token_invalid" });
    expect(t.health.message).toMatch(/BotFather/);
  });

  it("a blocked chat drops its messages, is flagged, and does not stop other chats", async () => {
    const n = bootNotify({ config: { coalesceSeconds: 0 } });
    const { target } = await n.withChat();
    n.tg.receive(TOKEN, { chatId: 556, text: "hi", name: "Second" });
    await n.svc.pollOnce(target.id, { timeout: 0 });
    const [f] = await n.svc.findChats(target.id);
    await n.svc.addChat(target.id, { ref: f.ref });
    n.tg.script("sendMessage", { status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, times: 1 });
    await n.svc.publish(msg("hello"));
    await n.settle();
    await n.advance(2000);
    expect(n.tg.texts().filter((t) => t === "hello")).toHaveLength(2); // one refused, one delivered
    expect(n.svc.outbox.list()).toEqual([]);
    const [t] = await n.svc.listTargets();
    expect(t.chats.filter((c) => c.state?.kind === "blocked")).toHaveLength(1);
  });

  it("INT-12: Telegram refusing one message drops only that message: the kill-switch alert behind it is still sent", async () => {
    const n = bootNotify({ config: { coalesceSeconds: 0 } });
    await n.withChat();
    n.tg.script("sendMessage", { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: wrong file identifier" }, times: 1 });
    await n.svc.publish(msg("first, refused by Telegram", "order.filled", "g1"));
    await n.svc.publish(msg("Kill switch is ON: all new orders are blocked.", "kill_switch.engaged", "g2"));
    await n.settle();
    await n.advance(2000);
    expect(n.tg.texts()).toContain("Kill switch is ON: all new orders are blocked.");
    expect(n.svc.outbox.list()).toEqual([]);
  });

  it("INT-12: a blocked chat still drops its ordinary messages, but a critical one is tried once on its own", async () => {
    const n = bootNotify({ config: { coalesceSeconds: 0 } });
    await n.withChat();
    n.tg.script("sendMessage", { status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, times: 2 });
    await n.svc.publish(msg("first", "order.filled", "g1"));
    await n.svc.publish(msg("second, ordinary", "order.rejected", "g2"));
    await n.svc.publish(msg("Kill switch is ON", "kill_switch.engaged", "g3"));
    await n.settle();
    await n.advance(2000);
    const attempts = n.tg.sent().map((x) => x.body.text);
    expect(attempts).toContain("Kill switch is ON"); // it was tried (it failed too: two blocked answers were scripted)
    expect(attempts).not.toContain("second, ordinary"); // dropped without a try: the chat is known to be blocked
    expect(n.svc.outbox.list()).toEqual([]);
  });

  it("a group that became a supergroup is followed to its new id and the message is delivered", async () => {
    const n = bootNotify({ config: { coalesceSeconds: 0 } });
    const { target } = await n.svc.addTarget({ token: TOKEN });
    await n.svc.addChat(target.id, { chatId: "-4242", name: "Desk" });
    n.tg.script("sendMessage", { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: -1004242 } } });
    await n.svc.publish(msg("hello"));
    await n.settle();
    await n.advance(1500);
    expect(n.tg.sent().at(-1).body.chat_id).toBe("-1004242");
    expect(n.svc.outbox.list()).toEqual([]);
  });

  it("messages older than the retry window are dropped instead of arriving hours late", async () => {
    const n = bootNotify({ config: { coalesceSeconds: 0, retry: { maxAttempts: 20, baseMs: 60_000, maxMs: 3_600_000, maxAgeMinutes: 5 } } });
    await n.withChat();
    n.tg.script("sendMessage", { throws: true, times: 100 });
    await n.svc.publish(msg("old"));
    await n.settle();
    await n.advance(6 * 60_000);
    expect(n.svc.outbox.list()).toEqual([]);
  });
});

describe("pacing", () => {
  it("never sends to one chat faster than the pacing gap (Telegram: about one message per second per chat)", async () => {
    const n = bootNotify({ config: { coalesceSeconds: 0, dedupeSeconds: 0 } });
    await n.withChat();
    for (let i = 0; i < 4; i += 1) await n.svc.publish(msg(`m${i}`, "order.filled", `g${i}`));
    await n.settle();
    for (let i = 0; i < 12; i += 1) await n.advance(300);
    const times = n.tg.sent().map((c) => c.at);
    expect(times).toHaveLength(4);
    for (let i = 1; i < times.length; i += 1) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(1100);
    expect(n.tg.texts()).toEqual(["m0", "m1", "m2", "m3"]);
  });

  it("stays under the per-second ceiling across chats", async () => {
    const n = bootNotify({ config: { coalesceSeconds: 0, dedupeSeconds: 0, pacing: { perChatMs: 250, perSecond: 3 } } });
    const { target } = await n.svc.addTarget({ token: TOKEN });
    for (let i = 0; i < 6; i += 1) await n.svc.addChat(target.id, { chatId: String(1000 + i), name: `c${i}` });
    await n.svc.publish(msg("burst"));
    await n.settle();
    const firstSecond = n.tg.sent().filter((c) => c.at - n.tg.sent()[0].at < 1000);
    expect(firstSecond.length).toBeLessThanOrEqual(3);
    for (let i = 0; i < 10; i += 1) await n.advance(300);
    expect(n.tg.sent()).toHaveLength(6);
  });
});

describe("group chats", () => {
  it("a group gets at most the configured number of messages per minute (Telegram: 20), the rest wait", async () => {
    const n = bootNotify({ config: { coalesceSeconds: 0, dedupeSeconds: 0, pacing: { perChatMs: 250, perSecond: 20, groupPerMinute: 3 } } });
    const { target } = await n.svc.addTarget({ token: TOKEN });
    await n.svc.addChat(target.id, { chatId: "-100777", name: "Desk" });
    for (let i = 0; i < 5; i += 1) await n.svc.publish(msg(`m${i}`, "order.filled", `g${i}`));
    await n.settle();
    for (let i = 0; i < 20; i += 1) await n.advance(500);
    expect(n.tg.texts()).toEqual(["m0", "m1", "m2"]);
    for (let i = 0; i < 24; i += 1) await n.advance(3000);
    expect(n.tg.texts()).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    const t = n.tg.sent().map((c) => c.at);
    expect(t[3] - t[0]).toBeGreaterThanOrEqual(60_000);
  });
});

describe("coalescing and dedupe", () => {
  it("a burst of the same kind: the first goes at once, the rest become ONE digest line", async () => {
    const n = bootNotify({ config: { coalesceSeconds: 20, dedupeSeconds: 0 } });
    await n.withChat();
    for (let i = 0; i < 6; i += 1) await n.svc.publish(msg(`Order rejected: BUY ${i + 1} RELIANCE (paper, Paper). Reason: margin.`, "order.rejected", "order.rejected"));
    await n.settle();
    expect(n.tg.texts()).toHaveLength(1);
    await n.advance(21_000);
    expect(n.tg.texts()).toHaveLength(2);
    expect(n.tg.texts()[1]).toMatch(/^5 more \(an order is rejected\) in the last 20 seconds\. Latest: Order rejected: BUY 6 RELIANCE/);
  });

  it("a single held message is sent as itself, not as a digest", async () => {
    const n = bootNotify({ config: { coalesceSeconds: 20, dedupeSeconds: 0 } });
    await n.withChat();
    await n.svc.publish(msg("first", "order.rejected", "g"));
    await n.svc.publish(msg("second", "order.rejected", "g"));
    await n.settle();
    await n.advance(21_000);
    expect(n.tg.texts()).toEqual(["first", "second"]);
  });

  it("the same text again inside the dedupe window is counted, not sent", async () => {
    const n = bootNotify({ config: { coalesceSeconds: 0, dedupeSeconds: 60 } });
    await n.withChat();
    await n.svc.publish(msg("Dhan Main is logged out.", "session.expired", "a"));
    expect((await n.svc.publish(msg("Dhan Main is logged out.", "session.expired", "b"))).reason).toBe("duplicate");
    await n.settle();
    expect(n.tg.texts()).toHaveLength(1);
    await n.advance(61_000);
    await n.svc.publish(msg("Dhan Main is logged out.", "session.expired", "c"));
    await n.settle();
    expect(n.tg.texts()).toHaveLength(2);
    expect((await n.svc.status()).counters.suppressed).toBe(1);
  });

  it("critical events are never merged or dropped as duplicates", async () => {
    const n = bootNotify({ config: { coalesceSeconds: 20, dedupeSeconds: 60 } });
    await n.withChat();
    for (let i = 0; i < 3; i += 1) await n.svc.publish(msg("Order result unknown: BUY 1 RELIANCE. Check your broker.", "order.outcome_unknown", "order.outcome_unknown"));
    await n.settle();
    for (let i = 0; i < 5; i += 1) await n.advance(1200);
    expect(n.tg.texts()).toHaveLength(3);
  });
});

describe("quiet hours", () => {
  const quiet = { quietHours: { enabled: true, start: "22:00", end: "07:00" }, coalesceSeconds: 0, dedupeSeconds: 0 };
  // 22:30 IST on Monday 9 Nov 2026 = 17:00 UTC
  const NIGHT = Date.parse("2026-11-09T17:00:00Z");

  it("holds ordinary messages until the end of quiet hours and sends them as ONE message", async () => {
    const n = bootNotify({ config: quiet, now: { t: NIGHT } });
    await n.withChat();
    await n.svc.publish(msg("Filled: BUY 1 RELIANCE", "order.filled", "a"));
    await n.svc.publish(msg("Filled: SELL 2 INFY", "order.filled", "b"));
    await n.settle();
    expect(n.tg.texts()).toEqual([]);
    expect((await n.svc.status()).quietHours.activeNow).toBe(true);
    await n.advance(8 * 3600_000); // 06:30
    expect(n.tg.texts()).toEqual([]);
    await n.advance(40 * 60_000); // 07:10
    expect(n.tg.texts()).toHaveLength(1);
    expect(n.tg.texts()[0]).toMatch(/^While you were away \(2 alerts\):\n- Filled: BUY 1 RELIANCE\n- Filled: SELL 2 INFY$/);
  });

  it("critical events (kill switch, unknown order result) still go at once", async () => {
    const n = bootNotify({ config: quiet, now: { t: NIGHT } });
    await n.withChat();
    await n.svc.publish(msg("Kill switch ON", "kill_switch.engaged", "k"));
    await n.settle();
    expect(n.tg.texts()).toEqual(["Kill switch ON"]);
  });

  it("a held message survives a restart", async () => {
    const n = bootNotify({ config: quiet, now: { t: NIGHT } });
    await n.withChat();
    await n.svc.publish(msg("Filled: BUY 1 RELIANCE", "order.filled", "a"));
    const again = bootNotify({ dir: n.dataDir, now: n.clock, tg: n.tg, masterKey: n.key, config: quiet });
    await again.advance(9 * 3600_000);
    expect(n.tg.texts()).toEqual(["While you were away: Filled: BUY 1 RELIANCE"]);
  });

  it("a window that does not cross midnight works too, and a person can change it with setEvents", async () => {
    const n = bootNotify({ now: { t: NIGHT } });
    await n.withChat();
    n.svc.setEvents({ quietHours: { enabled: true, start: "22:00", end: "23:00" } });
    await n.svc.publish(msg("held", "order.filled", "a"));
    await n.advance(0);
    expect(n.tg.texts()).toEqual([]);
    await n.advance(31 * 60_000);
    expect(n.tg.texts()).toEqual(["While you were away: held"]);
  });
});

describe("which events are on", () => {
  it("the defaults include session expiry, order rejection and hook rejection, and leave the chatty ones off", () => {
    const d = defaultEventFlags();
    expect(d["session.expired"]).toBe(true);
    expect(d["order.rejected"]).toBe(true);
    expect(d["hook.rejected"]).toBe(true);
    expect(d["order.outcome_unknown"]).toBe(true);
    expect(d["ticket.prepared"]).toBe(true);
    expect(d["kill_switch.engaged"]).toBe(true);
    expect(d["order.placed"]).toBe(false);
    expect(d["summary.eod"]).toBe(false);
    for (const e of EVENT_CATALOG) {
      expect(e.label.length).toBeGreaterThan(5);
      expect(e.label).not.toMatch(/[_.]/);
    }
  });

  it("an event that is switched off is not sent; PUT-style changes persist across a restart", async () => {
    const n = bootNotify({ config: { coalesceSeconds: 0 } });
    await n.withChat();
    n.svc.setEvents({ events: { "order.filled": false } });
    expect((await n.svc.publish(msg("x", "order.filled"))).reason).toBe("event_off");
    const again = bootNotify({ dir: n.dataDir, now: n.clock, tg: n.tg, masterKey: n.key });
    expect(again.svc.events().events.find((e) => e.key === "order.filled").enabled).toBe(false);
    expect(again.svc.events().events.find((e) => e.key === "order.rejected").enabled).toBe(true);
  });

  it("nothing is queued when there is no chat yet", async () => {
    const n = bootNotify();
    await n.svc.addTarget({ token: TOKEN });
    expect((await n.svc.publish(msg("x"))).reason).toBe("no_chats");
    expect(n.svc.outbox.list()).toEqual([]);
  });
});
