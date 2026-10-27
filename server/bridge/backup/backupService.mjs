/**
 * BackupDataService — stream S12. Free public market data (Yahoo Finance, the NSE India website) for when no broker
 * account can answer. Contract: SERVICE_CONTRACTS.backupData in ../core/contracts.mjs.
 *
 * Each provider gets its own pacing (config backup.providers.<id>.perSecond, calls spaced evenly, never in bursts)
 * and a circuit breaker (backup.breaker): after N consecutive failures it is skipped for cooldownMs, so a site that
 * is blocking us is left alone instead of hammered. Quotes are cached for backup.cacheMs.
 *
 * Everything returned names the provider and the time the provider says the value is from. MarketDataService turns
 * that into Freshness { source: "backup", provider }. Nothing here touches broker accounts, credentials or orders.
 */
import { BridgeError } from "../core/errors.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { aggregate, planInterval } from "../market/history.mjs";
import { parseBackupConfig } from "./config.mjs";
import { createHttpClient } from "./httpClient.mjs";
import { createNseProvider } from "./providers/nse.mjs";
import { YAHOO_INTERVALS, createYahooProvider } from "./providers/yahoo.mjs";

/** Errors that say "this provider cannot have it", which do not count against the provider's health. */
const NOT_A_FAILURE = new Set(["SYMBOL_NOT_FOUND", "CAPABILITY_UNSUPPORTED", "VALIDATION_FAILED"]);
/** Longest a call waits for its provider's pacing slot before giving up. */
const MAX_PACING_WAIT_MS = 15_000;
const MAX_SYMBOLS = 500;

/**
 * @param {object} deps core deps (config, logger, clock); tests may add `providers` (id -> provider) and `sleep`.
 */
