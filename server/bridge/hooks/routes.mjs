/**
 * Webhook routes — stream S11 (docs/openapi.yaml, tag "Webhooks").
 *
 *   POST   /hooks/{source}/{token}   public ingress allowed, auth "custom": the URL token (and for generic hooks the
 *                                    HMAC signature) is the credential. Answers 202 in milliseconds.
 *   GET    /v1/hooks                 admin, this computer only. Never shows tokens. An account-limited admin key sees, and
 *                                    can delete, only the hooks of its own accounts.
 *   POST   /v1/hooks                 admin, this computer only. 201 with the URL (token) and signing secret ONCE.
 *   DELETE /v1/hooks/{hookId}        admin, this computer only. The URL stops working at once.
 *
 * Receiver order of checks (cheapest and most selective first; every refusal is generic so it reveals nothing):
 *   source + token -> hook (404 for anything unknown) -> source-IP allowlist -> live hook whose creating key was
 *   revoked (401) -> generic: failed-signature limit per source IP, HMAC + replay, THEN the per-hook rate (so
 *   someone who knows the URL but not the secret cannot use up the hook's budget); other sources: per-hook rate ->
 *   parse (400 on a malformed alert) -> dedupe -> bounded queue (429 when full) -> 202.
 *
 * Creating a LIVE hook (POST /v1/hooks with mode "live") needs, besides admin: the "live" scope on the creating key
 * (admin does not imply live; the local CLI is exempt), access to the hook's account, live enabled for that account
 * in the config with "webhook" in live.allowedSources, and, for sources that cannot sign their alerts (ChartInk,
 * GoCharting: the URL token is the only credential), at least one of allowSourceIps, requireConfirmation:
 * true, or an explicit acknowledgeUnsignedLive: true (audited and shown on the hook). The creating key id is kept on
 * the hook; when that key is revoked, the live hook stops accepting alerts.
 */
import { createHash, randomBytes } from "node:crypto";
import { verify as verifySignature, createReplayCache } from "../auth/hmac.mjs";
import { liveAllowedByConfig } from "../core/config.mjs";
import { isStub } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { json, noContent } from "../core/http.mjs";
import { isLoopbackAddress } from "../core/security.mjs";
import { expandIpList, ipAllowed } from "./config.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { HOOK_SOURCES, publicHook } from "./hookStore.mjs";
import { parseChartInk } from "./receivers/chartink.mjs";
import { parseGeneric } from "./receivers/generic.mjs";
import { parseGoCharting } from "./receivers/gocharting.mjs";
import { alertTemplates } from "./templates.mjs";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const IST_OFFSET_MS = 19_800_000;
const istDate = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
const HOOK_ID_RE = /^hk_[a-z2-7]{12}$/;

const PARSERS = Object.freeze({
  chartink: (body, meta) => parseChartInk(body, meta),
  gocharting: (body) => parseGoCharting(body),
  generic: (body) => parseGeneric(body),
});

const notFound = () => new BridgeError("NOT_FOUND", "No hook at this address.");
/** Failed signatures allowed per source address per minute on generic hooks. */
const FAILED_SIGNATURES_PER_MINUTE = 30;
/** A dated contract in allowedSymbols that expires within this many days gets a warning on create. */
const EXPIRY_WARN_DAYS = 7;

/**
 * Bounded "seen recently" map for alert-level dedupe.
 * @param {{ max?: number, now: () => number }} opts
 */
export function createDedupeMap({ max = 20_000, now }) {
  /** @type {Map<string, { signalId: string, expiresAt: number }>} */
  const m = new Map();
  return {
    get(key) {
      const e = m.get(key);
      if (!e) return null;
      if (e.expiresAt <= now()) {
        m.delete(key);
        return null;
      }
      return e;
    },
    set(key, signalId, ttlMs) {
      if (m.size >= max) {
        const t = now();
        for (const [k, e] of m) if (e.expiresAt <= t) m.delete(k);
        // receiveHook refuses new alerts while full (full()); this is only a backstop.
        while (m.size >= max) m.delete(m.keys().next().value);
      }
      m.set(key, { signalId, expiresAt: now() + ttlMs });
    },
    size: () => m.size,
    /** Full of unexpired entries (after dropping expired ones). */
    full() {
      if (m.size < max) return false;
      const t = now();
      for (const [k, e] of m) if (e.expiresAt <= t) m.delete(k);
      return m.size >= max;
    },
  };
}

