import { describe, expect, it } from "vitest";
import { createFakeClock, createScriptedFetch, runProviderConformance, windowViolations } from "../conformance.mjs";
import { validateDescriptor } from "../contract.mjs";
import { createAlphaVantageProvider, toAlphaVantageSymbol } from "./alphavantage.mjs";
import { fixture, query } from "./testkit.mjs";

// The vendor's pages do not print response bodies, so these fixtures follow its documented field names and are
// filled with invented values.
const KEY = "AVKEY-TEST-1234";
const DAY = 86_400_000;
const ist = (iso) => Date.parse(`${iso}+05:30`);

function setup({ apiKey = KEY, premium = false, scenarios = {} } = {}) {
  const clock = createFakeClock();
  const upstream = createScriptedFetch({
    clock,
    scenarios: {
      ok: (url) => (query(url).function === "GLOBAL_QUOTE" ? { json: fixture("alphavantage/global_quote.json") } : { json: fixture("alphavantage/daily.json") }),
      "rate-limited": () => ({ json: fixture("alphavantage/limit_per_day.json") }),
      auth: () => ({ json: fixture("alphavantage/invalid_key.json") }),
      "not-found": () => ({ json: fixture("alphavantage/invalid_call.json") }),
      upstream: () => ({ status: 503, text: "down" }),
      ...scenarios,
    },
  });
  const provider = createAlphaVantageProvider({ apiKey, fetch: upstream, clock, premium });
  return { clock, upstream, provider };
}

describe("alphavantage descriptor and symbols", () => {
  it("is a valid official bring-your-own-key end-of-day source with the stricter limits", () => {
    const { provider } = setup();
    expect(validateDescriptor(provider.descriptor).errors).toEqual([]);
    expect(provider.descriptor).toMatchObject({ id: "alphavantage", tier: "byok", class: "eod", official: true, needsKey: true, limits: { perMinute: 5, perDay: 25 } });
    expect(provider.descriptor.capabilities).toEqual(["quotes", "history"]);
    expect(provider.descriptor.terms.note.split(".").filter(Boolean)).toHaveLength(1);
  });

  it("maps BSE shares and refuses everything else with a plain message", () => {
    expect(toAlphaVantageSymbol("BSE:RELIANCE")).toBe("RELIANCE.BSE");
    for (const s of ["NSE:RELIANCE", "BSE:SENSEX", "NFO:NIFTY-2026-11-26-FUT"]) {
      let err;
      try {
        toAlphaVantageSymbol(s);
      } catch (e) {
        err = e;
      }
      expect(err.code).toBe("CAPABILITY_UNSUPPORTED");
      expect(err.fields.kind).toBe("unsupported");
    }
    expect(() => toAlphaVantageSymbol("nonsense")).toThrow(expect.objectContaining({ code: "SYMBOL_NOT_FOUND" }));
  });
});

