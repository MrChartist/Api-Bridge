/**
 * The sources service: what the rest of the Bridge sees of the source registry.
 *
 * 1. The BackupDataService facade (SERVICE_CONTRACTS.backupData): quotes, history, expiries, optionChain, status,
 *    autoFallback. MarketDataService reads through it when no broker account can answer. Every answer names its
 *    source id as `provider` and carries `class`, `delaySec` and `official`, so the market layer can label it.
 * 2. The management API the dashboard and the routes use: list, describe, setEnabled, setConfig, test, consentFor.
 *
 * Rules:
 *  - A source is used only when it is enabled, configured, not a broker, can do the thing asked, its data class is
 *    allowed for the read's purpose and its delay fits the caller's maxAgeMs. These checks run on whatever the
 *    selector returns, so a smarter selector (the router) cannot bypass them.
 *  - Which of the usable sources is tried first is decided by ONE function, pickSources(capability, req). The default
 *    is the most current class first, then registration order. Replace it with setPicker() or deps.pickSources.
 *  - Enabling needs the source to be configured (a BYOK key in the secrets store under `source:<id>`), and an opt-in
 *    source needs `acknowledge` equal to its noticeVersion. Disabling is always allowed.
 *  - Every call gets { signal, now } and a timeout (config sources.timeoutMs, 5 s by default, 15 s at most).
 *  - API keys are read from the secrets store only to be handed to the source that owns them (ctx.apiKey, for sources
 *    that need a key). They are never logged, never kept in state.json and never returned; text from a source is
 *    scrubbed of the key before it is shown or logged.
 */
import { istDate } from "../../lib/jsonl.mjs";
import { BridgeError, ERROR_CODES } from "../core/errors.mjs";
import { sourcesConfigSchema } from "./config.mjs";
import { classAllowedFor, classRank, meetsMaxAge } from "./contract.mjs";
import { createSourceState } from "./state.mjs";
import { outcomeKindOf } from "./health.mjs";

const MINUTE_MS = 60_000;
const HEALTH_WINDOW_MS = 5 * MINUTE_MS;
const HEALTH_KEEP = 60;
const KEY_MIN = 4;
const KEY_MAX = 512;

export const secretNameFor = (id) => `source:${id}`;
const needsKeyOf = (d) => d.needsKey ?? d.tier === "byok";
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};

/**
 * @param {object} deps
 * @param {ReturnType<import("./registry.mjs").createSourceRegistry>} deps.registry
 * @param {{ sources?: object }} [deps.config]  parsed config (sources section)
 * @param {object} [deps.logger]
 * @param {{ now(): number }} [deps.clock]
 * @param {{ dataDir: string }} [deps.paths]
 * @param {{ get(name: string): Promise<object|null>, set(name: string, value: object): Promise<void>, delete(name: string): Promise<boolean> }} [deps.secrets]
 * @param {ReturnType<typeof createSourceState>} [deps.state]  injected in tests; else built from paths.dataDir
 * @param {(capability: string, req: object) => unknown[] | Promise<unknown[]>} [deps.pickSources]  replaces the default selector
 */