export function createBackupDataService(deps) {
  // Test-only extras; reading an undeclared key from the scoped deps the app passes throws, so look them up safely.
  const extra = (k) => {
    try {
      return deps[k];
    } catch {
      return undefined;
    }
  };
  const cfg = parseBackupConfig(deps.config?.backup);
  const log = deps.logger?.child ? deps.logger.child({ module: "backup" }) : deps.logger;
  const now = () => deps.clock.now();
  const sleep = extra("sleep") ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const demo = deps.config?.demo === true;
  const enabled = cfg.enabled && !demo;

  const providers =
    extra("providers") ??
    (() => {
      const fetchImpl = extra("fetchImpl") ?? globalThis.fetch;
      return {
        yahoo: createYahooProvider({ http: createHttpClient({ fetchImpl, timeoutMs: cfg.timeoutMs, provider: "Yahoo Finance" }), now }),
        nse: createNseProvider({ http: createHttpClient({ fetchImpl, timeoutMs: cfg.timeoutMs, provider: "NSE India" }), now }),
      };
    })();

  /** id -> { nextAt, failures, openUntil, calls, errors, lastError, lastOkAt } */
  const health = new Map();
  const healthOf = (id) => {
    let h = health.get(id);
    if (!h) {
      h = { nextAt: 0, failures: 0, openUntil: 0, calls: 0, errors: 0, lastError: null, lastOkAt: null };
      health.set(id, h);
    }
    return h;
  };
  /** "q|<symbol>" -> { value, at, cachedAt } */
  const cache = new Map();

  const providerOn = (id) => enabled && Boolean(providers[id]) && cfg.providers[id]?.enabled !== false;

  function assertEnabled() {
    if (!enabled) {
      throw new BridgeError(
        "CAPABILITY_UNSUPPORTED",
        demo ? "Backup data sources are off in demo mode." : 'Backup data sources are off. Set "backup": { "enabled": true } in bridge.config.json to use Yahoo Finance and NSE as a fallback.',
      );
    }
  }

  /** Run fn under the provider's pacing and breaker; record health. */
  async function run(id, fn) {
    const h = healthOf(id);
    const t = now();
    if (h.openUntil > t) {
      throw new BridgeError("BROKER_UNAVAILABLE", `${providers[id].name} is paused for ${Math.ceil((h.openUntil - t) / 1000)} s after repeated failures.`, { retryAfterMs: h.openUntil - t });
    }
    const gap = 1000 / (cfg.providers[id]?.perSecond ?? 1);
    const slot = Math.max(t, h.nextAt);
    if (slot - t > MAX_PACING_WAIT_MS) throw new BridgeError("RATE_LIMITED", `Too many backup requests queued for ${providers[id].name}; try again shortly.`, { retryAfterMs: slot - t });
    h.nextAt = slot + gap;
    if (slot > t) await sleep(slot - t);
    h.calls += 1;
    try {
      const out = await fn(providers[id]);
      h.failures = 0;
      h.lastOkAt = now();
      return out;
    } catch (err) {
      const code = err instanceof BridgeError ? err.code : "INTERNAL";
      if (!NOT_A_FAILURE.has(code)) {
        h.errors += 1;
        h.failures += 1;
        h.lastError = { code, message: err instanceof BridgeError ? err.detail : "Internal error.", at: now() };
        if (h.failures >= cfg.breaker.failures) {
          h.openUntil = now() + cfg.breaker.cooldownMs;
          h.failures = 0;
          log?.warn?.("backup provider paused after repeated failures", { provider: id, cooldownMs: cfg.breaker.cooldownMs });
        }
      }
      if (err instanceof BridgeError) throw err;
      log?.error?.("backup provider failed", { provider: id, err });
      throw new BridgeError("UPSTREAM_ERROR", `${providers[id].name} failed.`);
    }
  }

  /** Providers to try for a symbol, in configured order, that are on and claim to cover it. */
  function chainFor(canonical, what) {
    const p = parseSymbol(canonical);
    const order = p.kind === "INDEX" ? cfg.order.index : cfg.order.equity;
    return order.filter((id) => providerOn(id) && providers[id].covers?.[what]?.includes?.(p.kind) && providers[id].supports(canonical));
  }

  /** Try each provider in turn; the first answer wins. */
  async function firstOf(ids, what, fn) {
    if (!ids.length) throw new BridgeError("CAPABILITY_UNSUPPORTED", `No backup source covers ${what}.`);
    let lastErr;
    for (const id of ids) {
      try {
        return { provider: id, ...(await run(id, fn)) };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async function quoteOne(canonical, maxAgeMs) {
    const key = `q|${canonical}`;
    const c = cache.get(key);
    const ttl = Math.min(cfg.cacheMs, maxAgeMs ?? cfg.cacheMs);
    if (c && ttl > 0 && now() - c.cachedAt <= ttl) return c.value;
    const got = await firstOf(chainFor(canonical, "quotes"), canonical, (p) => p.quote(canonical));
    const value = { symbol: canonical, fields: got.fields, at: got.at, provider: got.provider };
    cache.set(key, { value, cachedAt: now() });
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
    return value;
  }

  return {
    /**
     * Quotes for canonical cash/index symbols.
     * @param {string[]} list canonical symbols
     * @param {{ maxAgeMs?: number }} [opts]
     * @returns {Promise<{ items: Array<{ symbol, fields, at, provider }>, errors: Array<{ symbol, code, message }> }>}
     */
    async quotes(list, opts = {}) {
      assertEnabled();
      if (!Array.isArray(list) || !list.length) throw new BridgeError("VALIDATION_FAILED", "Give at least one symbol.");
      if (list.length > MAX_SYMBOLS) throw new BridgeError("VALIDATION_FAILED", `Ask for at most ${MAX_SYMBOLS} symbols at a time.`);
      const items = [];
      const errors = [];
      await Promise.all(
        list.map(async (s) => {
          try {
            const canonical = parseSymbol(s).canonical;
            items.push(await quoteOne(canonical, opts.maxAgeMs));
          } catch (err) {
            errors.push({ symbol: String(s), code: err instanceof BridgeError ? err.code : "INTERNAL", message: err instanceof BridgeError ? err.detail : "Internal error." });
          }
        }),
      );
      const order = new Map(list.map((s, i) => [String(s), i]));
      items.sort((a, b) => (order.get(a.symbol) ?? 0) - (order.get(b.symbol) ?? 0));
      return { items, errors };
    },

    /**
     * Candles for a cash/index symbol in any Bridge interval (built from Yahoo's bar sizes where needed).
     * @param {{ symbol: string, interval: string, fromMs: number, toMs: number }} p
     * @returns {Promise<{ symbol, interval, candles, partial, provider, at }>}
     */
    async history({ symbol, interval, fromMs, toMs }) {
      assertEnabled();
      const canonical = parseSymbol(symbol).canonical;
      const parts = parseSymbol(canonical);
      const plan = planInterval(interval, YAHOO_INTERVALS);
      const got = await firstOf(chainFor(canonical, "history"), `${canonical} candles`, (p) => p.history(canonical, plan.base, fromMs, toMs));
      const lo = Math.floor(fromMs / 1000);
      const hi = Math.floor(toMs / 1000);
      const candles = aggregate(got.candles, plan, interval, parts.exchange).filter((c) => c.time >= lo - (plan.base === "1d" ? 86_400 : 0) && c.time <= hi);
      return { symbol: canonical, interval, candles, partial: Boolean(got.partial), provider: got.provider, at: now() };
    },

    /** Upcoming option expiries (ISO dates) for an NSE underlying. */
    async expiries(underlying) {
      assertEnabled();
      const u = String(underlying ?? "").toUpperCase();
      const ids = ["nse"].filter((id) => providerOn(id) && providers[id].covers?.optionChain);
      const got = await firstOf(ids, `${u} expiries`, async (p) => ({ expiries: await p.expiries(u) }));
      return { underlying: u, expiries: got.expiries, provider: got.provider, at: now() };
    },

    /** Option chain rows (legs without greeks) for an NSE underlying and expiry. */
    async optionChain(underlying, expiry) {
      assertEnabled();
      const u = String(underlying ?? "").toUpperCase();
      const ids = ["nse"].filter((id) => providerOn(id) && providers[id].covers?.optionChain);
      const got = await firstOf(ids, `${u} option chain`, (p) => p.optionChain(u, expiry));
      return { underlying: u, expiry, rows: got.rows, underlyingLtp: got.underlyingLtp ?? null, provider: got.provider, at: got.at ?? now() };
    },

    /** Configuration and health of every provider. No network calls. */
    status() {
      const t = now();
      return {
        enabled,
        demo,
        autoFallback: enabled && cfg.autoFallback,
        providers: Object.keys(providers).map((id) => {
          const h = healthOf(id);
          return {
            id,
            name: providers[id].name,
            enabled: providerOn(id),
            perSecond: cfg.providers[id]?.perSecond ?? null,
            covers: providers[id].covers,
            paused: h.openUntil > t,
            pausedForMs: Math.max(0, h.openUntil - t),
            calls: h.calls,
            errors: h.errors,
            lastError: h.lastError,
            lastOkAt: h.lastOkAt,
          };
        }),
        order: cfg.order,
        cacheMs: cfg.cacheMs,
        cacheEntries: cache.size,
      };
    },

    /** Whether reads that did not ask either way should fall back on their own. */
    autoFallback: () => enabled && cfg.autoFallback,
  };
}
