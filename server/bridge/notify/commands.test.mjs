import { describe, expect, it } from "vitest";
import { COMMANDS, createReader, dataLabel, normaliseSymbol, parseCommand } from "./commands.mjs";
import { TOKEN, bootNotify } from "./testkit.mjs";

const fresh = (o = {}) => ({ source: "stream", asOf: "x", ageMs: 2000, stale: false, accountId: "zerodha-main", broker: "zerodha", class: "realtime", delaySec: 0, official: true, confidence: "high", flags: [], ...o });

async function chat(config = {}) {
  const n = bootNotify({ config: { coalesceSeconds: 0, dedupeSeconds: 0, ...config } });
  const { target, chat: c } = await n.withChat();
  /** Send a message from the allowed chat, poll it, and return what the bot said. */
  const say = async (text, o = {}) => {
    const before = n.tg.texts().length;
    n.tg.receive(TOKEN, { chatId: 555, text, ...o });
    await n.svc.pollOnce(target.id, { timeout: 0 });
    for (let i = 0; i < 4; i += 1) await n.advance(1200);
    return n.tg.texts().slice(before);
  };
  return { n, target, c, say };
}

describe("parsing", () => {
  it("reads the command word, the bot mention and the arguments", () => {
    expect(parseCommand("/price NIFTY, RELIANCE")).toMatchObject({ command: "price", args: ["NIFTY", "RELIANCE"], known: true });
    expect(parseCommand("/price@my_bridge_bot nifty", "my_bridge_bot")).toMatchObject({ command: "price", args: ["nifty"] });
    expect(parseCommand("/price@someone_else_bot nifty", "my_bridge_bot")).toEqual({ ignore: true });
    expect(parseCommand("/start")).toMatchObject({ command: "help" });
    expect(parseCommand("/prices NIFTY")).toMatchObject({ command: "price" });
    expect(parseCommand("/nonsense")).toMatchObject({ command: "nonsense", known: false });
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
    expect(parseCommand("/price " + "A ".repeat(100)).args.length).toBeLessThanOrEqual(12);
  });
  it("symbols default to NSE and are cleaned", () => {
    expect(normaliseSymbol("nifty")).toBe("NSE:NIFTY");
    expect(normaliseSymbol("bse:sensex")).toBe("BSE:SENSEX");
    expect(normaliseSymbol("rel;iance")).toBe("NSE:RELIANCE");
    expect(normaliseSymbol("  ")).toBe("");
  });
  it("the command list has no way to trade, approve or manage keys", () => {
    expect(COMMANDS).toEqual(["price", "positions", "orders", "funds", "status", "help", "kill"]);
  });
});

describe("data labels: a price is never shown without how fresh it is", () => {
  it("names the class and the delay", () => {
    expect(dataLabel(fresh())).toBe("real-time, 2 s ago");
    expect(dataLabel(fresh({ ageMs: 100 }))).toBe("real-time, just now");
    expect(dataLabel(fresh({ ageMs: 125_000 }))).toBe("real-time, 2 min ago");
    expect(dataLabel(fresh({ class: "delayed", delaySec: 900 }))).toBe("delayed 15 min");
    expect(dataLabel(fresh({ class: "delayed", delaySec: 5400 }))).toBe("delayed 1.5 h");
    expect(dataLabel(fresh({ class: "eod" }))).toBe("end of day");
    expect(dataLabel(fresh({ class: "delayed", delaySec: 900, official: false, stale: true }))).toBe("delayed 15 min, unofficial, stale");
    expect(dataLabel(undefined)).toBe("data class unknown");
    expect(dataLabel({})).toBe("data class unknown");
  });
});

