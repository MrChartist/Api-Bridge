import { describe, expect, it } from "vitest";
import { BridgeError } from "../core/errors.mjs";
import { createFakeClock, createScriptedFetch, runProviderConformance, windowViolations } from "./conformance.mjs";
import { createHttp, createLimiter } from "./providers/common.mjs";
import { createBuiltinProviders } from "./providers/index.mjs";
import { fixture, query } from "./providers/testkit.mjs";

const KEY = "FAKE-SECRET-KEY-42";
const HOST = "api.fake.example";
const FROM = Date.UTC(2026, 10, 2);
const TO = Date.UTC(2026, 10, 7);

/** Scripted upstream for the fake vendor. */
function upstreamFor(clock) {
  return createScriptedFetch({
    clock,
    scenarios: {
      ok: (url) => {
        const u = new URL(url);
        if (u.pathname === "/quote") return { json: { price: 100.5, prev: 99, ts: clock.now() - 60_000 } };
        return { json: { bars: [0, 1, 2, 3].map((i) => ({ t: Math.floor(FROM / 1000) + i * 86400, o: 10, h: 12, l: 9, c: 11, v: 100 })) } };
      },
      "rate-limited": () => ({ status: 429, headers: { "retry-after": "30" }, text: "slow down" }),
      "not-found": () => ({ status: 404, text: "no such symbol" }),
      upstream: () => ({ status: 500, text: "boom" }),
      auth: () => ({ status: 401, text: "bad key" }),
    },
  });
}

/**
 * A small correct provider, and flawed copies of it. `flaw` switches on one deliberate defect.
 * @param {{ fetch: any, clock: any, flaw?: string }} o
 */
function fakeProvider({ fetch, clock, flaw }) {
  const limits = { perSecond: 2, perMinute: 10 };
  const limiter = createLimiter({ limits, clock, source: "fake", label: "Fake vendor" });
  const http = createHttp({ id: "fake", name: "Fake vendor", fetch, clock, hosts: [HOST], limiter, userAgent: "Bridge-DataSource/1.0 (test)", secrets: () => [KEY] });
  const descriptor = {
    id: "fake-vendor",
    name: "Fake vendor",
    kind: "free",
    tier: "byok",
    class: "delayed",
    delaySec: 900,
    official: true,
    capabilities: ["quotes", "history"],
    limits,
    needsKey: true,
    terms: { url: "https://fake.example/terms", note: "You use your own key and accept the vendor's terms." },
  };
  const declared = flaw === "badDescriptor" ? { ...descriptor, terms: undefined, class: "realtime", delaySec: null } : descriptor;
  const raw = (url, init = {}) => fetch(url, { redirect: "error", ...init });

  async function get(url, ctx) {
    if (flaw === "ignoresAbort") return raw(url, {}).then((r) => r.json());
    if (flaw === "overLimit" || flaw === "noBackoff") {
      const r = await raw(url, { signal: ctx.signal, headers: { "user-agent": "Bridge-DataSource/1.0 (test)" } });
      if (r.status === 429) throw new BridgeError("UPSTREAM_RATE_LIMITED", "slow down", { retryAfterMs: 30_000, fields: { kind: "rate-limited" } });
      if (r.status === 404) throw new BridgeError("SYMBOL_NOT_FOUND", "no such symbol", { fields: { kind: "not-found" } });
      if (r.status === 401) throw new BridgeError("UPSTREAM_ERROR", "bad key", { fields: { kind: "auth" } });
      if (r.status >= 400) throw new BridgeError("UPSTREAM_ERROR", "boom");
      return r.json();
    }
    if (flaw === "rawErrors") {
      const r = await raw(url, { signal: ctx.signal });
      return r.json();
    }
    if (flaw === "undeclaredHost") return (await raw(`https://evil.example/q?k=1`, { signal: ctx.signal })).json();
    if (flaw === "cookie") return (await raw(url, { signal: ctx.signal, headers: { cookie: "A=1", "user-agent": "Mozilla/5.0 (X11) Chrome/120" } })).json();
    let res;
    try {
      res = await http.get(url, { signal: ctx.signal, headers: { authorization: `apikey ${KEY}` } });
    } catch (e) {
      if (flaw === "leaksSecret" && e instanceof BridgeError) throw new BridgeError(e.code, `${e.detail} (key ${KEY})`, { fields: e.fields, retryAfterMs: e.retryAfterMs });
      throw e;
    }
    if (res.status === 429) throw http.rateLimited(res);
    if (res.status === 404) throw new BridgeError("SYMBOL_NOT_FOUND", "The vendor does not know this symbol.", { fields: { kind: "not-found" } });
    if (res.status === 401) throw new BridgeError("UPSTREAM_ERROR", "The vendor did not accept the key.", { fields: { kind: "auth" } });
    if (res.status >= 400) throw http.upstream("The vendor is having trouble.");
    if (!res.json || typeof res.json !== "object") throw http.upstream("The vendor sent an answer the Bridge could not read.");
    return res.json;
  }

  const provider = {
    descriptor: declared,
    hosts: [HOST],
    async quotes(symbols, ctx = {}) {
      const items = [];
      for (const symbol of symbols) {
        const j = await get(`https://${HOST}/quote?symbol=${encodeURIComponent(symbol)}`, ctx);
        const item = { symbol, fields: { ltp: flaw === "badLtp" ? Number.NaN : j.price, close: j.prev }, at: j.ts, flags: flaw === "noDelayFlag" ? [] : ["delayed"] };
        items.push(item);
      }
      return { items };
    },
    async history(req, ctx = {}) {
      const j = await get(`https://${HOST}/bars?symbol=${encodeURIComponent(req.symbol)}`, ctx);
      let candles = j.bars.map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
      if (flaw === "unsorted") candles = [candles[2], candles[0], candles[1], candles[3]];
      if (flaw === "duplicates") candles = [...candles, candles[3]];
      return { candles, at: clock.now(), flags: ["delayed"] };
    },
  };
  if (flaw === "undeclaredCapability") provider.expiries = async () => ({ expiries: ["2026-11-26"], at: clock.now() });
  return provider;
}

