/**
 * Test helpers for the notify module: a fake Telegram HTTP server behind an injected fetch (no network, ever), small fakes
 * for the services the module reads, and a boot function that builds a NotifyService on a temp folder with a fake clock.
 * Not shipped behaviour: only tests import it.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretStore } from "../auth/secretStore.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createLogger } from "../core/logger.mjs";
import { notifyConfig, NOTIFY_CONFIG_SCHEMA } from "./config.mjs";
import { createNotifyService } from "./service.mjs";

export const TOKEN = "123456789:AAH-fake_Token_value_for_tests_0000";
export const TOKEN2 = "987654321:AAE-other_Token_value_for_tests_111";
/** Monday 9 Nov 2026, 09:30 IST. */
export const MONDAY_0930 = Date.parse("2026-11-09T04:00:00Z");

/**
 * A fake Telegram Bot API. `fetch` answers like api.telegram.org for getMe, sendMessage and getUpdates.
 * `script(method, response)` makes the next call(s) of a method fail the way Telegram does.
 */
export function createFakeTelegram({ bots = { [TOKEN]: { id: 123456789, username: "my_bridge_bot" }, [TOKEN2]: { id: 987654321, username: "other_bot" } } } = {}) {
  /** @type {Array<{ token: string, method: string, body: any, at: number }>} */
  const calls = [];
  const queues = new Map(); // token -> updates
  const scripted = [];
  let updateId = 1000;
  let clock = () => Date.now();
  const api = {
    calls,
    setClock: (fn) => (clock = fn),
    sent: (token) => calls.filter((c) => c.method === "sendMessage" && (!token || c.token === token)),
    texts: (token) => api.sent(token).map((c) => c.body.text),
    /** Someone writes to the bot. */
    receive(token, { chatId = 555, text = "/start", type = "private", name = "Asha", date, fromBot = false } = {}) {
      const u = { update_id: updateId++, message: { message_id: updateId, date: date ?? Math.floor(clock() / 1000), chat: { id: chatId, type, ...(type === "private" ? { first_name: name } : { title: name }) }, from: { id: chatId, is_bot: fromBot, first_name: name }, text } };
      (queues.get(token) ?? queues.set(token, []).get(token)).push(u);
      return u;
    },
    /** Make the next `times` calls of `method` answer with this HTTP status and body (or throw when `throws`). */
    script(method, { status = 200, body, times = 1, throws } = {}) {
      scripted.push({ method, status, body, times, throws });
    },
    async fetch(url, init = {}) {
      const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/([A-Za-z]+)$/.exec(String(url));
      if (!m) throw new Error(`fake Telegram: unexpected URL ${url}`);
      const [, token, method] = m;
      const body = init.body ? JSON.parse(init.body) : {};
      calls.push({ token, method, body, at: clock() });
      const res = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
      const s = scripted.find((x) => x.method === method && x.times > 0);
      if (s) {
        s.times -= 1;
        if (s.throws) throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" });
        return res(s.status, s.body ?? { ok: false, error_code: s.status, description: "scripted" });
      }
      const bot = bots[token];
      if (!bot) return res(401, { ok: false, error_code: 401, description: "Unauthorized" });
      if (method === "getMe") return res(200, { ok: true, result: { id: bot.id, is_bot: true, first_name: "Bridge", username: bot.username } });
      if (method === "sendMessage") return res(200, { ok: true, result: { message_id: calls.length, chat: { id: body.chat_id }, text: body.text } });
      if (method === "getUpdates") {
        const q = queues.get(token) ?? [];
        const out = q.filter((u) => body.offset === undefined || u.update_id >= body.offset).slice(0, body.limit ?? 100);
        queues.set(token, q.filter((u) => body.offset === undefined || u.update_id >= body.offset));
        return res(200, { ok: true, result: out });
      }
      return res(404, { ok: false, error_code: 404, description: "Not Found" });
    },
  };
  return api;
}

