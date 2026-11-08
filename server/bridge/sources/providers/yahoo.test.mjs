import { describe, expect, it } from "vitest";
import { BridgeError } from "../../core/errors.mjs";
import { istDateTimeMinutes } from "../../market/time.mjs";
import { createFakeClock, createScriptedFetch, runProviderConformance, windowViolations } from "../conformance.mjs";
import { validateDescriptor } from "../contract.mjs";
import { fixture, query } from "./testkit.mjs";
import { YAHOO_INDEX_TABLE, createYahooProvider, toYahooSymbol } from "./yahoo.mjs";

const DAY = 86_400_000;
const daily = fixture("yahoo/chart_RELIANCE_NS_5d_1d.json");
const oneMinute = fixture("yahoo/chart_NSEI_1m.json");

/** A one-bar chart answer whose bar sits at `period1`, so chunked requests are easy to tell apart. */
const chunkAnswer = (url) => {
  const t = Number(query(url).period1) + 60;
  return { json: { chart: { result: [{ meta: { regularMarketTime: t + 100000, regularMarketPrice: 100 }, timestamp: [t], indicators: { quote: [{ open: [100], high: [101], low: [99], close: [100.5], volume: [10] }] } }], error: null } } };
};

function setup(scenarios = {}) {
  const clock = createFakeClock();
  const upstream = createScriptedFetch({
    clock,
    scenarios: {
      ok: (url) => (query(url).range === "5d" ? { json: daily } : { json: oneMinute }),
      "rate-limited": () => ({ status: 429, headers: { "retry-after": "30" }, text: "Too Many Requests" }),
      "not-found": () => ({ status: 404, json: fixture("yahoo/error_404.json") }),
      upstream: () => ({ status: 503, text: "unavailable" }),
      ...scenarios,
    },
  });
  const provider = createYahooProvider({ fetch: upstream, clock });
  return { clock, upstream, provider };
}

describe("yahoo symbol mapping", () => {
  it.each([
    ["NSE:RELIANCE", "RELIANCE.NS"],
    ["BSE:RELIANCE", "RELIANCE.BO"],
    ["NSE:BAJAJ-AUTO", "BAJAJ-AUTO.NS"],
    ["NSE:M&M", "M&M.NS"],
    ["NSE:NIFTY", "^NSEI"],
    ["NSE:BANKNIFTY", "^NSEBANK"],
    ["NSE:INDIAVIX", "^INDIAVIX"],
    ["BSE:SENSEX", "^BSESN"],
    ["nse:reliance", "RELIANCE.NS"],
  ])("%s -> %s", (bridge, yahoo) => {
    expect(toYahooSymbol(bridge)).toBe(yahoo);
  });

  it.each(["NFO:NIFTY-2026-11-26-FUT", "NFO:NIFTY-2026-11-26-25000-CE", "MCX:CRUDEOIL-2026-11-19-FUT", "NSE:FINNIFTY", "NSE:SENSEX", "BSE:BANKEX", "garbage", ""])("refuses %j with SYMBOL_NOT_FOUND", (s) => {
    let err;
    try {
      toYahooSymbol(s);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BridgeError);
    expect(err.code).toBe("SYMBOL_NOT_FOUND");
    expect(err.fields.kind).toBe("not-found");
  });

  it("lists only caret tickers for indices", () => {
    for (const table of Object.values(YAHOO_INDEX_TABLE)) for (const t of Object.values(table)) expect(t).toMatch(/^\^/);
  });
});

describe("yahoo descriptor", () => {
  it("is a valid, honest opt-in delayed unofficial source", () => {
    const { provider } = setup();
    const d = provider.descriptor;
    expect(validateDescriptor(d).errors).toEqual([]);
    expect(d).toMatchObject({ id: "yahoo", tier: "opt-in", class: "delayed", delaySec: 900, official: false, noticeVersion: "yahoo-1", needsKey: false });
    expect(d.capabilities).toEqual(["quotes", "history"]);
    expect(d.limits).toEqual({ perSecond: 1, perMinute: 60 });
    expect(d.terms.note).toContain("automated means");
    expect(d.note).toMatch(/not been verified/);
  });
});

