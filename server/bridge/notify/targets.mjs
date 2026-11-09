/**
 * Notification targets: a Telegram bot (its token) and the chats it may write to. Each target is ONE entry in the
 * encrypted secrets store (name "notify:telegram:<id>"), so the bot token AND the chat ids are encrypted on disk, are
 * registered with the logger's redaction, and never leave this module except as masked hints.
 *
 * A chat has a stable short `key` (a hash of its id) that screens, the outbox and the audit log use instead of the id.
 * `commands: true` puts the chat on the allow-list for inbound commands (/price, /positions ...); only such chats are
 * ever answered.
 */
import { createHash, randomBytes } from "node:crypto";
import { BridgeError } from "../core/errors.mjs";
import { maskId, maskToken } from "./telegram.mjs";

const PREFIX = "notify:telegram:";
const ID_RE = /^tg_[a-z2-7]{8}$/;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export const MAX_TARGETS = 5;
export const MAX_CHATS = 10;

export const isTargetId = (s) => typeof s === "string" && ID_RE.test(s);
export const chatKeyOf = (chatId) => createHash("sha256").update(`tg-chat:${chatId}`).digest("hex").slice(0, 10);

const newId = () => `tg_${[...randomBytes(8)].map((b) => B32[b % 32]).join("")}`;

/**
 * @typedef {{ key: string, id: string, name: string, type: "private"|"group"|"supergroup"|"channel"|"unknown", commands: boolean, addedAt: string }} Chat
 * @typedef {{ id: string, kind: "telegram", label: string, botToken: string, botId: number, botUsername: string, chats: Chat[], createdAt: string }} Target
 */

/**
 * @param {{ secrets: any, logger?: any, now?: () => number }} deps
 */
export function createTargetStore({ secrets, logger, now = () => Date.now() }) {
  /** @type {Map<string, Target>} */
  let cache = new Map();
  let loaded = false;
  /** Writes are serialised so two quick calls cannot overwrite each other. */
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  const register = (t) => {
    logger?.addSecret?.(t.botToken);
  };

  async function load() {
    const names = (await secrets.list()).filter((n) => n.startsWith(PREFIX));
    const next = new Map();
    for (const name of names) {
      const v = await secrets.get(name);
      if (!v || typeof v.botToken !== "string") continue;
      const t = { ...v, id: name.slice(PREFIX.length), kind: "telegram", chats: Array.isArray(v.chats) ? v.chats : [] };
      register(t);
      next.set(t.id, t);
    }
    cache = next;
    loaded = true;
  }
  const ensure = async () => {
    if (!loaded) await load();
  };
  const persist = (t) => secrets.set(PREFIX + t.id, { ...t, id: undefined });

  return {
    load,
    async list() {
      await ensure();
      return [...cache.values()];
    },
    async get(id) {
      await ensure();
      return cache.get(id) ?? null;
    },
    /** @param {{ token: string, label: string, bot: { id: number, username: string } }} input */
    create({ token, label, bot }) {
      return serial(async () => {
        await ensure();
        if (cache.size >= MAX_TARGETS) throw new BridgeError("VALIDATION_FAILED", `At most ${MAX_TARGETS} Telegram bots can be set up. Remove one first.`);
        for (const t of cache.values()) if (t.botId === bot.id) throw new BridgeError("STATE_CONFLICT", `This bot (@${bot.username}) is already set up. Add chats to it instead.`);
        const t = { id: newId(), kind: "telegram", label, botToken: token, botId: bot.id, botUsername: bot.username, chats: [], createdAt: new Date(now()).toISOString() };
        register(t);
        await persist(t);
        cache.set(t.id, t);
        return t;
      });
    },
    /** Replace the token of an existing target (the same bot, a new token from BotFather's /token). */
    setToken(id, token, bot) {
      return serial(async () => {
        await ensure();
        const t = cache.get(id);
        if (!t) throw new BridgeError("NOT_FOUND", "No such notification target.");
        const next = { ...t, botToken: token, botId: bot.id, botUsername: bot.username };
        register(next);
        await persist(next);
        cache.set(id, next);
        return next;
      });
    },
    /** @param {string} id @param {{ id: string, name: string, type?: string, commands?: boolean }} chat */
    addChat(id, chat) {
      return serial(async () => {
        await ensure();
        const t = cache.get(id);
        if (!t) throw new BridgeError("NOT_FOUND", "No such notification target.");
        const key = chatKeyOf(chat.id);
        if (t.chats.some((c) => c.key === key)) throw new BridgeError("STATE_CONFLICT", "This chat is already on the list.");
        if (t.chats.length >= MAX_CHATS) throw new BridgeError("VALIDATION_FAILED", `At most ${MAX_CHATS} chats per bot.`);
        const type = ["private", "group", "supergroup", "channel"].includes(chat.type) ? chat.type : "unknown";
        // Commands default on for a private chat only: in a group, everyone in it could type commands.
        const entry = { key, id: String(chat.id), name: String(chat.name ?? "").slice(0, 60) || "Chat", type, commands: chat.commands ?? type === "private", addedAt: new Date(now()).toISOString() };
        const next = { ...t, chats: [...t.chats, entry] };
        await persist(next);
        cache.set(id, next);
        return entry;
      });
    },
    removeChat(id, key) {
      return serial(async () => {
        await ensure();
        const t = cache.get(id);
        if (!t || !t.chats.some((c) => c.key === key)) throw new BridgeError("NOT_FOUND", "No such chat on this target.");
        const next = { ...t, chats: t.chats.filter((c) => c.key !== key) };
        await persist(next);
        cache.set(id, next);
      });
    },
    setChatCommands(id, key, commands) {
      return serial(async () => {
        await ensure();
        const t = cache.get(id);
        const c = t?.chats.find((x) => x.key === key);
        if (!t || !c) throw new BridgeError("NOT_FOUND", "No such chat on this target.");
        const next = { ...t, chats: t.chats.map((x) => (x.key === key ? { ...x, commands: Boolean(commands) } : x)) };
        await persist(next);
        cache.set(id, next);
        return next.chats.find((x) => x.key === key);
      });
    },
    /** A group became a supergroup: Telegram gives the new id. */
    migrateChat(id, key, newChatId) {
      return serial(async () => {
        await ensure();
        const t = cache.get(id);
        const c = t?.chats.find((x) => x.key === key);
        if (!t || !c) return null;
        const moved = { ...c, id: String(newChatId), key: chatKeyOf(newChatId), type: "supergroup" };
        const next = { ...t, chats: t.chats.map((x) => (x.key === key ? moved : x)) };
        await persist(next);
        cache.set(id, next);
        return moved;
      });
    },
    remove(id) {
      return serial(async () => {
        await ensure();
        if (!cache.has(id)) return false;
        await secrets.delete(PREFIX + id);
        cache.delete(id);
        return true;
      });
    },
  };
}

/** What may leave this module: no token, no chat id. */
export function publicTarget(t, runtime = {}) {
  return {
    id: t.id,
    kind: "telegram",
    label: t.label,
    bot: { username: t.botUsername, tokenHint: maskToken(t.botToken) },
    chats: t.chats.map((c) => ({ key: c.key, name: c.name, type: c.type, idHint: maskId(c.id), commands: c.commands, ...(runtime.chats?.[c.key] ? { state: runtime.chats[c.key] } : {}) })),
    createdAt: t.createdAt,
    health: runtime.health ?? { state: "unverified", message: "Nothing has been sent yet. Press Send a test message.", lastOkAt: null, lastError: null },
  };
}