async function run(flaw) {
  const clock = createFakeClock();
  const upstream = upstreamFor(clock);
  const provider = fakeProvider({ fetch: upstream, clock, flaw });
  const report = await runProviderConformance(provider, {
    clock,
    upstream,
    inputs: { quotes: ["NSE:RELIANCE"], history: { symbol: "NSE:RELIANCE", interval: "1d", fromMs: FROM, toMs: TO } },
    secrets: [KEY],
  });
  return report;
}

const failed = (report) => report.checks.filter((c) => !c.ok).map((c) => c.name);

describe("runProviderConformance", () => {
  it("passes a correct provider on every check", async () => {
    const report = await run();
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(["descriptor", "capabilities", "shape:quotes", "shape:history", "abort", "limits", "errors:rate-limited", "errors:auth", "errors:not-found", "errors:upstream", "errors:network-error", "errors:garbage", "secrets", "network"]),
    );
  });

  it.each([
    ["badDescriptor", "descriptor"],
    ["badLtp", "shape:quotes"],
    ["noDelayFlag", "shape:quotes"],
    ["unsorted", "shape:history"],
    ["duplicates", "shape:history"],
    ["undeclaredCapability", "capabilities"],
    ["overLimit", "limits"],
    ["noBackoff", "errors:rate-limited"],
    ["rawErrors", "errors:network-error"],
    ["leaksSecret", "secrets"],
    ["undeclaredHost", "network"],
    ["cookie", "network"],
  ])("catches the flaw %s in the %s check", async (flaw, check) => {
    const report = await run(flaw);
    expect(report.ok).toBe(false);
    expect(failed(report)).toContain(check);
  });

  it("catches a provider that ignores the abort signal", async () => {
    const report = await run("ignoresAbort");
    expect(failed(report)).toContain("abort");
    expect(report.checks.find((c) => c.name === "abort").detail).toMatch(/did not stop|AbortError/);
  });

  it("explains each failure in plain words", async () => {
    const report = await run("badLtp");
    expect(report.failures.join("\n")).toMatch(/fields\.ltp must be a finite positive number/);
    const leak = await run("leaksSecret");
    expect(leak.failures.join("\n")).toMatch(/a secret \(FA\*\*\*\) appears/);
    const raw = await run("rawErrors");
    expect(raw.failures.join("\n")).toMatch(/raw (TypeError|SyntaxError)/);
  });

  it("requires the fake clock and scripted fetch", async () => {
    await expect(runProviderConformance({}, {})).rejects.toThrow(/fixtures.clock/);
    await expect(runProviderConformance({}, { clock: createFakeClock() })).rejects.toThrow(/fixtures.upstream/);
  });
});

describe("windowViolations", () => {
  it("finds a burst that breaks any window", () => {
    expect(windowViolations([0, 100, 200], { perSecond: 2 })).toHaveLength(1);
    expect(windowViolations([0, 1000, 2000], { perSecond: 1 })).toEqual([]);
    expect(windowViolations(Array.from({ length: 6 }, (_, i) => i * 10_000), { perMinute: 5 })).toHaveLength(1);
    expect(windowViolations([0, 86_399_999], { perDay: 1 })).toHaveLength(1);
    expect(windowViolations([0, 86_400_000], { perDay: 1 })).toEqual([]);
  });
});

describe("createBuiltinProviders", () => {
  it("returns the three providers, valid and with declared hosts", () => {
    const providers = createBuiltinProviders({ fetch: async () => new Response("{}"), getSecret: () => "k" });
    expect(providers.map((p) => p.descriptor.id)).toEqual(["yahoo", "alphavantage", "twelvedata"]);
    expect(providers.map((p) => p.descriptor.tier)).toEqual(["opt-in", "byok", "byok"]);
    expect(providers.map((p) => p.hosts)).toEqual([["query1.finance.yahoo.com"], ["www.alphavantage.co"], ["api.twelvedata.com"]]);
  });

  it("passes the provider id to getSecret and uses the answer as the key, per request", async () => {
    const asked = [];
    const clock = createFakeClock();
    const upstream = createScriptedFetch({ clock, scenarios: { ok: (url) => (new URL(url).hostname === "api.twelvedata.com" ? { json: fixture("twelvedata/quote.json") } : { json: fixture("alphavantage/global_quote.json") }) } });
    const [, av, td] = createBuiltinProviders({ fetch: upstream, clock, getSecret: async (id) => (asked.push(id), `key-for-${id}`) });
    await av.quotes(["BSE:RELIANCE"], {});
    await td.quotes(["NSE:RELIANCE"], {});
    expect(asked).toEqual(["alphavantage", "twelvedata"]);
    expect(query(upstream.calls[0].url).apikey).toBe("key-for-alphavantage");
    expect(upstream.calls[1].init.headers.authorization).toBe("apikey key-for-twelvedata");
  });

  it("reports a missing key as an auth error when getSecret is not given", async () => {
    const providers = createBuiltinProviders({ fetch: async () => new Response("{}") });
    await expect(providers[1].quotes(["BSE:RELIANCE"], {})).rejects.toMatchObject({ fields: { kind: "auth" } });
  });
});