describe("replies", () => {
  it("/price: each line has the number, the change and the data class and delay", async () => {
    const { n, say } = await chat();
    n.world.quotes["NSE:NIFTY"] = { ltp: 24880.5, changePct: 0.42, freshness: fresh() };
    n.world.quotes["NSE:RELIANCE"] = { ltp: 2431.5, changePct: -0.8, freshness: fresh({ class: "delayed", delaySec: 900, official: false, ageMs: 0 }) };
    const [reply] = await say("/price NIFTY RELIANCE FOO");
    expect(reply.split("\n")).toEqual(["NIFTY 24,880.50 (+0.42%) - real-time, 2 s ago", "RELIANCE 2,431.50 (-0.80%) - delayed 15 min, unofficial", "FOO: symbol not found"]);
  });

  it("/price with nothing asks which symbols; more than ten are cut", async () => {
    const { n, say } = await chat();
    expect((await say("/price"))[0]).toMatch(/Which symbols/);
    let asked = 0;
    n.world.services.marketData.quotes = async (s) => ((asked = s.length), { items: [], errors: [] });
    await say(`/price ${Array.from({ length: 12 }, (_, i) => `S${i}`).join(" ")}`);
    expect(asked).toBe(10);
  });

  it("/positions: open lines per account, paper and live labelled, a logged-out account named not called", async () => {
    const { n, say } = await chat();
    n.world.positions.paper = [{ symbol: "NSE:RELIANCE", netQty: 10, avgPrice: 2400, pnl: 310 }, { symbol: "NSE:INFY", netQty: 0, avgPrice: 1500, pnl: 0 }];
    n.world.positions["zerodha-main"] = [];
    n.world.accounts.find((a) => a.id === "dhan-main").session.state = "expired";
    const [reply] = await say("/positions");
    expect(reply).toContain("Paper (paper):\nRELIANCE +10 at 2,400.00, P&L +₹310.00");
    expect(reply).not.toContain("INFY");
    expect(reply).toContain("Zerodha Main (live, from broker at 09:30): no open positions");
    expect(reply).toContain("Dhan Main: not logged in");
  });

  it("/orders: latest orders with a plain status; an unknown result says so", async () => {
    const { n, say } = await chat();
    n.world.orders = [
      { placedAt: "2026-11-09T09:29:00+05:30", side: "BUY", quantity: 10, symbol: "NSE:RELIANCE", price: 2400, status: "open", mode: "paper", accountId: "paper" },
      { placedAt: "2026-11-09T09:20:00+05:30", side: "SELL", quantity: 1, symbol: "NSE:INFY", price: null, status: "outcome_unknown", mode: "live", accountId: "dhan-main" },
    ];
    const [reply] = await say("/orders");
    expect(reply).toBe("09:29 BUY 10 RELIANCE at 2,400.00: open (paper, paper)\n09:20 SELL 1 INFY: unknown, check your broker (live, dhan-main)");
  });

  it("/funds", async () => {
    const { say } = await chat();
    const [reply] = await say("/funds");
    expect(reply).toContain("Zerodha Main (live): cash ₹1,24,500.50, margin used ₹5,000.00, realised +₹310.00");
  });

  it("/status: logins, kill switch and data sources in one screen", async () => {
    const { n, say } = await chat();
    n.world.accounts.find((a) => a.id === "dhan-main").session.state = "expired";
    n.world.sources = [{ id: "nse-eod", name: "NSE end of day", enabled: true, health: { state: "open" } }];
    const [reply] = await say("/status");
    expect(reply).toMatch(/^Bridge status \(09:\d\d IST\)\nAccounts: Zerodha Main logged in; Dhan Main NOT logged in\nKill switch: off\nData sources: NSE end of day open\nAlerts: \d+ waiting/);
  });

  it("/help lists the commands and says approval is on the computer", async () => {
    const { say } = await chat();
    const [reply] = await say("/help");
    expect(reply).toMatch(/I can read, not trade/);
    expect(reply).toMatch(/Orders are approved on the computer running the Bridge, never here/);
    expect(reply).not.toMatch(/\/approve|\/buy|\/sell|\/place/);
  });

  it("an unknown command gets one short hint; plain text gets no answer", async () => {
    const { say } = await chat();
    expect((await say("/buy RELIANCE 10"))[0]).toMatch(/do not know that command/);
    expect(await say("what is the price of reliance")).toEqual([]);
  });

  it("replies carry no secrets even when a broker message did", async () => {
    const { n, say } = await chat();
    n.world.services.orders.list = async () => { throw Object.assign(new Error("bad"), { detail: `session mcb_abcdefgh_ssssssssssssssss ${TOKEN}` }); };
    const [reply] = await say("/orders");
    expect(reply).not.toMatch(/mcb_|AAH/);
  });
});

