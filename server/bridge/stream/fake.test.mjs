import { describe, expect, it } from "vitest";
import { assertService } from "../core/contracts.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createFakeStreamHub } from "./fake.mjs";
import { resolveStreamConfig, streamConfigSchema } from "./config.mjs";

describe("createFakeStreamHub", () => {
  it("satisfies the StreamHub contract", () => {
    expect(() => assertService("streamHub", createFakeStreamHub())).not.toThrow();
  });

  it("subscribes with canonical symbols, caps and rejects like the real hub", async () => {
    const hub = createFakeStreamHub({ limit: 2, maxSymbolsPerClient: 3, unknown: ["NSE:GHOST"] });
    const r = await hub.subscribe("c1", ["nse:nifty", "NSE:INFY", "NSE:RELIANCE", "NSE:GHOST", "%%"]);
    expect(r.accepted).toEqual(["NSE:NIFTY", "NSE:INFY"]);
    expect(r.rejected.map((x) => x.code)).toEqual(["SUBSCRIPTION_LIMIT", "SYMBOL_NOT_FOUND", "VALIDATION_FAILED"]);
    await expect(hub.subscribe("c1", ["NSE:NIFTY"], "full")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(hub.stats()).toMatchObject({ clients: 1, symbols: 2, upstreams: [{ connected: true, limit: 2, modes: { ltp: 2, quote: 0, depth: 0 } }] });
    expect(hub.calls[0]).toEqual(["subscribe", "c1", ["nse:nifty", "NSE:INFY", "NSE:RELIANCE", "NSE:GHOST", "%%"], "ltp"]);
  });

  it("pushTick fills a Tick, keeps it while subscribed, emits it and feeds sinks", async () => {
    const bus = createEventBus();
    const seen = [];
    bus.on("tick", (t) => seen.push(t));
    const hub = createFakeStreamHub({ bus, clock: { now: () => 1234 } });
    const sunk = [];
    hub.attachSink("c1", (t, mode) => sunk.push([t.ltp, mode]));
    await hub.subscribe("c1", ["NSE:NIFTY"], "quote");
    const t = hub.pushTick({ symbol: "nse:nifty", ltp: 25000 });
    expect(t).toMatchObject({ symbol: "NSE:NIFTY", ltp: 25000, receivedAt: 1234, accountId: "fake-acct", broker: "fake", bid: null });
    expect(hub.lastTick("NSE:NIFTY")).toEqual(t);
    expect(hub.isLive("NSE:NIFTY")).toBe(true);
    expect(sunk).toEqual([[25000, "quote"]]);
    expect(seen).toHaveLength(1);
    hub.setConnected(false);
    expect(hub.isLive("NSE:NIFTY")).toBe(false);
    hub.unsubscribe("c1", ["NSE:NIFTY"]);
    expect(hub.lastTick("NSE:NIFTY")).toBeNull();
    hub.pushTick({ symbol: "NSE:INFY", ltp: 1 }); // nobody subscribed: emitted, not stored
    expect(hub.lastTick("NSE:INFY")).toBeNull();
    expect(seen).toHaveLength(2);
  });

  it("dropClient releases everything", async () => {
    const hub = createFakeStreamHub();
    await hub.subscribe("c1", ["NSE:NIFTY", "NSE:INFY"]);
    await hub.subscribe("c2", ["NSE:NIFTY"]);
    hub.dropClient("c1");
    expect(hub.stats().symbols).toBe(1);
    expect(hub.clientSymbols("c2")).toEqual([{ symbol: "NSE:NIFTY", mode: "ltp" }]);
  });
});

describe("stream config", () => {
  it("defaults every key", () => {
    expect(resolveStreamConfig(undefined)).toMatchObject({ heartbeatMs: 15000, maxClients: 50, maxSymbolsPerClient: 500, maxSubscriptionsPerUpstream: null, backoff: { initialMs: 1000, maxMs: 30000 }, candles: { intervals: ["1m", "5m", "15m"] } });
  });

  it("refuses unknown keys and unsafe values", () => {
    expect(streamConfigSchema.safeParse({ heartbeat: 1 }).success).toBe(false);
    expect(streamConfigSchema.safeParse({ heartbeatMs: 10 }).success).toBe(false);
    expect(streamConfigSchema.safeParse({ candles: { intervals: ["2m"] } }).success).toBe(false);
  });
});