export function createSourcesService(deps) {
  const { registry, secrets } = deps;
  const clock = deps.clock ?? { now: () => Date.now() };
  const log = deps.logger?.child ? deps.logger.child({ module: "sources" }) : deps.logger;
  const cfg = sourcesConfigSchema.parse(deps.config?.sources ?? {});
  const state = deps.state ?? createSourceState({ dataDir: deps.paths.dataDir, logger: log, clock });
  /** @type {null | { state(id: string): object | undefined, record?(id: string, r: object): void }} */
  let healthTracker = null;
  /** Whether callOne() reports its outcomes to the attached tracker (false when the caller of the facade does it, as the market service does). */
  let trackerRecordsCalls = true;
  let picker = typeof deps.pickSources === "function" ? deps.pickSources : null;

  const timeoutMs = () => Math.min(cfg.timeoutMs, 15_000);
  const nowMs = () => clock.now();
  const providerOf = (id) => {
    const p = registry.get(id);
    if (!p) throw new BridgeError("NOT_FOUND", `There is no data source "${id}".`);
    return p;
  };

  // ── Usage and health counters (memory only) ──
  /** @type {Map<string, { stamps: number[], day: string, today: number }>} */
  const usage = new Map();
  /** @type {Map<string, { results: Array<{ at: number, ok: boolean, ms: number }>, lastError: string | null }>} */
  const outcomes = new Map();

  function touch(id) {
    const t = nowMs();
    const u = usage.get(id) ?? { stamps: [], day: istDate(t), today: 0 };
    const day = istDate(t);
    if (u.day !== day) {
      u.day = day;
      u.today = 0;
    }
    u.today += 1;
    u.stamps.push(t);
    while (u.stamps.length && u.stamps[0] <= t - MINUTE_MS) u.stamps.shift();
    usage.set(id, u);
  }
  function usageOf(id) {
    const t = nowMs();
    const u = usage.get(id);
    if (!u) return { lastMinute: 0, today: 0 };
    while (u.stamps.length && u.stamps[0] <= t - MINUTE_MS) u.stamps.shift();
    return { lastMinute: u.stamps.length, today: u.day === istDate(t) ? u.today : 0 };
  }
  function recordOutcome(id, { ok, ms, kind, message }, { toTracker = true } = {}) {
    const o = outcomes.get(id) ?? { results: [], lastError: null };
    o.results.push({ at: nowMs(), ok, ms });
    if (o.results.length > HEALTH_KEEP) o.results.shift();
    if (!ok) o.lastError = message ?? "failed";
    outcomes.set(id, o);
    if (!toTracker) return;
    try {
      healthTracker?.record?.(id, { ok, ms, kind, ...(message ? { message: String(message).slice(0, 200) } : {}) });
    } catch {
      // health is advisory; it never fails a read
    }
  }
  /** A tracker's lastError ({ kind, message } or text) as the plain sentence the API shows. */
  const errorText = (e) => (e && typeof e === "object" ? (typeof e.message === "string" && e.message ? e.message : (e.kind ?? null)) : (e ?? null));
  /** An epoch-ms or ISO time as ISO text, or null. */
  const isoOrNull = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : typeof t === "string" && t ? t : null);
  const SEVERITY = { ok: 0, degraded: 1, open: 2, disabled: 3 };
  /** What a plugin's host says about its own child process, when the provider has health(). */
  function providerHealth(id) {
    const p = registry.get(id);
    if (typeof p?.health !== "function") return null;
    try {
      const h = p.health();
      return h && typeof h === "object" && Object.hasOwn(SEVERITY, h.state) ? h : null;
    } catch {
      return null;
    }
  }
  function healthOf(id, enabled) {
    if (!enabled) return { state: "disabled", errorRate: 0, p50Ms: null, lastError: null, nextTryAt: null };
    let base = null;
    try {
      const h = healthTracker?.state?.(id);
      if (h && typeof h === "object") base = { state: h.state ?? "ok", errorRate: h.errorRate ?? 0, p50Ms: h.p50Ms ?? null, lastError: errorText(h.lastError), nextTryAt: isoOrNull(h.nextTryAt) };
    } catch {
      // fall back to the local numbers
    }
    if (!base) {
      const o = outcomes.get(id);
      const recent = (o?.results ?? []).filter((r) => r.at > nowMs() - HEALTH_WINDOW_MS);
      const errorRate = recent.length ? recent.filter((r) => !r.ok).length / recent.length : 0;
      const bad = recent.length >= 3 && errorRate >= 0.5;
      base = { state: bad ? "degraded" : "ok", errorRate: Math.round(errorRate * 1000) / 1000, p50Ms: median(recent.filter((r) => r.ok).map((r) => r.ms)), lastError: o?.lastError ?? null, nextTryAt: null };
    }
    // A plugin knows what the call counters cannot (its process was restarted, or switched off after crashing): the
    // worse of the two states wins, and the plugin's own reason is shown when it decided.
    const ph = providerHealth(id);
    if (ph && ph.state !== "ok" && SEVERITY[ph.state] >= SEVERITY[base.state]) {
      return { ...base, state: ph.state, lastError: errorText(ph.lastError) ?? base.lastError, nextTryAt: isoOrNull(ph.nextTryAt) ?? base.nextTryAt };
    }
    return base;
  }

  // ── Secrets ──
  async function readKey(id) {
    if (!secrets) return null;
    try {
      const v = await secrets.get(secretNameFor(id));
      const key = v && typeof v.apiKey === "string" && v.apiKey ? v.apiKey : null;
      if (key) deps.logger?.addSecret?.(key);
      return key;
    } catch (err) {
      log?.warn?.("source key could not be read", { id, code: err?.code });
      return null;
    }
  }
  /** Text safe to show or log: the key is replaced if a source echoed it back. */
  const scrub = (text, key) => {
    let s = String(text ?? "").slice(0, 300);
    if (key && key.length >= 4) s = s.split(key).join("***");
    return s;
  };

  // ── State ──
  const configuredOf = (d) => !needsKeyOf(d) || state.get(d.id)?.configured === true;
  const forcedOff = (d) => cfg.providers[d.id]?.enabled === false;
  function storedEnabled(d) {
    const s = state.get(d.id);
    if (s) return s.enabled;
    if (d.tier === "builtin") return true;
    return cfg.providers[d.id]?.enabled === true && d.tier !== "opt-in";
  }
  const consentOf = (id) => state.get(id)?.consent ?? null;
  const consentValid = (d) => d.tier !== "opt-in" || consentOf(d.id)?.noticeVersion === d.noticeVersion;
  const enabledOf = (d) => !forcedOff(d) && storedEnabled(d) && configuredOf(d) && consentValid(d);

  /** Re-read which BYOK sources have a key (the secrets file can change under us, for example from the CLI). */
  async function refresh() {
    for (const p of registry.list()) {
      const d = p.descriptor;
      if (!needsKeyOf(d)) continue;
      const present = (await readKey(d.id)) !== null;
      const s = state.get(d.id);
      if ((s?.configured ?? false) !== present || (!present && s?.enabled)) state.update(d.id, { configured: present, ...(present ? {} : { enabled: false }) });
    }
  }

  // ── Management API ──
  function describe(id) {
    const d = providerOf(id).descriptor;
    const enabled = enabledOf(d);
    const out = {
      id: d.id,
      name: d.name,
      kind: d.kind,
      tier: d.tier,
      enabled,
      configured: configuredOf(d),
      class: d.class,
      delaySec: d.class === "realtime" ? 0 : (d.delaySec ?? null),
      official: d.official,
      capabilities: [...d.capabilities],
      limits: { ...d.limits },
      usage: usageOf(d.id),
      health: healthOf(d.id, enabled),
      terms: d.terms ? { url: d.terms.url, note: d.terms.note } : null,
      needsKey: needsKeyOf(d),
      consent: consentOf(d.id),
    };
    if (d.noticeVersion) out.noticeVersion = d.noticeVersion;
    return out;
  }

  const problem = (code, detail, extra) => new BridgeError(code, detail, extra);

  async function setEnabled(id, enabled, { acknowledge } = {}) {
    const d = providerOf(id).descriptor;
    if (typeof enabled !== "boolean") throw problem("VALIDATION_FAILED", "enabled must be true or false.", { errors: [{ path: "enabled", message: "must be true or false" }] });
    if (d.kind === "broker") throw problem("STATE_CONFLICT", `${d.name} is made of your broker accounts. Switch accounts on or off on the Accounts page.`, { retryable: false });
    if (!enabled) {
      state.update(id, { enabled: false });
      log?.info?.("source disabled", { id });
      return describe(id);
    }
    if (forcedOff(d)) throw problem("STATE_CONFLICT", `${d.name} is switched off in the config file (sources.providers.${id}.enabled is false). Change it there first.`, { retryable: false });
    if (!configuredOf(d)) throw problem("STATE_CONFLICT", `${d.name} needs an API key before it can be switched on. Add one first.`, { retryable: false });
    const patch = { enabled: true };
    if (d.tier === "opt-in") {
      const have = consentOf(id)?.noticeVersion === d.noticeVersion;
      if (acknowledge !== undefined && acknowledge !== d.noticeVersion) {
        throw problem("VALIDATION_FAILED", `acknowledge must equal the notice version "${d.noticeVersion}" shown with ${d.name}.`, { errors: [{ path: "acknowledge", message: `must equal "${d.noticeVersion}"` }] });
      }
      if (acknowledge === undefined && !have) {
        throw problem("VALIDATION_FAILED", `${d.name} needs your acknowledgement first: ${d.terms?.note ?? "it is unofficial or terms-sensitive"} Send acknowledge: "${d.noticeVersion}" once you have read the notice.`, { errors: [{ path: "acknowledge", message: `required: "${d.noticeVersion}"` }] });
      }
      if (acknowledge === d.noticeVersion) patch.consent = { acceptedAt: new Date(nowMs()).toISOString(), noticeVersion: d.noticeVersion };
    }
    state.update(id, patch);
    log?.info?.("source enabled", { id, tier: d.tier });
    return describe(id);
  }

  async function setConfig(id, config) {
    const d = providerOf(id).descriptor;
    if (!isPlain(config)) throw problem("VALIDATION_FAILED", "Send a JSON object such as { \"apiKey\": \"...\" }.");
    const unknown = Object.keys(config).filter((k) => k !== "apiKey");
    if (unknown.length) throw problem("VALIDATION_FAILED", `Unknown setting: ${unknown.join(", ")}. The only setting is apiKey.`, { errors: unknown.map((k) => ({ path: k, message: "unknown setting" })) });
    if (!needsKeyOf(d)) throw problem("VALIDATION_FAILED", `${d.name} does not take an API key.`);
    if (!("apiKey" in config)) throw problem("VALIDATION_FAILED", "Send apiKey (a string), or null to remove the saved key.", { errors: [{ path: "apiKey", message: "required" }] });
    if (config.apiKey === null || config.apiKey === "") {
      if (secrets) await secrets.delete(secretNameFor(id));
      state.update(id, { configured: false, enabled: false });
      log?.info?.("source key removed", { id });
      return { configured: false };
    }
    const key = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
    if (key.length < KEY_MIN || key.length > KEY_MAX || /[\s\u0000-\u001f\u007f]/.test(key)) {
      throw problem("VALIDATION_FAILED", `apiKey must be ${KEY_MIN} to ${KEY_MAX} characters with no spaces.`, { errors: [{ path: "apiKey", message: `${KEY_MIN} to ${KEY_MAX} characters, no spaces` }] });
    }
    if (!secrets) throw problem("INTERNAL", "The secrets store is not available.");
    deps.logger?.addSecret?.(key);
    await secrets.set(secretNameFor(id), { apiKey: key });
    state.update(id, { configured: true });
    log?.info?.("source key saved", { id });
    return { configured: true };
  }

  async function test(id) {
    const p = providerOf(id);
    const d = p.descriptor;
    if (needsKeyOf(d) && !configuredOf(d)) return { ok: false, latencyMs: 0, detail: "Add an API key first." };
    if (typeof p.test !== "function") return { ok: false, latencyMs: 0, detail: "This source has no connection test." };
    const t0 = performance.now();
    const key = needsKeyOf(d) ? await readKey(id) : null;
    touch(id);
    try {
      const r = await runWithLimits((ctx) => p.test(ctx), { key });
      const latencyMs = Number.isFinite(r?.latencyMs) ? Math.max(0, Math.round(r.latencyMs)) : Math.round(performance.now() - t0);
      recordOutcome(id, { ok: Boolean(r?.ok), ms: latencyMs, kind: r?.ok ? "ok" : "error", message: r?.detail });
      return { ok: Boolean(r?.ok), latencyMs, ...(typeof r?.detail === "string" && r.detail ? { detail: scrub(r.detail, key) } : {}) };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - t0);
      const info = toProblem(err, key);
      recordOutcome(id, { ok: false, ms: latencyMs, kind: outcomeKindOf(info), message: info.message });
      return { ok: false, latencyMs, detail: info.message };
    }
  }

  const consentFor = (id) => {
    providerOf(id);
    return consentOf(id);
  };

  // ── Reading through a source ──
  /** A thrown value as { code, message } with the key scrubbed out. */
  function toProblem(err, key) {
    if (err?.name === "TimeoutError" || err?.code === "UPSTREAM_TIMEOUT") return { code: "UPSTREAM_TIMEOUT", message: "The data source did not answer in time." };
    const code = typeof err?.code === "string" && ERROR_CODES[err.code] ? err.code : "UPSTREAM_ERROR";
    return { code, message: scrub(err instanceof Error ? err.message : "The data source failed.", key) };
  }

  /**
   * Run fn(ctx) with { signal, now } under the call timeout and the caller's signal. Rejects with a BridgeError
   * UPSTREAM_TIMEOUT at the deadline even if the source ignores the signal, or with an AbortError if the caller aborted.
   */
  async function runWithLimits(fn, { key = null, signal, deadlineMs } = {}) {
    const ctrl = new AbortController();
    const limit = Math.max(50, Math.min(timeoutMs(), Number.isFinite(deadlineMs) ? deadlineMs : timeoutMs()));
    let timer;
    let onCallerAbort;
    const stop = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new BridgeError("UPSTREAM_TIMEOUT", "The data source did not answer in time.");
        ctrl.abort(err);
        reject(err);
      }, limit);
      if (signal) {
        onCallerAbort = () => {
          const err = Object.assign(new Error("aborted"), { name: "AbortError" });
          ctrl.abort(err);
          reject(err);
        };
        if (signal.aborted) onCallerAbort();
        else signal.addEventListener("abort", onCallerAbort, { once: true });
      }
    });
    stop.catch(() => {});
    const ctx = { signal: ctrl.signal, now: nowMs(), ...(key ? { apiKey: key } : {}) };
    try {
      return await Promise.race([Promise.resolve().then(() => fn(ctx)), stop]);
    } finally {
      clearTimeout(timer);
      if (signal && onCallerAbort) signal.removeEventListener("abort", onCallerAbort);
    }
  }

  /** Why a provider may not serve this request, or null when it may. */
  function eligible(p, capability, req) {
    const d = p.descriptor;
    if (d.kind === "broker") return "broker";
    if (!enabledOf(d)) return "not enabled";
    if (!d.capabilities.includes(capability) || typeof p[capability] !== "function") return "capability";
    if (!classAllowedFor(d.class, req.purpose ?? "display")) return "class not allowed for this purpose";
    if (!meetsMaxAge(d, req.maxAgeMs)) return "too slow for maxAgeMs";
    return null;
  }
  /** Everything the facade may use for this read, most current class first, then registration order. */
  function eligibleSources(capability, req = {}) {
    return registry
      .list()
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => eligible(p, capability, req) === null)
      .sort((a, b) => classRank(a.p.descriptor.class) - classRank(b.p.descriptor.class) || a.i - b.i)
      .map(({ p }) => p);
  }
  /**
   * THE selection point. Returns the providers to try, in order. The default is eligibleSources(); the router
   * replaces it (setPicker) with one that scores by spare budget and health. Whatever it returns is filtered again
   * through the same eligibility rules.
   */
  async function pickSources(capability, req = {}) {
    const chosen = picker ? await picker(capability, req, { eligibleSources: () => eligibleSources(capability, req), registry }) : eligibleSources(capability, req);
    const seen = new Set();
    // `sourceId` is the router's choice: this read goes to that source only (it still has to be eligible), never to another.
    const only = typeof req.sourceId === "string" ? req.sourceId : null;
    return (Array.isArray(chosen) ? chosen : []).filter((p) => p?.descriptor && (only === null || p.descriptor.id === only) && registry.get(p.descriptor.id) === p && !seen.has(p) && seen.add(p) && eligible(p, capability, req) === null);
  }

  /** Call one source, count the call, record the outcome. Throws a BridgeError (or AbortError). */
  async function callOne(p, capability, fn, opts) {
    const d = p.descriptor;
    const key = needsKeyOf(d) ? await readKey(d.id) : null;
    const t0 = performance.now();
    touch(d.id);
    try {
      const out = await runWithLimits(fn, { key, signal: opts.signal, deadlineMs: opts.deadlineMs });
      recordOutcome(d.id, { ok: true, ms: Math.round(performance.now() - t0), kind: "ok" }, { toTracker: trackerRecordsCalls });
      return out;
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      const info = toProblem(err, key);
      // A 429, an auth failure or a not-found says nothing about the source being down; the router decides what trips.
      recordOutcome(d.id, { ok: false, ms: Math.round(performance.now() - t0), kind: outcomeKindOf(info), message: info.message }, { toTracker: trackerRecordsCalls });
      log?.warn?.("source call failed", { id: d.id, capability, code: info.code });
      throw new BridgeError(info.code, `${d.name}: ${info.message}`);
    }
  }

  const label = (p) => {
    const d = p.descriptor;
    return { provider: d.id, class: d.class, delaySec: d.class === "realtime" ? 0 : (d.delaySec ?? null), official: d.official };
  };
  const atOf = (out) => (Number.isFinite(out?.at) ? out.at : nowMs());
  const reqOf = (capability, opts, extra) => ({ capability, purpose: opts?.purpose ?? "display", maxAgeMs: opts?.maxAgeMs ?? null, ...(typeof opts?.sourceId === "string" ? { sourceId: opts.sourceId } : {}), ...extra });
  const noneEnabled = (what) => new BridgeError("CAPABILITY_UNSUPPORTED", `No enabled data source can answer ${what}. Switch one on under Sources.`);
  const unusable = (p) => new BridgeError("UPSTREAM_ERROR", `${p.descriptor.name} returned an answer the Bridge cannot read.`);

  /** Try the picked sources in order until one answers; rethrow the last failure when none does. */
  async function firstAnswer(capability, req, what, opts, call, valid) {
    const list = await pickSources(capability, req);
    if (!list.length) throw noneEnabled(what);
    let last = null;
    for (const p of list) {
      try {
        const out = await callOne(p, capability, (ctx) => call(p, ctx), opts);
        if (!valid(out)) throw unusable(p);
        return { p, out };
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        last = err;
      }
    }
    throw last;
  }

  const facade = {
    /**
     * @param {string[]} symbols canonical symbols
     * @param {{ maxAgeMs?: number, purpose?: string, signal?: AbortSignal, deadlineMs?: number }} [opts]
     * @returns {Promise<{ items: Array<{ symbol: string, fields: object, at: number, provider: string, class: string, delaySec: number|null, official: boolean }>, errors: Array<{ symbol: string, code: string, message: string }> }>}
     */
    async quotes(symbols, opts = {}) {
      const wanted = [...new Set(Array.isArray(symbols) ? symbols : [])];
      const items = [];
      const errors = new Map();
      if (!wanted.length) return { items, errors: [] };
      const list = await pickSources("quotes", reqOf("quotes", opts, { symbols: wanted }));
      if (!list.length) {
        const e = noneEnabled("quotes");
        return { items, errors: wanted.map((symbol) => ({ symbol, code: e.code, message: e.detail })) };
      }
      const remaining = new Set(wanted);
      for (const p of list) {
        if (!remaining.size) break;
        const ask = [...remaining];
        try {
          const out = await callOne(p, "quotes", (ctx) => p.quotes(ask, ctx), opts);
          for (const it of Array.isArray(out?.items) ? out.items : []) {
            if (!remaining.has(it?.symbol) || !isPlain(it.fields)) continue;
            remaining.delete(it.symbol);
            errors.delete(it.symbol);
            items.push({ symbol: it.symbol, fields: it.fields, at: atOf(it), ...label(p) });
          }
          for (const symbol of remaining) errors.set(symbol, { code: "SYMBOL_NOT_FOUND", message: `${p.descriptor.name} has no quote for ${symbol}.` });
        } catch (err) {
          if (err?.name === "AbortError") throw err;
          for (const symbol of remaining) errors.set(symbol, { code: err.code ?? "UPSTREAM_ERROR", message: err.detail ?? err.message });
        }
      }
      const order = new Map(wanted.map((s, i) => [s, i]));
      items.sort((a, b) => order.get(a.symbol) - order.get(b.symbol));
      return { items, errors: [...errors].map(([symbol, e]) => ({ symbol, ...e })) };
    },

    /**
     * @param {{ symbol: string, interval: string, fromMs: number, toMs: number, maxAgeMs?: number, purpose?: string }} req
     * @param {{ maxAgeMs?: number, purpose?: string, signal?: AbortSignal, deadlineMs?: number }} [opts]
     */
    async history(req, opts = {}) {
      const merged = { ...opts, purpose: req?.purpose ?? opts.purpose, maxAgeMs: req?.maxAgeMs ?? opts.maxAgeMs, sourceId: req?.sourceId ?? opts.sourceId };
      const { p, out } = await firstAnswer(
        "history",
        reqOf("history", merged, { symbols: [req?.symbol] }),
        "history",
        opts,
        (src, ctx) => src.history({ symbol: req.symbol, interval: req.interval, fromMs: req.fromMs, toMs: req.toMs }, ctx),
        (o) => Array.isArray(o?.candles),
      );
      return { symbol: req.symbol, interval: req.interval, candles: out.candles, partial: Boolean(out.partial), at: atOf(out), ...label(p) };
    },

    /** @param {string} underlying @param {{ maxAgeMs?: number, purpose?: string, signal?: AbortSignal, deadlineMs?: number }} [opts] */
    async expiries(underlying, opts = {}) {
      const { p, out } = await firstAnswer("expiries", reqOf("expiries", opts, { symbols: [underlying] }), "expiries", opts, (src, ctx) => src.expiries(underlying, ctx), (o) => Array.isArray(o?.expiries));
      return { underlying, expiries: out.expiries, at: atOf(out), ...label(p) };
    },

    /** @param {string} underlying @param {string} [expiry] @param {{ maxAgeMs?: number, purpose?: string, signal?: AbortSignal, deadlineMs?: number }} [opts] */
    async optionChain(underlying, expiry, opts = {}) {
      const { p, out } = await firstAnswer("optionChain", reqOf("optionChain", opts, { symbols: [underlying] }), "an option chain", opts, (src, ctx) => src.optionChain(underlying, expiry, ctx), (o) => Array.isArray(o?.rows));
      return { underlying, expiry: out.expiry ?? expiry ?? null, rows: out.rows, underlyingLtp: out.underlyingLtp ?? null, at: atOf(out), ...label(p) };
    },

    /** @returns {{ enabled: boolean, autoFallback: boolean, providers: object[], order: string[], cacheMs: number }} */
    status() {
      const usable = registry.list().filter((p) => p.descriptor.kind !== "broker");
      const order = eligibleOrderAll();
      return {
        enabled: usable.some((p) => enabledOf(p.descriptor)),
        autoFallback: cfg.autoFallback,
        providers: usable.map((p) => {
          const d = p.descriptor;
          return { id: d.id, name: d.name, enabled: enabledOf(d), configured: configuredOf(d), class: d.class, delaySec: d.class === "realtime" ? 0 : (d.delaySec ?? null), official: d.official };
        }),
        order,
        cacheMs: 0,
      };
    },

    /** Whether a read no broker could answer may go to a source without being asked (config sources.autoFallback). */
    autoFallback() {
      return cfg.autoFallback;
    },
  };

  /** Ids of the enabled sources in default order, for status(). */
  function eligibleOrderAll() {
    return registry
      .list()
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.descriptor.kind !== "broker" && enabledOf(p.descriptor))
      .sort((a, b) => classRank(a.p.descriptor.class) - classRank(b.p.descriptor.class) || a.i - b.i)
      .map(({ p }) => p.descriptor.id);
  }

  return {
    ...facade,
    // management API
    list: () => registry.list().map((p) => describe(p.descriptor.id)),
    describe,
    setEnabled,
    setConfig,
    test,
    consentFor,
    // extension points for the router and other modules
    registry,
    pickSources,
    eligibleSources,
    /** Replace the selector: fn(capability, req, { eligibleSources, registry }) returns providers in the order to try. Pass null to restore the default. */
    setPicker(fn) {
      if (fn !== null && typeof fn !== "function") throw new TypeError("setPicker needs a function or null");
      picker = fn;
    },
    /**
     * Let a health tracker supply `state(id)` for the list. By default the service also reports every call's outcome to
     * it; pass `{ recordsCalls: false }` when the caller of the facade (the market service) records them itself, so no call counts twice.
     */
    attachHealth(tracker, { recordsCalls = true } = {}) {
      healthTracker = tracker ?? null;
      trackerRecordsCalls = recordsCalls !== false;
    },
    refresh,
    usage: usageOf,
    /** Whether this source is enabled right now (all rules applied). */
    isEnabled: (id) => enabledOf(providerOf(id).descriptor),
  };
}
