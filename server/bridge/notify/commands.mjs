/**
 * Commands a person can send the bot. READ-ONLY by construction:
 *
 *   /price SYMBOL...   /positions   /orders   /funds   /status   /help
 *   /kill              asks for a one-time code; "/kill 4821" then ENGAGES the kill switch. Engage only.
 *
 * What is NOT here, on purpose: placing, changing or cancelling an order, approving an order ticket, creating or
 * revoking a key, releasing the kill switch. Approval must stay on this computer (a Telegram account can be taken over
 * by a SIM swap or a stolen phone, and Telegram chats are not end-to-end encrypted), so no command and no button can do it.
 *
 * Everything runs through `reader`, a small object that only has read methods, with a context whose only scope is
 * "read". The handler is given no way to reach the order service's write methods (a test proves it). Every command is
 * audited (who: the chat key, never the chat id; what: the command word and how many arguments). Prices carry their data
 * class and delay, always: a delayed or end-of-day number is never shown bare.
 */
import { randomInt, timingSafeEqual } from "node:crypto";
import { createCallContext } from "../core/context.mjs";
import { clip, displaySymbol, money, pnl, qty, scrub } from "./messages.mjs";

export const COMMANDS = Object.freeze(["price", "positions", "orders", "funds", "status", "help", "kill"]);
const ALIASES = Object.freeze({ prices: "price", p: "price", quote: "price", quotes: "price", start: "help", pos: "positions", order: "orders", fund: "funds" });
export const KILL_CODE_TTL_MS = 60_000;
const MAX_SYMBOLS = 10;
const MAX_LINES = 10;
const num = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * "/price@my_bot NIFTY RELIANCE" -> { command: "price", args: ["NIFTY", "RELIANCE"] }.
 * null: not a command. { ignore: true }: addressed to another bot.
 * @param {string} text @param {string} [botUsername]
 */
export function parseCommand(text, botUsername) {
  const m = /^\/([A-Za-z_]{1,32})(?:@([A-Za-z0-9_]{3,32}))?(?:[\s]+([\s\S]*))?$/.exec(String(text ?? "").slice(0, 500).trim());
  if (!m) return null;
  if (m[2] && botUsername && m[2].toLowerCase() !== botUsername.toLowerCase()) return { ignore: true };
  const word = m[1].toLowerCase();
  const command = ALIASES[word] ?? word;
  const args = String(m[3] ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((s) => s.slice(0, 40));
  return { command, args, known: COMMANDS.includes(command) };
}

/** "NIFTY" -> "NSE:NIFTY", "nse:reliance" -> "NSE:RELIANCE". Anything with another shape is passed on and refused by the market service. */
export function normaliseSymbol(raw) {
  const s = String(raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9:&_.-]/g, "");
  if (!s) return "";
  return s.includes(":") ? s : `NSE:${s}`;
}

