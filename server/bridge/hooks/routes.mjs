/**
 * Webhook routes (docs/openapi.yaml, tag "Webhooks").
 *
 *   POST   /hooks/{source}/{token}   public ingress allowed, auth "custom": the URL token (and for generic hooks the
 *                                    HMAC signature) is the credential. Answers 202 in milliseconds.
 *   GET    /v1/hooks                 admin, this computer only. Never shows tokens. An account-limited admin key sees, and
 *                                    can delete, only the hooks of its own accounts.
 *   POST   /v1/hooks                 admin, this computer only. 201 with the URL (token), the signing secret (generic) or
 *                                    the passphrase (tradingview) ONCE.
 *   DELETE /v1/hooks/{hookId}        admin, this computer only. The URL stops working at once.
 *   GET    /v1/hooks/presets         admin, this computer only. The address presets, trusted-tunnel header and public hosts.
 *   GET    /v1/hooks/{hookId}/signals  admin, this computer only. Recent alerts with their outcome, plus counts.
 *   POST   /v1/hooks/{hookId}/test   admin, this computer only. Sends a test alert through the real pipeline as a PAPER order.
 *
 * Receiver order of checks (cheapest and most selective first; every refusal is generic so it reveals nothing):
 *   source + token -> hook (404 for anything unknown) -> source-IP allowlist (global, the hook's own, its preset) -> live
 *   hook whose creating key was revoked (401) -> generic: failed-signature limit per source IP, HMAC + replay;
 *   tradingview: failed-passphrase limit per source IP, passphrase in constant time -> THEN the per-hook rate (so
 *   someone who knows the URL but not the secret cannot use up the hook's budget) -> parse (400 on a malformed alert)
 *   -> account / mode rules (tradingview) -> age limit (maxAgeSec) -> dedupe -> bounded queue (429 when full) -> 202.
 *   Every refusal after the hook is known is counted per hook (GET .../signals), audited without the body (throttled),
 *   and the useful ones (stale, unreadable, queue full) are announced on the bus as hook.rejected.
 *
 * Creating a LIVE hook (POST /v1/hooks with mode "live") needs, besides admin: the "live" scope on the creating key
 * (admin does not imply live; the local CLI is exempt), access to the hook's account, live enabled for that account
 * in the config with "webhook" in live.allowedSources, and, for sources that cannot sign their alerts (ChartInk,
 * GoCharting, TradingView: the URL token (and for TradingView the passphrase) is the only credential), at least one of
 * allowSourceIps, sourceIpPreset, requireConfirmation: true, or an explicit acknowledgeUnsignedLive: true (audited and
 * shown on the hook). A live TradingView hook also needs maxAgeSec and every alert on it must say "mode": "live" and
 * carry its time. The creating key id is kept on
 * the hook; when that key is revoked, the live hook stops accepting alerts.
 */
import { createHash, randomBytes } from "node:crypto";
import { verify as verifySignature, createReplayCache } from "../auth/hmac.mjs";
import { liveAllowedByConfig } from "../core/config.mjs";
import { isStub } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { json, noContent } from "../core/http.mjs";
import { isLoopbackAddress } from "../core/security.mjs";
import { IP_PRESET_NAMES, expandIpList, ipAllowed, ipPreset } from "./config.mjs";
import { createDedupeMap } from "./dedupe.mjs";
import { createSignalLog, plainSummary } from "./signalLog.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { DEFAULT_MAX_AGE_SEC, HOOK_SOURCES, defaultIstIso, publicHook } from "./hookStore.mjs";
import { parseChartInk } from "./receivers/chartink.mjs";
import { parseGeneric } from "./receivers/generic.mjs";
import { parseGoCharting } from "./receivers/gocharting.mjs";
import { extractPassphrase, isDatedCanonical, parseTradingView, tryAlertTime } from "./receivers/tradingview.mjs";
import { alertTemplates } from "./templates.mjs";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const IST_OFFSET_MS = 19_800_000;
const istDate = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
const HOOK_ID_RE = /^hk_[a-z2-7]{12}$/;