/**
 * Sliding one-minute window per hook.
 * @param {{ now: () => number }} opts
 */
function createHookRateLimiter({ now }) {
  /** @type {Map<string, number[]>} */
  const hits = new Map();
  return {
    /** Would take() succeed? (Does not count.) @returns {{ ok: boolean, retryAfterMs: number }} */
    peek(hookId, perMinute) {
      const t = now();
      const arr = (hits.get(hookId) ?? []).filter((x) => x > t - 60_000);
      return arr.length >= perMinute ? { ok: false, retryAfterMs: Math.max(1, arr[0] + 60_000 - t) } : { ok: true, retryAfterMs: 0 };
    },
    /** @returns {{ ok: boolean, retryAfterMs: number }} */
    take(hookId, perMinute) {
      const t = now();
      const arr = (hits.get(hookId) ?? []).filter((x) => x > t - 60_000);
      if (arr.length >= perMinute) {
        hits.set(hookId, arr);
        return { ok: false, retryAfterMs: Math.max(1, arr[0] + 60_000 - t) };
      }
      arr.push(t);
      hits.set(hookId, arr);
      return { ok: true, retryAfterMs: 0 };
    },
  };
}

/**
 * @param {{ deps: any, cfg: ReturnType<typeof import("./config.mjs").hooksConfig>, store: any, worker: any, logger: any,
 *   now?: () => number }} opts
 */