describe("who may ask", () => {
  it("a chat that is not on the list is never answered, only counted", async () => {
    const { n, target } = await chat();
    const before = n.tg.texts().length;
    n.tg.receive(TOKEN, { chatId: 999, text: "/positions" });
    n.tg.receive(TOKEN, { chatId: 999, text: "/kill" });
    await n.svc.pollOnce(target.id, { timeout: 0 });
    await n.advance(2000);
    expect(n.tg.texts().length).toBe(before);
    expect((await n.svc.status()).counters.ignoredMessages).toBeGreaterThanOrEqual(2);
    expect(n.world.engaged).toEqual([]);
  });

  it("a chat on the list for alerts only (commands off) is not answered either", async () => {
    const n = bootNotify({ config: { coalesceSeconds: 0 } });
    const { target } = await n.withChat({ commands: false });
    n.tg.receive(TOKEN, { chatId: 555, text: "/positions" });
    await n.svc.pollOnce(target.id, { timeout: 0 });
    await n.advance(2000);
    expect(n.tg.texts()).toEqual([]);
    const [t] = await n.svc.listTargets();
    await n.svc.setChatCommands(target.id, t.chats[0].key, true);
    n.tg.receive(TOKEN, { chatId: 555, text: "/help" });
    await n.svc.pollOnce(target.id, { timeout: 0 });
    await n.advance(2000);
    expect(n.tg.texts()).toHaveLength(1);
  });

  it("messages from bots, and commands that waited too long, are ignored", async () => {
    const { n, target } = await chat();
    n.tg.receive(TOKEN, { chatId: 555, text: "/help", fromBot: true });
    n.tg.receive(TOKEN, { chatId: 555, text: "/help", date: Math.floor(n.clock.t / 1000) - 3600 });
    await n.svc.pollOnce(target.id, { timeout: 0 });
    await n.advance(2000);
    expect(n.tg.texts()).toEqual([]);
  });

  it("a poll offset is kept, so a restart does not run the same command twice", async () => {
    const { n, target, say } = await chat();
    await say("/help");
    const again = bootNotify({ dir: n.dataDir, now: n.clock, tg: n.tg, masterKey: n.key });
    const before = n.tg.texts().length;
    await again.svc.pollOnce(target.id, { timeout: 0 });
    await again.advance(2000);
    expect(n.tg.texts().length).toBe(before);
    expect(n.tg.calls.filter((c) => c.method === "getUpdates").at(-1).body.offset).toBeGreaterThan(1000);
  });

  it("command rate limit per chat: one 'slow down', then silence", async () => {
    const { n, say } = await chat({ inbound: { commandsPerMinute: 3 } });
    const out = [];
    for (let i = 0; i < 6; i += 1) out.push(...(await say("/help")));
    expect(out.filter((t) => /Too many commands/.test(t))).toHaveLength(1);
    expect(out.filter((t) => /I can read/.test(t))).toHaveLength(3);
    expect(n.world.audit.some((a) => a.data.command === "rate_limited")).toBe(true);
  });

  it("every command is audited with the chat key, never the chat id or the text", async () => {
    const { n, say, c } = await chat();
    await say("/price NIFTY RELIANCE");
    const rec = n.world.audit.find((a) => a.data.command === "price");
    expect(rec).toMatchObject({ type: "notify.command", source: "telegram", actor: { kind: "telegram", id: c.key }, data: { command: "price", args: 2, ok: true } });
    expect(JSON.stringify(n.world.audit)).not.toMatch(/555|NIFTY/);
  });
});

describe("read-only by construction", () => {
  it("the reader has no write method except turning the kill switch ON", () => {
    const n = bootNotify();
    expect(Object.keys(n.svc.reader).sort()).toEqual(["accounts", "engageKill", "funds", "killStatus", "limits", "order", "orders", "positions", "quotes", "sources"]);
    expect(Object.isFrozen(n.svc.reader)).toBe(true);
  });

  it("every command, run for real, never touches a write method of any service", async () => {
    const { say, n } = await chat();
    n.world.quotes["NSE:NIFTY"] = { ltp: 1, freshness: fresh() };
    for (const text of ["/price NIFTY", "/positions", "/orders", "/funds", "/status", "/help", "/kill", "/kill 0000", "/place", "/approve tkt_1", "/release", "/cancel 1"]) await say(text);
    expect(n.world.writes).toEqual([]);
  });

  it("calls reach the services only with a read-scoped context and a principal that is not a person", async () => {
    const n = bootNotify();
    const seen = [];
    n.world.services.orders.positions = async (ctx) => (seen.push(ctx), { items: [], freshness: {} });
    await n.svc.reader.positions("paper");
    expect([...seen[0].scopes]).toEqual(["read"]);
    expect(seen[0].principal).toEqual({ kind: "key", id: "telegram", label: "Telegram bot" });
    expect(() => seen[0].requireScope("admin")).toThrow();
    expect(() => seen[0].requireScope("paper")).toThrow();
  });
});

