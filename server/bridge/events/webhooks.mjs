/**
 * Webhook subscriptions and their delivery.
 *
 *   event (from the event log)  ->  one outbox item per matching subscription (durable, written to disk first)
 *   pump: due items, at most `concurrency` at once  ->  sender.mjs (signed, checked, no redirects)
 *     2xx         delivered: the item leaves the outbox
 *     retryable   (5xx, 408, 425, 429, timeout, no connection): waits, doubling from baseMs up to maxMs with jitter
 *                 (a Retry-After longer than that is honoured, up to maxMs); after maxAttempts or maxAgeSec it becomes a
 *                 dead letter
 *     permanent   (other 4xx, a redirect, a refused target): a dead letter at once
 *   dead letters stay listed (bounded) and can be sent again by hand; every attempt is written to the delivery log.
 *
 * Delivery is at least once: an attempt that was in flight when the Bridge stopped is sent again after the restart, so
 * a receiver de-duplicates on the event id (`X-Bridge-Event-Id`, also `id` in the body). Order is by event id, not
 * guaranteed on the wire when a retry overtakes a newer event.
 *
 * Where things are kept: dataDir/events/{subscriptions,outbox,deadletter,deliveries}.jsonl (journal.mjs). The URL and
 * the signing secret are NOT in those files: they are one encrypted entry per subscription in the secrets store
 * ("subscription:<id>"), so a backup of the data folder carries no webhook secret. The secret is write-only: no route,
 * log line, audit record or delivery record contains it.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { BridgeError } from "../core/errors.mjs";
import { TEST_TOPIC, canSee, checkTopicPatterns, matchesAny } from "./catalog.mjs";
import { toEnvelope } from "./eventLog.mjs";
import { createJournal } from "./journal.mjs";
import { FAILURE_TEXT } from "./sender.mjs";
import { HEADERS } from "./signature.mjs";
import { checkTargetUrl, displayTarget } from "./urlPolicy.mjs";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export const SUBSCRIPTION_ID_RE = /^sub_[a-z2-7]{8}$/;
export const DELIVERY_ID_RE = /^dlv_[0-9a-f]{12}$/;
const SECRET_PREFIX = "subscription:";
const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const ADMIN_ALL = { admin: true, accounts: "*" };
const TEST_MIN_GAP_MS = 2000;

const newSubId = () => `sub_${[...randomBytes(8)].map((b) => B32[b % 32]).join("")}`;
const newDeliveryId = () => `dlv_${randomBytes(6).toString("hex")}`;

/** Delay before attempt number `attempts + 1`, after `attempts` failures. Exported for tests. */
export function backoffMs(attempts, { baseMs, maxMs, jitter }, random = Math.random) {
  const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempts - 1));
  return Math.max(0, Math.round(raw * (1 + (random() * 2 - 1) * jitter)));
}

/**
 * @param {{ cfg: ReturnType<typeof import("./config.mjs").eventsConfig>, dir: string, secrets: any, sender: { send: Function },
 *   logger: any, now?: () => number, random?: () => number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} deps
 */
