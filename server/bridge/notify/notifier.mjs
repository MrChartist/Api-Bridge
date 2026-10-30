/**
 * Notifier — stream S15. Listens on the event bus and delivers chosen events to Telegram, Discord, Slack or any
 * webhook. Each target has its own bounded queue, sends one message at a time (spaced by minIntervalMs), times out,
 * and retries network errors, 429 and 5xx with back-off (Retry-After honoured) up to maxRetries. A full queue drops
 * the oldest message and counts it. Delivery never blocks or fails the code that emitted the event.
 *
 * Nothing secret is logged or returned by status(): tokens and webhook URLs come from environment variables and only
 * whether they are set is reported.
 */
import { sign } from "../auth/hmac.mjs";
import { formatEvent } from "./format.mjs";
import { parseNotifyConfig } from "./config.mjs";

const DEFAULT_INTERVAL = { telegram: 1100, discord: 500, slack: 1000, webhook: 0 };
const RETRYABLE = (status) => status === 429 || status >= 500;

/**
 * @param {{ config: object, bus: object, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch,
 *   clock?: { now(): number }, logger?: object, sleep?: (ms: number) => Promise<void> }} deps
 */
export function createNotifier(deps) {
  const cfg = parseNotifyConfig(deps.config?.notify);
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = () => (deps.clock ? deps.clock.now() : Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.logger?.child ? deps.logger.child({ module: "notify" }) : deps.logger;
  const demo = deps.config?.demo === true;
  const offs = [];
  let stopped = false;

  const targets = cfg.targets
    .filter((t) => t.enabled)
    .map((t) => ({ t, queue: [], busy: false, lastSentAt: 0, sent: 0, failed: 0, dropped: 0, lastError: null, lastSentIso: null }));

  function secretOf(name) {
    const v = name ? env[name] : undefined;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  }

  /** The HTTP request for one message, or a reason it cannot be built. */
  function request(t, topic, payload) {
    const { title, text } = formatEvent(topic, payload);
    const line = text ? `${title}\n${text}` : title;
    if (t.kind === "telegram") {
      const token = secretOf(t.tokenEnv);
      if (!token) return { error: `${t.tokenEnv} is not set` };
      return { url: `https://api.telegram.org/bot${token}/sendMessage`, body: JSON.stringify({ chat_id: t.chatId, text: line, disable_web_page_preview: true }) };
    }
    if (t.kind === "discord" || t.kind === "slack") {
      const url = secretOf(t.urlEnv);
      if (!url || !/^https:\/\//i.test(url)) return { error: `${t.urlEnv} is not set to an https:// webhook URL` };
      return { url, body: JSON.stringify(t.kind === "discord" ? { content: line.slice(0, 1900) } : { text: line }) };
    }
    const url = t.url ?? secretOf(t.urlEnv);
    if (!url) return { error: `${t.urlEnv} is not set` };
    const body = JSON.stringify({ event: topic, title, text, at: new Date(now()).toISOString(), data: payload });
    const headers = {};
    const secret = secretOf(t.secretEnv);
    if (t.secretEnv && !secret) return { error: `${t.secretEnv} is not set` };
    if (secret) headers["X-MCB-Signature"] = sign(secret, Math.floor(now() / 1000), body);
    return { url, body, headers };
  }

  async function deliver(st, msg) {
    const t = st.t;
    const req = request(t, msg.topic, msg.payload);
    if (req.error) {
      st.failed += 1;
      st.lastError = { message: req.error, at: new Date(now()).toISOString() };
      return;
    }
    for (let attempt = 0; ; attempt += 1) {
      const gap = (t.minIntervalMs ?? DEFAULT_INTERVAL[t.kind]) - (now() - st.lastSentAt);
      if (gap > 0) await sleep(gap);
      let status = 0;
      let retryAfterMs = null;
      try {
        const res = await fetchImpl(req.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": "mrchartist-api-bridge", ...(req.headers ?? {}) },
          body: req.body,
          redirect: "error",
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        status = res.status;
        const ra = Number(res.headers?.get?.("retry-after"));
        if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.min(60_000, ra * 1000);
        await res.text().catch(() => "");
      } catch (err) {
        status = 0;
        st.lastError = { message: `could not reach ${t.kind} (${err?.name === "TimeoutError" ? "timed out" : err?.cause?.code ?? "network error"})`, at: new Date(now()).toISOString() };
      }
      st.lastSentAt = now();
      if (status >= 200 && status < 300) {
        st.sent += 1;
        st.lastSentIso = new Date(now()).toISOString();
        return;
      }
      if (status) st.lastError = { message: `${t.kind} answered HTTP ${status}`, at: new Date(now()).toISOString() };
      if ((status && !RETRYABLE(status)) || attempt >= cfg.maxRetries || stopped) {
        st.failed += 1;
        log?.warn?.("notification not delivered", { target: t.id, kind: t.kind, status });
        return;
      }
      await sleep(retryAfterMs ?? 1000 * 2 ** attempt);
    }
  }

  async function pump(st) {
    if (st.busy) return;
    st.busy = true;
    try {
      while (st.queue.length && !stopped) await deliver(st, st.queue.shift());
    } finally {
      st.busy = false;
    }
  }

  function enqueue(st, topic, payload) {
    if (st.queue.length >= cfg.queueSize) {
      st.queue.shift();
      st.dropped += 1;
    }
    st.queue.push({ topic, payload });
    pump(st).catch((err) => log?.error?.("notify pump failed", { err }));
  }

  /** Whether this target wants this event. */
  function wants(t, topic, p) {
    if (!t.events.includes(topic)) return false;
    if (topic === "order.updated") return t.orderModes.includes(p?.mode) && t.orderStatuses.includes(p?.status);
    if (topic === "scan.completed") return Boolean(p?.savedId);
    if (topic === "account.status") return p?.session === "expired" || p?.session === "error";
    if (topic === "limits.throttled") return p?.upstream === true;
    // The readiness monitor decides (dedupe, cooldown, warn is never pushed); every change still goes on the bus.
    if (topic === "trading.readiness") return p?.notify === true;
    // Position alerts: only rules that ask to be sent ("Also send to my notification channels").
    if (topic === "option.alert") return p?.notify === true;
    return true;
  }

  function onEvent(topic) {
    return (payload) => {
      if (stopped) return;
      const { keyId: _k, ...clean } = payload ?? {};
      for (const st of targets) if (wants(st.t, topic, clean)) enqueue(st, topic, clean);
    };
  }

  return {
    start() {
      if (demo || offs.length) return;
      const topics = new Set(targets.flatMap((s) => s.t.events));
      for (const topic of topics) offs.push(deps.bus.on(topic, onEvent(topic)));
    },
    stop() {
      stopped = true;
      for (const off of offs.splice(0)) off();
    },
    /** Send a test message to one target (or all); resolves when delivered or given up. */
    async test(targetId) {
      const chosen = targetId ? targets.filter((s) => s.t.id === targetId) : targets;
      for (const st of chosen) enqueue(st, "test", {});
      await Promise.all(chosen.map(async (st) => {
        while (st.queue.length || st.busy) await new Promise((r) => setTimeout(r, 20));
      }));
      return this.status().targets.filter((x) => chosen.some((s) => s.t.id === x.id));
    },
    has: (id) => targets.some((s) => s.t.id === id),
    status() {
      return {
        demo,
        active: !demo && offs.length > 0,
        targets: targets.map((s) => ({
          id: s.t.id,
          kind: s.t.kind,
          events: s.t.events,
          configured: !request(s.t, "test", {}).error,
          problem: request(s.t, "test", {}).error ?? null,
          queued: s.queue.length,
          sent: s.sent,
          failed: s.failed,
          dropped: s.dropped,
          lastSentAt: s.lastSentIso,
          lastError: s.lastError,
        })),
      };
    },
  };
}
