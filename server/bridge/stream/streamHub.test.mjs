import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { assertService } from "../core/contracts.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { BridgeError } from "../core/errors.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { backoffDelay, createStreamHub, maxMode, quoteToTick } from "./streamHub.mjs";
import { stubAdapter } from "./__fixtures__/stubFeed.mjs";

const settle = () => new Promise((r) => setImmediate(r));

const INSTRUMENTS = [
  { symbol: "NSE:NIFTY", lotSize: 1, refs: { dhan: { token: "13" }, zerodha: { token: "256265" } } },
  { symbol: "NSE:BANKNIFTY", lotSize: 1, refs: { dhan: { token: "25" }, zerodha: { token: "260105" } } },
  { symbol: "NSE:RELIANCE", lotSize: 1, refs: { dhan: { token: "2885" }, zerodha: { token: "738561" } } },
  { symbol: "NSE:INFY", lotSize: 1, refs: { dhan: { token: "1594" }, zerodha: { token: "408065" } } },
  { symbol: "NFO:NIFTY-2026-10-27-FUT", lotSize: 65, refs: { dhan: { token: "52175" } } },
];

function setup({ stream = {}, policies = {}, accountsList, adapters, symbolsOpts } = {}) {
  const bus = createEventBus({ logger: createNullLogger() });
  const a1 = adapters?.dhan ?? stubAdapter();
  const list = accountsList ?? [{ id: "dhan-main", broker: "dhan", adapter: a1.adapter, capabilities: ["feed", "ltp"], creds: { clientId: "1", accessToken: "secret-token-123" } }];
  const accounts = createFakeAccountManager({ accounts: list, bus, policies });
  const symbols = createFakeSymbolService({ instruments: INSTRUMENTS, today: "2026-10-18", ...symbolsOpts });
  const statuses = [];
  const ticks = [];
  bus.on("stream.status", (p) => statuses.push(p));
  bus.on("tick", (t) => ticks.push(t));
  // random() = 1 gives the full back-off value, so timings are deterministic.
  const hub = createStreamHub({ config: { stream }, logger: createNullLogger(), bus, clock: { now: () => Date.now() }, accounts, symbols }, { random: () => 1 });
  return { bus, accounts, symbols, hub, a1, statuses, ticks };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-10-19T10:00:00+05:30"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("helpers", () => {
  it("maxMode picks the highest demand", () => {
    expect(maxMode([])).toBe("ltp");
    expect(maxMode(["ltp", "depth", "quote"])).toBe("depth");
    expect(maxMode(["quote", "ltp"])).toBe("quote");
  });

  it("quoteToTick maps an adapter quote and drops unusable prices", () => {
    const meta = { symbol: "NSE:NIFTY", accountId: "a", broker: "dhan", receivedAt: 5 };
    expect(quoteToTick({ token: "13", exchange: "NSE", ltp: 0 }, meta)).toBeNull();
    expect(quoteToTick({ token: "13", exchange: "NSE", ltp: Number.NaN }, meta)).toBeNull();
    const t = quoteToTick({ token: "13", exchange: "NSE", ltp: "25000.5", bid: 25000, ask: 25001, volume: 10, ltt: 1760000000000, depth: { bids: [{ price: 1, qty: 2 }], asks: [] } }, meta);
    expect(t).toMatchObject({ symbol: "NSE:NIFTY", ltp: 25000.5, bid: 25000, ask: 25001, volume: 10, exchangeTs: 1760000000000, receivedAt: 5, accountId: "a", broker: "dhan", oi: null });
    expect(t.depth.bids[0]).toEqual({ price: 1, qty: 2, orders: null });
  });

  it("backoffDelay doubles, caps and jitters between 50 and 100 %", () => {
    const b = { initialMs: 1000, maxMs: 30_000 };
    expect(backoffDelay(0, b, () => 1)).toBe(1000);
    expect(backoffDelay(3, b, () => 1)).toBe(8000);
    expect(backoffDelay(10, b, () => 1)).toBe(30_000);
    expect(backoffDelay(3, b, () => 0)).toBe(4000);
  });
});