describe("yahoo quotes", () => {
  it("reads the latest price and the previous close from the chart answer", async () => {
    const { provider, clock } = setup();
    const { items } = await provider.quotes(["NSE:RELIANCE"], { now: clock.now() });
    expect(items).toHaveLength(1);
    const it0 = items[0];
    expect(it0.symbol).toBe("NSE:RELIANCE");
    expect(it0.fields).toEqual({ ltp: 1324, open: null, high: 1327.4, low: 1309.9, close: 1311.8, volume: 6821400 });
    expect(it0.at).toBe(1794132180 * 1000);
    expect(it0.provider).toBe("yahoo");
    expect(it0.flags).toEqual(["unofficial", "delayed"]);
  });

  it("asks the chart endpoint only, with an honest User-Agent, no cookies and no crumb", async () => {
    const { provider, upstream } = setup();
    await provider.quotes(["BSE:RELIANCE"]);
    const call = upstream.calls[0];
    const u = new URL(call.url);
    expect(u.hostname).toBe("query1.finance.yahoo.com");
    expect(u.pathname).toBe("/v8/finance/chart/RELIANCE.BO");
    expect(u.searchParams.has("crumb")).toBe(false);
    expect(call.init.headers["user-agent"]).toMatch(/^Bridge-DataSource\//);
    expect(call.init.headers["user-agent"]).not.toMatch(/mozilla|chrome/i);
    expect(Object.keys(call.init.headers).map((k) => k.toLowerCase())).not.toContain("cookie");
    expect(call.init.redirect).toBe("error");
  });

  it("returns what it could resolve and drops a symbol Yahoo cannot map", async () => {
    const { provider, upstream } = setup();
    const { items } = await provider.quotes(["NFO:NIFTY-2026-11-26-FUT", "NSE:RELIANCE"]);
    expect(items.map((i) => i.symbol)).toEqual(["NSE:RELIANCE"]);
    expect(upstream.calls).toHaveLength(1);
  });

  it("throws SYMBOL_NOT_FOUND, without any request, when nothing can be mapped", async () => {
    const { provider, upstream } = setup();
    await expect(provider.quotes(["NFO:NIFTY-2026-11-26-FUT"])).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND" });
    expect(upstream.calls).toHaveLength(0);
  });

  it("treats an answer without a price as an upstream problem", async () => {
    const empty = { chart: { result: [{ meta: { symbol: "X.NS", regularMarketPrice: null }, timestamp: [], indicators: { quote: [{}] } }], error: null } };
    const { provider } = setup({ ok: () => ({ json: empty }) });
    await expect(provider.quotes(["NSE:RELIANCE"])).rejects.toMatchObject({ code: "UPSTREAM_ERROR", fields: { kind: "upstream" } });
  });
});

describe("yahoo history", () => {
  const window = { fromMs: Date.UTC(2026, 10, 6, 3, 45), toMs: Date.UTC(2026, 10, 6, 10, 5) };

  it("stamps IST bars correctly, skips null gaps and flags the trailing snapshot as provisional", async () => {
    const { provider, clock } = setup();
    const res = await provider.history({ symbol: "NSE:NIFTY", interval: "1m", ...window }, { now: clock.now() });
    // 4 real bars (one row was null) plus the 15:30 snapshot point
    expect(res.candles).toHaveLength(5);
    expect(istDateTimeMinutes(res.candles[0].time * 1000)).toBe("2026-11-06 09:15");
    expect(istDateTimeMinutes(res.candles[1].time * 1000)).toBe("2026-11-06 09:16");
    expect(istDateTimeMinutes(res.candles[2].time * 1000)).toBe("2026-11-06 09:18"); // 09:17 was null
    expect(istDateTimeMinutes(res.candles[4].time * 1000)).toBe("2026-11-06 15:30");
    expect(res.candles[0]).toEqual({ time: 1793936700, open: 24800.1, high: 24806.3, low: 24798.7, close: 24805, volume: 0 });
    expect(res.provisionalFrom).toBe(res.candles[4].time);
    expect(res.flags).toEqual(["unofficial", "delayed", "last-bar-provisional"]);
    expect(res.partial).toBeUndefined();
  });

  it("flags a daily series whose trailing point is a snapshot, and sorts and de-duplicates", async () => {
    const dup = structuredClone(daily);
    const r = dup.chart.result[0];
    r.timestamp.push(r.timestamp[0]); // a repeated timestamp
    for (const k of ["open", "high", "low", "close", "volume"]) r.indicators.quote[0][k].push(r.indicators.quote[0][k][0]);
    const { provider, clock } = setup({ ok: () => ({ json: dup }) });
    const res = await provider.history({ symbol: "NSE:RELIANCE", interval: "1d", fromMs: Date.UTC(2026, 10, 1), toMs: Date.UTC(2026, 10, 9) }, { now: clock.now() });
    expect(res.candles.map((c) => c.time)).toEqual([1793591100, 1793591100 + 2 * 86400, 1793591100 + 3 * 86400, 1793591100 + 4 * 86400, 1794132000]);
    expect(res.provisionalFrom).toBe(1794132000);
  });

  it("does not flag a finished bar from a closed session", async () => {
    const closed = structuredClone(oneMinute);
    closed.chart.result[0].timestamp.pop();
    for (const k of ["open", "high", "low", "close", "volume"]) closed.chart.result[0].indicators.quote[0][k].pop();
    const { provider, clock } = setup({ ok: () => ({ json: closed }) });
    const res = await provider.history({ symbol: "NSE:NIFTY", interval: "1m", ...window }, { now: clock.now() });
    expect(res.provisionalFrom).toBeUndefined();
    expect(res.flags).toEqual(["unofficial", "delayed"]);
  });

  it("flags the bar that is still forming during the session", async () => {
    // Yahoo's last update (regularMarketTime) is 09:19:30 IST: the 09:19 bar has not closed yet
    const live = structuredClone(oneMinute);
    live.chart.result[0].meta.regularMarketTime = 1793936700 + 4 * 60 + 30;
    live.chart.result[0].timestamp.pop();
    for (const k of ["open", "high", "low", "close", "volume"]) live.chart.result[0].indicators.quote[0][k].pop();
    const { provider, clock } = setup({ ok: () => ({ json: live }) });
    const res = await provider.history({ symbol: "NSE:NIFTY", interval: "1m", ...window }, { now: clock.now() });
    expect(res.provisionalFrom).toBe(1793936700 + 4 * 60);
  });

  it("splits a long 1m range into requests of at most 7 days, newest first, and merges the bars", async () => {
    const { provider, upstream, clock } = setup({ ok: chunkAnswer });
    const now = clock.now();
    const res = await provider.history({ symbol: "NSE:NIFTY", interval: "1m", fromMs: now - 20 * DAY, toMs: now }, { now });
    const qs = upstream.calls.map((c) => query(c.url));
    expect(qs).toHaveLength(3);
    for (const q of qs) expect(Number(q.period2) - Number(q.period1)).toBeLessThanOrEqual(7 * 86400 + 1);
    expect(Number(qs[0].period2)).toBeGreaterThan(Number(qs[1].period2)); // newest first
    expect(qs.every((q) => q.interval === "1m")).toBe(true);
    expect(res.candles).toHaveLength(3);
    expect(res.candles.map((c) => c.time)).toEqual([...res.candles.map((c) => c.time)].sort((a, b) => a - b));
    expect(res.partial).toBeUndefined();
  });

  it("clamps a range that starts before Yahoo's look-back and says it is partial", async () => {
    const { provider, upstream, clock } = setup({ ok: chunkAnswer });
    const now = clock.now();
    const res = await provider.history({ symbol: "NSE:NIFTY", interval: "1m", fromMs: now - 90 * DAY, toMs: now }, { now });
    expect(res.partial).toBe(true);
    const oldest = Math.min(...upstream.calls.map((c) => Number(query(c.url).period1)));
    expect(oldest * 1000).toBeGreaterThanOrEqual(now - 30 * DAY - 1000);
    expect(upstream.calls.length).toBeLessThanOrEqual(5);
  });

  it("refuses a range wholly older than the look-back, without a request", async () => {
    const { provider, upstream, clock } = setup();
    const now = clock.now();
    await expect(provider.history({ symbol: "NSE:NIFTY", interval: "1m", fromMs: now - 120 * DAY, toMs: now - 100 * DAY }, { now })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    expect(upstream.calls).toHaveLength(0);
  });

  it("refuses intervals Yahoo does not offer, and bad ranges", async () => {
    const { provider } = setup();
    await expect(provider.history({ symbol: "NSE:NIFTY", interval: "3m", ...{ fromMs: 1, toMs: 2 } })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    await expect(provider.history({ symbol: "NSE:NIFTY", interval: "1d", fromMs: 5, toMs: 5 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("uses 60 and 730 day look-backs for 5m and 60m", async () => {
    const { provider, upstream, clock } = setup({ ok: chunkAnswer });
    const now = clock.now();
    const r5 = await provider.history({ symbol: "NSE:NIFTY", interval: "5m", fromMs: now - 59 * DAY, toMs: now }, { now });
    expect(r5.partial).toBeUndefined();
    expect(upstream.calls).toHaveLength(1);
    const r60 = await provider.history({ symbol: "NSE:NIFTY", interval: "60m", fromMs: now - 800 * DAY, toMs: now }, { now });
    expect(r60.partial).toBe(true);
  });
});

describe("yahoo errors and back-off", () => {
  it("maps a 429 to UPSTREAM_RATE_LIMITED with Retry-After and sends nothing more until it passes", async () => {
    const { provider, upstream, clock } = setup();
    upstream.setScenario("rate-limited");
    const err = await provider.quotes(["NSE:RELIANCE"]).catch((e) => e);
    expect(err).toBeInstanceOf(BridgeError);
    expect(err.code).toBe("UPSTREAM_RATE_LIMITED");
    expect(err.retryAfterMs).toBe(30_000);
    expect(err.fields.kind).toBe("rate-limited");
    upstream.setScenario("ok");
    const again = await provider.quotes(["NSE:RELIANCE"]).catch((e) => e);
    expect(again.code).toBe("UPSTREAM_RATE_LIMITED");
    expect(upstream.calls).toHaveLength(1);
    clock.advance(31_000);
    await expect(provider.quotes(["NSE:RELIANCE"])).resolves.toBeTruthy();
    expect(upstream.calls).toHaveLength(2);
  });

  it("uses a default back-off when the 429 has no Retry-After", async () => {
    const { provider } = setup({ ok: () => ({ status: 429, text: "" }) });
    const e = await provider.quotes(["NSE:RELIANCE"]).catch((x) => x);
    expect(e.code).toBe("UPSTREAM_RATE_LIMITED");
    expect(e.retryAfterMs).toBe(60_000);
  });

  it("answers clearly when Yahoo starts demanding a cookie or crumb", async () => {
    const { provider } = setup({ ok: () => ({ status: 401, json: { finance: { error: { code: "Unauthorized", description: "Invalid Crumb" } } } }) });
    const err = await provider.quotes(["NSE:RELIANCE"]).catch((e) => e);
    expect(err.code).toBe("UPSTREAM_ERROR");
    expect(err.fields.kind).toBe("blocked");
    expect(err.detail).toMatch(/cookie or crumb/);
  });

  it("maps 404, 422, 5xx, network failure and unreadable bodies", async () => {
    const mk = async (s) => {
      const { provider, upstream } = setup({ ok: () => ({ status: 200, json: {} }), "422": () => ({ status: 422, json: fixture("yahoo/error_422.json") }) });
      upstream.setScenario(s);
      return provider.history({ symbol: "NSE:NIFTY", interval: "1d", fromMs: Date.UTC(2026, 10, 1), toMs: Date.UTC(2026, 10, 8) }, { now: Date.UTC(2026, 10, 9) }).catch((e) => e);
    };
    expect((await mk("not-found")).code).toBe("SYMBOL_NOT_FOUND");
    expect((await mk("422")).code).toBe("CAPABILITY_UNSUPPORTED");
    expect((await mk("upstream")).code).toBe("UPSTREAM_ERROR");
    expect((await mk("network-error")).code).toBe("BROKER_UNAVAILABLE");
    expect((await mk("garbage")).code).toBe("UPSTREAM_ERROR");
    expect((await mk("ok")).code).toBe("SYMBOL_NOT_FOUND"); // 200 with no result
  });

  it("does not leak the request URL from a network error", async () => {
    const { provider, upstream } = setup();
    upstream.setScenario("network-error");
    const err = await provider.quotes(["NSE:RELIANCE"]).catch((e) => e);
    expect(err.detail).not.toContain("finance.yahoo.com");
    expect(err.cause).toBeUndefined();
  });

  it("refuses expiries and option chains plainly", async () => {
    const { provider } = setup();
    await expect(provider.expiries("NIFTY")).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED", fields: { kind: "unsupported" } });
    await expect(provider.optionChain("NIFTY")).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  });
});

describe("yahoo limits", () => {
  it("spaces requests at least one second apart and never exceeds 60 a minute (fake clock)", async () => {
    const { provider, upstream, clock } = setup();
    await Promise.all(Array.from({ length: 70 }, () => provider.quotes(["NSE:RELIANCE"]).catch(() => null)));
    const times = upstream.calls.map((c) => c.at);
    expect(times.length).toBeGreaterThan(55);
    expect(windowViolations(times, provider.descriptor.limits)).toEqual([]);
    for (let i = 1; i < times.length; i += 1) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(1000);
    expect(provider.usage().lastMinute).toBeLessThanOrEqual(60);
    expect(clock.sleeps.length).toBeGreaterThan(0);
  });

  it("test() reports ok with latency", async () => {
    const { provider } = setup();
    const r = await provider.test({});
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/NIFTY/);
  });

  it("test() reports a plain failure, never a throw", async () => {
    const { provider, upstream } = setup();
    upstream.setScenario("upstream");
    const r = await provider.test({});
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/trouble/);
  });
});

describe("yahoo conformance", () => {
  it("passes the conformance harness", async () => {
    const { provider, upstream, clock } = setup();
    const report = await runProviderConformance(provider, {
      clock,
      upstream,
      inputs: { quotes: ["NSE:RELIANCE"], history: { symbol: "NSE:NIFTY", interval: "1m", fromMs: Date.UTC(2026, 10, 6, 3, 45), toMs: Date.UTC(2026, 10, 6, 10, 5) } },
      secrets: [],
    });
    expect(report.failures).toEqual([]);
    expect(report.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["descriptor", "capabilities", "shape:quotes", "shape:history", "abort", "limits", "errors:rate-limited", "errors:not-found", "secrets", "network"]));
  });
});