export function createHookRoutes({ deps, cfg, store, worker, logger, now = () => Date.now(), automations = null }) {
  const dedupe = createDedupeMap({ now });
  // Sized for every hook signing at its full rate across the whole timestamp window (entries live about twice the
  // tolerance), so it only fills under abuse; when full it refuses new signatures (429) instead of evicting.
  const replayMax = Math.max(10_000, (cfg.maxSignalsPerMinute ?? 30) * (cfg.maxHooks ?? 100) * Math.ceil(((cfg.signatureToleranceS ?? 300) * 2 + 1) / 60));
  const replay = createReplayCache({ now, max: replayMax, onFull: "refuse" });
  const rate = createHookRateLimiter({ now });
  const failedSignatures = createHookRateLimiter({ now });
  const globalIps = expandIpList(cfg.allowSourceIps);

  const audit = async (ctx, type, accountId, data) => {
    if (!deps.audit || isStub(deps.audit)) return;
    await deps.audit.append({ type, actor: { kind: ctx.principal?.kind ?? "anonymous", id: ctx.principal?.id ?? "anonymous" }, source: ctx.source ?? "rest", accountId, requestId: ctx.requestId, data });
  };

  /** The address to check against allowlists: a trusted local tunnel's header, else the TCP peer. */
  const clientAddress = (ctx) => {
    const peer = ctx.clientIp ?? "";
    if (cfg.clientIpHeader && isLoopbackAddress(peer)) {
      const raw = ctx.req?.headers?.[cfg.clientIpHeader];
      const v = Array.isArray(raw) ? raw[raw.length - 1] : raw;
      if (typeof v === "string" && v.trim()) {
        // X-Forwarded-For: the right-most entry is the one our local proxy appended.
        const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
        return parts[parts.length - 1] ?? peer;
      }
    }
    return peer;
  };

  /** POST /hooks/{source}/{token} */
  async function receiveHook(ctx) {
    const receivedAt = now();
    const source = ctx.params.source;
    const token = ctx.params.token;
    if (!HOOK_SOURCES.includes(source) || typeof token !== "string") throw notFound();
    const hook = store.findByToken(token);
    if (!hook || hook.source !== source) throw notFound();
    // From here the token is known to be a live credential: mask it in every log line, including the access log.
    logger.addSecret?.(token);
    ctx.source = "webhook";
    ctx.principal = { kind: "hook", id: hook.id, label: hook.label };
    ctx.hookAccounts = [hook.account];

    const allow = [...globalIps, ...expandIpList(hook.allowSourceIps)];
    if (allow.length && !ipAllowed(clientAddress(ctx), allow)) {
      logger.warn("hook refused: source address not allowed", { hookId: hook.id });
      throw new BridgeError("UNAUTHENTICATED", "This hook does not accept alerts from this address.");
    }
    if (hook.mode === "live" && hook.createdByKeyId && deps.keyStore && !isStub(deps.keyStore)) {
      let creator = null;
      try {
        creator = await deps.keyStore.get(hook.createdByKeyId);
      } catch {
        creator = null;
      }
      if (!creator || creator.revokedAt) {
        logger.warn("hook refused: the key that created this live hook was revoked", { hookId: hook.id });
        throw new BridgeError("UNAUTHENTICATED", "This live hook was created with an API key that has since been revoked. Create the hook again.");
      }
    }

    const raw = Buffer.isBuffer(ctx.rawBody) ? ctx.rawBody : Buffer.from(typeof ctx.body === "string" ? ctx.body : JSON.stringify(ctx.body ?? ""), "utf8");
    if (source === "generic") {
      const addr = `ip:${clientAddress(ctx) || "unknown"}`;
      const tooMany = failedSignatures.peek(addr, FAILED_SIGNATURES_PER_MINUTE);
      if (!tooMany.ok) throw new BridgeError("RATE_LIMITED", "Too many requests with a bad signature from this address. Try again shortly.", { retryAfterMs: tooMany.retryAfterMs });
      const secret = await store.signingSecret(hook.id);
      const header = ctx.req?.headers?.["x-mcb-signature"];
      const v = verifySignature(Array.isArray(header) ? header[0] : header, secret, raw, { now: now(), toleranceS: cfg.signatureToleranceS, seen: replay });
      if (!v.ok) {
        if (v.reason === "replay_cache_full") {
          logger.warn("hook refused: replay cache full", { hookId: hook.id });
          throw new BridgeError("RATE_LIMITED", "The Bridge is receiving too many signed alerts. Try again shortly.", { retryAfterMs: 60_000 });
        }
        failedSignatures.take(addr, FAILED_SIGNATURES_PER_MINUTE);
        logger.warn("hook refused: bad signature", { hookId: hook.id, reason: v.reason });
        throw new BridgeError("UNAUTHENTICATED", "The request signature is missing, wrong, too old or was already used.");
      }
    }
    // Charged only after the signature check for generic hooks: junk requests cannot use up a hook's budget.
    const r = rate.take(hook.id, cfg.maxSignalsPerMinute);
    if (!r.ok) throw new BridgeError("RATE_LIMITED", "This hook is receiving too many alerts. Try again shortly.", { retryAfterMs: r.retryAfterMs });
    if (ctx.body === undefined || ctx.body === null || ctx.body === "") throw new BridgeError("VALIDATION_FAILED", "The alert is empty.");

    const parsed = PARSERS[source](ctx.body, { istDate: istDate(receivedAt) });
    if (parsed.signals.length === 0) throw new BridgeError("VALIDATION_FAILED", "The alert does not contain any order.");

    // Alert identity: the sender's own id + time when present, else the exact bytes (inside the dedupe window).
    const rawHash = sha256(raw);
    const basis = parsed.basis ?? `raw|${rawHash}`;
    const alertKey = sha256(`${hook.id}|${basis}`);
    const seen = dedupe.get(alertKey);
    if (seen) {
      logger.info("hook duplicate", { hookId: hook.id, signalId: seen.signalId });
      return json({ accepted: true, signalId: seen.signalId, duplicate: true }, { status: 202 });
    }
    // Fail closed: a full dedupe map would have to forget an alert that could then be sent twice.
    if (dedupe.full()) throw new BridgeError("RATE_LIMITED", "The Bridge is receiving too many alerts. Try again shortly.", { retryAfterMs: 30_000 });
    const signalId = `sig_${randomBytes(10).toString("base64url")}`;
    // Idempotency-Key per order. With a sender id it is stable for the IST day (OrderService keeps keys that long);
    // without one it includes the first-seen time, so a repeat of the same text hours later is a new order.
    const idemBase = parsed.basis ? `${hook.id}|${parsed.basis}` : `${hook.id}|raw|${rawHash}|${receivedAt}`;
    const jobs = parsed.signals.map((signal, index) => ({
      signalId,
      hookId: hook.id,
      index,
      signal,
      idempotencyKey: `hook:${hook.id}:${sha256(`${idemBase}|${signal.ref ?? ""}|${index}`).slice(0, 40)}`,
      receivedAt,
    }));
    worker.enqueue(jobs);
    dedupe.set(alertKey, signalId, cfg.dedupeWindowMs);
    store.touch(hook.id);
    const body = { accepted: true, signalId };
    if (parsed.dropped) body.dropped = parsed.dropped;
    return json(body, { status: 202 });
  }

  /** GET /v1/hooks */
  async function listHooks(ctx) {
    const mine = store.list().filter((h) => ctx.canAccessAccounts?.([h.account]) ?? true);
    return { data: mine.map((h) => ({ ...publicHook(h), readiness: automations?.state(h) ?? null, templates: alertTemplates(h) })), meta: { requestId: ctx.requestId } };
  }

  /** Refuse a live hook the caller may not create (see the file header). Throws; returns nothing. */
  function assertLiveHookAllowed(ctx, input) {
    const local = ctx.principal?.kind === "local";
    if (!local && !ctx.scopes?.has("live")) {
      throw new BridgeError("SCOPE_REQUIRED", 'A live hook places real orders, so creating one needs a key with the "live" scope as well as admin (admin alone does not allow live trading).');
    }
    if (typeof input.account === "string") ctx.requireAccountAccess(input.account);
    const acct = (deps.config?.accounts ?? []).find((a) => a.id === input.account);
    if (!acct || !liveAllowedByConfig(deps.config, acct)) {
      throw new BridgeError("PAPER_ONLY", `Live trading is not enabled for ${input.account} in the config file (accounts[].live.enabled), so a live hook cannot be created for it.`);
    }
    if (!acct.live?.allowedSources?.includes("webhook")) {
      throw new BridgeError("PAPER_ONLY", `Add "webhook" to accounts[].live.allowedSources for ${input.account} before creating a live hook.`);
    }
    if (input.source !== "generic") {
      const ips = Array.isArray(input.allowSourceIps) && input.allowSourceIps.length > 0;
      if (!ips && input.requireConfirmation !== true && input.acknowledgeUnsignedLive !== true) {
        throw new BridgeError(
          "VALIDATION_FAILED",
          `${input.source} alerts cannot be signed, so for live orders the URL alone would be the only protection (it is stored in your ${input.source} account, browser history and tunnel logs). Set allowSourceIps (the sender's published addresses), or requireConfirmation: true, or acknowledgeUnsignedLive: true to accept the risk.`,
          { errors: [{ path: "allowSourceIps", message: "needed for an unsigned live hook (or requireConfirmation / acknowledgeUnsignedLive)" }] },
        );
      }
    }
  }

  /** Warnings for dated contracts in allowedSymbols that have expired or expire soon. */
  function expiryWarnings(hook) {
    const out = [];
    const today = istDate(now());
    const soon = istDate(now() + EXPIRY_WARN_DAYS * 86_400_000);
    for (const s of hook.allowedSymbols ?? []) {
      let p = null;
      try {
        p = parseSymbol(s);
      } catch {
        continue;
      }
      if (!p.expiry) continue;
      if (p.expiry < today) out.push(`${s} has already expired: alerts for it will be refused. Use the current contract.`);
      else if (p.expiry <= soon) out.push(`${s} expires on ${p.expiry}: after that every alert for it is refused until you update allowedSymbols (your chart may keep sending a continuous symbol such as NIFTY1!).`);
    }
    return out;
  }

  /** POST /v1/hooks */
  async function createHook(ctx) {
    const input = ctx.body;
    // Paper or live, the creating key must be allowed to use the hook's account (checked before the lookup, so a key
    // cannot probe which account ids exist).
    if (input && typeof input === "object" && typeof input.account === "string") ctx.requireAccountAccess?.(input.account);
    if (input && typeof input === "object" && typeof input.account === "string" && deps.accounts && !isStub(deps.accounts)) {
      deps.accounts.get(input.account); // throws ACCOUNT_NOT_FOUND
    }
    if (input && typeof input === "object" && input.mode === "live") assertLiveHookAllowed(ctx, input);
    const createdByKeyId = ctx.key?.id ?? null;
    const { hook, token, signingSecret } = await store.create(input, { createdByKeyId });
    const warnings = [];
    if (hook.mode === "live" && hook.source !== "generic" && hook.acknowledgeUnsignedLive && !hook.allowSourceIps.length && !hook.requireConfirmation) {
      warnings.push("This live hook is protected only by its URL: anyone who learns the URL can place live orders. Keep it secret, and consider allowSourceIps or requireConfirmation.");
    }
    warnings.push(...expiryWarnings(hook));
    if (hook.source === "chartink" && !hook.side) warnings.push("ChartInk alerts carry no side: set side (BUY or SELL) on this hook, or every alert will be refused.");
    if (hook.orderType === "MARKET") warnings.push("MARKET orders are sent with market protection (safety.marketProtectionPct); LIMIT is safer for alerts.");
    const host = typeof ctx.req?.headers?.host === "string" ? ctx.req.headers.host : `127.0.0.1:${deps.config?.server?.port ?? 4300}`;
    const path = `/hooks/${hook.source}/${token}`;
    automations?.sync(hook);
    const data = { ...publicHook(hook), readiness: automations?.state(hook) ?? null, url: `http://${host}${path}`, path, templates: alertTemplates(hook), warnings };
    if (signingSecret) data.signingSecret = signingSecret;
    await audit(ctx, "hook.created", hook.account, { hookId: hook.id, source: hook.source, label: hook.label, mode: hook.mode, requireConfirmation: hook.requireConfirmation, maxLotsPerSignal: hook.maxLotsPerSignal, allowSourceIps: hook.allowSourceIps.length, acknowledgeUnsignedLive: hook.acknowledgeUnsignedLive, createdByKeyId });
    return json({ data, meta: { requestId: ctx.requestId, accountId: hook.account, mode: hook.mode } }, { status: 201, headers: { "Cache-Control": "no-store" } });
  }

  /** DELETE /v1/hooks/{hookId} */
  async function deleteHook(ctx) {
    const id = String(ctx.params.hookId ?? "");
    if (!HOOK_ID_RE.test(id)) throw new BridgeError("NOT_FOUND", "No hook with this id.");
    // An account-limited admin key cannot delete (or learn of) another account's hook.
    const existing = store.get(id);
    if (existing && !(ctx.canAccessAccounts?.([existing.account]) ?? true)) throw new BridgeError("NOT_FOUND", "No hook with this id.");
    const hook = await store.remove(id);
    automations?.remove(hook.id);
    await audit(ctx, "hook.deleted", hook.account, { hookId: hook.id, source: hook.source, label: hook.label });
    return noContent();
  }

  return { receiveHook, listHooks, createHook, deleteHook, _dedupe: dedupe };
}
