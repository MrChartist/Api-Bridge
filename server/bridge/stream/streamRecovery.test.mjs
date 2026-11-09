/**
 * Feed recovery: the daily token rollover, a re-login with a new token, a half-open socket, a feed that never connects and
 * a broker that stays down. All with fakes and a fake clock: no network, no real waiting.
 *
 * What these protect (the failures real operators hit most): a feed that stays dead after the new-day login until a restart,
 * calls that keep going out with yesterday's token, a socket that looks open but delivers nothing, and reconnect loops that
 * give up or subscribe the same symbol twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { createStreamHub } from "./streamHub.mjs";
import { stubAdapter } from "./__fixtures__/stubFeed.mjs";

const settle = () => new Promise((r) => setImmediate(r));
const INSTRUMENTS = [
  { symbol: "NSE:NIFTY", lotSize: 1, refs: { dhan: { token: "13" } } },
  { symbol: "NSE:BANKNIFTY", lotSize: 1, refs: { dhan: { token: "25" } } },
];

function setup({ stream = {}, marketOpen = () => true, adapter = stubAdapter() } = {}) {
  const bus = createEventBus({ logger: createNullLogger() });
  const accounts = createFakeAccountManager({
    accounts: [{ id: "dhan-main", broker: "dhan", adapter: adapter.adapter, capabilities: ["feed", "ltp"], creds: { clientId: "1", accessToken: "token-monday" } }],
    bus,
  });
  const credsCalls = [];
  const realCreds = accounts.creds;
  accounts.creds = async (id) => {
    credsCalls.push(id);
    return realCreds(id);
  };
  const symbols = createFakeSymbolService({ instruments: INSTRUMENTS, today: "2026-10-18" });
  const statuses = [];
  bus.on("stream.status", (p) => statuses.push(p));
  const hub = createStreamHub({ config: { stream }, logger: createNullLogger(), bus, clock: { now: () => Date.now() }, accounts, symbols }, { random: () => 1, marketOpen });
  return { hub, accounts, adapter, bus, statuses, credsCalls };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-10-19T10:00:00+05:30"));
});
afterEach(() => vi.useRealTimers());

describe("token rollover and re-login", () => {
  it("stops using the old token at once, makes no calls while logged out, and resumes with the new token and every symbol after login", async () => {
    const { hub, accounts, adapter, credsCalls } = setup();
    const got = [];
    hub.attachSink("c1", (t) => got.push([t.symbol, t.ltp]));
    await hub.subscribe("c1", ["NSE:NIFTY", "NSE:BANKNIFTY"], "ltp");
    await settle();
    const first = adapter.last();
    first.status(true);
    first.tick("13", "NSE", 25000);
    expect(got).toEqual([["NSE:NIFTY", 25000]]);
    expect(first.creds.accessToken).toBe("token-monday");

    // 03:00 IST rollover: the Bridge marks the account expired.
    accounts.setState("dhan-main", "expired", { message: "Session ended" });
    await settle();
    expect(first.closed).toBe(true);
    expect(hub.stats().upstreams[0]).toMatchObject({ detail: "waiting_session", connected: false, subscriptions: 2 });
    const callsAtExpiry = credsCalls.length;
    const feedsAtExpiry = adapter.feeds.length;

    // Hours pass with the session dead: no credential reads, no new feed, no retry timers firing.
    vi.advanceTimersByTime(6 * 3600_000);
    await settle();
    expect(credsCalls.length).toBe(callsAtExpiry);
    expect(adapter.feeds.length).toBe(feedsAtExpiry);
    first.tick("13", "NSE", 1); // a late frame from the closed socket is ignored
    expect(got).toHaveLength(1);

    // The user logs in; the stored token is new.
    const real = accounts.creds;
    accounts.creds = async (id) => ({ ...(await real(id)), accessToken: "token-tuesday" });
    accounts.setState("dhan-main", "connected");
    await settle();
    await settle();
    const second = adapter.last();
    expect(second).not.toBe(first);
    expect(second.creds.accessToken).toBe("token-tuesday");
    expect(second.subscribeCalls.flat().sort()).toEqual(["13", "25"]);
    second.status(true);
    second.tick("25", "NSE", 52000);
    expect(got.at(-1)).toEqual(["NSE:BANKNIFTY", 52000]); // the same client, no resubscribe from its side
    expect(hub.stats().upstreams[0]).toMatchObject({ connected: true, subscriptions: 2 });
  });

  it("a login that leaves the session as it was does not tear the feed down", async () => {
    const { hub, accounts, adapter } = setup();
    await hub.subscribe("c1", ["NSE:NIFTY"], "ltp");
    await settle();
    adapter.last().status(true);
    accounts.setState("dhan-main", "connected", { message: "checked again" });
    await settle();
    expect(adapter.feeds).toHaveLength(1);
    expect(adapter.last().closed).toBe(false);
  });

  it("a feed that was down when the login came is rebuilt at once, not after the retry delay", async () => {
    const { hub, accounts, adapter } = setup();
    await hub.subscribe("c1", ["NSE:NIFTY"], "ltp");
    await settle();
    adapter.last().status(true);
    adapter.last().status(false, "socket closed");
    accounts.setState("dhan-main", "expired");
    accounts.setState("dhan-main", "connected");
    await settle();
    await settle();
    expect(adapter.feeds).toHaveLength(2);
  });
});

describe("half-open sockets", () => {
  it("rebuilds a connected feed that goes silent during market hours, once, with everything resubscribed once", async () => {
    const { hub, adapter, statuses } = setup({ stream: { staleAfterMs: 20_000, staleRebuildAfterMs: 60_000 } });
    await hub.subscribe("c1", ["NSE:NIFTY", "NSE:BANKNIFTY"], "ltp");
    await settle();
    const first = adapter.last();
    first.status(true);
    first.tick("13", "NSE", 25000);
    vi.advanceTimersByTime(30_000);
    expect(statuses.at(-1)).toMatchObject({ state: "stale" });
    expect(adapter.feeds).toHaveLength(1);
    vi.advanceTimersByTime(40_000); // 70 s of silence in total
    expect(first.closed).toBe(true);
    expect(statuses.find((x) => x.detail === "retrying")?.reason).toMatch(/half-open/);
    vi.advanceTimersByTime(1000);
    await settle();
    expect(adapter.feeds).toHaveLength(2);
    const second = adapter.last();
    expect(second.subscribeCalls.flat().sort()).toEqual(["13", "25"]);
    second.status(true);
    second.tick("13", "NSE", 25010);
    expect(hub.stats().upstreams[0]).toMatchObject({ state: "up", rebuilds: 1, subscriptions: 2 });
  });

  it("does not rebuild a quiet feed when the market is closed", async () => {
    const { hub, adapter } = setup({ stream: { staleAfterMs: 20_000, staleRebuildAfterMs: 60_000 }, marketOpen: () => false });
    await hub.subscribe("c1", ["NSE:NIFTY"], "ltp");
    await settle();
    adapter.last().status(true);
    vi.advanceTimersByTime(3600_000);
    await settle();
    expect(adapter.feeds).toHaveLength(1);
    expect(hub.stats().upstreams[0]).toMatchObject({ state: "stale", rebuilds: 0 });
  });

  it("waits longer after each rebuild that brought no tick (a holiday) and starts over at the first tick", async () => {
    const { hub, adapter } = setup({ stream: { staleAfterMs: 20_000, staleRebuildAfterMs: 60_000 } });
    await hub.subscribe("c1", ["NSE:NIFTY"], "ltp");
    await settle();
    let connected = null;
    const connectAndWait = async (ms) => {
      if (connected !== adapter.last()) adapter.last().status(true); // a new feed connects once; the same feed is not re-announced
      connected = adapter.last();
      vi.advanceTimersByTime(ms);
      vi.advanceTimersByTime(2000); // back-off
      await settle();
    };
    await connectAndWait(65_000); // first silence: rebuilt after 60 s
    expect(adapter.feeds).toHaveLength(2);
    await connectAndWait(65_000); // second feed, silent for 67 s: it needs 120 s, so not yet
    expect(adapter.feeds).toHaveLength(2);
    await connectAndWait(60_000); // 127 s in total: rebuilt
    expect(adapter.feeds).toHaveLength(3);
    adapter.last().status(true);
    adapter.last().tick("13", "NSE", 25000);
    vi.advanceTimersByTime(65_000);
    vi.advanceTimersByTime(2000);
    await settle();
    expect(adapter.feeds).toHaveLength(4); // the tick reset the wait to 60 s
  });

  it("rebuilds a feed that never reports connected", async () => {
    const { hub, adapter, statuses } = setup({ stream: { connectTimeoutMs: 10_000 } });
    await hub.subscribe("c1", ["NSE:NIFTY"], "ltp");
    await settle();
    expect(adapter.feeds).toHaveLength(1); // created, but status(true) never arrives
    vi.advanceTimersByTime(20_000);
    expect(adapter.feeds[0].closed).toBe(true);
    expect(statuses.find((x) => x.detail === "retrying")?.reason).toMatch(/did not connect/);
    vi.advanceTimersByTime(2000);
    await settle();
    expect(adapter.feeds.length).toBeGreaterThanOrEqual(2);
    expect(adapter.last().subscribeCalls.flat()).toEqual(["13"]);
  });

  it("every adapter that declares a live feed gets this watchdog because it lives in the hub, not in the adapter", async () => {
    const { createBrokerRegistry } = await import("../../brokers/registry.mjs");
    const reg = createBrokerRegistry();
    const withFeed = reg.list().filter((id) => reg.get(id).capabilities?.feed);
    expect(withFeed.length).toBeGreaterThan(5);
    for (const id of withFeed) expect(typeof reg.get(id).createFeed, `${id} declares feed but has no createFeed`).toBe("function");
  });
});

describe("reconnect never gives up and never doubles a subscription", () => {
  it("keeps retrying when the broker stays down, with the delay capped, then connects", async () => {
    const adapter = stubAdapter({ throwOnCreate: 40 });
    const { hub } = setup({ adapter, stream: { backoff: { initialMs: 1000, maxMs: 30_000 } } });
    await hub.subscribe("c1", ["NSE:NIFTY"], "ltp");
    await settle();
    for (let i = 0; i < 40; i++) {
      expect(hub.stats().upstreams[0].detail, `attempt ${i}`).toBe("retrying");
      expect(adapter.feeds).toHaveLength(0);
      vi.advanceTimersByTime(30_001); // never longer than backoff.maxMs, however many attempts failed
      await settle();
    }
    expect(adapter.feeds).toHaveLength(1);
    expect(adapter.last().subscribeCalls.flat()).toEqual(["13"]);
  });

  it("subscribes each symbol exactly once per feed across many reconnects", async () => {
    const { hub, adapter } = setup({ stream: { adapterGraceMs: 0 } });
    await hub.subscribe("c1", ["NSE:NIFTY", "NSE:BANKNIFTY"], "ltp");
    await hub.subscribe("c2", ["NSE:NIFTY"], "ltp");
    await settle();
    for (let i = 0; i < 5; i++) {
      adapter.last().status(true);
      adapter.last().status(false, "reset");
      vi.advanceTimersByTime(40_000);
      await settle();
    }
    expect(adapter.feeds.length).toBeGreaterThanOrEqual(6);
    for (const feed of adapter.feeds) {
      const tokens = feed.subscribeCalls.flat();
      expect(new Set(tokens).size, `feed subscribed ${tokens.join(",")}`).toBe(tokens.length);
    }
    expect(adapter.last().subscribeCalls.flat().sort()).toEqual(["13", "25"]);
    expect(hub.stats().symbols).toBe(2);
  });
});