const PARSERS = Object.freeze({
  chartink: (body, meta) => parseChartInk(body, meta),
  gocharting: (body) => parseGoCharting(body),
  generic: (body) => parseGeneric(body),
  tradingview: (body) => parseTradingView(body),
});

const OUTCOMES = Object.freeze(["queued", "processing", "placed", "awaiting_confirmation", "duplicate", "stale", "rejected", "refused", "failed", "outcome_unknown", "dropped"]);
/** An alert whose time is more than this far ahead of this computer's clock is refused (clock skew is normal, a minute of it). */
const FUTURE_SKEW_MS = 60_000;
/** How long the test route waits for the order path before it answers with what it has. */
const TEST_WAIT_MS = 4000;
const TEST_NOTE = "A test alert goes through the same checks as a real one and places a paper order only. It does not prove that TradingView can reach this hook: check the web address, the tunnel and the alert's Webhook URL box too.";

const notFound = () => new BridgeError("NOT_FOUND", "No hook at this address.");
/** Failed signatures allowed per source address per minute on generic hooks. */
const FAILED_SIGNATURES_PER_MINUTE = 30;
/** A dated contract in allowedSymbols that expires within this many days gets a warning on create. */
const EXPIRY_WARN_DAYS = 7;

export { createDedupeMap };

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
export function createHookRoutes({ deps, cfg, store, worker, logger, now = () => Date.now(), automations = null, signals = createSignalLog({ keep: cfg.signalsKept, now }), dedupeFile = null }) {
  const dedupe = createDedupeMap({ now, file: dedupeFile, logger });
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

  // ── Refusal bookkeeping: counts and a short list per hook, a throttled audit entry, a throttled bus event ──

  /** hook id + kind -> { at, count } for the audit throttle. */
  const auditSeen = new Map();
  const busSeen = new Map();
  const throttled = (map, key, windowMs) => {
    const t = now();
    const e = map.get(key) ?? { at: 0, suppressed: 0 };
    if (t - e.at < windowMs) {
      e.suppressed += 1;
      map.set(key, e);
      return null;
    }
    const suppressed = e.suppressed;
    map.set(key, { at: t, suppressed: 0 });
    if (map.size > 1000) map.delete(map.keys().next().value);
    return suppressed;
  };

  /** A refusal that knows what kind it is (the receiver counts it and shows it by kind). */
  const refuse = (kind, code, detail, extra) => Object.assign(new BridgeError(code, detail, extra), { hookKind: kind });

  const kindOf = (err) => {
    if (err?.hookKind) return err.hookKind;
    if (err?.code === "UNAUTHENTICATED") return "auth";
    if (err?.code === "RATE_LIMITED") return "rate";
    if (["VALIDATION_FAILED", "INVALID_JSON", "PAYLOAD_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE"].includes(err?.code)) return "bad_request";
    return null;
  };

  /**
   * Record a failed delivery: counts, list entry (for alerts a person can fix), audit entry (throttled, no body) and, for
   * refusals that a notifier should mention, the bus event hook.rejected (throttled). Once per error.
   * @param {any} hook @param {any} err @param {{ at: number, symbol?: string | null, side?: string | null, id?: string | null, time?: string | null, test?: boolean }} info
   */
  function observeFailure(hook, err, info) {
    if (!err || err.hookObserved) return;
    const kind = kindOf(err);
    if (!kind) return;
    err.hookObserved = true;
    const reason = typeof err.detail === "string" ? err.detail : String(err.message ?? "");
    signals.refused(hook.id, kind, { at: info.at, code: err.code, reason, symbol: info.symbol, side: info.side, id: info.id, time: info.time, test: info.test });
    if (kind !== "rate" && !info.test) {
      const sup = throttled(auditSeen, `${hook.id}|${kind}`, 60_000);
      if (sup !== null) {
        audit({ principal: { kind: "hook", id: hook.id }, source: "webhook" }, "hook.refused", hook.account, { hookId: hook.id, kind, code: err.code, reason: reason.slice(0, 300), symbol: info.symbol ?? undefined, repeats: sup || undefined }).catch((e) => logger.warn("hook refusal could not be audited", { code: e?.code }));
      }
    }
    if ((kind === "stale" || kind === "bad_request" || kind === "queue_full") && !info.test) {
      const sup = throttled(busSeen, `${hook.id}|${kind}`, 10_000);
      if (sup !== null) {
        try {
          deps.bus?.emit?.("hook.rejected", {
            hookId: hook.id,
            label: hook.label,
            source: hook.source,
            signalId: null,
            stage: "receive",
            outcome: kind === "stale" ? "stale" : kind === "queue_full" ? "rejected" : "refused",
            code: err.code,
            reason: reason.slice(0, 300),
            symbol: info.symbol ?? null,
            side: info.side ?? null,
            accountId: hook.account,
            mode: hook.mode,
            at: info.at,
            ...(sup ? { suppressed: sup } : {}),
          });
        } catch (e) {
          logger.warn("hook.rejected could not be announced", { message: e?.message });
        }
      }
    }
  }

  /** Errors raised before the handler runs (body too large, wrong content type, invalid JSON) still count against the hook. */
  function onReceiveError(ctx, err) {
    if (err?.hookObserved) return;
    const token = ctx.params?.token;
    const hook = typeof token === "string" ? store.findByToken(token) : null;
    if (!hook || hook.source !== ctx.params?.source) return;
    observeFailure(hook, err, { at: now() });
  }

  // ── Alert checks shared by the public receiver and the test route ──

  /** The mode, account and symbol rules only TradingView alerts carry. */
  function assertTradingViewScope(hook, signal, { test }) {
    if (signal.account && signal.account !== hook.account) {
      throw refuse("bad_request", "VALIDATION_FAILED", `The alert says account ${signal.account}, but this hook belongs to ${hook.account}. Remove "account" from the alert or use the hook of that account.`, { errors: [{ path: "account", message: "differs from the hook's account" }] });
    }
    if (test) return;
    const want = signal.mode ?? "paper";
    if (want !== hook.mode) {
      throw refuse(
        "bad_request",
        "VALIDATION_FAILED",
        hook.mode === "live"
          ? 'This hook places LIVE orders, so the alert must say "mode": "live" on purpose (an alert without a mode means paper). Nothing was placed.'
          : `This hook places paper orders only; the alert says mode ${want}. Nothing was placed.`,
        { errors: [{ path: "mode", message: `the hook is ${hook.mode}` }] },
      );
    }
  }

  /** Refuse an alert older than the hook allows (and, on a live TradingView hook, an alert that cannot be aged at all). */
  function assertFresh(hook, signals_, receivedAt) {
    if (!hook.maxAgeSec) return;
    for (const s of signals_) {
      if (s.timeMs === null || s.timeMs === undefined) {
        if (hook.mode === "live" && hook.source === "tradingview") {
          throw refuse("stale", "VALIDATION_FAILED", `This live hook checks how old an alert is, so the alert must carry its time (time: {{timenow}}). Nothing was placed.`, { errors: [{ path: "time", message: "required on a live hook" }] });
        }
        continue;
      }
      const ageMs = receivedAt - s.timeMs;
      if (ageMs > hook.maxAgeSec * 1000) {
        throw refuse("stale", "VALIDATION_FAILED", `The alert is ${Math.round(ageMs / 1000)} seconds old and this hook only accepts alerts up to ${hook.maxAgeSec} seconds old, so nothing was placed. If fresh alerts are refused too, check that this computer's clock is right.`, { errors: [{ path: "time", message: `older than maxAgeSec (${hook.maxAgeSec})` }] });
      }
      if (ageMs < -FUTURE_SKEW_MS) {
        throw refuse("stale", "VALIDATION_FAILED", `The alert's time is ${Math.round(-ageMs / 1000)} seconds ahead of this computer's clock, so it is refused. Check this computer's clock and the alert's time.`, { errors: [{ path: "time", message: "in the future" }] });
      }
    }
  }

  /** The derived clientOrderId of one order of an alert: stable for the same alert identity, so a resend is the same order. */
  const derivedClientOrderId = (hookId, idemBase, key) => `mcb-${hookId.slice(3)}-${sha256(`${idemBase}|${key}`).slice(0, 28)}`;

  /**
   * Everything after the sender is known to be allowed: read the alert, apply the checks, dedupe, queue.
   * @param {{ hook: any, body: unknown, raw: Buffer, receivedAt: number, test?: boolean, state: any }} a
   * @returns {{ duplicate: boolean, signalId: string, dropped: number }}
   */
  function admitAlert({ hook, body, raw, receivedAt, test = false, state }) {
    const parsed = PARSERS[hook.source](body, { istDate: istDate(receivedAt) });
    if (parsed.signals.length === 0) throw new BridgeError("VALIDATION_FAILED", "The alert does not contain any order.");
    for (const s of parsed.signals) if (s.timeMs === undefined) s.timeMs = tryAlertTime(s.time);
    const first = parsed.signals[0];
    Object.assign(state, { symbol: first.symbol, side: first.side, id: first.ref, time: first.time, test });
    if (hook.source === "tradingview") for (const s of parsed.signals) assertTradingViewScope(hook, s, { test });
    assertFresh(hook, parsed.signals, receivedAt);

    // Alert identity: the sender's own id + time when present, else the exact bytes (inside the dedupe window).
    const rawHash = sha256(raw);
    const basis = parsed.basis ?? `raw|${rawHash}`;
    const alertKey = sha256(`${hook.id}|${basis}`);
    if (!test) {
      const seen = dedupe.get(alertKey);
      if (seen) {
        logger.info("hook duplicate", { hookId: hook.id, signalId: seen.signalId });
        signals.duplicate(hook.id, { signalId: seen.signalId, at: receivedAt, symbol: first.symbol, side: first.side, id: first.ref, time: first.time });
        return { duplicate: true, signalId: seen.signalId, dropped: 0 };
      }
      // Fail closed: a full dedupe map would have to forget an alert that could then be sent twice.
      if (dedupe.full()) throw refuse("queue_full", "RATE_LIMITED", "The Bridge is remembering too many alerts to tell new ones from repeats, so this alert was refused and nothing was placed. Try again shortly.", { retryAfterMs: 30_000 });
    }
    const signalId = `sig_${randomBytes(10).toString("base64url")}`;
    // Idempotency-Key per order. With a sender identity it is stable for the IST day (OrderService keeps keys that long);
    // without one it includes the first-seen time, so a repeat of the same text hours later is a new order.
    const idemBase = test ? `${hook.id}|test|${signalId}` : parsed.basis ? `${hook.id}|${parsed.basis}` : `${hook.id}|raw|${rawHash}|${receivedAt}`;
    const jobs = parsed.signals.map((signal, index) => {
      const key = `${signal.ref ?? ""}|${index}`;
      return {
        signalId,
        hookId: hook.id,
        index,
        signal,
        idempotencyKey: `hook:${hook.id}:${sha256(`${idemBase}|${key}`).slice(0, 40)}`,
        ...(hook.source === "tradingview" ? { clientOrderId: derivedClientOrderId(hook.id, idemBase, key) } : {}),
        receivedAt,
        ...(test ? { test: true } : {}),
      };
    });
    try {
      worker.enqueue(jobs);
    } catch (err) {
      if (err?.code === "RATE_LIMITED") err.hookKind = "queue_full";
      throw err;
    }
    for (const j of jobs) signals.accepted(hook.id, { signalId, index: j.index, at: receivedAt, symbol: j.signal.symbol, side: j.signal.side, id: j.signal.ref, time: j.signal.time, mode: test ? "paper" : hook.mode, test });
    if (!test) {
      dedupe.set(alertKey, signalId, dedupeTtlMs(hook, parsed.basis !== null));
      store.touch(hook.id);
    }
    return { duplicate: false, signalId, dropped: parsed.dropped };
  }

  /** How long an alert identity is remembered: at least the dedupe window, and past the age limit when the identity is id + time. */
  const dedupeTtlMs = (hook, hasIdentity) => Math.max(cfg.dedupeWindowMs, hasIdentity && hook.maxAgeSec ? hook.maxAgeSec * 1000 + 60_000 : 0);

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
    const state = {};
    try {
      return await acceptDelivery(ctx, hook, receivedAt, state);
    } catch (err) {
      observeFailure(hook, err, { at: receivedAt, ...state });
      throw err;
    }
  }

  async function acceptDelivery(ctx, hook, receivedAt, state) {
    const source = hook.source;
    const allow = [...globalIps, ...expandIpList(hook.allowSourceIps), ...(hook.sourceIpPreset ? expandIpList(ipPreset(cfg, hook.sourceIpPreset).ips) : [])];
    if (allow.length && !ipAllowed(clientAddress(ctx), allow)) {
      logger.warn("hook refused: source address not allowed", { hookId: hook.id });
      throw refuse("address", "UNAUTHENTICATED", "This hook does not accept alerts from this address.");
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
        throw refuse("key_revoked", "UNAUTHENTICATED", "This live hook was created with an API key that has since been revoked. Create the hook again.");
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
    if (ctx.body === undefined || ctx.body === null || ctx.body === "") throw new BridgeError("VALIDATION_FAILED", "The alert is empty.");
    if (source === "tradingview") {
      // TradingView cannot sign or add headers: the credential is the secret URL plus the passphrase inside the
      // message. Checked before anything else about the message is read, in constant time, with a failure limit per address.
      const addr = `ip:${clientAddress(ctx) || "unknown"}`;
      const tooMany = failedSignatures.peek(addr, FAILED_SIGNATURES_PER_MINUTE);
      if (!tooMany.ok) throw new BridgeError("RATE_LIMITED", "Too many alerts with a wrong passphrase from this address. Try again shortly.", { retryAfterMs: tooMany.retryAfterMs });
      if (!store.checkPassphrase(hook.id, extractPassphrase(ctx.body))) {
        failedSignatures.take(addr, FAILED_SIGNATURES_PER_MINUTE);
        logger.warn("hook refused: passphrase missing or wrong", { hookId: hook.id });
        throw new BridgeError("UNAUTHENTICATED", "The alert's passphrase is missing or wrong. Add passphrase to the alert message exactly as shown when the hook was created.");
      }
    }
    // Charged only after the credential check: junk requests cannot use up a hook's budget.
    const r = rate.take(hook.id, cfg.maxSignalsPerMinute);
    if (!r.ok) throw new BridgeError("RATE_LIMITED", "This hook is receiving too many alerts. Try again shortly.", { retryAfterMs: r.retryAfterMs });

    const out = admitAlert({ hook, body: ctx.body, raw, receivedAt, state });
    const body = { accepted: true, signalId: out.signalId };
    if (out.duplicate) body.duplicate = true;
    if (out.dropped) body.dropped = out.dropped;
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
      const ips = (Array.isArray(input.allowSourceIps) && input.allowSourceIps.length > 0) || (typeof input.sourceIpPreset === "string" && input.sourceIpPreset !== "");
      if (!ips && input.requireConfirmation !== true && input.acknowledgeUnsignedLive !== true) {
        throw new BridgeError(
          "VALIDATION_FAILED",
          `${input.source} alerts cannot be signed, so for live orders the URL alone would be the only protection (it is stored in your ${input.source} account, browser history and tunnel logs). Set allowSourceIps or sourceIpPreset (the sender's published addresses), or requireConfirmation: true, or acknowledgeUnsignedLive: true to accept the risk.`,
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

  /** What a person should know right after creating a TradingView hook. */
  function tradingViewWarnings(hook) {
    const out = [];
    if (hook.sourceIpPreset && !cfg.clientIpHeader) {
      out.push("This hook only accepts alerts from TradingView's published addresses. If your alerts arrive through a tunnel (Cloudflare Tunnel, ngrok), the Bridge sees the tunnel, not TradingView, and refuses every alert until you set hooks.clientIpHeader in the config file (cf-connecting-ip for Cloudflare Tunnel).");
    }
    if (!hook.sourceIpPreset && !hook.allowSourceIps.length) out.push("This hook does not check the sender's address. The secret address and the passphrase protect it; turn on the TradingView address list as well when you can.");
    if (hook.mode === "paper") out.push('This hook places PAPER orders only. Every alert is treated as paper; an alert with "mode": "live" is refused.');
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
    const { hook, token, signingSecret, passphrase } = await store.create(input, { createdByKeyId });
    const warnings = [];
    if (hook.mode === "live" && hook.source !== "generic" && hook.acknowledgeUnsignedLive && !hook.allowSourceIps.length && !hook.requireConfirmation) {
      warnings.push("This live hook is protected only by its URL: anyone who learns the URL can place live orders. Keep it secret, and consider allowSourceIps or requireConfirmation.");
    }
    warnings.push(...expiryWarnings(hook));
    if (hook.source === "chartink" && !hook.side) warnings.push("ChartInk alerts carry no side: set side (BUY or SELL) on this hook, or every alert will be refused.");
    if (hook.source === "tradingview") warnings.push(...tradingViewWarnings(hook));
    if (hook.orderType === "MARKET") warnings.push("MARKET orders are sent with market protection (safety.marketProtectionPct); LIMIT is safer for alerts.");
    const host = typeof ctx.req?.headers?.host === "string" ? ctx.req.headers.host : `127.0.0.1:${deps.config?.server?.port ?? 4300}`;
    const path = `/hooks/${hook.source}/${token}`;
    automations?.sync(hook);
    const data = { ...publicHook(hook), readiness: automations?.state(hook) ?? null, url: `http://${host}${path}`, path, templates: alertTemplates(hook, { passphrase }), warnings };
    if (signingSecret) data.signingSecret = signingSecret;
    if (passphrase) data.passphrase = passphrase;
    if (hook.sourceIpPreset) data.ipPreset = ipPreset(cfg, hook.sourceIpPreset);
    await audit(ctx, "hook.created", hook.account, { hookId: hook.id, source: hook.source, label: hook.label, mode: hook.mode, requireConfirmation: hook.requireConfirmation, maxLotsPerSignal: hook.maxLotsPerSignal, allowSourceIps: hook.allowSourceIps.length, sourceIpPreset: hook.sourceIpPreset, maxAgeSec: hook.maxAgeSec, acknowledgeUnsignedLive: hook.acknowledgeUnsignedLive, createdByKeyId });
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
    signals.remove(hook.id);
    await audit(ctx, "hook.deleted", hook.account, { hookId: hook.id, source: hook.source, label: hook.label });
    return noContent();
  }

  /** The hook a management route is about, or a 404 that does not reveal other accounts' hooks. */
  function ownHook(ctx) {
    const id = String(ctx.params.hookId ?? "");
    if (!HOOK_ID_RE.test(id)) throw new BridgeError("NOT_FOUND", "No hook with this id.");
    const hook = store.get(id);
    if (!hook || !(ctx.canAccessAccounts?.([hook.account]) ?? true)) throw new BridgeError("NOT_FOUND", "No hook with this id.");
    return hook;
  }

  /** GET /v1/hooks/presets */
  async function hookPresets(ctx) {
    const pi = deps.config?.server?.publicIngress ?? {};
    const hosts = pi.enabled ? (pi.allowedHosts ?? []) : [];
    return {
      data: {
        ipPresets: IP_PRESET_NAMES.map((n) => ipPreset(cfg, n)),
        clientIpHeader: cfg.clientIpHeader,
        publicIngress: { enabled: pi.enabled === true, port: pi.port ?? null, allowedHosts: hosts, urls: hosts.map((h) => `https://${h}`) },
        tradingview: { defaultMaxAgeSec: DEFAULT_MAX_AGE_SEC, sourceIpPreset: "tradingview" },
        limits: { maxSignalsPerMinute: cfg.maxSignalsPerMinute, bodyLimitBytes: 16384, queueSize: cfg.queueSize, burstWaitSec: cfg.burstWaitSec },
      },
      meta: { requestId: ctx.requestId },
    };
  }

  /** GET /v1/hooks/{hookId}/signals */
  async function listSignals(ctx) {
    const hook = ownHook(ctx);
    const rawLimit = Number(ctx.query.get("limit") ?? 50);
    const limit = Number.isInteger(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, 200) : 50;
    const outcome = ctx.query.get("outcome");
    if (outcome && !OUTCOMES.includes(outcome)) throw new BridgeError("VALIDATION_FAILED", `outcome must be one of ${OUTCOMES.join(", ")}.`, { errors: [{ path: "outcome", message: "unknown outcome" }] });
    const l = signals.list(hook.id, { limit, outcome });
    const t = now();
    return {
      data: {
        hookId: hook.id,
        label: hook.label,
        source: hook.source,
        mode: hook.mode,
        lastSignalAt: hook.lastSignalAt,
        serverTime: defaultIstIso(t),
        counts: l.counts,
        countsSince: defaultIstIso(l.since),
        lastAuthFailureAt: l.lastAuthFailureAt ? defaultIstIso(l.lastAuthFailureAt) : null,
        queue: worker.stats(),
        signals: l.signals.map(({ at, finishedAt, ...e }) => ({ ...e, receivedAt: defaultIstIso(at), finishedAt: finishedAt ? defaultIstIso(finishedAt) : null })),
      },
      meta: { requestId: ctx.requestId, accountId: hook.account },
    };
  }

  /** A current price for a LIMIT test alert (rounded to the tick), or a 400 that says what to send. */
  async function referencePrice(symbol) {
    try {
      const r = await deps.symbols.resolve(symbol, isDatedCanonical(symbol) ? {} : { from: "chart" });
      const q = await deps.marketData.ltp([r.canonical], {});
      const ltp = Number(q?.items?.[0]?.ltp);
      if (!(ltp > 0)) throw new Error("no price");
      const tick = Number(r.tickSize) > 0 ? Number(r.tickSize) : 0.05;
      const decimals = Math.min(4, (String(tick).split(".")[1] ?? "").length);
      return Number((Math.round(ltp / tick) * tick).toFixed(decimals));
    } catch {
      throw new BridgeError("VALIDATION_FAILED", `The Bridge has no current price for ${symbol} to build a LIMIT test alert. Send "price" in the request, or choose a symbol that has a price.`, { errors: [{ path: "price", message: "needed for a LIMIT hook when no price is available" }] });
    }
  }

  /** A realistic alert for this hook, in the shape its source reads. */
  async function sampleAlert(hook, input, receivedAt) {
    const symbol = typeof input.symbol === "string" && input.symbol.trim() ? input.symbol.trim() : (hook.allowedSymbols[0] ?? "NSE:RELIANCE");
    const side = input.side ? String(input.side).toUpperCase() : (hook.side ?? "BUY");
    const price = hook.orderType === "LIMIT" ? (input.price !== undefined ? Number(input.price) : await referencePrice(symbol)) : null;
    const time = new Date(receivedAt).toISOString().replace(/\.\d{3}Z$/, "Z");
    const id = `test-${randomBytes(4).toString("hex")}`;
    const productWord = hook.product ? null : "MIS";
    switch (hook.source) {
      case "tradingview":
        return { symbol, side: side.toLowerCase(), lots: 1, orderType: hook.orderType.toLowerCase(), ...(price ? { price } : {}), ...(productWord ? { product: productWord } : {}), mode: "paper", id, time };
      case "gocharting":
        return `${side} ${symbol} 1${price ? ` @ ${price}` : " MKT"}${productWord ? ` ${productWord}` : ""} id=${id} time=${time}`;
      case "chartink":
        return { stocks: symbol.replace(/^[A-Za-z]+:/, ""), ...(price ? { trigger_prices: String(price) } : {}), triggered_at: time, scan_url: id };
      default:
        return { symbol, side, quantity: 1, ...(price ? { price } : {}), ...(productWord ? { product: productWord } : {}), id };
    }
  }

  const without = (body) => {
    if (body && typeof body === "object" && !Array.isArray(body)) return Object.fromEntries(Object.entries(body).filter(([k]) => k.toLowerCase() !== "passphrase"));
    return typeof body === "string" ? body.replace(/(^|[\s,;])passphrase=[^\s,;]+/gi, "$1").trim() : body;
  };

  /** POST /v1/hooks/{hookId}/test */
  async function testHook(ctx) {
    const hook = ownHook(ctx);
    const input = ctx.body ?? {};
    if (typeof input !== "object" || Array.isArray(input)) throw new BridgeError("VALIDATION_FAILED", "Send a JSON object, or nothing.");
    for (const k of Object.keys(input)) {
      if (!["alert", "symbol", "side", "price"].includes(k)) throw new BridgeError("VALIDATION_FAILED", `Unknown field "${k.slice(0, 30)}". Fields: alert, symbol, side, price.`, { errors: [{ path: k.slice(0, 30), message: "unknown field" }] });
    }
    const receivedAt = now();
    const r = rate.take(hook.id, cfg.maxSignalsPerMinute);
    if (!r.ok) throw new BridgeError("RATE_LIMITED", "This hook is receiving too many alerts. Try again shortly.", { retryAfterMs: r.retryAfterMs });
    let body;
    if (input.alert !== undefined) {
      body = input.alert;
      if (typeof body === "string" && /^\s*\{/.test(body)) {
        try {
          body = JSON.parse(body);
        } catch {
          /* kept as text: the parser says what is wrong with it */
        }
      }
      if (body === null || body === "" || (typeof body !== "string" && typeof body !== "object")) throw new BridgeError("VALIDATION_FAILED", "alert must be the alert message, as text or a JSON object.", { errors: [{ path: "alert", message: "text or object" }] });
    } else body = await sampleAlert(hook, input, receivedAt);
    // The hook's own passphrase is not needed here (an admin on this computer is asking); a pasted one is dropped.
    const shown = without(body);
    const raw = Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
    const state = {};
    const base = { test: true, mode: "paper", message: shown, hookId: hook.id };
    let out;
    try {
      out = admitAlert({ hook, body, raw, receivedAt, test: true, state });
    } catch (err) {
      observeFailure(hook, err, { at: receivedAt, ...state, test: true });
      const kind = kindOf(err);
      await audit(ctx, "hook.test", hook.account, { hookId: hook.id, outcome: kind === "stale" ? "stale" : "refused", code: err?.code });
      if (!(err instanceof BridgeError) || !kind) throw err;
      const outcome = kind === "stale" ? "stale" : kind === "queue_full" ? "rejected" : "refused";
      const entry = { outcome, reason: err.detail, code: err.code };
      return { data: { ...base, signalId: null, accepted: false, outcome, reason: err.detail, code: err.code, orderId: null, summary: plainSummary(entry), note: TEST_NOTE }, meta: { requestId: ctx.requestId, accountId: hook.account, mode: "paper" } };
    }
    let timer;
    await Promise.race([worker.idle(), new Promise((res) => (timer = setTimeout(res, TEST_WAIT_MS)))]);
    clearTimeout(timer);
    const e = signals.byId(hook.id, out.signalId)[0] ?? { outcome: "queued", reason: null, code: null, orderId: null };
    await audit(ctx, "hook.test", hook.account, { hookId: hook.id, signalId: out.signalId, outcome: e.outcome, code: e.code ?? undefined });
    return {
      data: { ...base, signalId: out.signalId, accepted: true, outcome: e.outcome, reason: e.reason ?? null, code: e.code ?? null, orderId: e.orderId ?? null, summary: e.summary ?? plainSummary(e), note: TEST_NOTE },
      meta: { requestId: ctx.requestId, accountId: hook.account, mode: "paper" },
    };
  }

  return { receiveHook, onReceiveError, listHooks, createHook, deleteHook, hookPresets, listSignals, testHook, signals, _dedupe: dedupe };
}
