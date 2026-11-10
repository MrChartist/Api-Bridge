/**
 * NotifyService (deps.notify): turns Bridge events into short Telegram messages and answers a few read-only commands.
 *
 *   events (bus) -> router (which events are on, one plain message) -> coalescing + dedupe + quiet hours
 *     -> durable outbox (outbox.mjs) -> pacing -> Telegram sendMessage (retry with backoff and retry_after)
 *   Telegram getUpdates (long polling, outbound only) -> allow-list -> commands.mjs -> replies through the same outbox
 *
 * Time and network are injected (`now`, `fetchImpl`, `random`), and nothing runs by itself except through start():
 * tests call pump() and pollOnce() with a fake clock and a fake Telegram. Persistent files, all under
 * dataDir/notify/ (0600): outbox.json (messages waiting), state.json (poll offsets, delivery health, reminders already
 * sent, today's counters), settings.json (the events a person switched on or off). Tokens and chat ids are NOT in any of
 * them: they are in the encrypted secrets store (targets.mjs).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BridgeError } from "../core/errors.mjs";
import { isStub } from "../core/contracts.mjs";
import { writeFileAtomic } from "../../lib/jsonl.mjs";
import { istClockOf, istDateOf, istInstant } from "../reference/calendar.mjs";
import { notifyConfig } from "./config.mjs";
import { createCommandHandler, createReader } from "./commands.mjs";
import { EVENT_CATALOG, effectiveEventFlags, isCritical } from "./events.mjs";
import * as msg from "./messages.mjs";
import { createOutbox } from "./outbox.mjs";
import { createTradingCalendar, dueReminders, nextReminderAt } from "./reminders.mjs";
import { PLAIN, TelegramError, createTelegramClient, isChatRef, looksLikeToken, maskId } from "./telegram.mjs";
import { chatKeyOf, createTargetStore, publicTarget } from "./targets.mjs";

const SECOND = 1000;
const MIN = 60_000;
const BASE_TICK_MS = 15_000;
const SOURCE_POLL_MS = 30_000;
const CANDIDATE_TTL_MS = 15 * MIN;
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The state of the module's own data directory (dataDir/notify). */
function createJsonFile(file, fallback) {
  let value = fallback();
  try {
    if (existsSync(file)) value = { ...fallback(), ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    value = fallback();
  }
  return {
    get: () => value,
    save() {
      try {
        writeFileAtomic(file, JSON.stringify(value));
      } catch {
        /* a full disk must not stop alerts; the next change tries again */
      }
    },
  };
}

/**
 * @param {any} deps  scoped deps: config, logger, bus, clock, paths, secrets, audit, accounts, safety, marketData, orders, readiness, backupData
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, random?: () => number, calendar?: any, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} [opts]
 */
export function createNotifyService(deps, opts = {}) {
  const cfg = notifyConfig(deps.config);
  const log = deps.logger.child({ module: "notify" });
  const now = opts.now ?? (() => deps.clock.now());
  const random = opts.random ?? Math.random;
  const dir = join(deps.paths.dataDir, "notify");
  const calendar = opts.calendar ?? createTradingCalendar();
  const setTimer = opts.setTimer ?? setTimeout;
  const clearTimer = opts.clearTimer ?? clearTimeout;
  const hasSecrets = deps.secrets && !isStub(deps.secrets);

  const settingsFile = createJsonFile(join(dir, "settings.json"), () => ({ events: {}, quietHours: null, morning: null }));
  const stateFile = createJsonFile(join(dir, "state.json"), () => ({ offsets: {}, health: {}, sent: {}, daily: { date: "", rows: {} }, counters: { delivered: 0, failed: 0, ignoredMessages: 0, commands: 0, suppressed: 0, stale: 0 } }));
  const outbox = createOutbox({ file: join(dir, "outbox.json"), max: cfg.queue.max, now, logger: log });
  const store = hasSecrets ? createTargetStore({ secrets: deps.secrets, logger: deps.logger, now }) : null;
  const reader = createReader(deps, { logger: log });
  const state = () => stateFile.get();

  const clients = new Map(); // targetId -> { token, client }
  const clientFor = (t) => {
    const c = clients.get(t.id);
    if (c && c.token === t.botToken) return c.client;
    const client = createTelegramClient({ token: t.botToken, fetchImpl: opts.fetchImpl });
    clients.set(t.id, { token: t.botToken, client });
    return client;
  };

  // ── settings ──
  const settings = () => {
    const s = settingsFile.get();
    return {
      events: effectiveEventFlags(cfg.events, s.events),
      quietHours: { ...cfg.quietHours, ...(s.quietHours ?? {}) },
      morning: { ...cfg.morning, ...(s.morning ?? {}), endOfDay: { ...cfg.morning.endOfDay, ...(s.morning?.endOfDay ?? {}) } },
    };
  };

  function inQuiet(t, q) {
    if (!q.enabled) return false;
    const m = toMin(istClockOf(t));
    const a = toMin(q.start);
    const b = toMin(q.end);
    return a === b ? false : a < b ? m >= a && m < b : m >= a || m < b;
  }
  /** The next instant the quiet period ends. */
  function quietEnd(t, q) {
    const date = istDateOf(t);
    let at = istInstant(date, q.end);
    if (at <= t) at = istInstant(istDateOf(t + 86_400_000), q.end);
    return at;
  }

  // ── health, counters ──
  const health = (id) => (state().health[id] ??= { lastOkAt: null, lastError: null, chats: {} });
  const count = (k, n = 1) => {
    state().counters[k] = (state().counters[k] ?? 0) + n;
  };
  const noteOk = (target, chat) => {
    const h = health(target.id);
    h.lastOkAt = now();
    h.lastError = null;
    if (h.chats[chat.key]) delete h.chats[chat.key];
    count("delivered");
    stateFile.save();
  };
  const noteError = (target, chat, err) => {
    const h = health(target.id);
    const info = { kind: err.kind, message: PLAIN[err.kind] ?? PLAIN.unknown, at: now() };
    h.lastError = info;
    if (chat && ["blocked", "forbidden", "chat_not_found"].includes(err.kind)) h.chats[chat.key] = info;
    stateFile.save();
  };

  /** Plain state of one target for screens. */
  function targetHealth(t) {
    const h = state().health[t.id];
    if (!h || (!h.lastOkAt && !h.lastError)) return { state: "unverified", message: "Nothing has been sent yet. Press Send a test message.", lastOkAt: null, lastError: null };
    const bad = h.lastError && (!h.lastOkAt || h.lastError.at >= h.lastOkAt);
    const iso = (x) => (x ? new Date(x).toISOString() : null);
    return bad
      ? { state: h.lastError.kind, message: h.lastError.message, lastOkAt: iso(h.lastOkAt), lastError: { kind: h.lastError.kind, message: h.lastError.message, at: iso(h.lastError.at) } }
      : { state: "ok", message: "Messages are being delivered.", lastOkAt: iso(h.lastOkAt), lastError: h.lastError ? { kind: h.lastError.kind, message: h.lastError.message, at: iso(h.lastError.at) } : null };
  }

  const runtimeFor = (t) => ({
    health: targetHealth(t),
    chats: Object.fromEntries(Object.entries(health(t.id).chats ?? {}).map(([k, v]) => [k, { kind: v.kind, message: v.message }])),
  });

  // ── sending ──
  const lastSent = new Map(); // `${target}:${chat}` -> ms
  const blockedUntil = new Map(); // targetId -> ms (Telegram told us to wait)
  const globalSent = []; // send times in the last second
  const chatSent = new Map(); // `${target}:${chat}` -> send times in the last minute (groups are limited per minute)

  /** One send with its bookkeeping. @returns {Promise<{ ok: true } | { ok: false, error: TelegramError }>} */
  async function sendNow(target, chat, text, { silent = false } = {}) {
    try {
      await clientFor(target).sendMessage(chat.id, text, { silent });
      lastSent.set(`${target.id}:${chat.key}`, now());
      globalSent.push(now());
      const k = `${target.id}:${chat.key}`;
      const recent = (chatSent.get(k) ?? []).filter((x) => x > now() - MIN);
      recent.push(now());
      chatSent.set(k, recent);
      noteOk(target, chat);
      return { ok: true };
    } catch (err) {
      const e = err instanceof TelegramError ? err : new TelegramError("unknown");
      lastSent.set(`${target.id}:${chat.key}`, now());
      noteError(target, chat, e);
      if (e.kind === "rate_limited") blockedUntil.set(target.id, now() + (e.retryAfterSeconds ?? 5) * SECOND + 250);
      return { ok: false, error: e };
    }
  }

  const backoff = (attempts) => Math.min(cfg.retry.maxMs, cfg.retry.baseMs * 2 ** Math.max(0, attempts - 1)) * (0.8 + 0.4 * random());

  /** Milliseconds a group chat must still wait (Telegram: at most 20 messages per minute to a group). 0 for other chats. */
  function groupWait(target, chatKey, t) {
    const chat = target.chats.find((c) => c.key === chatKey);
    if (!chat || !["group", "supergroup"].includes(chat.type)) return 0;
    const recent = (chatSent.get(`${target.id}:${chatKey}`) ?? []).filter((x) => x > t - MIN);
    return recent.length >= cfg.pacing.groupPerMinute ? recent[0] + MIN - t : 0;
  }

  /** Handle one outbox item: send it and decide what happens to it. */
  async function deliver(item, target) {
    const chat = target.chats.find((c) => c.key === item.chatKey);
    if (!chat) {
      outbox.remove(item.id);
      return;
    }
    const r = await sendNow(target, chat, item.text, { silent: item.silent });
    if (r.ok) {
      outbox.remove(item.id);
      return;
    }
    const e = r.error;
    const t = now();
    if (e.kind === "rate_limited") {
      // Telegram said how long to wait: do not count it as an attempt, just wait that long.
      outbox.update(item.id, { nextAttemptAt: blockedUntil.get(target.id) ?? t + 5 * SECOND, lastError: { kind: e.kind, at: t } });
    } else if (e.kind === "migrated" && e.migrateTo) {
      const moved = await store.migrateChat(target.id, chat.key, e.migrateTo);
      if (moved) for (const i of outbox.list().filter((x) => x.targetId === target.id && x.chatKey === chat.key)) outbox.update(i.id, { chatKey: moved.key, nextAttemptAt: t });
    } else if (e.retryable) {
      const attempts = item.attempts + 1;
      if (attempts >= cfg.retry.maxAttempts) {
        outbox.remove(item.id);
        count("failed");
        log.warn("notification dropped after repeated failures", { kind: e.kind, targetId: target.id });
      } else outbox.update(item.id, { attempts, nextAttemptAt: t + backoff(attempts), lastError: { kind: e.kind, at: t } });
    } else if (e.kind === "token_invalid") {
      // Nothing can be sent until the person enters a working token: do not keep hammering Telegram with the old one.
      outbox.removeFor(target.id);
      count("failed");
    } else {
      outbox.removeFor(target.id, chat.key);
      count("failed");
    }
  }

  // ── publishing ──
  const dedupeSeen = new Map(); // key -> ms
  const groups = new Map(); // group -> { lastSentAt, held: [{text, key}] }

  function enqueueText(targets, text, { kind = "event", critical = false, silent = false, event, holdUntil, maxAgeMs } = {}) {
    const clean = msg.scrub(text, (t) => deps.logger.redact(t));
    let n = 0;
    for (const t of targets) {
      for (const c of t.chats) {
        outbox.add({ targetId: t.id, chatKey: c.key, text: clean, kind, critical, silent, event, ...(holdUntil ? { holdUntil } : {}), maxAgeMs: maxAgeMs ?? cfg.retry.maxAgeMinutes * MIN });
        n += 1;
      }
    }
    return n;
  }

  /**
   * Route one composed message ({ key, text, group, dedupe? }) through the event switches, dedupe, coalescing and quiet
   * hours into the outbox.
   * @returns {Promise<{ queued: number, reason?: string }>}
   */
  async function publish(c, o = {}) {
    if (!cfg.enabled || !store || !c?.text) return { queued: 0, reason: "off" };
    const s = settings();
    if (c.key && s.events[c.key] === false) return { queued: 0, reason: "event_off" };
    const targets = (await store.list()).filter((t) => t.chats.length);
    if (!targets.length) return { queued: 0, reason: "no_chats" };
    const critical = o.critical ?? isCritical(c.key);
    const t = now();
    // Identical text again within the dedupe window: counted, not sent (critical messages are never dropped here).
    if (!critical && cfg.dedupeSeconds > 0) {
      const dk = c.dedupe ?? `${c.key}:${c.text}`;
      const seen = dedupeSeen.get(dk);
      if (seen && t - seen < cfg.dedupeSeconds * SECOND) {
        count("suppressed");
        return { queued: 0, reason: "duplicate" };
      }
      dedupeSeen.set(dk, t);
      if (dedupeSeen.size > 500) for (const [k, v] of dedupeSeen) if (t - v > cfg.dedupeSeconds * SECOND) dedupeSeen.delete(k);
    }
    const quiet = !critical && !o.bypassQuiet && inQuiet(t, s.quietHours);
    if (quiet) {
      const queued = enqueueText(targets, c.text, { kind: "digest", event: c.key, holdUntil: quietEnd(t, s.quietHours) });
      stateFile.save();
      return { queued, reason: "quiet_hours" };
    }
    // A burst of the same kind: the first goes out now, the rest become ONE digest line when the window ends.
    const windowMs = cfg.coalesceSeconds * SECOND;
    if (!critical && !o.noCoalesce && windowMs > 0 && c.group) {
      const g = groups.get(c.group) ?? { lastSentAt: -Infinity, held: [] };
      groups.set(c.group, g);
      if (g.held.length || t - g.lastSentAt < windowMs) {
        g.held.push({ text: c.text, key: c.key });
        if (g.held.length > 50) g.held.shift();
        return { queued: 0, reason: "coalesced" };
      }
      g.lastSentAt = t;
    }
    const queued = enqueueText(targets, c.text, { event: c.key, critical, silent: false });
    void pump();
    return { queued };
  }

  /** Send the digest line of every burst whose window has ended. */
  async function flushGroups() {
    const t = now();
    const windowMs = cfg.coalesceSeconds * SECOND;
    for (const g of groups.values()) {
      if (!g.held.length || t - g.lastSentAt < windowMs) continue;
      const held = g.held.splice(0);
      const label = held.length === 1 ? null : EVENT_CATALOG.find((e) => e.key === held[0].key)?.label?.toLowerCase();
      const text = held.length === 1 ? held[0].text : `${held.length} more${label ? ` (${label})` : ""} in the last ${cfg.coalesceSeconds} seconds. Latest: ${held[held.length - 1].text}`;
      g.lastSentAt = t;
      const targets = (await store.list()).filter((x) => x.chats.length);
      enqueueText(targets, text, { event: held[0].key });
      count("suppressed", Math.max(0, held.length - 1));
      stateFile.save();
    }
    for (const [name, g] of groups) if (!g.held.length && t - g.lastSentAt > 10 * MIN) groups.delete(name);
  }

  /** Quiet-hours messages whose hold has ended become one message per chat. */
  function mergeHeld() {
    const t = now();
    const due = outbox.list().filter((i) => i.kind === "digest" && (i.holdUntil ?? 0) <= t);
    const by = new Map();
    for (const i of due) {
      const k = `${i.targetId}:${i.chatKey}`;
      (by.get(k) ?? by.set(k, []).get(k)).push(i);
    }
    for (const list of by.values()) {
      list.sort((a, b) => a.seq - b.seq);
      const shown = list.slice(0, 8).map((i) => `- ${i.text}`);
      const text = list.length === 1 ? `While you were away: ${list[0].text}` : `While you were away (${list.length} alerts):\n${shown.join("\n")}${list.length > 8 ? `\nand ${list.length - 8} more` : ""}`;
      outbox.replace(
        list.map((i) => i.id),
        { targetId: list[0].targetId, chatKey: list[0].chatKey, text: text.slice(0, 3900), kind: "event", critical: false, silent: false, maxAgeMs: cfg.retry.maxAgeMinutes * MIN },
      );
    }
  }

  // ── router: bus topics ──
  const offs = [];
  const orderSeen = new Map(); // orderId -> last status (bounded)
  const sessionSeen = new Map(); // accountId -> last session state
  const throttles = []; // { at, accountId, endpointClass }
  let throttleAlertedAt = -Infinity;
  const sourceFlag = new Map(); // sourceId -> true while flagged
  let lastSourcePoll = 0;

  const accountLabel = (id) => {
    try {
      const a = deps.accounts.get(id);
      return a?.label || id;
    } catch {
      return id;
    }
  };
  const helpers = { accountLabel };

  const dayRow = (accountId, mode) => {
    const d = state().daily;
    const today = istDateOf(now());
    if (d.date !== today) {
      d.date = today;
      d.rows = {};
    }
    return (d.rows[`${accountId}|${mode}`] ??= { orders: 0, fills: 0, rejections: 0 });
  };

  async function onOrder(p) {
    if (!p?.orderId) return;
    const prev = orderSeen.get(p.orderId);
    if (prev === p.status) return;
    orderSeen.set(p.orderId, p.status);
    if (orderSeen.size > 2000) orderSeen.delete(orderSeen.keys().next().value);
    const mode = p.mode === "live" ? "live" : "paper";
    if (prev === undefined && !["rejected"].includes(p.status)) dayRow(p.accountId, mode).orders += 1;
    if (p.status === "filled") dayRow(p.accountId, mode).fills += 1;
    if (p.status === "rejected") {
      const row = dayRow(p.accountId, mode);
      if (prev === undefined) row.orders += 1;
      row.rejections += 1;
    }
    stateFile.save();
    const kind = p.status === "filled" ? "filled" : p.status === "rejected" ? "rejected" : prev === undefined && ["open", "pending", "trigger_pending", "partially_filled"].includes(p.status) ? "placed" : null;
    if (!kind) return;
    const flags = settings().events;
    if (flags[`order.${kind}`] === false) return;
    let order = null;
    try {
      order = await reader.order(p.orderId);
    } catch {
      /* the details are optional */
    }
    await publish(msg.orderMessage(kind, p, order, helpers));
  }

  async function onUnknown(p) {
    let order = null;
    try {
      order = await reader.order(p.orderId);
    } catch {
      /* optional */
    }
    await publish(msg.unknownOutcomeMessage(p, order, helpers), { critical: true });
  }

  function onAccount(p) {
    if (!p?.accountId) return;
    const prev = sessionSeen.get(p.accountId);
    sessionSeen.set(p.accountId, p.session);
    if (prev === "connected" && ["expired", "error", "missing"].includes(p.session)) void publish(msg.sessionMessage(p, helpers));
  }

  function onThrottle(p) {
    const t = now();
    const windowMs = cfg.rateLimitAlert.windowMinutes * MIN;
    throttles.push({ at: t, accountId: p?.accountId, endpointClass: p?.endpointClass });
    while (throttles.length && throttles[0].at < t - windowMs) throttles.shift();
    if (throttles.length >= cfg.rateLimitAlert.threshold && t - throttleAlertedAt >= windowMs) {
      throttleAlertedAt = t;
      const tally = new Map();
      for (const x of throttles) tally.set(`${x.accountId}|${x.endpointClass}`, (tally.get(`${x.accountId}|${x.endpointClass}`) ?? 0) + 1);
      const [top] = [...tally.entries()].sort((a, b) => b[1] - a[1]);
      const [accountId, endpointClass] = top ? top[0].split("|") : [];
      void publish(msg.rateLimitMessage({ count: throttles.length, windowMinutes: cfg.rateLimitAlert.windowMinutes, worst: top ? { accountId, endpointClass } : null }, helpers));
    }
  }

  async function pollSources() {
    const t = now();
    if (t - lastSourcePoll < SOURCE_POLL_MS) return;
    lastSourcePoll = t;
    let rows = [];
    try {
      rows = deps.backupData && !isStub(deps.backupData) ? (typeof deps.backupData.list === "function" ? deps.backupData.list() : deps.backupData.status().providers) : [];
    } catch {
      return;
    }
    for (const r of rows) {
      const bad = r.enabled && ["open", "ejected", "down"].includes(r.health?.state);
      if (bad && !sourceFlag.get(r.id)) {
        sourceFlag.set(r.id, true);
        await publish(msg.sourceMessage(r));
      } else if (!bad && sourceFlag.get(r.id)) sourceFlag.delete(r.id);
    }
  }

  function subscribe() {
    const on = (topic, fn) => {
      try {
        offs.push(
          deps.bus.on(topic, (p) => {
            Promise.resolve()
              .then(() => fn(p))
              .catch((err) => log.warn("notification handler failed", { topic, code: err?.code ?? "ERROR" }));
          }),
        );
      } catch {
        // This bus does not know the topic (an older build, or a module that is not installed): nothing to listen to.
      }
    };
    on("order.updated", onOrder);
    on("order.outcome_unknown", onUnknown);
    on("ticket.prepared", (p) => publish(msg.ticketMessage(p, helpers)));
    on("safety.kill_switch", (p) => publish(msg.killSwitchMessage(p)));
    on("account.status", onAccount);
    on("trading.readiness", (p) => (p?.notify === true ? publish(msg.readinessMessage(p, helpers)) : undefined));
    on("hook.rejected", (p) => publish(msg.hookMessage("rejected", p)));
    on("hook.stale", (p) => publish(msg.hookMessage("stale", p)));
    on("hook.failed", (p) => publish(msg.hookMessage("failed", p)));
    on("safety.limit", (p) => publish(msg.limitMessage(p, helpers)));
    on("limits.throttled", onThrottle);
    on("backup.failed", (p) => publish(msg.backupFailedMessage(p)));
  }

  // ── reminders ──
  const notLoggedIn = () => {
    try {
      return deps.accounts.list().filter((a) => a.enabled !== false && a.broker !== "paper" && ["expired", "missing", "error"].includes(a.session?.state));
    } catch {
      return [];
    }
  };

  async function checkReminders() {
    const s = settings();
    const t = now();
    const due = dueReminders({ now: t, morning: s.morning, calendar, sent: state().sent });
    const mark = (id) => {
      state().sent[id] = t;
      for (const k of Object.keys(state().sent)) if (t - state().sent[k] > 10 * 86_400_000) delete state().sent[k];
      stateFile.save();
    };
    for (const r of due) {
      let result = null;
      if (r.kind === "morning" || r.kind === "second") {
        const list = notLoggedIn();
        const tooSoon = r.kind === "second" && state().sent[`morning:${r.date}`] && t - state().sent[`morning:${r.date}`] < 10 * MIN;
        if (list.length && !tooSoon) result = await publish(msg.morningMessage(list, { second: r.kind === "second", opens: calendar.marketOpen?.() ?? undefined }), { bypassQuiet: true, noCoalesce: true });
      } else {
        const rows = [];
        if (state().daily.date === r.date) {
          for (const [k, v] of Object.entries(state().daily.rows ?? {})) {
            const [accountId, mode] = k.split("|");
            let pl = 0;
            try {
              pl = reader.limits(accountId).usage.byMode?.[mode]?.realisedPnl ?? 0;
            } catch {
              pl = 0;
            }
            rows.push({ label: accountLabel(accountId), mode, orders: v.orders, fills: v.fills, rejections: v.rejections, pnl: pl });
          }
        }
        result = await publish(msg.eodMessage(rows, r.date), { bypassQuiet: true, noCoalesce: true });
      }
      // With no chat to write to yet, try again later in the same window (the person may be mid-setup).
      if (result?.reason !== "no_chats") mark(r.id);
    }
  }

  // ── the pump ──
  let current = null;
  let again = false;
  let timer = null;
  let running = false;

  /** Run everything that is due. One run at a time: a call while one is running asks for another pass and waits for it. */
  function pump() {
    if (!store) return Promise.resolve();
    if (current) {
      again = true;
      return current;
    }
    current = (async () => {
      try {
        do {
          again = false;
          await step();
        } while (again);
      } catch (err) {
        log.error("notification pump failed", { code: err?.code ?? "ERROR" });
      } finally {
        current = null;
      }
    })();
    return current;
  }

  async function step() {
    const t0 = now();
    outbox.expire(t0);
    await flushGroups();
    mergeHeld();
    await pollSources();
    await checkReminders();
    const targets = new Map((await store.list()).map((t) => [t.id, t]));
    for (const item of outbox.due(now())) {
      const target = targets.get(item.targetId);
      if (!target) {
        outbox.remove(item.id);
        continue;
      }
      const t = now();
      if ((blockedUntil.get(target.id) ?? 0) > t) continue;
      if (t - (lastSent.get(`${target.id}:${item.chatKey}`) ?? -Infinity) < cfg.pacing.perChatMs) continue;
      if (groupWait(target, item.chatKey, t) > 0) continue;
      while (globalSent.length && globalSent[0] < t - SECOND) globalSent.shift();
      if (globalSent.length >= cfg.pacing.perSecond) continue;
      await deliver(item, target);
    }
  }

  /** Milliseconds until something needs attention (a retry, a hold ending, a coalesce window, a pacing gap). */
  function nextWakeMs() {
    const t = now();
    let at = t + BASE_TICK_MS;
    for (const i of outbox.list()) {
      const ready = Math.max(i.nextAttemptAt, i.holdUntil ?? 0, blockedUntil.get(i.targetId) ?? 0, (lastSent.get(`${i.targetId}:${i.chatKey}`) ?? -Infinity) + cfg.pacing.perChatMs);
      if (ready < at) at = ready;
    }
    for (const g of groups.values()) if (g.held.length) at = Math.min(at, g.lastSentAt + cfg.coalesceSeconds * SECOND);
    return Math.max(200, Math.min(BASE_TICK_MS, at - t));
  }

  function arm() {
    if (!running) return;
    timer = setTimer(async () => {
      await pump();
      arm();
    }, nextWakeMs());
    timer?.unref?.();
  }

  // ── inbound ──
  const candidates = new Map(); // chatKey -> { id, name, type, seenAt }
  const pollers = new Map(); // targetId -> { abort, done }
  const commands = createCommandHandler({
    reader,
    audit: deps.audit && !isStub(deps.audit) ? deps.audit : undefined,
    cfg,
    now,
    logger: log,
    queueStatus: () => ({ depth: outbox.size(), lastDeliveryAt: lastDeliveryAt() }),
    istClock: (t) => istClockOf(t),
  });

  function lastDeliveryAt() {
    const at = Math.max(0, ...Object.values(state().health).map((h) => h.lastOkAt ?? 0));
    return at ? new Date(at).toISOString() : null;
  }

  const chatName = (c) => String(c.title ?? ([c.first_name, c.last_name].filter(Boolean).join(" ") || c.username || "Chat")).slice(0, 60);

  /** Process one batch of updates. */
  async function handleUpdates(target, updates) {
    for (const u of updates) {
      state().offsets[target.id] = Math.max(state().offsets[target.id] ?? 0, u.update_id + 1);
      const m = u.message;
      if (!m?.chat || m.from?.is_bot) continue;
      const chat = target.chats.find((c) => c.id === String(m.chat.id));
      if (!chat) {
        // Unknown chat: never answered. Counted, and remembered for a few minutes so "Find my chat" can offer it.
        count("ignoredMessages");
        const key = chatKeyOf(m.chat.id);
        candidates.set(key, { id: String(m.chat.id), name: chatName(m.chat), type: m.chat.type, seenAt: now(), targetId: target.id });
        if (candidates.size > 20) candidates.delete(candidates.keys().next().value);
        continue;
      }
      if (!chat.commands) {
        count("ignoredMessages");
        continue;
      }
      if (Number.isFinite(m.date) && now() / 1000 - m.date > cfg.inbound.maxCommandAgeSeconds) {
        count("stale");
        continue;
      }
      count("commands");
      const replies = await commands.handle({ targetId: target.id, chatKey: chat.key, text: typeof m.text === "string" ? m.text : "", botUsername: target.botUsername });
      for (const text of replies ?? []) outbox.add({ targetId: target.id, chatKey: chat.key, text: text.slice(0, 3900), kind: "reply", critical: false, silent: false, maxAgeMs: 2 * MIN });
    }
    stateFile.save();
    void pump();
  }

  /** One getUpdates call for a target. Exposed for tests and for the one-shot "find my chat" when polling is off. */
  async function pollOnce(target, { timeout = cfg.inbound.pollSeconds, signal } = {}) {
    try {
      const updates = await clientFor(target).getUpdates({ offset: state().offsets[target.id], timeout, signal });
      const h = health(target.id);
      if (h.inboundError) {
        delete h.inboundError;
        stateFile.save();
      }
      await handleUpdates(target, updates);
      return { ok: true, updates: updates.length };
    } catch (err) {
      const e = err instanceof TelegramError ? err : new TelegramError("unknown");
      const h = health(target.id);
      h.inboundError = { kind: e.kind, message: PLAIN[e.kind] ?? PLAIN.unknown, at: now() };
      if (["token_invalid"].includes(e.kind)) noteError(target, null, e);
      stateFile.save();
      return { ok: false, error: e };
    }
  }

  async function runPoller(targetId, ctl) {
    let failures = 0;
    while (!ctl.signal.aborted) {
      const target = await store.get(targetId);
      if (!target) return;
      const r = await pollOnce(target, { signal: ctl.signal });
      if (ctl.signal.aborted) return;
      let wait = r.ok ? (cfg.inbound.pollSeconds === 0 ? SECOND : 100) : 0;
      if (!r.ok) {
        failures += 1;
        if (r.error.kind === "token_invalid") return; // stop; entering a new token restarts it
        wait = r.error.kind === "rate_limited" ? (r.error.retryAfterSeconds ?? 5) * SECOND : r.error.kind === "conflict" ? 30 * SECOND : Math.min(60_000, 2000 * 2 ** Math.min(failures, 5));
      } else failures = 0;
      await new Promise((res) => {
        const tm = setTimer(res, wait);
        tm?.unref?.();
        ctl.signal.addEventListener("abort", () => (clearTimer(tm), res()), { once: true });
      });
    }
  }

  async function syncPollers() {
    if (!store || !running || !cfg.inbound.enabled) return;
    const targets = await store.list();
    const ids = new Set(targets.map((t) => t.id));
    for (const [id, p] of pollers) {
      if (!ids.has(id)) {
        p.abort.abort();
        pollers.delete(id);
      }
    }
    for (const t of targets) {
      if (pollers.has(t.id)) continue;
      const abort = new AbortController();
      const done = runPoller(t.id, abort).catch((err) => log.warn("telegram polling stopped", { code: err?.code ?? "ERROR" })).finally(() => pollers.get(t.id)?.abort === abort && pollers.delete(t.id));
      pollers.set(t.id, { abort, done });
    }
  }

  // ── public operations ──
  const requireStore = () => {
    if (!store) throw new BridgeError("NOT_IMPLEMENTED", "Notifications need the encrypted secrets store, which is not available.");
    return store;
  };
  const getTarget = async (id) => {
    const t = await requireStore().get(id);
    if (!t) throw new BridgeError("NOT_FOUND", "No such notification target.");
    return t;
  };
  const refuseTelegram = (e) => {
    if (e.kind === "token_invalid") return new BridgeError("VALIDATION_FAILED", PLAIN.token_invalid, { errors: [{ path: "token", message: PLAIN.token_invalid }] });
    return new BridgeError("UPSTREAM_ERROR", PLAIN[e.kind] ?? PLAIN.unknown);
  };

  const api = {
    /** Contract: where things stand (queue depth, last error per target, last delivery). No secrets. */
    async status() {
      const t = now();
      const targets = store ? await store.list() : [];
      const s = settings();
      const stats = outbox.stats();
      const c = state().counters;
      return {
        enabled: cfg.enabled,
        targets: targets.map((x) => ({ id: x.id, label: x.label, bot: `@${x.botUsername}`, chats: x.chats.length, ...targetHealth(x), inbound: state().health[x.id]?.inboundError ? { state: state().health[x.id].inboundError.kind, message: state().health[x.id].inboundError.message } : { state: cfg.inbound.enabled ? (pollers.has(x.id) ? "listening" : running ? "starting" : "off") : "off", message: cfg.inbound.enabled ? "Listening for commands from the chats you allowed." : "Commands are switched off in the config." } })),
        queue: { depth: stats.depth, held: stats.held, dropped: stats.dropped, oldestAt: stats.oldestAt ? new Date(stats.oldestAt).toISOString() : null },
        lastDeliveryAt: lastDeliveryAt(),
        counters: { delivered: c.delivered ?? 0, failed: c.failed ?? 0, suppressed: c.suppressed ?? 0, ignoredMessages: c.ignoredMessages ?? 0, commands: c.commands ?? 0 },
        quietHours: { ...s.quietHours, activeNow: inQuiet(t, s.quietHours) },
        reminders: { enabled: s.morning.enabled, at: s.morning.at, secondAt: s.morning.secondAt, endOfDay: s.morning.endOfDay, calendar: calendar.source, nextAt: (() => { const n = nextReminderAt({ now: t, morning: s.morning, calendar }); return n ? new Date(n).toISOString() : null; })() },
      };
    },
    async listTargets() {
      const list = await requireStore().list();
      return list.map((t) => publicTarget(t, runtimeFor(t)));
    },
    /** Contract: the events with their labels and whether each is on, plus the quiet-hours and reminder settings. */
    events() {
      const s = settings();
      return { events: EVENT_CATALOG.map((e) => ({ key: e.key, label: e.label, help: e.help, enabled: s.events[e.key], default: e.default, critical: e.critical })), quietHours: s.quietHours, morning: s.morning };
    },
    /** Persist the person's choices (only the keys given change). */
    setEvents(input) {
      const cur = settingsFile.get();
      if (input.events) cur.events = { ...cur.events, ...input.events };
      if (input.quietHours) cur.quietHours = { ...(cur.quietHours ?? {}), ...input.quietHours };
      if (input.morning) cur.morning = { ...(cur.morning ?? {}), ...input.morning, ...(input.morning.endOfDay ? { endOfDay: { ...(cur.morning?.endOfDay ?? {}), ...input.morning.endOfDay } } : {}) };
      settingsFile.save();
      return api.events();
    },
    /** Contract: queue a ready-made message (for modules that want to say something). Goes through the same checks as events. */
    publish: (composed, o) => publish(composed, o),

    /** Add (or update the token of) a Telegram bot. The token is checked with getMe before it is stored. */
    async addTarget({ token, label }) {
      requireStore();
      const tok = String(token ?? "").trim();
      if (!looksLikeToken(tok)) throw new BridgeError("VALIDATION_FAILED", "That does not look like a bot token. BotFather gives you one like 123456789:ABC... Copy all of it.", { errors: [{ path: "token", message: "not a bot token" }] });
      deps.logger.addSecret(tok);
      let me;
      try {
        me = await createTelegramClient({ token: tok, fetchImpl: opts.fetchImpl }).getMe();
      } catch (err) {
        throw refuseTelegram(err instanceof TelegramError ? err : new TelegramError("unknown"));
      }
      const existing = (await store.list()).find((t) => t.botId === me.id);
      let target;
      let replaced = false;
      if (existing) {
        target = await store.setToken(existing.id, tok, me);
        replaced = true;
        delete state().health[target.id];
        const p = pollers.get(target.id);
        if (p) {
          p.abort.abort();
          pollers.delete(target.id);
        }
      } else target = await store.create({ token: tok, label: String(label ?? "").trim().slice(0, 40) || `@${me.username}`, bot: me });
      stateFile.save();
      await syncPollers();
      return { target: publicTarget(target, runtimeFor(target)), replaced };
    },
    async removeTarget(id) {
      requireStore();
      const ok = await store.remove(id);
      if (!ok) throw new BridgeError("NOT_FOUND", "No such notification target.");
      outbox.removeFor(id);
      delete state().health[id];
      delete state().offsets[id];
      clients.delete(id);
      stateFile.save();
      await syncPollers();
    },
    /** "Find my chat": the chats that wrote to the bot recently and are not on the list yet. */
    async findChats(id, { waitMs = 2500 } = {}) {
      const t = await getTarget(id);
      const have = new Set(t.chats.map((c) => c.key));
      const list = () => {
        const cutoff = now() - CANDIDATE_TTL_MS;
        return [...candidates.entries()]
          .filter(([k, c]) => c.seenAt >= cutoff && c.targetId === id && !have.has(k))
          .map(([k, c]) => ({ ref: k, name: c.name, type: c.type ?? "unknown", idHint: maskId(c.id), seenAt: new Date(c.seenAt).toISOString() }));
      };
      if (!cfg.inbound.enabled || !running) {
        // Polling is off: look once now (nothing else is reading this bot's messages).
        const r = await pollOnce(t, { timeout: 0 });
        if (!r.ok) throw refuseTelegram(r.error);
        return list();
      }
      // Polling is on: the poller already holds a request open at Telegram, so a message shows up within a moment.
      await syncPollers();
      const until = Date.now() + waitMs;
      while (!list().length && Date.now() < until) await new Promise((res) => setTimeout(res, 100));
      return list();
    },
    /** Put a chat on the list: a candidate from findChats ({ ref }), or an id typed by hand ({ chatId }). */
    async addChat(id, { ref, chatId, name, commands }) {
      const t = await getTarget(id);
      let chat;
      if (ref) {
        const c = candidates.get(ref);
        if (!c || c.targetId !== id) throw new BridgeError("NOT_FOUND", "That chat is no longer waiting. Send the bot a message again, then press Find my chat.");
        chat = { id: c.id, name: c.name, type: c.type, commands };
      } else {
        if (!isChatRef(chatId)) throw new BridgeError("VALIDATION_FAILED", "A chat id is a whole number such as 123456789 (a group's id starts with -).", { errors: [{ path: "chatId", message: "not a chat id" }] });
        chat = { id: String(chatId), name: name || "Chat", type: String(chatId).startsWith("-") ? "group" : "private", commands };
      }
      const entry = await store.addChat(t.id, chat);
      if (ref) candidates.delete(ref);
      return { key: entry.key, name: entry.name, type: entry.type, idHint: maskId(entry.id), commands: entry.commands };
    },
    async removeChat(id, key) {
      await getTarget(id);
      await store.removeChat(id, key);
      outbox.removeFor(id, key);
    },
    async setChatCommands(id, key, on) {
      await getTarget(id);
      const c = await store.setChatCommands(id, key, on);
      return { key: c.key, name: c.name, type: c.type, idHint: maskId(c.id), commands: c.commands };
    },
    /** Send a test message to every chat of the target (or one) and say what happened, in plain words. */
    async testTarget(id, { chatKey } = {}) {
      const t = await getTarget(id);
      const chats = chatKey ? t.chats.filter((c) => c.key === chatKey) : t.chats;
      if (!chats.length) return { ok: false, delivered: 0, results: [], message: "No chat is set up yet. Send your bot a message, then press Find my chat." };
      const results = [];
      for (const c of chats) {
        const wait = (blockedUntil.get(t.id) ?? 0) - now();
        if (wait > 0) {
          results.push({ chat: { key: c.key, name: c.name, idHint: maskId(c.id) }, ok: false, error: { kind: "rate_limited", message: PLAIN.rate_limited, retryAfterSeconds: Math.ceil(wait / SECOND) } });
          continue;
        }
        const r = await sendNow(t, c, msg.TEST_MESSAGE);
        if (r.ok) results.push({ chat: { key: c.key, name: c.name, idHint: maskId(c.id) }, ok: true });
        else {
          if (r.error.kind === "migrated" && r.error.migrateTo) await store.migrateChat(t.id, c.key, r.error.migrateTo);
          results.push({ chat: { key: c.key, name: c.name, idHint: maskId(c.id) }, ok: false, error: { kind: r.error.kind, message: PLAIN[r.error.kind] ?? PLAIN.unknown, ...(r.error.retryAfterSeconds ? { retryAfterSeconds: r.error.retryAfterSeconds } : {}) } });
        }
      }
      const delivered = results.filter((r) => r.ok).length;
      try {
        await deps.audit?.append?.({ type: "notify.test", actor: { kind: "local", id: "dashboard" }, source: "rest", data: { targetId: id, delivered, chats: results.length } });
      } catch {
        /* the audit log is optional here */
      }
      return { ok: delivered === results.length, delivered, results, message: delivered === results.length ? "Delivered." : results.find((r) => !r.ok)?.error?.message };
    },

    // lifecycle and test hooks
    pump,
    pollOnce: async (id, o) => pollOnce(await getTarget(id), o),
    async start() {
      if (running || !store) return;
      running = true;
      subscribe();
      arm();
      // An unreadable secrets file must not stop the Bridge: Telegram stays off until it is fixed, and the rest runs.
      try {
        await syncPollers();
      } catch (err) {
        log.warn("Telegram is off: the saved bot settings could not be read", { err: err?.message });
      }
      void pump();
    },
    async stop() {
      running = false;
      for (const off of offs.splice(0)) off();
      if (timer) clearTimer(timer);
      for (const [, p] of pollers) p.abort.abort();
      await Promise.all([...pollers.values()].map((p) => p.done.catch(() => {})));
      pollers.clear();
    },
    /** Subscribe to the bus without timers or polling (tests). */
    subscribe,
    outbox: { list: () => outbox.list(), stats: () => outbox.stats() },
    commands,
    reader,
  };

  return api;
}

export { chatKeyOf };
