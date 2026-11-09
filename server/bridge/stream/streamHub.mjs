/**
 * StreamHub. Contract: SERVICE_CONTRACTS.streamHub in ../core/contracts.mjs.
 *
 * What it does
 *  - Upstream manager: at most ONE broker feed per account (adapter.createFeed(creds, { onTick, onStatus })), shared by
 *    every local client: the WebSocket and SSE endpoints, MarketDataService's streaming-first reads, live candles.
 *  - Reference-counted subscriptions: two clients on NSE:NIFTY cost one upstream subscription; the upstream one goes
 *    away when the last client leaves (optionally after `unsubscribeLingerMs`, to absorb reconnect churn).
 *  - Upstream mode = the highest mode any client asked for (ltp < quote < depth). The current adapters always stream
 *    their fullest packet, so the mode is bookkeeping plus an optional `feed.setMode(refs, mode)` hook.
 *  - Caps: per feed, the smallest of `stream.maxSubscriptionsPerUpstream`, the broker policy's `feed.maxSubscriptions`
 *    and FEED_LIMITS.maxSubscriptions (brokers/upstreamFeedLimits.mjs); per client, `stream.maxSymbolsPerClient`.
 *    Crossing a cap is reported to the caller as SUBSCRIPTION_LIMIT, never a silent drop.
 *  - Account choice: accounts.marketDataCandidates({ capability: "feed" }), which already applies the user's pooling
 *    setting and the broker's terms (pooling "allowed" only). Among candidates the feed with the most free room wins;
 *    a symbol stays on the account that first served it. Credentials never move between accounts.
 *  - Recovery: adapters reconnect by themselves; if a feed has not recovered within `adapterGraceMs` the hub closes it
 *    and builds a new one with jittered exponential back-off, resubscribing everything. A new broker session
 *    ("account.status" -> connected) rebuilds the feed at once; an ended session parks it until the next login.
 *  - Emits "tick" (canonical Tick) and "stream.status" on the bus; a connected feed with no tick for `staleAfterMs`
 *    reports state "stale".
 *  - Watchdog for half-open sockets (the connection looks open but no frames arrive, and the adapter never notices):
 *    during market hours a feed silent for `staleRebuildAfterMs` is closed and rebuilt with the same back-off as any
 *    other failure, and a feed that never reports "connected" within `connectTimeoutMs` is rebuilt too. This runs in the
 *    hub, so every adapter's feed gets it without touching the adapter. The hub never gives up: every failure schedules
 *    another attempt (back-off capped at `backoff.maxMs`), and a rebuild resubscribes each symbol exactly once.
 *
 * Batching: subscribe/unsubscribe calls made in the same turn of the event loop reach the adapter as one call per feed.
 * Memory: the hub keeps one last tick per subscribed symbol and nothing per tick; downstream queues live in protocol.mjs.
 */
import { FEED_LIMITS } from "../../brokers/upstreamFeedLimits.mjs";
import { marketSession } from "../../lib/marketHours.mjs";
import { BridgeError } from "../core/errors.mjs";
import { resolveStreamConfig } from "./config.mjs";

/** @typedef {import("../core/contracts.mjs").Tick} Tick */
/** @typedef {import("../core/contracts.mjs").StreamMode} StreamMode */

export const STREAM_MODES = Object.freeze(["ltp", "quote", "depth"]);
const MODE_RANK = Object.freeze({ ltp: 0, quote: 1, depth: 2 });

/** Highest of a list of modes ("ltp" when empty). @param {Iterable<StreamMode>} modes @returns {StreamMode} */
export function maxMode(modes) {
  let best = "ltp";
  for (const m of modes) if (MODE_RANK[m] > MODE_RANK[best]) best = m;
  return best;
}

const num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const refKeyOf = (ref) => `${String(ref.exchange ?? "").toUpperCase()}:${String(ref.token)}`;

/**
 * Map an adapter Quote (brokers/contract.mjs) to a canonical Tick. Returns null for a quote without a usable price.
 * @param {object} q  adapter quote
 * @param {{ symbol: string, accountId: string, broker: string, receivedAt: number }} meta
 * @returns {Tick | null}
 */
export function quoteToTick(q, { symbol, accountId, broker, receivedAt }) {
  const ltp = num(q?.ltp ?? q?.last_price);
  if (ltp === null || ltp <= 0) return null;
  const ts = num(q.exchangeTs ?? q.ltt ?? q.timestamp);
  /** @type {Tick & { depth?: object }} */
  const tick = {
    symbol,
    ltp,
    bid: num(q.bid),
    ask: num(q.ask),
    bidQty: num(q.bidQty),
    askQty: num(q.askQty),
    volume: num(q.volume),
    oi: num(q.oi),
    open: num(q.open),
    high: num(q.high),
    low: num(q.low),
    close: num(q.close),
    exchangeTs: ts !== null && ts > 0 ? ts : null,
    receivedAt,
    accountId,
    broker,
  };
  if (q.depth && Array.isArray(q.depth.bids) && Array.isArray(q.depth.asks)) {
    const level = (l) => ({ price: num(l?.price), qty: num(l?.qty), orders: num(l?.orders) });
    tick.depth = { bids: q.depth.bids.slice(0, 20).map(level), asks: q.depth.asks.slice(0, 20).map(level) };
  }
  return tick;
}