describe("StreamHub", () => {
  it("satisfies the contract", () => {
    const { hub } = setup();
    expect(() => assertService("streamHub", hub)).not.toThrow();
  });

  it("fans one upstream subscription out to two clients", async () => {
    const { hub, a1, ticks } = setup();
    const got = { c1: [], c2: [] };
    hub.attachSink("c1", (t, mode) => got.c1.push([t.symbol, t.ltp, mode]));
    hub.attachSink("c2", (t, mode) => got.c2.push([t.symbol, t.ltp, mode]));
    const [r1, r2] = await Promise.all([hub.subscribe("c1", ["NSE:NIFTY"], "ltp"), hub.subscribe("c2", ["nse:nifty"], "quote")]);
    expect(r1).toEqual({ accepted: ["NSE:NIFTY"], rejected: [] });
    expect(r2.accepted).toEqual(["NSE:NIFTY"]);
    await settle();
    expect(a1.feeds).toHaveLength(1);
    const feed = a1.last();
    expect(feed.subscribeCalls).toEqual([["13"]]);
    expect(feed.creds.accessToken).toBe("secret-token-123");
    feed.status(true);
    feed.tick("13", "NSE", 25010);
    expect(got.c1).toEqual([["NSE:NIFTY", 25010, "ltp"]]);
    expect(got.c2).toEqual([["NSE:NIFTY", 25010, "quote"]]);
    expect(ticks).toHaveLength(1);
    expect(hub.lastTick("NSE:NIFTY").ltp).toBe(25010);
    expect(hub.isLive("nse:nifty")).toBe(true);
    expect(hub.stats()).toMatchObject({ clients: 2, symbols: 1, upstreams: [{ accountId: "dhan-main", broker: "dhan", connected: true, subscriptions: 1, modes: { ltp: 0, quote: 1, depth: 0 } }] });
  });

  it("batches symbols subscribed together into one adapter call", async () => {
    const { hub, a1 } = setup();
    await hub.subscribe("c1", ["NSE:NIFTY", "NSE:BANKNIFTY", "NSE:RELIANCE"], "ltp");
    await settle();
    expect(a1.last().subscribeCalls).toEqual([["13", "25", "2885"]]);
    await hub.subscribe("c1", ["NSE:INFY"], "ltp");
    await settle();
    expect(a1.last().subscribeCalls).toEqual([["13", "25", "2885"], ["1594"]]);
  });

  it("removes the upstream subscription when the last client leaves, then closes the idle feed", async () => {
    const { hub, a1 } = setup({ stream: { upstreamIdleMs: 5000 } });
    await hub.subscribe("c1", ["NSE:NIFTY", "NSE:RELIANCE"]);
    await hub.subscribe("c2", ["NSE:NIFTY"]);
    await settle();
    const feed = a1.last();
    hub.unsubscribe("c1", ["NSE:NIFTY"]);
    await settle();
    expect(feed.unsubscribeCalls).toEqual([]);
    hub.unsubscribe("c2", ["NSE:NIFTY"]);
    await settle();
    expect(feed.unsubscribeCalls).toEqual([["13"]]);
    expect(hub.lastTick("NSE:NIFTY")).toBeNull();
    hub.dropClient("c1");
    await settle();
    expect(feed.unsubscribeCalls).toEqual([["13"], ["2885"]]);
    expect(hub.stats().symbols).toBe(0);
    expect(feed.closed).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(feed.closed).toBe(true);
    expect(hub.stats().upstreams).toEqual([]);
  });

  it("keeps a symbol upstream during unsubscribeLingerMs and reuses it", async () => {
    const { hub, a1 } = setup({ stream: { unsubscribeLingerMs: 2000 } });
    await hub.subscribe("c1", ["NSE:NIFTY"]);
    await settle();
    hub.unsubscribe("c1", ["NSE:NIFTY"]);
    await settle();
    expect(a1.last().unsubscribeCalls).toEqual([]);
    await hub.subscribe("c2", ["NSE:NIFTY"]);
    vi.advanceTimersByTime(3000);
    await settle();
    expect(a1.last().unsubscribeCalls).toEqual([]);
    expect(a1.last().subscribeCalls).toEqual([["13"]]);
    hub.dropClient("c2");
    vi.advanceTimersByTime(2000);
    await settle();
    expect(a1.last().unsubscribeCalls).toEqual([["13"]]);
  });

  it("sets the upstream mode to the highest demand and lowers it when that client leaves", async () => {
    const a = stubAdapter({ setMode: true });
    const { hub } = setup({ adapters: { dhan: a }, accountsList: [{ id: "dhan-main", broker: "dhan", adapter: a.adapter, capabilities: ["feed"], creds: { t: "x" } }] });
    await hub.subscribe("c1", ["NSE:NIFTY"], "ltp");
    await hub.subscribe("c2", ["NSE:NIFTY"], "depth");
    await settle();
    expect(a.last().modeCalls).toEqual([[["13"], "depth"]]);
    expect(hub.stats().upstreams[0].modes).toEqual({ ltp: 0, quote: 0, depth: 1 });
    hub.dropClient("c2");
    expect(a.last().modeCalls.at(-1)).toEqual([["13"], "ltp"]);
    await hub.subscribe("c1", ["NSE:NIFTY"], "quote"); // re-subscribe changes the client's own mode
    expect(hub.clientSymbols("c1")).toEqual([{ symbol: "NSE:NIFTY", mode: "quote" }]);
    expect(a.last().modeCalls.at(-1)).toEqual([["13"], "quote"]);
  });

  it("returns SUBSCRIPTION_LIMIT to the client that crosses the broker cap", async () => {
    const { hub, a1 } = setup({ policies: { dhan: { feed: { maxConnections: 1, maxSubscriptions: 2 } } } });
    expect((await hub.subscribe("c1", ["NSE:NIFTY", "NSE:BANKNIFTY"])).accepted).toHaveLength(2);
    const r = await hub.subscribe("c2", ["NSE:NIFTY", "NSE:RELIANCE"]);
    expect(r.accepted).toEqual(["NSE:NIFTY"]); // already upstream: costs nothing
    expect(r.rejected).toEqual([{ symbol: "NSE:RELIANCE", code: "SUBSCRIPTION_LIMIT", message: expect.stringContaining("full (2 symbols)") }]);
    await settle();
    expect(a1.last().subscribeCalls.flat()).toEqual(["13", "25"]);
    expect(hub.stats().upstreams[0].limit).toBe(2);
  });

  it("uses the smallest of config, policy and FEED_LIMITS as the cap", async () => {
    const a = setup({ stream: { maxSubscriptionsPerUpstream: 1 }, policies: { dhan: { feed: { maxSubscriptions: 3000 } } } });
    await a.hub.subscribe("c1", ["NSE:NIFTY"]);
    expect(a.hub.stats().upstreams[0].limit).toBe(1);
    const b = setup();
    await b.hub.subscribe("c1", ["NSE:NIFTY"]);
    expect(b.hub.stats().upstreams[0].limit).toBe(1500);
  });

  it("caps symbols per client", async () => {
    const { hub } = setup({ stream: { maxSymbolsPerClient: 2 } });
    const r = await hub.subscribe("c1", ["NSE:NIFTY", "NSE:BANKNIFTY", "NSE:RELIANCE"]);
    expect(r.accepted).toHaveLength(2);
    expect(r.rejected[0]).toMatchObject({ symbol: "NSE:RELIANCE", code: "SUBSCRIPTION_LIMIT" });
    expect((await hub.subscribe("c1", ["NSE:NIFTY"], "quote")).accepted).toEqual(["NSE:NIFTY"]);
  });

  it("refuses an oversized request and a bad mode", async () => {
    const { hub } = setup({ stream: { maxSymbolsPerRequest: 2 } });
    await expect(hub.subscribe("c1", ["NSE:NIFTY", "NSE:BANKNIFTY", "NSE:INFY"])).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(hub.subscribe("c1", ["NSE:NIFTY"], "full")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(hub.subscribe("", ["NSE:NIFTY"])).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects unknown and invalid symbols per symbol, never silently", async () => {
    const { hub } = setup();
    const r = await hub.subscribe("c1", ["NSE:NIFTY", "NSE:DOESNOTEXIST", "%%%"]);
    expect(r.accepted).toEqual(["NSE:NIFTY"]);
    expect(r.rejected.map((x) => [x.symbol, x.code])).toEqual([
      ["NSE:DOESNOTEXIST", "SYMBOL_NOT_FOUND"],
      ["%%%", expect.stringMatching(/VALIDATION_FAILED|SYMBOL_NOT_FOUND/)],
    ]);
  });

  it("says when no connected account can stream", async () => {
    const { hub, accounts } = setup();
    accounts.setState("dhan-main", "expired");
    const r = await hub.subscribe("c1", ["NSE:NIFTY"]);
    expect(r.rejected[0]).toMatchObject({ code: "BROKER_UNAVAILABLE" });
    expect(hub.stats().clients).toBe(0);
  });

  it("accepts aliases, answers with canonical symbols and unsubscribes by alias", async () => {
    const { hub, a1 } = setup();
    const r = await hub.subscribe("c1", ["NSE:NIFTY1!"]);
    expect(r.accepted).toEqual(["NFO:NIFTY-2026-10-27-FUT"]);
    await settle();
    expect(a1.last().subscribeCalls).toEqual([["52175"]]);
    expect(hub.canonicalFor("c1", "NSE:NIFTY1!")).toBe("NFO:NIFTY-2026-10-27-FUT");
    hub.unsubscribe("c1", ["NSE:NIFTY1!"]);
    await settle();
    expect(a1.last().unsubscribeCalls).toEqual([["52175"]]);
  });

  it("spreads symbols over the user's own pooled accounts when the broker allows it", async () => {
    const d = stubAdapter();
    const z = stubAdapter();
    const { hub } = setup({
      policies: { dhan: { pooling: "allowed", feed: { maxSubscriptions: 1 } }, zerodha: { pooling: "allowed", feed: { maxSubscriptions: 1 } } },
      accountsList: [
        { id: "dhan-main", broker: "dhan", adapter: d.adapter, capabilities: ["feed"], pooling: true, creds: { a: "1" } },
        { id: "kite-2", broker: "zerodha", adapter: z.adapter, capabilities: ["feed"], pooling: true, creds: { b: "2" } },
      ],
    });
    const r = await hub.subscribe("c1", ["NSE:NIFTY", "NSE:RELIANCE", "NSE:INFY"]);
    expect(r.accepted).toEqual(["NSE:NIFTY", "NSE:RELIANCE"]);
    expect(r.rejected[0]).toMatchObject({ symbol: "NSE:INFY", code: "SUBSCRIPTION_LIMIT" });
    await settle();
    expect(d.last().subscribeCalls).toEqual([["13"]]);
    expect(z.last().subscribeCalls).toEqual([["738561"]]);
    expect(d.last().creds).toEqual({ a: "1" }); // each feed uses its own account's credentials
    expect(z.last().creds).toEqual({ b: "2" });
  });

  it("does not pool when the broker policy is unknown", async () => {
    const d = stubAdapter();
    const z = stubAdapter();
    const { hub } = setup({
      policies: { dhan: { feed: { maxSubscriptions: 1 } } },
      accountsList: [
        { id: "dhan-main", broker: "dhan", adapter: d.adapter, capabilities: ["feed"], pooling: true },
        { id: "kite-2", broker: "zerodha", adapter: z.adapter, capabilities: ["feed"], pooling: true },
      ],
    });
    const r = await hub.subscribe("c1", ["NSE:NIFTY", "NSE:RELIANCE"]);
    expect(r.accepted).toEqual(["NSE:NIFTY"]);
    expect(r.rejected[0].code).toBe("SUBSCRIPTION_LIMIT");
    expect(z.feeds).toHaveLength(0);
  });

  it("rebuilds a feed that does not recover and resubscribes everything", async () => {
    const { hub, a1, statuses } = setup({ stream: { adapterGraceMs: 10_000, backoff: { initialMs: 1000, maxMs: 30_000 } } });
    await hub.subscribe("c1", ["NSE:NIFTY", "NSE:BANKNIFTY"]);
    await hub.subscribe("c2", ["NSE:RELIANCE"]);
    await settle();
    const first = a1.last();
    first.status(true);
    first.status(false, "socket closed");
    expect(hub.isLive("NSE:NIFTY")).toBe(false);
    expect(statuses.at(-1)).toMatchObject({ accountId: "dhan-main", connected: false, state: "down", reason: "socket closed", subscriptions: 3 });
    vi.advanceTimersByTime(9999);
    expect(a1.feeds).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(first.closed).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ detail: "retrying" });
    vi.advanceTimersByTime(1000);
    await settle();
    expect(a1.feeds).toHaveLength(2);
    const second = a1.last();
    expect(second.subscribeCalls).toEqual([["13", "25", "2885"]]);
    first.tick("13", "NSE", 1); // callbacks from the old feed are ignored
    expect(hub.lastTick("NSE:NIFTY")).toBeNull();
    second.status(true);
    second.tick("13", "NSE", 25000);
    expect(hub.lastTick("NSE:NIFTY").ltp).toBe(25000);
    expect(hub.stats().upstreams[0]).toMatchObject({ connected: true, reconnects: 1, subscriptions: 3 });
  });

  it("feedInfo says when the feed behind a symbol connected and last ticked (quiet strikes)", async () => {
    const { hub, a1 } = setup({ stream: { adapterGraceMs: 10_000 } });
    await hub.subscribe("c1", ["NSE:NIFTY", "NSE:RELIANCE"]);
    await settle();
    expect(hub.feedInfo("NSE:NIFTY")).toBeNull(); // not connected yet
    a1.last().status(true);
    const info = hub.feedInfo("NSE:NIFTY");
    expect(info).toMatchObject({ lastTickAt: null, stale: false });
    expect(Number.isFinite(info.connectedAt)).toBe(true);
    vi.advanceTimersByTime(1500);
    a1.last().tick("2885", "NSE", 2900); // RELIANCE ticks; NIFTY is quiet
    const after = hub.feedInfo("NSE:NIFTY");
    expect(after.lastTickAt).toBe(hub.lastTick("NSE:RELIANCE").receivedAt);
    expect(after.lastTickAt).toBeGreaterThan(after.connectedAt);
    expect(hub.feedInfo("NSE:INFY")).toBeNull(); // not subscribed
  });

  it("leaves a feed alone when the adapter reconnects within the grace period", async () => {
    const { hub, a1 } = setup({ stream: { adapterGraceMs: 10_000 } });
    await hub.subscribe("c1", ["NSE:NIFTY"]);
    await settle();
    a1.last().status(true);
    a1.last().status(false);
    vi.advanceTimersByTime(5000);
    a1.last().status(true);
    vi.advanceTimersByTime(60_000);
    expect(a1.feeds).toHaveLength(1);
    expect(hub.isLive("NSE:NIFTY")).toBe(true);
  });

  it("backs off with growing delays while createFeed keeps failing, without logging secrets", async () => {
    const lines = [];
    const a = stubAdapter({ throwOnCreate: 2 });
    const bus = createEventBus();
    const accounts = createFakeAccountManager({ accounts: [{ id: "dhan-main", broker: "dhan", adapter: a.adapter, capabilities: ["feed"], creds: { accessToken: "secret-token-123" } }], bus });
    const { createLogger } = await import("../core/logger.mjs");
    const logger = createLogger({ level: "debug", write: (l) => lines.push(l) });
    const hub = createStreamHub({ config: {}, logger, bus, clock: { now: () => Date.now() }, accounts, symbols: createFakeSymbolService({ instruments: INSTRUMENTS }) }, { random: () => 1 });
    await hub.subscribe("c1", ["NSE:NIFTY"]);
    await settle();
    expect(a.feeds).toHaveLength(0);
    vi.advanceTimersByTime(999);
    await settle();
    expect(a.feeds).toHaveLength(0);
    vi.advanceTimersByTime(1);
    await settle(); // second attempt fails too -> 2 s
    vi.advanceTimersByTime(1999);
    await settle();
    expect(a.feeds).toHaveLength(0);
    vi.advanceTimersByTime(1);
    await settle();
    expect(a.feeds).toHaveLength(1);
    expect(a.last().subscribeCalls).toEqual([["13"]]);
    expect(lines.join("\n")).not.toContain("secret-token-123");
    expect(lines.some((l) => l.includes("UPSTREAM_ERROR"))).toBe(true);
  });

  it("parks the feed when the session ends and resubscribes everything after the next login", async () => {
    const { hub, a1, accounts, statuses } = setup();
    await hub.subscribe("c1", ["NSE:NIFTY", "NSE:INFY"]);
    await settle();
    const first = a1.last();
    first.status(true);
    accounts.setState("dhan-main", "expired", { message: "Your Dhan session ended at 6 am. Log in again from the Bridge." });
    expect(first.closed).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ connected: false, detail: "waiting_session", reason: expect.stringContaining("6 am") });
    vi.advanceTimersByTime(120_000);
    await settle();
    expect(a1.feeds).toHaveLength(1); // no retries without a session
    accounts.setCreds("dhan-main", { clientId: "1", accessToken: "fresh-token-456" });
    accounts.setState("dhan-main", "connected");
    await settle();
    expect(a1.feeds).toHaveLength(2);
    expect(a1.last().creds.accessToken).toBe("fresh-token-456");
    expect(a1.last().subscribeCalls).toEqual([["13", "1594"]]);
  });

  it("moves symbols to another connected feed account when a session ends, so clients keep ticking", async () => {
    const d = stubAdapter();
    const z = stubAdapter();
    const { hub, accounts, ticks } = setup({
      adapters: { dhan: d },
      accountsList: [
        { id: "dhan-main", broker: "dhan", adapter: d.adapter, capabilities: ["feed"], creds: { t: "d" } },
        { id: "zerodha-main", broker: "zerodha", adapter: z.adapter, capabilities: ["feed"], creds: { t: "z" } },
      ],
    });
    const got = [];
    hub.attachSink("c1", (t) => got.push([t.symbol, t.ltp, t.accountId]));
    await hub.subscribe("c1", ["NSE:NIFTY"]);
    await settle();
    expect(d.feeds).toHaveLength(1);
    d.last().status(true);
    accounts.setState("dhan-main", "expired");
    await settle();
    await settle();
    expect(z.feeds).toHaveLength(1);
    expect(z.last().subscribeCalls.flat()).toEqual(["256265"]);
    z.last().status(true);
    z.last().tick("256265", "NSE", 25050);
    expect(got.at(-1)).toEqual(["NSE:NIFTY", 25050, "zerodha-main"]);
    expect(hub.clientSymbols("c1")).toEqual([{ symbol: "NSE:NIFTY", mode: "ltp" }]);
    expect(ticks.length).toBeGreaterThan(0);
  });

  it("an unsubscribe that arrives while the subscribe is still resolving wins", async () => {
    const { hub } = setup();
    const pending = hub.subscribe("c1", ["NSE:RELIANCE"]);
    hub.unsubscribe("c1", ["NSE:RELIANCE"]);
    const r = await pending;
    expect(r.accepted).toEqual([]);
    expect(hub.clientSymbols("c1")).toEqual([]);
    await settle();
    expect(hub.stats().symbols).toBe(0);
    // A later subscribe for the same symbol works normally.
    expect((await hub.subscribe("c1", ["NSE:RELIANCE"])).accepted).toEqual(["NSE:RELIANCE"]);
  });

  it("waits for a login when the session is already gone at start", async () => {
    const { hub, a1, accounts } = setup();
    const realCreds = accounts.creds;
    let fail = true;
    accounts.creds = async (id) => {
      if (fail) {
        fail = false;
        throw new BridgeError("SESSION_EXPIRED", "expired");
      }
      return realCreds(id);
    };
    await hub.subscribe("c1", ["NSE:NIFTY"]);
    await settle();
    expect(a1.feeds).toHaveLength(0);
    expect(hub.stats().upstreams[0]).toMatchObject({ detail: "waiting_session", connected: false, subscriptions: 1 });
    vi.advanceTimersByTime(120_000);
    await settle();
    expect(a1.feeds).toHaveLength(0);
    accounts.setState("dhan-main", "expired");
    accounts.setState("dhan-main", "connected");
    await settle();
    expect(a1.feeds).toHaveLength(1);
    expect(a1.last().subscribeCalls).toEqual([["13"]]);
  });

  it("reports a quiet feed as stale and recovers on the next tick", async () => {
    const { hub, a1, statuses } = setup({ stream: { staleAfterMs: 20_000 } });
    await hub.subscribe("c1", ["NSE:NIFTY"]);
    await settle();
    a1.last().status(true);
    vi.advanceTimersByTime(25_000);
    expect(statuses.at(-1)).toMatchObject({ state: "stale", connected: true });
    expect(hub.isLive("NSE:NIFTY")).toBe(true);
    a1.last().tick("13", "NSE", 25000);
    expect(statuses.at(-1)).toMatchObject({ state: "up" });
  });

  it("treats the first tick as proof of connection and ignores unknown tokens", async () => {
    const { hub, a1, ticks } = setup();
    await hub.subscribe("c1", ["NSE:NIFTY"]);
    await settle();
    a1.last().tick("999", "NSE", 10);
    expect(ticks).toHaveLength(0);
    a1.last().tick("13", "NSE", 25000.25);
    expect(hub.isLive("NSE:NIFTY")).toBe(true);
    expect(ticks[0]).toMatchObject({ symbol: "NSE:NIFTY", ltp: 25000.25, accountId: "dhan-main", broker: "dhan" });
  });

  it("a throwing sink does not stop delivery to others", async () => {
    const { hub, a1 } = setup();
    const got = [];
    hub.attachSink("bad", () => {
      throw new Error("x");
    });
    hub.attachSink("good", (t) => got.push(t.ltp));
    await hub.subscribe("bad", ["NSE:NIFTY"]);
    await hub.subscribe("good", ["NSE:NIFTY"]);
    await settle();
    a1.last().tick("13", "NSE", 5);
    expect(got).toEqual([5]);
  });

  it("drops a subscription whose client vanished mid-subscribe", async () => {
    const { hub, a1 } = setup();
    const p = hub.subscribe("c1", ["NSE:NIFTY"]);
    hub.dropClient("c1");
    const r = await p;
    expect(r.accepted).toEqual([]);
    await settle();
    expect(hub.stats().symbols).toBe(0);
    expect(a1.last()?.subs.size ?? 0).toBe(0);
  });

  it("stop() closes every feed and refuses new work", async () => {
    const { hub, a1, statuses } = setup();
    await hub.subscribe("c1", ["NSE:NIFTY"]);
    await settle();
    hub.stop();
    hub.stop();
    expect(a1.last().closed).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ detail: "closed" });
    expect(hub.stats()).toEqual({ clients: 0, symbols: 0, upstreams: [] });
    await expect(hub.subscribe("c1", ["NSE:NIFTY"])).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE" });
  });

  it("reports an adapter without a feed as unsupported", async () => {
    const { hub } = setup({ accountsList: [{ id: "dhan-main", broker: "dhan", adapter: {}, capabilities: ["feed"] }] });
    await hub.subscribe("c1", ["NSE:NIFTY"]);
    await settle();
    expect(hub.stats().upstreams[0]).toMatchObject({ detail: "unsupported", connected: false });
    expect(hub.isLive("NSE:NIFTY")).toBe(false);
  });
});