export function createWebhookService({ cfg, dir, secrets, sender, logger, now = () => Date.now(), random = Math.random, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const w = cfg.webhooks;
  const subs = createJournal({ file: join(dir, "subscriptions.jsonl"), logger });
  const outbox = createJournal({ file: join(dir, "outbox.jsonl"), logger });
  const dead = createJournal({ file: join(dir, "deadletter.jsonl"), logger });
  const deliveries = createJournal({ file: join(dir, "deliveries.jsonl"), logger });
  const inflight = new Set();
  /** @type {Map<string, { url: string, secret: string }>} */
  const creds = new Map();
  let logSeq = deliveries.list().reduce((m, r) => Math.max(m, Number(String(r.id).slice(4)) || 0), 0);
  let timer = null;
  let stopped = false;
  const lastTest = new Map();

  // A secret and a URL that were saved before this start must be masked in every log line from the first one.
  const remember = (id, c) => {
    creds.set(id, c);
    logger.addSecret?.(c.secret);
    logger.addSecret?.(c.url);
  };

  async function credsOf(id) {
    const hit = creds.get(id);
    if (hit) return hit;
    const v = await secrets.get(`${SECRET_PREFIX}${id}`);
    if (!v || typeof v.url !== "string" || typeof v.secret !== "string") return null;
    remember(id, { url: v.url, secret: v.secret });
    return creds.get(id);
  }

  // ── what a person sees ──
  function publicView(s) {
    const pending = outbox.list().filter((i) => i.subId === s.id).length;
    const deadN = dead.list().filter((i) => i.subId === s.id).length;
    return {
      id: s.id,
      label: s.label ?? null,
      target: s.target,
      host: s.host,
      topics: s.topics,
      accounts: s.accounts,
      active: s.active,
      signing: { algorithm: "hmac-sha256", version: "v1", replayWindowSec: w.replayWindowSec },
      createdAt: new Date(s.createdAt).toISOString(),
      updatedAt: new Date(s.updatedAt).toISOString(),
      health: {
        state: !s.active ? "paused" : s.consecutiveFailures >= 3 ? "failing" : s.lastDeliveredAt || s.lastTestOkAt ? "ok" : "unverified",
        delivered: s.delivered ?? 0,
        failed: s.failed ?? 0,
        deadLettered: s.deadLettered ?? 0,
        consecutiveFailures: s.consecutiveFailures ?? 0,
        lastDeliveredAt: s.lastDeliveredAt ? new Date(s.lastDeliveredAt).toISOString() : null,
        lastFailureAt: s.lastFailureAt ? new Date(s.lastFailureAt).toISOString() : null,
        lastFailure: s.lastFailureCode ? { code: s.lastFailureCode, status: s.lastFailureStatus ?? null, message: FAILURE_TEXT[s.lastFailureCode] ?? "The delivery failed." } : null,
      },
      pending,
      deadLetters: deadN,
    };
  }
  const mustGet = (id) => {
    const s = SUBSCRIPTION_ID_RE.test(String(id)) ? subs.get(id) : null;
    if (!s) throw new BridgeError("NOT_FOUND", "No webhook subscription with this id.");
    return s;
  };
  const invalid = (path, message) => new BridgeError("VALIDATION_FAILED", message, { errors: [{ path, message }] });

  // ── validation shared by create and update ──
  function checkUrl(raw) {
    const r = checkTargetUrl(raw, { allowPrivateTargets: w.allowPrivateTargets, allowedHosts: w.allowedHosts });
    if (!r.ok) throw invalid("url", r.message);
    return r;
  }
  function checkTopics(raw) {
    const r = checkTopicPatterns(raw);
    if (!r.ok) throw invalid("topics", r.message);
    return r.patterns;
  }
  function checkSecret(raw) {
    if (typeof raw !== "string" || raw.length < 16 || raw.length > 256 || /[\u0000-\u001f\u007f]/.test(raw)) throw invalid("secret", "The signing secret must be 16 to 256 characters (a long random string: openssl rand -hex 32).");
    return raw;
  }
  function checkAccounts(raw) {
    if (raw === undefined || raw === "*") return "*";
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100 || !raw.every((a) => typeof a === "string" && ACCOUNT_ID_RE.test(a))) throw invalid("accounts", 'accounts must be "*" or a list of account ids.');
    return [...new Set(raw)];
  }
  const checkLabel = (raw) => {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string" || raw.length > 60) throw invalid("label", "label is at most 60 characters.");
    return raw.trim() || null;
  };

  // ── subscriptions ──
  const api = {
    enabled: w.enabled,

    list: () => subs.list().map(publicView),
    get: (id) => publicView(mustGet(id)),

    async create({ url, topics, secret, active = true, label, accounts }) {
      if (!w.enabled) throw new BridgeError("CAPABILITY_UNSUPPORTED", "Webhooks are switched off (events.webhooks.enabled in the config file).");
      if (subs.size() >= w.maxSubscriptions) throw new BridgeError("VALIDATION_FAILED", `There are already ${w.maxSubscriptions} webhook subscriptions (events.webhooks.maxSubscriptions). Remove one first.`);
      const target = checkUrl(url);
      const patterns = checkTopics(topics);
      checkSecret(secret);
      const acc = checkAccounts(accounts);
      const lbl = checkLabel(label);
      let id = newSubId();
      while (subs.get(id)) id = newSubId();
      await secrets.set(`${SECRET_PREFIX}${id}`, { url: target.url.href, secret });
      remember(id, { url: target.url.href, secret });
      const t = now();
      subs.put({ id, label: lbl, target: displayTarget(target.url), host: target.url.host, topics: patterns, accounts: acc, active: Boolean(active), createdAt: t, updatedAt: t, delivered: 0, failed: 0, deadLettered: 0, consecutiveFailures: 0 });
      schedule();
      return publicView(subs.get(id));
    },

    async update(id, patch) {
      const cur = mustGet(id);
      const next = { updatedAt: now() };
      let nextCreds = null;
      if (patch.url !== undefined) {
        const target = checkUrl(patch.url);
        const c = await credsOf(id);
        if (!c && patch.secret === undefined) throw invalid("secret", "The stored signing secret for this subscription is missing. Send the secret again together with the url.");
        nextCreds = { secret: "", ...(c ?? {}), url: target.url.href };
        Object.assign(next, { target: displayTarget(target.url), host: target.url.host });
      }
      if (patch.secret !== undefined) {
        const base = nextCreds ?? (await credsOf(id));
        if (!base) throw invalid("url", "The stored target for this subscription is missing. Send the url again together with the secret.");
        nextCreds = { ...base, secret: checkSecret(patch.secret) };
      }
      if (patch.topics !== undefined) next.topics = checkTopics(patch.topics);
      if (patch.accounts !== undefined) next.accounts = checkAccounts(patch.accounts);
      if (patch.active !== undefined) next.active = Boolean(patch.active);
      if (patch.label !== undefined) next.label = checkLabel(patch.label);
      if (nextCreds) {
        await secrets.set(`${SECRET_PREFIX}${id}`, { url: nextCreds.url, secret: nextCreds.secret });
        remember(id, nextCreds);
        next.consecutiveFailures = 0;
      }
      if (patch.active === true && !cur.active) next.consecutiveFailures = 0;
      subs.patch(id, next);
      schedule();
      return publicView(subs.get(id));
    },

    async remove(id) {
      mustGet(id);
      subs.delete(id);
      for (const i of outbox.list()) if (i.subId === id) outbox.delete(i.id);
      for (const i of dead.list()) if (i.subId === id) dead.delete(i.id);
      for (const i of deliveries.list()) if (i.subId === id) deliveries.delete(i.id);
      creds.delete(id);
      lastTest.delete(id);
      try {
        await secrets.delete(`${SECRET_PREFIX}${id}`);
      } catch (err) {
        logger.warn?.("a webhook's stored secret could not be deleted", { subscriptionId: id, code: err?.code });
      }
    },

    // ── delivery log and dead letters ──
    deliveries(id, { limit = 100, outcome } = {}) {
      mustGet(id);
      const rows = deliveries.list().filter((r) => r.subId === id && (!outcome || r.outcome === outcome));
      return rows.slice(-limit).reverse().map(logView);
    },
    deadLetters(id) {
      mustGet(id);
      return dead.list().filter((r) => r.subId === id).reverse().map(deadView);
    },
    async retryDead(id, deliveryId) {
      mustGet(id);
      const d = DELIVERY_ID_RE.test(String(deliveryId)) ? dead.get(deliveryId) : null;
      if (!d || d.subId !== id) throw new BridgeError("NOT_FOUND", "No dead letter with this id on this subscription.");
      dead.delete(deliveryId);
      outbox.put({ id: d.id, subId: id, eventId: d.eventId, topic: d.topic, body: d.body, createdAt: now(), firstAt: now(), attempts: 0, nextAttemptAt: now() });
      schedule();
      return { id: d.id, status: "queued" };
    },
    clearDead(id) {
      mustGet(id);
      let n = 0;
      for (const d of dead.list()) if (d.subId === id && dead.delete(d.id)) n += 1;
      return { removed: n };
    },

    /** One attempt now, to check the URL, the secret and the receiver's check. Not queued, not retried. */
    async test(id) {
      const s = mustGet(id);
      const t = now();
      const last = lastTest.get(id);
      if (last !== undefined && t - last < TEST_MIN_GAP_MS) throw new BridgeError("RATE_LIMITED", "Wait a couple of seconds between test sends.", { retryAfterMs: TEST_MIN_GAP_MS - (t - last) });
      lastTest.set(id, t);
      const c = await credsOf(id);
      if (!c) throw new BridgeError("STATE_CONFLICT", "The signing secret for this subscription is missing from the secrets store. Set it again with PATCH.");
      const deliveryId = newDeliveryId();
      const body = JSON.stringify({ id: "test", topic: TEST_TOPIC, time: new Date(t).toISOString(), apiVersion: "v1", data: { message: "This is a test from the Bridge. No real event happened.", subscriptionId: id } });
      const r = await sender.send({ url: c.url, secret: c.secret, body, headers: headersFor({ eventId: "test", topic: TEST_TOPIC, deliveryId, attempt: 1 }) });
      record({ subId: id, deliveryId, eventId: "test", topic: TEST_TOPIC, attempt: 1, result: r, outcome: r.ok ? "delivered" : "failed", test: true });
      subs.patch(id, r.ok ? { lastTestOkAt: now() } : { lastTestFailedAt: now() });
      return { ok: r.ok, status: r.status ?? null, code: r.code ?? null, message: r.ok ? "The receiver accepted the test." : (FAILURE_TEXT[r.code] ?? "The test failed."), durationMs: r.durationMs, deliveryId, willRetry: false };
    },

    // ── feeding and running the outbox ──
    /** Called for every new event. Queues one delivery per matching, active subscription. */
    offer(evt) {
      if (!w.enabled || stopped) return;
      let body = null;
      for (const s of subs.list()) {
        if (!s.active || !matchesAny(s.topics, evt.topic)) continue;
        if (!canSee({ ...ADMIN_ALL, accounts: s.accounts === "*" ? "*" : new Set(s.accounts) }, evt)) continue;
        body ??= JSON.stringify(toEnvelope(evt));
        const pending = outbox.list().filter((i) => i.subId === s.id);
        if (pending.length >= w.maxPendingPerSubscription) moveToDead(pending[0], "overflow");
        const id = newDeliveryId();
        const t = now();
        outbox.put({ id, subId: s.id, eventId: String(evt.seq), topic: evt.topic, body, createdAt: t, firstAt: t, attempts: 0, nextAttemptAt: t });
      }
      if (body) schedule();
    },

    /** Start every due delivery (up to the concurrency limit). Resolves when those attempts are done. */
    async pump() {
      if (stopped) return;
      const t = now();
      const free = w.concurrency - inflight.size;
      if (free <= 0) return;
      const subActive = new Map(subs.list().map((s) => [s.id, s.active]));
      const due = outbox
        .list()
        .filter((i) => !inflight.has(i.id) && i.nextAttemptAt <= t && subActive.get(i.subId) === true)
        .slice(0, free);
      const runs = due.map((item) => {
        inflight.add(item.id);
        return attempt(item).finally(() => inflight.delete(item.id));
      });
      await Promise.all(runs);
      schedule();
    },

    start() {
      stopped = false;
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },

    status() {
      const items = outbox.list();
      const subList = subs.list();
      return {
        enabled: w.enabled,
        subscriptions: subList.length,
        active: subList.filter((s) => s.active).length,
        pending: items.length,
        inflight: inflight.size,
        deadLetters: dead.size(),
        oldestPendingAt: items.length ? new Date(Math.min(...items.map((i) => i.createdAt))).toISOString() : null,
        allowPrivateTargets: w.allowPrivateTargets,
        storageErrors: outbox.writeErrors() + subs.writeErrors() + dead.writeErrors() + deliveries.writeErrors(),
      };
    },
    /** For tests: the outbox as stored (bodies included). */
    _outbox: () => outbox.list(),
  };

  // ── internals ──
  function headersFor({ eventId, topic, deliveryId, attempt }) {
    return { [HEADERS.eventId]: eventId, [HEADERS.topic]: topic, [HEADERS.delivery]: deliveryId, [HEADERS.attempt]: String(attempt) };
  }

  function logView(r) {
    return {
      id: r.id,
      deliveryId: r.deliveryId,
      eventId: r.eventId,
      topic: r.topic,
      attempt: r.attempt,
      at: new Date(r.at).toISOString(),
      outcome: r.outcome,
      ok: r.ok,
      status: r.status ?? null,
      code: r.code ?? null,
      message: r.ok ? null : (FAILURE_TEXT[r.code] ?? "The delivery failed."),
      durationMs: r.durationMs ?? null,
      nextAttemptAt: r.nextAttemptAt ? new Date(r.nextAttemptAt).toISOString() : null,
      test: r.test === true,
    };
  }
  function deadView(d) {
    return {
      id: d.id,
      eventId: d.eventId,
      topic: d.topic,
      attempts: d.attempts,
      createdAt: new Date(d.createdAt).toISOString(),
      deadAt: new Date(d.deadAt).toISOString(),
      reason: d.reason,
      status: d.lastStatus ?? null,
      message: FAILURE_TEXT[d.reason] ?? (d.reason === "overflow" ? "The queue for this subscription was full, so the oldest event was set aside." : d.reason === "expired" ? "The event was too old to deliver any more." : d.reason === "no_credentials" ? "The signing secret is missing." : "The delivery failed."),
    };
  }

  function record({ subId, deliveryId, eventId, topic, attempt, result, outcome, nextAttemptAt, test = false }) {
    logSeq += 1;
    const rec = { id: `log_${logSeq}`, subId, deliveryId, eventId, topic, attempt, at: now(), outcome, ok: Boolean(result?.ok), status: result?.status, code: result?.code, durationMs: result?.durationMs, nextAttemptAt, test };
    deliveries.put(rec);
    // Keep the log to its bound: drop the oldest rows.
    const all = deliveries.list();
    for (let i = 0; i < all.length - w.deliveryLogMax; i += 1) deliveries.delete(all[i].id);
  }

  function moveToDead(item, reason, lastStatus) {
    outbox.delete(item.id);
    dead.put({ id: item.id, subId: item.subId, eventId: item.eventId, topic: item.topic, body: item.body, createdAt: item.createdAt, deadAt: now(), attempts: item.attempts, reason, lastStatus });
    const all = dead.list();
    for (let i = 0; i < all.length - w.deadLetterMax; i += 1) dead.delete(all[i].id);
    const s = subs.get(item.subId);
    if (s) subs.patch(item.subId, { deadLettered: (s.deadLettered ?? 0) + 1 });
  }

  async function attempt(item) {
    const s = subs.get(item.subId);
    if (!s) {
      outbox.delete(item.id);
      return;
    }
    const c = await credsOf(item.subId).catch(() => null);
    const n = item.attempts + 1;
    if (!c) {
      record({ subId: item.subId, deliveryId: item.id, eventId: item.eventId, topic: item.topic, attempt: n, result: { ok: false, code: "request_failed" }, outcome: "dead" });
      moveToDead({ ...item, attempts: n }, "no_credentials");
      return;
    }
    const r = await sender.send({ url: c.url, secret: c.secret, body: item.body, headers: headersFor({ eventId: item.eventId, topic: item.topic, deliveryId: item.id, attempt: n }) });
    if (!subs.get(item.subId)) return; // removed while the call was running
    if (r.ok) {
      outbox.delete(item.id);
      record({ subId: item.subId, deliveryId: item.id, eventId: item.eventId, topic: item.topic, attempt: n, result: r, outcome: "delivered" });
      subs.patch(item.subId, { delivered: (subs.get(item.subId).delivered ?? 0) + 1, lastDeliveredAt: now(), consecutiveFailures: 0 });
      return;
    }
    const t = now();
    const failure = { failed: (subs.get(item.subId).failed ?? 0) + 1, lastFailureAt: t, lastFailureCode: r.code, lastFailureStatus: r.status ?? null, consecutiveFailures: (subs.get(item.subId).consecutiveFailures ?? 0) + 1 };
    subs.patch(item.subId, failure);
    const tooOld = t - item.firstAt > w.retry.maxAgeSec * 1000;
    if (!r.retryable || n >= w.retry.maxAttempts || tooOld) {
      record({ subId: item.subId, deliveryId: item.id, eventId: item.eventId, topic: item.topic, attempt: n, result: r, outcome: "dead" });
      moveToDead({ ...item, attempts: n }, !r.retryable ? r.code : tooOld && n < w.retry.maxAttempts ? "expired" : r.code, r.status);
      return;
    }
    const wait = Math.max(backoffMs(n, w.retry, random), Math.min(r.retryAfterMs ?? 0, w.retry.maxMs));
    const nextAttemptAt = t + wait;
    outbox.patch(item.id, { attempts: n, nextAttemptAt });
    record({ subId: item.subId, deliveryId: item.id, eventId: item.eventId, topic: item.topic, attempt: n, result: r, outcome: "retry", nextAttemptAt });
  }

  function schedule() {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = null;
    const active = new Set(subs.list().filter((s) => s.active).map((s) => s.id));
    let next = Infinity;
    for (const i of outbox.list()) if (!inflight.has(i.id) && active.has(i.subId)) next = Math.min(next, i.nextAttemptAt);
    if (next === Infinity) return;
    const delay = Math.min(Math.max(0, next - now()), 2_147_000_000);
    timer = setTimer(() => {
      timer = null;
      api.pump().catch((err) => logger.error?.("webhook delivery failed unexpectedly", { code: err?.code }));
    }, delay);
    timer.unref?.();
  }

  return api;
}