/** Fakes for the services the module reads. Everything is a plain object a test can change. */
export function createFakeWorld({ clock }) {
  const world = {
    accounts: [
      { id: "zerodha-main", broker: "zerodha", label: "Zerodha Main", enabled: true, session: { state: "connected" } },
      { id: "dhan-main", broker: "dhan", label: "Dhan Main", enabled: true, session: { state: "connected" } },
      { id: "paper", broker: "paper", label: "Paper", enabled: true, session: { state: "connected" } },
    ],
    killed: { engaged: false, reason: null, by: null, at: null },
    quotes: {},
    positions: { paper: [], "zerodha-main": [], "dhan-main": [] },
    funds: { paper: { availableCash: 1_000_000, usedMargin: 0, realisedPnl: 0 }, "zerodha-main": { availableCash: 124_500.5, usedMargin: 5000, realisedPnl: 310 }, "dhan-main": { availableCash: 1, usedMargin: 0, realisedPnl: 0 } },
    orders: [],
    orderById: {},
    sources: [],
    engaged: [],
    audit: [],
    writes: [],
    pnl: {},
  };
  const forbid = (name) => () => {
    world.writes.push(name);
    throw new Error(`${name} must never be called by notify`);
  };
  world.services = {
    accounts: { list: () => world.accounts.map((a) => ({ ...a })), get: (id) => ({ ...world.accounts.find((a) => a.id === id) }) },
    marketData: {
      async quotes(symbols) {
        const items = [];
        const errors = [];
        for (const s of symbols) {
          const q = world.quotes[s];
          if (q) items.push({ symbol: s, ...q });
          else errors.push({ symbol: s, code: "SYMBOL_NOT_FOUND", message: "not found" });
        }
        return { items, errors };
      },
      ltp: forbid("ltp"),
    },
    orders: {
      async positions(_ctx, id) {
        return { items: world.positions[id] ?? [], freshness: { source: id === "paper" ? "paper" : "broker", asOf: "2026-11-09T09:30:00+05:30" } };
      },
      async funds(_ctx, id) {
        return { funds: world.funds[id], freshness: { source: "paper", asOf: "2026-11-09T09:30:00+05:30" } };
      },
      async list() {
        return { items: world.orders, nextCursor: null };
      },
      async get(_ctx, id) {
        if (!world.orderById[id]) throw new Error("not found");
        return world.orderById[id];
      },
      place: forbid("orders.place"),
      modify: forbid("orders.modify"),
      cancel: forbid("orders.cancel"),
      cancelAll: forbid("orders.cancelAll"),
      confirmTicket: forbid("orders.confirmTicket"),
      rejectTicket: forbid("orders.rejectTicket"),
    },
    safety: {
      killSwitchStatus: () => ({ ...world.killed }),
      async engageKillSwitch(ctx, { reason, cancelOpenOrders }) {
        world.engaged.push({ reason, cancelOpenOrders, scopes: [...ctx.scopes], principal: ctx.principal });
        world.killed = { engaged: true, reason, by: `${ctx.principal.kind}:${ctx.principal.id}`, at: "now" };
        return { ...world.killed };
      },
      releaseKillSwitch: forbid("safety.releaseKillSwitch"),
      limits: (id) => ({ limits: {}, usage: { byMode: { paper: { realisedPnl: world.pnl[id] ?? 0 }, live: { realisedPnl: world.pnl[id] ?? 0 } } } }),
    },
    backupData: { list: () => world.sources.map((s) => ({ ...s })), status: () => ({ providers: world.sources }) },
    audit: {
      async append(rec) {
        world.audit.push(rec);
        return rec;
      },
    },
    readiness: {},
  };
  void clock;
  return world;
}

/**
 * Boot a NotifyService on a fresh (or given) folder with the real secret store and a fake clock.
 * @param {{ dir?: string, config?: object, fetchImpl?: any, tg?: ReturnType<typeof createFakeTelegram>, now?: { t: number }, world?: any, random?: () => number, bus?: any, calendar?: any }} [o]
 */
export function bootNotify(o = {}) {
  const dataDir = o.dir ?? mkdtempSync(join(tmpdir(), "mcb-notify-"));
  const clock = o.now ?? { t: MONDAY_0930 };
  const tg = o.tg ?? createFakeTelegram();
  tg.setClock(() => clock.t);
  const lines = [];
  const logger = createLogger({ level: "debug", write: (l) => lines.push(l), now: () => clock.t });
  const bus = o.bus ?? createEventBus({ logger });
  const world = o.world ?? createFakeWorld({ clock });
  const key = randomBytes(32).toString("base64");
  const secrets = createSecretStore({ logger, paths: { dataDir } }, { env: { MCB_MASTER_KEY: o.masterKey ?? key } });
  const config = Object.freeze({ dataDir, demo: false, notify: notifyConfig({ notify: NOTIFY_CONFIG_SCHEMA.parse(o.config ?? {}) }) });
  const deps = { config, logger, bus, clock: { now: () => clock.t }, paths: { dataDir }, secrets, ...world.services };
  const svc = createNotifyService(deps, { fetchImpl: tg.fetch, now: () => clock.t, random: o.random ?? (() => 0.5), calendar: o.calendar });
  return {
    svc,
    bus,
    tg,
    world,
    clock,
    logs: lines,
    dataDir,
    secrets,
    deps,
    key,
    /** Advance the fake clock and run the pump (all due work). */
    async advance(ms = 0) {
      clock.t += ms;
      await svc.pump();
    },
    /** Let queued microtasks (bus handlers are async) finish, then pump. */
    async settle() {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
      await svc.pump();
    },
    /** A ready target with one private chat. */
    async withChat({ commands = true, token = TOKEN, chatId = 555 } = {}) {
      const { target } = await svc.addTarget({ token });
      tg.receive(token, { chatId, text: "/start" });
      await svc.pollOnce(target.id, { timeout: 0 });
      const found = await svc.findChats(target.id);
      const chat = await svc.addChat(target.id, { ref: found[0].ref, commands });
      return { target, chat };
    },
  };
}