/**
 * Jittered exponential back-off: the full value at attempt n is min(max, initial * 2^n); the result is 50-100 % of it.
 * @param {number} attempt 0-based @param {{ initialMs: number, maxMs: number }} b @param {() => number} [random]
 */
export function backoffDelay(attempt, b, random = Math.random) {
  const full = Math.min(b.maxMs, b.initialMs * 2 ** Math.min(attempt, 30));
  return Math.round(full * (0.5 + random() * 0.5));
}

const SESSION_ENDED = (up) => `The ${up.broker} session for ${up.accountId} has ended. Log in again from the Bridge to resume live prices.`;

/**
 * @param {object} deps  Core deps plus `accounts` and `symbols` (SERVICE_CONTRACTS.streamHub.requires).
 * @param {{ random?: () => number, marketOpen?: () => boolean }} [opts]  random: injectable back-off jitter for tests;
 *   marketOpen: whether ticks are expected now (default: the IST regular or special session), used by the silence watchdog.
 * @returns {object} StreamHub (contract methods plus internal helpers used by this stream's endpoints)
 */
export function createStreamHub(deps, { random = Math.random, marketOpen } = {}) {
  const { accounts, symbols, bus, clock } = deps;
  const cfg = resolveStreamConfig(deps.config?.stream);
  const log = deps.logger.child({ module: "stream" });
  const now = () => clock.now();
  const isMarketOpen =
    marketOpen ??
    (() => {
      const state = marketSession(new Date(now())).state;
      return state === "OPEN" || state === "SPECIAL";
    });

  /**
   * @typedef {{ id: string, symbols: Map<string, StreamMode>, aliases: Map<string, string>, pending: number,
   *   sink: ((tick: Tick, mode: StreamMode) => void) | null }} Client
   * @typedef {{ symbol: string, accountId: string, refKey: string, ref: { token: string, exchange: string },
   *   clients: Map<string, StreamMode>, mode: StreamMode, lastTick: Tick | null, linger: any }} Sub
   */
  /** @type {Map<string, Client>} */
  const clients = new Map();
  /** @type {Map<string, Sub>} canonical symbol -> subscription */
  const subs = new Map();
  /** @type {Map<string, Promise<Sub>>} symbols being placed on an upstream right now (dedupes concurrent subscribes) */
  const pendingSubs = new Map();
  /** @type {Map<string, any>} accountId -> upstream */
  const upstreams = new Map();
  let staleTimer = null;
  let stopped = false;

  // ───────────────────────── upstream manager ─────────────────────────

  const policyLimit = (accountId) => {
    let policy = null;
    try {
      policy = accounts.capabilities(accountId)?.policy ?? null;
    } catch {
      policy = null;
    }
    const caps = [cfg.maxSubscriptionsPerUpstream, policy?.feed?.maxSubscriptions].filter((v) => typeof v === "number" && v > 0);
    return caps.length ? Math.min(...caps) : FEED_LIMITS.maxSubscriptions;
  };

  const publicState = (up) => (up.connected ? (up.stale ? "stale" : "up") : "down");

  const statusPayload = (up) => ({
    accountId: up.accountId,
    broker: up.broker,
    connected: up.connected,
    state: publicState(up),
    detail: up.state,
    reason: up.reason,
    subscriptions: up.refs.size,
  });

  const emitStatus = (up, force = false) => {
    const sig = `${up.connected}|${up.stale}|${up.state}|${up.reason ?? ""}`;
    if (!force && sig === up.lastSig) return;
    up.lastSig = sig;
    bus.emit("stream.status", statusPayload(up));
  };

  const clearTimers = (up) => {
    clearTimeout(up.retryTimer);
    clearTimeout(up.graceTimer);
    clearTimeout(up.idleTimer);
    up.retryTimer = up.graceTimer = up.idleTimer = null;
  };

  const closeFeed = (up) => {
    up.gen += 1; // callbacks from the old feed are ignored from now on
    const feed = up.feed;
    up.feed = null;
    up.connected = false;
    up.stale = false;
    if (feed) {
      try {
        feed.close();
      } catch (err) {
        log.debug("feed close failed", { accountId: up.accountId, code: err?.code });
      }
    }
  };

  const ensureStaleTimer = () => {
    if (staleTimer || stopped) return;
    const every = Math.max(1000, Math.min(15_000, Math.floor(cfg.staleAfterMs / 2)));
    staleTimer = setInterval(checkStale, every);
    staleTimer.unref?.();
  };

  function checkStale() {
    const t = now();
    for (const up of [...upstreams.values()]) {
      // A feed that was built but never reported "connected": the handshake hung. Rebuild it.
      if (!up.connected && up.feed && up.state === "connecting" && up.feedStartedAt !== null && t - up.feedStartedAt >= cfg.connectTimeoutMs) {
        log.warn("stream feed did not connect in time; rebuilding", { accountId: up.accountId, broker: up.broker });
        up.rebuilds += 1;
        scheduleRetry(up, `The ${up.broker} feed did not connect within ${Math.round(cfg.connectTimeoutMs / 1000)} s; rebuilding it.`);
        continue;
      }
      if (!up.connected || up.refs.size === 0) continue;
      const since = Math.max(up.lastTickAt ?? 0, up.connectedAt ?? 0, up.lastSubAt ?? 0) || t;
      if (!up.stale && t - since >= cfg.staleAfterMs) {
        up.stale = true;
        up.reason = `No ticks for ${Math.round(cfg.staleAfterMs / 1000)} s (normal outside market hours).`;
        emitStatus(up);
      }
      // Half-open socket: silent for a long time while the market is open. The wait doubles after each rebuild that did
      // not bring a tick, so a holiday (open by the clock, no ticks) costs a few reconnects, not one every few minutes.
      if (up.stale && cfg.staleRebuildAfterMs > 0 && isMarketOpen()) {
        const wait = cfg.staleRebuildAfterMs * 2 ** Math.min(up.silentRebuilds, 4);
        if (t - since >= wait) {
          log.warn("stream feed silent during market hours; rebuilding", { accountId: up.accountId, broker: up.broker, silentMs: t - since });
          up.silentRebuilds += 1;
          up.rebuilds += 1;
          scheduleRetry(up, `No ticks for ${Math.round((t - since) / 1000)} s during market hours, so the ${up.broker} connection may be half-open. Rebuilding the feed.`);
        }
      }
    }
    if (upstreams.size === 0 && staleTimer) {
      clearInterval(staleTimer);
      staleTimer = null;
    }
  }

  function scheduleRetry(up, reason) {
    closeFeed(up);
    clearTimeout(up.retryTimer);
    clearTimeout(up.graceTimer);
    up.graceTimer = null;
    const delay = backoffDelay(up.attempts, cfg.backoff, random);
    up.attempts += 1;
    up.state = "retrying";
    up.reason = reason;
    up.retryTimer = setTimeout(() => {
      up.retryTimer = null;
      startFeed(up);
    }, delay);
    up.retryTimer.unref?.();
    emitStatus(up);
  }

  async function startFeed(up) {
    if (stopped || upstreams.get(up.accountId) !== up) return;
    closeFeed(up);
    const gen = up.gen;
    up.state = "connecting";
    up.reason = null;
    emitStatus(up);
    let creds;
    let adapter;
    try {
      creds = await accounts.creds(up.accountId);
      adapter = accounts.adapter(up.accountId);
    } catch (err) {
      if (gen !== up.gen || upstreams.get(up.accountId) !== up) return;
      if (err?.code === "SESSION_EXPIRED") {
        up.state = "waiting_session";
        up.session = "expired";
        up.reason = SESSION_ENDED(up);
        emitStatus(up);
        return;
      }
      if (err?.code === "CAPABILITY_UNSUPPORTED" || err?.code === "ACCOUNT_NOT_FOUND") {
        up.state = "unsupported";
        up.reason = `Account ${up.accountId} cannot stream live prices.`;
        emitStatus(up);
        return;
      }
      log.warn("stream upstream could not start", { accountId: up.accountId, broker: up.broker, code: err?.code ?? err?.name });
      scheduleRetry(up, `Could not start the ${up.broker} feed; retrying.`);
      return;
    }
    if (gen !== up.gen || upstreams.get(up.accountId) !== up) return;
    if (typeof adapter?.createFeed !== "function") {
      up.state = "unsupported";
      up.reason = `The ${up.broker} adapter has no live feed.`;
      emitStatus(up);
      return;
    }
    let feed;
    try {
      feed = adapter.createFeed(creds, {
        onTick: (q) => onUpstreamTick(up, gen, q),
        onStatus: (s) => onUpstreamStatus(up, gen, s),
      });
    } catch (err) {
      // Never log err.message: adapters may echo request details. The code is enough to diagnose.
      log.warn("stream createFeed failed", { accountId: up.accountId, broker: up.broker, code: err?.code ?? err?.name });
      scheduleRetry(up, `Could not open the ${up.broker} feed; retrying.`);
      return;
    } finally {
      creds = null;
    }
    if (gen !== up.gen || !feed) {
      try {
        feed?.close?.();
      } catch {
        /* already replaced */
      }
      if (!feed && gen === up.gen) scheduleRetry(up, `The ${up.broker} adapter returned no feed; retrying.`);
      return;
    }
    up.feed = feed;
    up.feedStartedAt = now();
    up.pendingSub.clear();
    up.pendingUnsub.clear();
    const refs = [...up.refs.values()];
    up.lastSubAt = now();
    if (refs.length) callFeed(up, "subscribe", refs.map((r) => r.ref));
    for (const mode of ["quote", "depth"]) {
      const list = refs.filter((r) => r.mode === mode).map((r) => r.ref);
      if (list.length) callFeed(up, "setMode", list, mode);
    }
    ensureStaleTimer();
  }

  function callFeed(up, method, refs, mode) {
    const feed = up.feed;
    if (!feed || typeof feed[method] !== "function" || refs.length === 0) return;
    try {
      if (method === "setMode") feed.setMode(refs, mode);
      else feed[method](refs);
    } catch (err) {
      log.warn(`stream feed.${method} failed`, { accountId: up.accountId, broker: up.broker, count: refs.length, code: err?.code ?? err?.name });
    }
  }

  function onUpstreamStatus(up, gen, s) {
    if (gen !== up.gen || stopped) return;
    if (s?.connected) {
      if (!up.connected && up.everConnected) up.reconnects += 1;
      up.connected = true;
      up.everConnected = true;
      up.stale = false;
      up.attempts = 0;
      up.state = "up";
      up.reason = null;
      up.connectedAt = now();
      clearTimeout(up.graceTimer);
      up.graceTimer = null;
      emitStatus(up);
      return;
    }
    up.connected = false;
    up.stale = false;
    up.state = "down";
    up.reason = typeof s?.reason === "string" && s.reason ? s.reason.slice(0, 200) : `The ${up.broker} feed disconnected.`;
    emitStatus(up);
    if (up.graceTimer) return;
    const rebuild = () => {
      up.graceTimer = null;
      if (gen !== up.gen || up.connected || stopped) return;
      scheduleRetry(up, `The ${up.broker} feed did not recover; reconnecting.`);
    };
    if (cfg.adapterGraceMs === 0) rebuild();
    else {
      up.graceTimer = setTimeout(rebuild, cfg.adapterGraceMs);
      up.graceTimer.unref?.();
    }
  }

  function onUpstreamTick(up, gen, q) {
    if (gen !== up.gen || stopped || !q) return;
    const item = up.refs.get(refKeyOf(q));
    if (!item) return;
    const sub = subs.get(item.symbol);
    if (!sub) return;
    const tick = quoteToTick(q, { symbol: item.symbol, accountId: up.accountId, broker: up.broker, receivedAt: now() });
    if (!tick) return;
    if (!up.connected) onUpstreamStatus(up, gen, { connected: true }); // some feeds only prove themselves by ticking
    up.lastTickAt = tick.receivedAt;
    up.silentRebuilds = 0;
    up.ticks += 1;
    if (up.stale) {
      up.stale = false;
      up.reason = null;
      emitStatus(up);
    }
    sub.lastTick = tick;
    bus.emit("tick", tick);
    for (const [clientId, mode] of sub.clients) {
      const sink = clients.get(clientId)?.sink;
      if (!sink) continue;
      try {
        sink(tick, mode);
      } catch (err) {
        log.error("stream client sink failed", { clientId, err });
      }
    }
  }

  function ensureUpstream(accountId) {
    let up = upstreams.get(accountId);
    if (up) {
      clearTimeout(up.idleTimer);
      up.idleTimer = null;
      return up;
    }
    let broker = "unknown";
    try {
      broker = accounts.get(accountId).broker;
    } catch {
      /* the account vanished; startFeed reports it */
    }
    up = {
      accountId,
      broker,
      feed: null,
      gen: 0,
      state: "idle",
      connected: false,
      everConnected: false,
      stale: false,
      reason: null,
      session: "connected",
      refs: new Map(),
      reserved: 0,
      limit: policyLimit(accountId),
      attempts: 0,
      reconnects: 0,
      rebuilds: 0,
      silentRebuilds: 0,
      feedStartedAt: null,
      ticks: 0,
      lastTickAt: null,
      lastSubAt: null,
      connectedAt: null,
      retryTimer: null,
      graceTimer: null,
      idleTimer: null,
      pendingSub: new Map(),
      pendingUnsub: new Map(),
      flushQueued: false,
      lastSig: "",
    };
    upstreams.set(accountId, up);
    startFeed(up);
    return up;
  }

  function closeUpstream(up, reason) {
    clearTimers(up);
    closeFeed(up);
    upstreams.delete(up.accountId);
    up.state = "closed";
    up.reason = reason;
    emitStatus(up, true);
  }

  function queueFlush(up) {
    if (up.flushQueued) return;
    up.flushQueued = true;
    // A macrotask, so every symbol placed in this turn (including ones awaiting instrument lookups) goes in one call.
    setImmediate(() => {
      up.flushQueued = false;
      const unsub = [...up.pendingUnsub].filter(([k]) => !up.refs.has(k)).map(([, ref]) => ref);
      const sub = [...up.pendingSub].filter(([k]) => up.refs.has(k)).map(([, ref]) => ref);
      up.pendingSub.clear();
      up.pendingUnsub.clear();
      if (!up.feed) return; // startFeed subscribes everything in up.refs when the feed opens
      if (sub.length) up.lastSubAt = now();
      callFeed(up, "unsubscribe", unsub);
      callFeed(up, "subscribe", sub);
    });
  }

  // ───────────────────────── account sessions ─────────────────────────

  const offAccount = bus.on("account.status", (p) => {
    const up = upstreams.get(p?.accountId);
    if (!up || stopped) return;
    const prev = up.session;
    up.session = p.session;
    if (p.session === "connected") {
      if (prev !== "connected" || up.state === "waiting_session") {
        up.attempts = 0;
        clearTimeout(up.retryTimer);
        clearTimeout(up.graceTimer);
        up.retryTimer = up.graceTimer = null;
        startFeed(up); // new session: fresh feed with the new credentials, everything resubscribed
      }
      return;
    }
    if (["expired", "missing", "error"].includes(p.session)) {
      clearTimeout(up.retryTimer);
      clearTimeout(up.graceTimer);
      up.retryTimer = up.graceTimer = null;
      closeFeed(up);
      up.state = "waiting_session";
      up.reason = typeof p.message === "string" && p.message ? p.message.slice(0, 200) : SESSION_ENDED(up);
      emitStatus(up);
      migrateUpstream(up).catch((err) => log.warn("stream failover failed", { accountId: up.accountId, code: err?.code ?? err?.name }));
    }
  });

  /**
   * Move every symbol of an upstream whose session ended (or that cannot stream) onto another connected feed account
   * that marketDataCandidates offers (it applies the pooling flags), within each feed's caps. Symbols with no room
   * elsewhere stay parked and resume when this account logs in again. Clients keep their subscriptions throughout.
   */
  async function migrateUpstream(up) {
    if (stopped || up.refs.size === 0) return;
    const moving = [...up.refs.values()].map((r) => subs.get(r.symbol)).filter((sub) => sub && sub.accountId === up.accountId && sub.clients.size > 0);
    let moved = 0;
    for (const old of moving) {
      if (stopped || upstreams.get(up.accountId) !== up || up.session === "connected") break;
      if (subs.get(old.symbol) !== old) continue;
      subs.delete(old.symbol);
      let next = null;
      try {
        next = await placeSymbol(old.symbol, null, { exclude: up.accountId });
      } catch {
        next = null;
      }
      if (!next) {
        if (!subs.has(old.symbol)) subs.set(old.symbol, old); // no room elsewhere: stay parked here
        continue;
      }
      next.clients = old.clients;
      if (old.linger) clearTimeout(old.linger);
      recomputeMode(next);
      up.refs.delete(old.refKey);
      up.pendingSub.delete(old.refKey);
      moved += 1;
    }
    if (moved) {
      up.reason = `${up.reason ?? SESSION_ENDED(up)} ${moved} symbol(s) moved to another connected account.`.slice(0, 300);
      emitStatus(up);
      scheduleIdleClose(up);
    }
  }

  // ───────────────────────── subscriptions ─────────────────────────

  const getClient = (clientId) => {
    let c = clients.get(clientId);
    if (!c) {
      // opSeq/unsubAt: an unsubscribe that arrives while a subscribe for the same symbol is still resolving wins.
      c = { id: clientId, symbols: new Map(), aliases: new Map(), pending: 0, sink: null, opSeq: 0, subsRunning: 0, unsubAt: new Map() };
      clients.set(clientId, c);
    }
    return c;
  };

  const tryParse = (input) => {
    try {
      return symbols.parse(input).canonical;
    } catch {
      return null;
    }
  };

  /** @returns {Promise<{ canonical: string, refs: Record<string, any> | null }>} */
  async function canonicalize(input) {
    const parsed = tryParse(input);
    if (parsed) return { canonical: parsed, refs: null };
    const r = await symbols.resolve(input); // aliases such as NSE:NIFTY1! need instrument data
    return { canonical: r.canonical, refs: r.refs ?? null };
  }

  const freeRoom = (accountId) => {
    const up = upstreams.get(accountId);
    if (!up) return policyLimit(accountId);
    return up.limit - up.refs.size - up.reserved;
  };

  /** Place a symbol on an upstream (or join the in-flight placement). */
  function createSub(symbol, knownRefs) {
    const existing = subs.get(symbol);
    if (existing) return Promise.resolve(existing);
    const inflight = pendingSubs.get(symbol);
    if (inflight) return inflight;
    const p = placeSymbol(symbol, knownRefs).finally(() => {
      pendingSubs.delete(symbol);
      // Close upstreams that were opened only while looking for room and ended up empty.
      for (const up of [...upstreams.values()]) scheduleIdleClose(up);
    });
    pendingSubs.set(symbol, p);
    return p;
  }

  async function placeSymbol(symbol, knownRefs, { exclude = null } = {}) {
    const candidates = (accounts.marketDataCandidates({ capability: "feed" }) ?? []).filter((id) => id !== exclude);
    if (!candidates.length) {
      throw new BridgeError("BROKER_UNAVAILABLE", "No connected broker account can stream live prices. Log in to an account with a live feed from the Bridge.");
    }
    const ordered = candidates.map((id, i) => ({ id, i, room: freeRoom(id) })).sort((a, b) => b.room - a.room || a.i - b.i);
    let lastErr = null;
    let full = null;
    for (const { id } of ordered) {
      if (freeRoom(id) <= 0) {
        full ??= id;
        continue;
      }
      let broker;
      try {
        broker = accounts.get(id).broker;
      } catch (err) {
        lastErr = err;
        continue;
      }
      let ref;
      const known = knownRefs?.[broker];
      if (known?.token) ref = known;
      else {
        try {
          ref = await symbols.toBroker(symbol, broker);
        } catch (err) {
          lastErr = err;
          continue;
        }
      }
      if (stopped) throw new BridgeError("BROKER_UNAVAILABLE", "The Bridge is shutting down.");
      if (freeRoom(id) <= 0) {
        full ??= id;
        continue;
      }
      const r = { token: String(ref.token), exchange: String(ref.exchange ?? symbol.split(":")[0]).toUpperCase() };
      const refKey = refKeyOf(r);
      const up = ensureUpstream(id);
      if (up.refs.has(refKey)) {
        lastErr = new BridgeError("VALIDATION_FAILED", `${symbol} maps to the same ${broker} instrument as ${up.refs.get(refKey).symbol}.`);
        continue;
      }
      /** @type {Sub} */
      const sub = { symbol, accountId: id, refKey, ref: r, clients: new Map(), mode: "ltp", lastTick: null, linger: null };
      subs.set(symbol, sub);
      up.refs.set(refKey, { symbol, ref: r, mode: "ltp" });
      up.pendingUnsub.delete(refKey);
      up.pendingSub.set(refKey, r);
      queueFlush(up);
      return sub;
    }
    if (full) {
      const limit = upstreams.get(full)?.limit ?? policyLimit(full);
      throw new BridgeError("SUBSCRIPTION_LIMIT", `The live feed on ${full} is full (${limit} symbols). Unsubscribe something first.`);
    }
    if (lastErr instanceof BridgeError) throw lastErr;
    throw new BridgeError("SYMBOL_NOT_FOUND", `No connected broker can stream ${symbol}.`);
  }

  function setClientMode(sub, clientId, mode) {
    sub.clients.set(clientId, mode);
    if (sub.linger) {
      clearTimeout(sub.linger);
      sub.linger = null;
    }
    recomputeMode(sub);
  }

  function recomputeMode(sub) {
    const m = maxMode(sub.clients.values());
    if (m === sub.mode) return;
    sub.mode = m;
    const up = upstreams.get(sub.accountId);
    const item = up?.refs.get(sub.refKey);
    if (item) {
      item.mode = m;
      callFeed(up, "setMode", [sub.ref], m);
    }
  }

  function scheduleIdleClose(up) {
    if (up.refs.size > 0 || up.reserved > 0 || up.idleTimer || upstreams.get(up.accountId) !== up) return;
    if (cfg.upstreamIdleMs === 0) {
      closeUpstream(up, "Closed: no symbols subscribed.");
      return;
    }
    up.idleTimer = setTimeout(() => {
      up.idleTimer = null;
      if (up.refs.size === 0 && up.reserved === 0) closeUpstream(up, "Closed: no symbols subscribed.");
    }, cfg.upstreamIdleMs);
    up.idleTimer.unref?.();
  }

  function removeSub(sub) {
    if (subs.get(sub.symbol) !== sub || sub.clients.size > 0) return;
    subs.delete(sub.symbol);
    const up = upstreams.get(sub.accountId);
    if (!up) return;
    up.refs.delete(sub.refKey);
    up.pendingSub.delete(sub.refKey);
    up.pendingUnsub.set(sub.refKey, sub.ref);
    queueFlush(up);
    scheduleIdleClose(up);
  }

  function releaseClientSymbol(client, symbol) {
    if (!client.symbols.delete(symbol)) return false;
    for (const [alias, c] of client.aliases) if (c === symbol) client.aliases.delete(alias);
    const sub = subs.get(symbol);
    if (!sub) return true;
    sub.clients.delete(client.id);
    if (sub.clients.size > 0) {
      recomputeMode(sub);
      return true;
    }
    if (cfg.unsubscribeLingerMs > 0 && !stopped) {
      sub.linger = setTimeout(() => {
        sub.linger = null;
        removeSub(sub);
      }, cfg.unsubscribeLingerMs);
      sub.linger.unref?.();
    } else removeSub(sub);
    return true;
  }

  const forgetIfEmpty = (client) => {
    if (client.symbols.size === 0 && client.pending === 0 && !client.sink && clients.get(client.id) === client) clients.delete(client.id);
  };

  /**
   * Subscribe a client to symbols. Never throws for a single bad symbol: it comes back in `rejected` with a code
   * (VALIDATION_FAILED, SYMBOL_NOT_FOUND, SUBSCRIPTION_LIMIT, BROKER_UNAVAILABLE ...). Re-subscribing a symbol the
   * client already has changes its mode. Throws VALIDATION_FAILED only for a malformed call.
   * @param {string} clientId
   * @param {string[]} input  canonical symbols or aliases (chart tickers, compact with exchange)
   * @param {StreamMode} [mode]
   * @returns {Promise<{ accepted: string[], rejected: Array<{ symbol: string, code: string, message: string }> }>}
   */
  async function subscribe(clientId, input, mode = "ltp") {
    if (typeof clientId !== "string" || !clientId) throw new BridgeError("VALIDATION_FAILED", "clientId is required.");
    if (!Array.isArray(input)) throw new BridgeError("VALIDATION_FAILED", "symbols must be an array.");
    if (!STREAM_MODES.includes(mode)) throw new BridgeError("VALIDATION_FAILED", `mode must be one of ${STREAM_MODES.join(", ")}.`);
    if (stopped) throw new BridgeError("BROKER_UNAVAILABLE", "The Bridge is shutting down.");
    const unique = [...new Set(input.filter((s) => typeof s === "string").map((s) => s.trim()).filter(Boolean))];
    if (unique.length > cfg.maxSymbolsPerRequest) {
      throw new BridgeError("VALIDATION_FAILED", `Subscribe to at most ${cfg.maxSymbolsPerRequest} symbols at a time.`);
    }
    const client = getClient(clientId);
    const mySeq = ++client.opSeq;
    client.subsRunning += 1;
    const unsubscribedSince = (key) => (client.unsubAt.get(key) ?? 0) > mySeq;
    const accepted = [];
    const rejected = [];
    const reject = (symbol, err) => {
      const known = err instanceof BridgeError;
      if (!known) log.error("stream subscribe failed", { symbol, err });
      rejected.push({ symbol, code: known ? err.code : "INTERNAL", message: known ? err.detail : "Could not subscribe to this symbol." });
    };
    const gone = () => clients.get(clientId) !== client;

    client.pending += 1; // keeps the client record alive while we resolve
    let resolved;
    try {
      resolved = await Promise.all(
        unique.map(async (s) => {
          try {
            return { input: s, ...(await canonicalize(s)) };
          } catch (err) {
            return { input: s, err };
          }
        }),
      );
    } finally {
      client.pending -= 1;
    }
    // Pass 1 (synchronous): duplicates, mode changes and the per-client cap; reserve room for new symbols.
    const seen = new Set();
    /** @type {Array<{ input: string, canonical: string, refs: object | null, done?: Sub, err?: unknown }>} */
    const fresh = [];
    /** @type {Array<{ input: string, canonical?: string, err?: unknown, existing?: boolean, item?: object }>} */
    const order = [];
    for (const r of resolved) {
      if (r.err) {
        order.push({ input: r.input, err: r.err });
        continue;
      }
      if (seen.has(r.canonical)) continue;
      seen.add(r.canonical);
      const existing = subs.get(r.canonical);
      if (client.symbols.has(r.canonical) && existing) {
        order.push({ input: r.input, canonical: r.canonical, existing: true });
        continue;
      }
      if (client.symbols.size + client.pending >= cfg.maxSymbolsPerClient) {
        order.push({ input: r.input, err: new BridgeError("SUBSCRIPTION_LIMIT", `This connection already has ${cfg.maxSymbolsPerClient} symbols, the most allowed. Unsubscribe some first.`) });
        continue;
      }
      client.pending += 1;
      const item = { input: r.input, canonical: r.canonical, refs: r.refs };
      fresh.push(item);
      order.push({ input: r.input, canonical: r.canonical, item });
    }
    // Pass 2: place new symbols concurrently, so their upstream subscribe goes out as one batched adapter call.
    await Promise.all(
      fresh.map(async (item) => {
        try {
          item.done = await createSub(item.canonical, item.refs);
        } catch (err) {
          item.err = err;
        } finally {
          client.pending -= 1;
        }
      }),
    );
    // Pass 3: attach to the client, in the order asked.
    for (const o of order) {
      if (o.err) {
        reject(o.input, o.err);
        continue;
      }
      const sub = o.existing ? subs.get(o.canonical) : o.item.done;
      if (!sub) {
        reject(o.input, o.item?.err ?? new BridgeError("SYMBOL_NOT_FOUND", `No connected broker can stream ${o.canonical}.`));
        continue;
      }
      if (gone()) {
        removeSub(sub);
        reject(o.input, new BridgeError("VALIDATION_FAILED", "The client disconnected."));
        continue;
      }
      if (unsubscribedSince(o.canonical) || unsubscribedSince(o.input)) {
        // The client unsubscribed this symbol while we were placing it: do not attach, release the upstream hold.
        removeSub(sub);
        continue;
      }
      client.symbols.set(o.canonical, mode);
      if (o.input !== o.canonical) client.aliases.set(o.input, o.canonical);
      setClientMode(sub, clientId, mode);
      accepted.push(o.canonical);
    }
    client.subsRunning -= 1;
    if (client.subsRunning === 0) client.unsubAt.clear();
    forgetIfEmpty(client);
    return { accepted, rejected };
  }

  /**
   * Unsubscribe a client from symbols (canonical or the alias it subscribed with). Unknown symbols are ignored.
   * @param {string} clientId @param {string[]} input
   */
  function unsubscribe(clientId, input) {
    const client = clients.get(clientId);
    if (!client || !Array.isArray(input)) return;
    for (const s of input) {
      if (typeof s !== "string") continue;
      const key = s.trim();
      const canonical = client.aliases.get(key) ?? (client.symbols.has(key) ? key : tryParse(key) ?? key);
      if (client.subsRunning > 0) {
        const seq = ++client.opSeq;
        client.unsubAt.set(key, seq);
        client.unsubAt.set(canonical, seq);
      }
      releaseClientSymbol(client, canonical);
    }
    forgetIfEmpty(client);
  }

  /** Remove a client and all its subscriptions. @param {string} clientId */
  function dropClient(clientId) {
    const client = clients.get(clientId);
    if (!client) return;
    clients.delete(clientId);
    client.sink = null;
    for (const symbol of [...client.symbols.keys()]) releaseClientSymbol(client, symbol);
  }

  const lookup = (symbol) => {
    if (typeof symbol !== "string") return null;
    return subs.get(symbol) ?? subs.get(tryParse(symbol) ?? "") ?? null;
  };

  /** Latest tick for a subscribed symbol, or null. @param {string} symbol @returns {Tick | null} */
  function lastTick(symbol) {
    return lookup(symbol)?.lastTick ?? null;
  }

  /** True when a connected upstream holds this symbol. @param {string} symbol */
  function isLive(symbol) {
    const sub = lookup(symbol);
    if (!sub) return false;
    const up = upstreams.get(sub.accountId);
    return Boolean(up?.connected && up.feed && up.refs.has(sub.refKey));
  }

  /**
   * The feed behind a live subscription, for judging a quiet symbol's last tick (market data's stream-first chains):
   * when the feed connected (a tick from before is from an earlier connection), when it last delivered any tick, and
   * whether it has gone silent (no tick at all for stream.staleAfterMs). Null when the symbol is not live.
   * @param {string} symbol
   * @returns {{ connectedAt: number|null, lastTickAt: number|null, stale: boolean } | null}
   */
  function feedInfo(symbol) {
    const sub = lookup(symbol);
    if (!sub) return null;
    const up = upstreams.get(sub.accountId);
    if (!(up?.connected && up.feed && up.refs.has(sub.refKey))) return null;
    return { connectedAt: up.connectedAt ?? null, lastTickAt: up.lastTickAt ?? null, stale: Boolean(up.stale) };
  }

  /** @returns {{ clients: number, symbols: number, upstreams: object[] }} */
  function stats() {
    return {
      clients: clients.size,
      symbols: subs.size,
      upstreams: [...upstreams.values()].map((up) => {
        const modes = { ltp: 0, quote: 0, depth: 0 };
        for (const r of up.refs.values()) modes[r.mode] += 1;
        return {
          accountId: up.accountId,
          broker: up.broker,
          connected: up.connected,
          state: publicState(up),
          detail: up.state,
          reason: up.reason,
          subscriptions: up.refs.size,
          limit: up.limit,
          modes,
          reconnects: up.reconnects,
          rebuilds: up.rebuilds,
          ticks: up.ticks,
          lastTickAt: up.lastTickAt === null ? null : new Date(up.lastTickAt).toISOString(),
        };
      }),
    };
  }

  return {
    subscribe,
    unsubscribe,
    dropClient,
    lastTick,
    isLive,
    stats,
    feedInfo,

    // ── internal helpers for this stream's endpoints (other modules use only the contract methods) ──
    /**
     * Deliver this client's ticks to `sink(tick, mode)` (WebSocket/SSE sessions). Creates the client if needed;
     * dropClient() detaches it.
     * @param {string} clientId @param {(tick: Tick, mode: StreamMode) => void} sink
     */
    attachSink(clientId, sink) {
      getClient(clientId).sink = sink;
    },
    /** @param {string} clientId @returns {Array<{ symbol: string, mode: StreamMode }>} */
    clientSymbols(clientId) {
      const c = clients.get(clientId);
      return c ? [...c.symbols].map(([symbol, mode]) => ({ symbol, mode })) : [];
    },
    /** Canonical form of a symbol as this client knows it (alias aware), or null. */
    canonicalFor(clientId, input) {
      const c = clients.get(clientId);
      const key = String(input ?? "").trim();
      return c?.aliases.get(key) ?? (c?.symbols.has(key) ? key : tryParse(key));
    },
    /** Current status of every upstream, in the "stream.status" payload shape. */
    upstreamStatuses() {
      return [...upstreams.values()].map(statusPayload);
    },
    /** The parsed `stream` config this hub runs with. */
    config: cfg,
    /** Close every upstream feed and stop timers. Safe to call twice. */
    stop() {
      if (stopped) return;
      stopped = true;
      offAccount();
      if (staleTimer) clearInterval(staleTimer);
      staleTimer = null;
      for (const sub of subs.values()) if (sub.linger) clearTimeout(sub.linger);
      for (const up of [...upstreams.values()]) closeUpstream(up, "The Bridge is shutting down.");
      subs.clear();
      clients.clear();
    },
  };
}