/** "real-time, 2 s ago" / "delayed 15 min" / "end of day" / "data class unknown", plus ", unofficial" and ", stale". Never empty. */
export function dataLabel(f) {
  if (!f || typeof f !== "object") return "data class unknown";
  let base;
  if (f.class === "realtime") {
    const age = Number.isFinite(f.ageMs) ? f.ageMs : null;
    base = age === null ? "real-time" : age < 1500 ? "real-time, just now" : age < 60_000 ? `real-time, ${Math.round(age / 1000)} s ago` : `real-time, ${Math.round(age / 60_000)} min ago`;
  } else if (f.class === "delayed") {
    const s = Number(f.delaySec);
    base = Number.isFinite(s) && s > 0 ? `delayed ${s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round((s / 3600) * 10) / 10} h`}` : "delayed";
  } else if (f.class === "eod") base = "end of day";
  else base = "data class unknown";
  const flags = Array.isArray(f.flags) ? f.flags : [];
  if (f.official === false || flags.includes("unofficial")) base += ", unofficial";
  if (f.stale === true || flags.includes("stale")) base += ", stale";
  return base;
}

const hhmm = (iso) => {
  const m = /T(\d{2}:\d{2})/.exec(String(iso ?? ""));
  return m ? m[1] : "";
};

/**
 * The read-only view of the Bridge a command may use. Every method is a read.
 * @param {any} services  deps (accounts, marketData, orders, safety, backupData, readiness)
 */
export function createReader(services, { logger } = {}) {
  const key = { id: "telegram", label: "Telegram bot", scopes: ["read"], accounts: "*", clientKind: "other", createdAt: new Date(0).toISOString() };
  const ctx = () => createCallContext({ source: "system", key, principal: { kind: "key", id: "telegram", label: "Telegram bot" }, scopes: ["read"], log: logger });
  return Object.freeze({
    quotes: (symbols) => services.marketData.quotes(symbols, { allowBackup: true, purpose: "display", priority: "interactive" }),
    accounts: () => services.accounts.list(),
    positions: (accountId) => services.orders.positions(ctx(), accountId),
    funds: (accountId) => services.orders.funds(ctx(), accountId),
    orders: (limit) => services.orders.list(ctx(), { limit }),
    order: (orderId) => services.orders.get(ctx(), orderId),
    limits: (accountId) => services.safety.limits(accountId),
    killStatus: () => services.safety.killSwitchStatus(),
    sources: () => {
      try {
        const rows = typeof services.backupData.list === "function" ? services.backupData.list() : services.backupData.status().providers;
        return rows.filter((r) => r.enabled);
      } catch {
        return [];
      }
    },
    /** The only write a command has: turn the kill switch ON. */
    engageKill: (reason) => services.safety.engageKillSwitch(ctx(), { reason, cancelOpenOrders: false }),
  });
}

/**
 * @param {{ reader: ReturnType<typeof createReader>, audit?: any, cfg: any, now?: () => number, logger?: any, queueStatus?: () => any, istClock?: (t: number) => string }} opts
 */
export function createCommandHandler({ reader, audit, cfg, now = () => Date.now(), logger, queueStatus, istClock }) {
  /** chat -> recent command times */
  const hits = new Map();
  /** chat -> { code, expiresAt, tries } */
  const killCodes = new Map();
  const perMinute = cfg.inbound.commandsPerMinute;

  const rate = (chatKey) => {
    const t = now();
    const arr = (hits.get(chatKey) ?? []).filter((x) => x > t - 60_000);
    if (arr.length >= perMinute) {
      hits.set(chatKey, arr);
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((arr[0] + 60_000 - t) / 1000)) };
    }
    arr.push(t);
    hits.set(chatKey, arr);
    return { ok: true };
  };
  const warned = new Map();

  async function record(chatKey, targetId, command, args, ok) {
    try {
      await audit?.append({ type: "notify.command", actor: { kind: "telegram", id: chatKey }, source: "telegram", data: { command, args: args.length, ok, targetId } });
    } catch (err) {
      logger?.warn?.("telegram command could not be audited", { code: err?.code });
    }
  }

  const accountName = (a) => clip(a.label || a.id, 40);
  const modeOf = (a) => (a.broker === "paper" ? "paper" : "live");

  async function price(args) {
    if (!args.length) return ["Which symbols? For example: /price NIFTY RELIANCE"];
    const symbols = [...new Set(args.map(normaliseSymbol).filter(Boolean))].slice(0, MAX_SYMBOLS);
    let r;
    try {
      r = await reader.quotes(symbols);
    } catch (err) {
      return [`Could not get prices: ${clip(err?.detail ?? err?.message ?? "unknown problem", 100)}.`];
    }
    const lines = r.items.map((q) => {
      const chg = Number.isFinite(q.changePct) ? ` (${q.changePct > 0 ? "+" : ""}${num.format(q.changePct)}%)` : "";
      return `${displaySymbol(q.symbol)} ${num.format(q.ltp)}${chg} - ${dataLabel(q.freshness)}`;
    });
    for (const e of r.errors ?? []) lines.push(`${displaySymbol(e.symbol)}: ${e.code === "SYMBOL_NOT_FOUND" ? "symbol not found" : clip(e.message ?? e.code, 60)}`);
    if (!lines.length) lines.push("No prices came back.");
    return [lines.join("\n")];
  }

  /** Accounts a portfolio read may use right now (a live account that is logged out is named, not called). */
  const usable = (accounts) => {
    const ok = [];
    const notes = [];
    for (const a of accounts) {
      if (a.enabled === false) continue;
      if (a.broker !== "paper" && a.session?.state !== "connected") notes.push(`${accountName(a)}: not logged in`);
      else ok.push(a);
    }
    return { ok, notes };
  };

  async function positions() {
    const { ok, notes } = usable(reader.accounts());
    const out = [];
    for (const a of ok) {
      try {
        const r = await reader.positions(a.id);
        const open = r.items.filter((p) => p.netQty !== 0);
        const head = `${accountName(a)} (${modeOf(a)}${modeOf(a) === "live" ? `, from broker${r.freshness?.asOf ? ` at ${hhmm(r.freshness.asOf)}` : ""}` : ""}):`;
        if (!open.length) out.push(`${head} no open positions`);
        else {
          const rows = open.slice(0, MAX_LINES).map((p) => `${displaySymbol(p.symbol)} ${p.netQty > 0 ? "+" : ""}${qty(p.netQty)} at ${num.format(p.avgPrice)}, P&L ${pnl(p.pnl)}`);
          if (open.length > MAX_LINES) rows.push(`and ${open.length - MAX_LINES} more`);
          out.push([head, ...rows].join("\n"));
        }
      } catch (err) {
        out.push(`${accountName(a)}: could not read positions (${clip(err?.code ?? "error", 30)})`);
      }
    }
    out.push(...notes);
    return [out.join("\n\n") || "No accounts."];
  }

  async function orders() {
    let page;
    try {
      page = await reader.orders(MAX_LINES);
    } catch (err) {
      return [`Could not read orders: ${clip(err?.detail ?? err?.message ?? "problem", 100)}.`];
    }
    if (!page.items.length) return ["No orders yet."];
    const label = { outcome_unknown: "unknown, check your broker", partially_filled: "partly filled", trigger_pending: "waiting for trigger" };
    const lines = page.items.slice(0, MAX_LINES).map((o) => {
      const px = Number.isFinite(o.price) && o.price > 0 ? ` at ${num.format(o.price)}` : "";
      return `${hhmm(o.placedAt)} ${o.side} ${qty(o.quantity)} ${displaySymbol(o.symbol)}${px}: ${label[o.status] ?? o.status} (${o.mode}, ${clip(o.accountId, 30)})`;
    });
    return [lines.join("\n")];
  }

  async function funds() {
    const { ok, notes } = usable(reader.accounts());
    const out = [];
    for (const a of ok) {
      try {
        const r = await reader.funds(a.id);
        const f = r.funds;
        out.push(`${accountName(a)} (${modeOf(a)}): cash ${money(f.availableCash)}, margin used ${money(f.usedMargin)}${Number.isFinite(f.realisedPnl) ? `, realised ${pnl(f.realisedPnl)}` : ""}`);
      } catch (err) {
        out.push(`${accountName(a)}: could not read funds (${clip(err?.code ?? "error", 30)})`);
      }
    }
    out.push(...notes);
    return [out.join("\n") || "No accounts."];
  }

  async function status() {
    const lines = [`Bridge status${istClock ? ` (${istClock(now())} IST)` : ""}`];
    const accs = reader.accounts().filter((a) => a.enabled !== false && a.broker !== "paper");
    lines.push(accs.length ? `Accounts: ${accs.map((a) => `${accountName(a)} ${a.session?.state === "connected" ? "logged in" : "NOT logged in"}`).join("; ")}` : "Accounts: no broker account set up");
    let ks = null;
    try {
      ks = reader.killStatus();
    } catch {
      /* not available */
    }
    lines.push(ks ? (ks.engaged ? `Kill switch: ON${ks.reason ? ` (${clip(ks.reason, 60)})` : ""}. Release it on this computer.` : "Kill switch: off") : "Kill switch: unknown");
    const src = reader.sources();
    lines.push(src.length ? `Data sources: ${src.map((s) => `${clip(s.name ?? s.id, 30)} ${s.health?.state && s.health.state !== "ok" ? s.health.state : "ok"}`).join("; ")}` : "Data sources: your broker accounts only");
    const q = queueStatus?.();
    if (q) lines.push(`Alerts: ${q.depth} waiting${q.lastDeliveryAt ? `, last sent at ${hhmm(q.lastDeliveryAt)}` : ""}`);
    return [lines.join("\n")];
  }

  const help = () => [
    [
      "I can read, not trade:",
      "/price NIFTY RELIANCE - prices, with how fresh they are",
      "/positions - open positions",
      "/orders - latest orders",
      "/funds - cash and margin",
      "/status - logins, kill switch, data sources",
      cfg.inbound.allowKill ? "/kill - turn the kill switch on (asks for a code first)" : "",
      "Orders are approved on the computer running the Bridge, never here.",
    ]
      .filter(Boolean)
      .join("\n"),
  ];

  async function kill(chatKey, targetId, args) {
    if (!cfg.inbound.allowKill) return ["The kill switch cannot be turned on from Telegram on this Bridge."];
    const id = `${targetId}:${chatKey}`;
    const t = now();
    const pending = killCodes.get(id);
    if (!args.length) {
      const code = String(randomInt(1000, 10_000));
      killCodes.set(id, { code, expiresAt: t + KILL_CODE_TTL_MS, tries: 0 });
      return [`To turn the kill switch ON (this blocks all new orders), reply within 60 seconds with: /kill ${code}\nOnly you can turn it off again, on the computer running the Bridge.`];
    }
    if (!pending || pending.expiresAt <= t) {
      killCodes.delete(id);
      return ["That code has expired or was never asked for. Send /kill to get a new one."];
    }
    const given = Buffer.from(String(args[0]));
    const want = Buffer.from(pending.code);
    const same = given.length === want.length && timingSafeEqual(given, want);
    if (!same) {
      pending.tries += 1;
      if (pending.tries >= 3) {
        killCodes.delete(id);
        return ["Wrong code three times. Send /kill to start again."];
      }
      return ["That is not the code. Check the number in my last message, or send /kill for a new one."];
    }
    killCodes.delete(id);
    const st = await reader.engageKill(`Turned on from Telegram (chat ${chatKey.slice(0, 6)})`);
    return [st?.engaged ? "Kill switch is ON. New orders are blocked. To turn it off, open the Bridge on your computer." : "The Bridge did not confirm the kill switch. Check the dashboard now."];
  }

  /**
   * @param {{ targetId: string, chatKey: string, text: string, botUsername?: string }} input
   * @returns {Promise<string[] | null>} reply texts (each under the Telegram limit), or null for no reply
   */
  async function handle({ targetId, chatKey, text, botUsername }) {
    const parsed = parseCommand(text, botUsername);
    if (!parsed || parsed.ignore) return null;
    const rl = rate(`${targetId}:${chatKey}`);
    if (!rl.ok) {
      const k = `${targetId}:${chatKey}`;
      if (warned.get(k) && warned.get(k) > now() - 60_000) return null;
      warned.set(k, now());
      await record(chatKey, targetId, "rate_limited", parsed.args ?? [], false);
      return [`Too many commands. Try again in ${rl.retryAfterS} seconds.`];
    }
    if (!parsed.known) {
      await record(chatKey, targetId, "unknown", [], false);
      return ["I do not know that command. Send /help to see what I can do."];
    }
    let replies;
    let ok = true;
    try {
      switch (parsed.command) {
        case "price":
          replies = await price(parsed.args);
          break;
        case "positions":
          replies = await positions();
          break;
        case "orders":
          replies = await orders();
          break;
        case "funds":
          replies = await funds();
          break;
        case "status":
          replies = await status();
          break;
        case "kill":
          replies = await kill(chatKey, targetId, parsed.args);
          break;
        default:
          replies = help();
      }
    } catch (err) {
      ok = false;
      logger?.warn?.("telegram command failed", { command: parsed.command, code: err?.code ?? "ERROR" });
      replies = ["Something went wrong reading that. Try again in a moment."];
    }
    await record(chatKey, targetId, parsed.command === "kill" && parsed.args.length ? "kill_confirm" : parsed.command, parsed.command === "kill" ? [] : parsed.args, ok);
    return replies.map((r) => scrub(r));
  }

  return { handle, pendingKillCodes: () => killCodes.size };
}
