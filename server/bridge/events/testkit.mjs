/**
 * Test helpers for the events module: a fake clock, a fake HTTP receiver behind an injected transport (no socket is ever
 * opened), a fake DNS, and a builder for a webhook service on a temp folder. Not shipped behaviour: only tests import it.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeSecretStore } from "../auth/fake.mjs";
import { createLogger } from "../core/logger.mjs";
import { EVENTS_CONFIG_SCHEMA } from "./config.mjs";
import { createEventLog } from "./eventLog.mjs";
import { createSender } from "./sender.mjs";
import { verifySignature } from "./signature.mjs";
import { createWebhookService } from "./webhooks.mjs";

/** Monday 9 Nov 2026, 09:30 IST. */
export const T0 = Date.parse("2026-11-09T04:00:00Z");
export const SECRET = "whsec_test_0123456789abcdef0123456789abcdef";
export const URL_OK = "https://hooks.example.test/in/abc123";

export function createClock(start = T0) {
  let t = start;
  return { now: () => t, set: (v) => (t = v), advance: (ms) => (t += ms) };
}

export const tmpDir = (prefix = "mcb-events-") => mkdtempSync(join(tmpdir(), prefix));

/**
 * A fake receiver. `transport` has the real transport's shape; `script(...)` decides the next answers (default 200).
 * Every call is recorded, including the address the sender pinned and whether the signature verifies with `secret`.
 */
export function createFakeReceiver({ clock = createClock(), secret = SECRET } = {}) {
  /** @type {Array<{ url: string, address: string, family: number, headers: Record<string, string>, body: string, signatureOk: boolean, at: number }>} */
  const calls = [];
  const scripted = [];
  const api = {
    calls,
    secret,
    /** The next `times` calls answer like this. status: HTTP status; throws: an error code (ETIMEDOUT, ECONNREFUSED ...). */
    script({ status = 200, times = 1, retryAfter = null, hasLocation = false, throws } = {}) {
      scripted.push({ status, times, retryAfter, hasLocation, throws });
      return api;
    },
    /** Answer every call this way from now on (after the scripted ones). */
    always(spec) {
      api.fallback = { status: 200, retryAfter: null, hasLocation: false, ...spec };
      return api;
    },
    fallback: { status: 200, retryAfter: null, hasLocation: false },
    bodies: () => calls.map((c) => JSON.parse(c.body)),
    async transport(req) {
      const verdict = verifySignature({ secret: api.secret, timestamp: req.headers["X-Bridge-Timestamp"], signature: req.headers["X-Bridge-Signature"], body: req.body, nowMs: clock.now() });
      calls.push({ url: req.url.href, address: req.address, family: req.family, headers: { ...req.headers }, body: req.body, signatureOk: verdict.ok, at: clock.now() });
      const s = scripted.find((x) => x.times > 0);
      const spec = s ?? api.fallback;
      if (s) s.times -= 1;
      if (spec.throws) throw Object.assign(new Error(`fake ${spec.throws}`), { code: spec.throws });
      return { status: spec.status, retryAfter: spec.retryAfter ?? null, hasLocation: Boolean(spec.hasLocation) };
    },
  };
  return api;
}

/** A DNS fake: names map to address lists; unknown names fail. */
export function createFakeDns(map = {}) {
  const table = new Map(Object.entries(map));
  const lookups = [];
  const resolve = async (host) => {
    lookups.push(host);
    const v = table.get(host);
    if (!v) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return v.map((a) => (typeof a === "string" ? { address: a, family: a.includes(":") ? 6 : 4 } : a));
  };
  return { resolve, lookups, set: (host, addrs) => table.set(host, addrs), delete: (host) => table.delete(host) };
}

/** Documentation ranges (203.0.113.0/24 ...) count as reserved, so the tests' "public" hosts use ordinary public addresses. */
export const publicDns = () => createFakeDns({ "hooks.example.test": ["93.184.216.34"], "other.example.test": ["151.101.1.69"], "second.example.test": ["8.8.4.4"] });

export function eventsConfigFor(overrides = {}) {
  return EVENTS_CONFIG_SCHEMA.parse(overrides);
}

/** A webhook service on a temp folder with a fake clock, receiver, DNS and secrets store. */
export function bootWebhooks({ dir = tmpDir(), clock = createClock(), config = {}, receiver, dns = publicDns(), secrets, random = () => 0.5, logLines = [], timers = true } = {}) {
  const cfg = eventsConfigFor(config);
  const logger = createLogger({ level: "debug", write: (l) => logLines.push(l) });
  const rx = receiver ?? createFakeReceiver({ clock });
  const store = secrets ?? createFakeSecretStore({ logger });
  const sender = createSender({
    policy: () => ({ allowPrivateTargets: cfg.webhooks.allowPrivateTargets, allowedHosts: cfg.webhooks.allowedHosts, timeoutMs: cfg.webhooks.timeoutMs, maxResponseBytes: cfg.webhooks.maxResponseBytes }),
    transport: rx.transport,
    resolve: dns.resolve,
    now: clock.now,
  });
  const scheduled = [];
  const setTimer = timers ? (fn, ms) => (scheduled.push({ fn, ms }), { unref() {} }) : undefined;
  const svc = createWebhookService({ cfg, dir, secrets: store, sender, logger, now: clock.now, random, ...(timers ? { setTimer, clearTimer: () => {} } : {}) });
  const eventLog = createEventLog({ dir: join(dir, "log"), retain: cfg.retain, now: clock.now, logger });
  eventLog.subscribe((e) => svc.offer(e));
  return { svc, cfg, clock, receiver: rx, dns, secrets: store, eventLog, dir, logLines, scheduled, logger };
}