describe("/kill: engage only, after a one-time code", () => {
  it("asks for a code first; the right code engages (no order cancelling); the code works once", async () => {
    const { n, say } = await chat();
    const [ask] = await say("/kill");
    const code = /\/kill (\d{4})/.exec(ask)[1];
    expect(ask).toMatch(/within 60 seconds/);
    expect(ask).toMatch(/Only you can turn it off again, on the computer running the Bridge/);
    expect(n.world.engaged).toEqual([]);
    const [done] = await say(`/kill ${code}`);
    expect(done).toMatch(/Kill switch is ON/);
    expect(n.world.engaged).toHaveLength(1);
    expect(n.world.engaged[0]).toMatchObject({ cancelOpenOrders: false });
    expect([...n.world.engaged[0].scopes]).toEqual(["read"]);
    const [again] = await say(`/kill ${code}`);
    expect(again).toMatch(/expired or was never asked for/);
    expect(n.world.engaged).toHaveLength(1);
  });

  it("a wrong code does nothing; three wrong codes cancel the request", async () => {
    const { n, say } = await chat();
    const [ask] = await say("/kill");
    const code = /\/kill (\d{4})/.exec(ask)[1];
    const wrong = code === "1234" ? "4321" : "1234";
    expect((await say(`/kill ${wrong}`))[0]).toMatch(/not the code/);
    expect((await say(`/kill ${wrong}`))[0]).toMatch(/not the code/);
    expect((await say(`/kill ${wrong}`))[0]).toMatch(/Wrong code three times/);
    expect((await say(`/kill ${code}`))[0]).toMatch(/expired or was never asked for/);
    expect(n.world.engaged).toEqual([]);
  });

  it("a code expires after 60 seconds", async () => {
    const { n, say } = await chat();
    const [ask] = await say("/kill");
    const code = /\/kill (\d{4})/.exec(ask)[1];
    n.clock.t += 61_000;
    expect((await say(`/kill ${code}`))[0]).toMatch(/expired/);
    expect(n.world.engaged).toEqual([]);
  });

  it("a code asked for in one chat does not work from another chat", async () => {
    const { n, target, say } = await chat();
    n.tg.receive(TOKEN, { chatId: 556, text: "hi", name: "B" });
    await n.svc.pollOnce(target.id, { timeout: 0 });
    const [f] = await n.svc.findChats(target.id);
    await n.svc.addChat(target.id, { ref: f.ref, commands: true });
    const [ask] = await say("/kill");
    const code = /\/kill (\d{4})/.exec(ask)[1];
    n.tg.receive(TOKEN, { chatId: 556, text: `/kill ${code}` });
    await n.svc.pollOnce(target.id, { timeout: 0 });
    await n.advance(2000);
    expect(n.world.engaged).toEqual([]);
  });

  it("can be switched off in the config, and releasing is not a command at all", async () => {
    const { n, say } = await chat({ inbound: { allowKill: false } });
    expect((await say("/kill"))[0]).toMatch(/cannot be turned on from Telegram/);
    expect((await say("/release"))[0]).toMatch(/do not know that command/);
    expect((await say("/kill release"))[0]).toMatch(/cannot be turned on/);
    expect(n.world.engaged).toEqual([]);
  });

  it("the audit record of /kill never contains the code", async () => {
    const { n, say } = await chat();
    const [ask] = await say("/kill");
    const code = /\/kill (\d{4})/.exec(ask)[1];
    await say(`/kill ${code}`);
    expect(JSON.stringify(n.world.audit)).not.toContain(code);
    expect(n.world.audit.map((a) => a.data.command)).toEqual(["kill", "kill_confirm"]);
  });
});

describe("createReader", () => {
  it("is exported for the doctor and tests", () => {
    expect(typeof createReader).toBe("function");
  });
});
