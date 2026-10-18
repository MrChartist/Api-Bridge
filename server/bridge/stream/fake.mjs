/**
 * In-memory StreamHub for OTHER streams' tests (S5 streaming-first reads, S10 live bars, S11 MCP). It satisfies
 * SERVICE_CONTRACTS.streamHub exactly (plus the internal helpers this stream's endpoints use), opens no broker feed and
 * lets a test push ticks and flip the upstream state.
 *
 *   import { createFakeStreamHub } from "../stream/fake.mjs";
 *   const hub = createFakeStreamHub({ bus, limit: 100 });      // bus optional: "tick" / "stream.status" are emitted on it
 *   await hub.subscribe("s5-reader", ["NSE:NIFTY"], "ltp");
 *   hub.pushTick({ symbol: "NSE:NIFTY", ltp: 25012.5 });       // fills the other Tick fields
 *   hub.lastTick("NSE:NIFTY").ltp                              // 25012.5
 *   hub.setConnected(false);  hub.isLive("NSE:NIFTY")          // false
 *   hub.calls                                                  // [["subscribe", "s5-reader", ["NSE:NIFTY"], "ltp"], ...]
 *
 * Semantics follow the real hub: symbols are canonicalised with core/symbolFormat.mjs (an unparsable one is rejected
 * with VALIDATION_FAILED, one listed in `unknown` with SYMBOL_NOT_FOUND); `limit` caps distinct upstream symbols and
 * `maxSymbolsPerClient` caps one client, both answered with SUBSCRIPTION_LIMIT; isLive() needs a subscriber and a
 * connected fake upstream; lastTick() is kept only while someone is subscribed.
 */
import { assertService } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { resolveStreamConfig } from "./config.mjs";
import { STREAM_MODES, maxMode } from "./streamHub.mjs";

/**
 * @param {{ bus?: { emit: Function }, clock?: { now(): number }, limit?: number, maxSymbolsPerClient?: number,
 *   accountId?: string, broker?: string, unknown?: string[], connected?: boolean }} [opts]
 */
export function createFakeStreamHub({ bus, clock = { now: () => Date.now() }, limit = 1000, maxSymbolsPerClient = 500, accountId = "fake-acct", broker = "fake", unknown = [], connected = true } = {}) {
  const cfg = resolveStreamConfig({ maxSymbolsPerClient: Math.min(10_000, maxSymbolsPerClient) });
  const clients = new Map(); // id -> { symbols: Map<symbol, mode>, sink }
  const subs = new Map(); // symbol -> { clients: Map<id, mode>, lastTick }
  const missing = new Set(unknown);
  let up = connected;
  const calls = [];

  const canon = (s) => {
    try {
      return parseSymbol(s).canonical;
    } catch {
      return null;
    }
  };
  const status = () => ({ accountId, broker, connected: up, state: up ? "up" : "down", detail: up ? "up" : "down", reason: up ? null : "Fake upstream is down.", subscriptions: subs.size });
  const client = (id) => {
    if (!clients.has(id)) clients.set(id, { symbols: new Map(), sink: null });
    return clients.get(id);
  };
  const release = (id, c, symbol) => {
    if (!c.symbols.delete(symbol)) return;
    const s = subs.get(symbol);
    if (!s) return;
    s.clients.delete(id);
    if (s.clients.size === 0) subs.delete(symbol);
  };

  const hub = {
    async subscribe(clientId, symbols, mode = "ltp") {
      calls.push(["subscribe", clientId, [...symbols], mode]);
      if (!STREAM_MODES.includes(mode)) throw new BridgeError("VALIDATION_FAILED", `mode must be one of ${STREAM_MODES.join(", ")}.`);
      const c = client(clientId);
      const accepted = [];
      const rejected = [];
      for (const input of symbols) {
        const s = canon(input);
        if (!s) rejected.push({ symbol: input, code: "VALIDATION_FAILED", message: `${input} is not a symbol.` });
        else if (missing.has(s)) rejected.push({ symbol: input, code: "SYMBOL_NOT_FOUND", message: `No connected broker can stream ${s}.` });
        else if (!c.symbols.has(s) && c.symbols.size >= cfg.maxSymbolsPerClient) rejected.push({ symbol: input, code: "SUBSCRIPTION_LIMIT", message: "This connection has too many symbols." });
        else if (!subs.has(s) && subs.size >= limit) rejected.push({ symbol: input, code: "SUBSCRIPTION_LIMIT", message: `The live feed on ${accountId} is full (${limit} symbols).` });
        else {
          if (!subs.has(s)) subs.set(s, { clients: new Map(), lastTick: null });
          subs.get(s).clients.set(clientId, mode);
          c.symbols.set(s, mode);
          accepted.push(s);
        }
      }
      return { accepted, rejected };
    },
    unsubscribe(clientId, symbols) {
      calls.push(["unsubscribe", clientId, [...symbols]]);
      const c = clients.get(clientId);
      if (!c) return;
      for (const input of symbols) release(clientId, c, canon(input) ?? input);
    },
    dropClient(clientId) {
      calls.push(["dropClient", clientId]);
      const c = clients.get(clientId);
      if (!c) return;
      clients.delete(clientId);
      for (const s of [...c.symbols.keys()]) release(clientId, c, s);
    },
    lastTick(symbol) {
      return subs.get(canon(symbol) ?? symbol)?.lastTick ?? null;
    },
    isLive(symbol) {
      return up && subs.has(canon(symbol) ?? symbol);
    },
    stats() {
      const modes = { ltp: 0, quote: 0, depth: 0 };
      for (const s of subs.values()) modes[maxMode(s.clients.values())] += 1;
      return { clients: clients.size, symbols: subs.size, upstreams: subs.size ? [{ ...status(), limit, modes, reconnects: 0, ticks: 0, lastTickAt: null }] : [] };
    },

    // ── internal helpers (same as the real hub) ──
    attachSink(clientId, sink) {
      client(clientId).sink = sink;
    },
    clientSymbols(clientId) {
      return [...(clients.get(clientId)?.symbols ?? [])].map(([symbol, mode]) => ({ symbol, mode }));
    },
    canonicalFor(_clientId, input) {
      return canon(input);
    },
    upstreamStatuses() {
      return subs.size ? [status()] : [];
    },
    config: cfg,
    stop() {
      clients.clear();
      subs.clear();
    },

    // ── test helpers ──
    /**
     * Deliver a tick: stored as lastTick (if subscribed), emitted on the bus, sent to client sinks. Missing Tick
     * fields default to null / the fake account. Returns the full Tick.
     * @param {Partial<import("../core/contracts.mjs").Tick> & { symbol: string, ltp: number }} partial
     */
    pushTick(partial) {
      const symbol = canon(partial.symbol) ?? partial.symbol;
      const tick = {
        bid: null, ask: null, bidQty: null, askQty: null, volume: null, oi: null, open: null, high: null, low: null, close: null, exchangeTs: null,
        receivedAt: clock.now(), accountId, broker, ...partial, symbol,
      };
      const s = subs.get(symbol);
      if (s) {
        s.lastTick = tick;
        for (const [id, mode] of s.clients) clients.get(id)?.sink?.(tick, mode);
      }
      bus?.emit("tick", tick);
      return tick;
    },
    /** Flip the fake upstream; emits "stream.status". */
    setConnected(value) {
      up = Boolean(value);
      bus?.emit("stream.status", status());
    },
    calls,
  };
  assertService("streamHub", hub);
  return hub;
}