describe("alphavantage quotes", () => {
  it("parses GLOBAL_QUOTE and stamps it at the close of the latest trading day in IST", async () => {
    const { provider, upstream } = setup();
    const { items } = await provider.quotes(["BSE:RELIANCE"], {});
    expect(items).toEqual([
      { symbol: "BSE:RELIANCE", fields: { ltp: 1311.8, open: 1306, high: 1316.2, low: 1303.3, close: 1308.4, volume: 5760000 }, at: ist("2026-11-06T15:30:00"), provider: "alphavantage", flags: ["eod"] },
    ]);
    const call = upstream.calls[0];
    const q = query(call.url);
    expect(new URL(call.url).hostname).toBe("www.alphavantage.co");
    expect(q).toMatchObject({ function: "GLOBAL_QUOTE", symbol: "RELIANCE.BSE", apikey: KEY });
    expect(call.init.headers["user-agent"]).toMatch(/^Bridge-DataSource\//);
  });

  it("reads the key afresh on every call so a changed key takes effect", async () => {
    let key = KEY;
    const { provider, upstream } = setup({ apiKey: () => key });
    await provider.quotes(["BSE:RELIANCE"], {});
    key = "AVKEY-OTHER-5678";
    await provider.quotes(["BSE:RELIANCE"], {});
    expect(upstream.calls.map((c) => query(c.url).apikey)).toEqual([KEY, "AVKEY-OTHER-5678"]);
  });

  it("answers with an auth error, and no request, when no key is configured", async () => {
    const { provider, upstream } = setup({ apiKey: "" });
    const err = await provider.quotes(["BSE:RELIANCE"], {}).catch((e) => e);
    expect(err.fields.kind).toBe("auth");
    expect(err.detail).toMatch(/Sources settings/);
    expect(upstream.calls).toHaveLength(0);
  });

  it("treats an empty quote as not found", async () => {
    const { provider } = setup({ scenarios: { ok: () => ({ json: fixture("alphavantage/global_quote_empty.json") }) } });
    await expect(provider.quotes(["BSE:RELIANCE"], {})).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND" });
  });

  it("refuses NSE without calling the vendor", async () => {
    const { provider, upstream } = setup();
    await expect(provider.quotes(["NSE:RELIANCE"], {})).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED", fields: { kind: "unsupported" } });
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("alphavantage history", () => {
  const req = { symbol: "BSE:RELIANCE", interval: "1d", fromMs: ist("2026-11-01T00:00:00"), toMs: ist("2026-11-08T00:00:00") };

  it("parses daily candles at IST midnight, ascending, skipping the zero-price row", async () => {
    const { provider, upstream, clock } = setup();
    const res = await provider.history(req, { now: clock.now() });
    expect(res.candles.map((c) => c.time * 1000)).toEqual([ist("2026-11-02T00:00:00"), ist("2026-11-04T00:00:00"), ist("2026-11-05T00:00:00"), ist("2026-11-06T00:00:00")]);
    expect(res.candles[0]).toEqual({ time: ist("2026-11-02T00:00:00") / 1000, open: 1290, high: 1302, low: 1288, close: 1296.5, volume: 5120000 });
    expect(res.flags).toEqual(["eod"]);
    expect(res.partial).toBeUndefined();
    expect(query(upstream.calls[0].url)).toMatchObject({ function: "TIME_SERIES_DAILY", symbol: "RELIANCE.BSE", outputsize: "compact" });
  });

  it("limits the answer to the requested range", async () => {
    const { provider, clock } = setup();
    const res = await provider.history({ ...req, fromMs: ist("2026-11-04T00:00:00"), toMs: ist("2026-11-05T12:00:00") }, { now: clock.now() });
    expect(res.candles.map((c) => c.time * 1000)).toEqual([ist("2026-11-04T00:00:00"), ist("2026-11-05T00:00:00")]);
  });

  it("says partial when a free key's 100 points do not reach back far enough", async () => {
    const series = {};
    for (let i = 0; i < 100; i += 1) {
      const day = new Date(Date.UTC(2026, 10, 6) - i * DAY).toISOString().slice(0, 10);
      series[day] = { "1. open": "10", "2. high": "11", "3. low": "9", "4. close": "10.5", "5. volume": "100" };
    }
    const { provider, clock } = setup({ scenarios: { ok: () => ({ json: { "Time Series (Daily)": series } }) } });
    const res = await provider.history({ ...req, fromMs: ist("2025-01-01T00:00:00") }, { now: clock.now() });
    expect(res.candles).toHaveLength(100);
    expect(res.partial).toBe(true);
  });

  it("asks for the full history only with a premium key", async () => {
    const { provider, upstream, clock } = setup({ premium: true });
    await provider.history(req, { now: clock.now() });
    expect(query(upstream.calls[0].url).outputsize).toBe("full");
  });

  it("refuses intraday intervals and the capabilities it does not have", async () => {
    const { provider, upstream } = setup();
    await expect(provider.history({ ...req, interval: "5m" }, {})).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    await expect(provider.expiries("NIFTY")).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    await expect(provider.optionChain("NIFTY")).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("alphavantage errors", () => {
  it("detects the 25-per-day message that arrives with HTTP 200, and waits for the next day", async () => {
    const { provider, upstream, clock } = setup();
    upstream.setScenario("rate-limited");
    const err = await provider.quotes(["BSE:RELIANCE"], {}).catch((e) => e);
    expect(err.code).toBe("UPSTREAM_RATE_LIMITED");
    expect(err.fields.kind).toBe("rate-limited");
    expect(err.retryAfterMs).toBeGreaterThanOrEqual(60_000);
    expect(err.retryAfterMs).toBeLessThanOrEqual(DAY);
    upstream.setScenario("ok");
    const again = await provider.quotes(["BSE:RELIANCE"], {}).catch((e) => e);
    expect(again.code).toBe("UPSTREAM_RATE_LIMITED");
    expect(upstream.calls).toHaveLength(1);
    clock.advance(DAY + 1000);
    await expect(provider.quotes(["BSE:RELIANCE"], {})).resolves.toBeTruthy();
  });

  it("classifies a bad key, an unknown symbol, a premium-only answer, HTTP 429 and 5xx", async () => {
    const run = async (scenarios, scenario) => {
      const s = setup({ scenarios });
      s.upstream.setScenario(scenario);
      return s.provider.history({ symbol: "BSE:RELIANCE", interval: "1d", fromMs: ist("2026-11-01T00:00:00"), toMs: ist("2026-11-08T00:00:00") }, { now: ist("2026-11-09T10:00:00") }).catch((e) => e);
    };
    expect((await run({}, "auth")).fields.kind).toBe("auth");
    expect((await run({}, "not-found")).code).toBe("SYMBOL_NOT_FOUND");
    expect((await run({ premium: () => ({ json: { Information: "This is a premium endpoint. Subscribe to a premium plan to unlock it." } }) }, "premium")).fields.kind).toBe("entitlement");
    const http429 = await run({ h429: () => ({ status: 429, headers: { "retry-after": "12" }, text: "" }) }, "h429");
    expect(http429.code).toBe("UPSTREAM_RATE_LIMITED");
    expect(http429.retryAfterMs).toBe(12_000);
    expect((await run({}, "upstream")).code).toBe("UPSTREAM_ERROR");
    expect((await run({ h401: () => ({ status: 401, text: "" }) }, "h401")).fields.kind).toBe("auth");
    expect((await run({}, "network-error")).code).toBe("BROKER_UNAVAILABLE");
    expect((await run({}, "garbage")).code).toBe("UPSTREAM_ERROR");
  });
});

describe("alphavantage secrets", () => {
  it("never puts the key in an error, even when the network error and the vendor message contain it", async () => {
    const echo = { ok: () => ({ json: { Note: `Something odd happened for apikey=${KEY} and ${KEY}` } }) };
    const { provider, upstream } = setup({ scenarios: echo });
    const e1 = await provider.quotes(["BSE:RELIANCE"], {}).catch((e) => e);
    upstream.setScenario("network-error");
    const e2 = await provider.quotes(["BSE:RELIANCE"], {}).catch((e) => e);
    for (const e of [e1, e2]) {
      const text = JSON.stringify({ m: e.message, d: e.detail, f: e.fields, b: e.broker, s: e.stack });
      expect(text).not.toContain(KEY);
      expect(e.cause).toBeUndefined();
    }
  });

  it("does not expose the key on the provider or its descriptor", () => {
    const { provider } = setup();
    expect(JSON.stringify(provider.descriptor)).not.toContain(KEY);
    expect(Object.values(provider).filter((v) => typeof v === "string")).not.toContain(KEY);
  });
});

describe("alphavantage limits", () => {
  it("sends at most 5 requests a minute and 25 a day, whatever the burst (fake clock)", async () => {
    const { provider, upstream, clock } = setup();
    const burst = () => Promise.all(Array.from({ length: 12 }, () => provider.quotes(["BSE:RELIANCE"], {}).then(() => "ok", (e) => e.code)));
    const first = await burst();
    expect(upstream.calls).toHaveLength(5);
    expect(first.filter((r) => r === "ok")).toHaveLength(5);
    expect(first.filter((r) => r === "UPSTREAM_RATE_LIMITED")).toHaveLength(7);
    for (let i = 0; i < 8; i += 1) {
      clock.advance(61_000);
      await burst();
    }
    expect(upstream.calls).toHaveLength(25);
    expect(windowViolations(upstream.calls.map((c) => c.at), provider.descriptor.limits)).toEqual([]);
    expect(provider.usage().today).toBe(25);
    clock.advance(DAY);
    await expect(provider.quotes(["BSE:RELIANCE"], {})).resolves.toBeTruthy();
  });

  it("test() says it used one request, and reports a rejected key plainly", async () => {
    const ok = setup();
    expect(await ok.provider.test({})).toMatchObject({ ok: true, detail: expect.stringMatching(/one of the day's requests/) });
    const bad = setup();
    bad.upstream.setScenario("auth");
    const r = await bad.provider.test({});
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/did not accept the key/);
  });
});

describe("alphavantage conformance", () => {
  it("passes the conformance harness", async () => {
    const { provider, upstream, clock } = setup();
    const report = await runProviderConformance(provider, {
      clock,
      upstream,
      inputs: { quotes: ["BSE:RELIANCE"], history: { symbol: "BSE:RELIANCE", interval: "1d", fromMs: ist("2026-11-01T00:00:00"), toMs: ist("2026-11-08T00:00:00") } },
      secrets: [KEY],
    });
    expect(report.failures).toEqual([]);
    expect(report.checks.find((c) => c.name === "errors:auth")?.ok).toBe(true);
  });
});
