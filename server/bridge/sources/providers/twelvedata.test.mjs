import { describe, expect, it } from "vitest";
import { createFakeClock, createScriptedFetch, runProviderConformance, windowViolations } from "../conformance.mjs";
import { validateDescriptor } from "../contract.mjs";
import { fixture, query } from "./testkit.mjs";
import { createTwelveDataProvider, toTwelveDataSymbol } from "./twelvedata.mjs";

// Field names follow the vendor's documentation; the values are invented.
const KEY = "TDKEY-TEST-9876";
const DAY = 86_400_000;
const ist = (iso) => Date.parse(`${iso}+05:30`);

function setup({ apiKey = KEY, scenarios = {} } = {}) {
  const clock = createFakeClock();
  const upstream = createScriptedFetch({
    clock,
    scenarios: {
      ok: (url) => (new URL(url).pathname === "/quote" ? { json: fixture("twelvedata/quote.json") } : { json: fixture("twelvedata/time_series.json") }),
      "rate-limited": () => ({ status: 429, json: fixture("twelvedata/error_429.json") }),
      auth: () => ({ status: 401, json: fixture("twelvedata/error_401.json") }),
      "not-found": () => ({ status: 404, json: fixture("twelvedata/error_404.json") }),
      entitlement: () => ({ status: 403, json: fixture("twelvedata/error_403_plan.json") }),
      upstream: () => ({ status: 503, text: "down" }),
      ...scenarios,
    },
  });
  const provider = createTwelveDataProvider({ apiKey, fetch: upstream, clock });
  return { clock, upstream, provider };
}

describe("twelvedata descriptor and symbols", () => {
  it("is a valid official bring-your-own-key end-of-day source with 8 per minute and 800 per day", () => {
    const { provider } = setup();
    expect(validateDescriptor(provider.descriptor).errors).toEqual([]);
    expect(provider.descriptor).toMatchObject({ id: "twelvedata", tier: "byok", class: "eod", official: true, needsKey: true, limits: { perMinute: 8, perDay: 800 } });
    expect(provider.descriptor.terms.url).toBe("https://twelvedata.com/terms");
  });

  it("maps NSE and BSE shares to a symbol and a market identifier code", () => {
    expect(toTwelveDataSymbol("NSE:RELIANCE")).toEqual({ symbol: "RELIANCE", mic_code: "XNSE" });
    expect(toTwelveDataSymbol("BSE:RELIANCE")).toEqual({ symbol: "RELIANCE", mic_code: "XBOM" });
    for (const s of ["NSE:NIFTY", "NFO:NIFTY-2026-11-26-FUT", "MCX:CRUDEOIL-2026-11-19-FUT"]) expect(() => toTwelveDataSymbol(s)).toThrow(expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED" }));
    expect(() => toTwelveDataSymbol("junk")).toThrow(expect.objectContaining({ code: "SYMBOL_NOT_FOUND" }));
  });
});

describe("twelvedata quotes", () => {
  it("parses the quote and sends the key in the Authorization header, not the URL", async () => {
    const { provider, upstream } = setup();
    const { items } = await provider.quotes(["NSE:RELIANCE"], {});
    expect(items).toEqual([
      { symbol: "NSE:RELIANCE", fields: { ltp: 1311.8, open: 1306, high: 1316.2, low: 1303.3, close: 1308.4, volume: 5760000 }, at: 1793936700 * 1000, provider: "twelvedata", flags: ["eod"] },
    ]);
    const call = upstream.calls[0];
    expect(new URL(call.url).hostname).toBe("api.twelvedata.com");
    expect(query(call.url)).toEqual({ symbol: "RELIANCE", mic_code: "XNSE" });
    expect(call.url).not.toContain(KEY);
    expect(call.init.headers.authorization).toBe(`apikey ${KEY}`);
    expect(call.init.headers["user-agent"]).toMatch(/^Bridge-DataSource\//);
  });

  it("falls back to the quote date in IST when there is no timestamp", async () => {
    const q = { ...fixture("twelvedata/quote.json"), timestamp: undefined };
    const { provider } = setup({ scenarios: { ok: () => ({ json: q }) } });
    const { items } = await provider.quotes(["BSE:RELIANCE"], {});
    expect(items[0].at).toBe(ist("2026-11-06T00:00:00"));
  });

  it("makes one request per symbol and keeps what it could read", async () => {
    const { provider, upstream } = setup();
    const { items } = await provider.quotes(["NSE:RELIANCE", "NSE:NIFTY", "BSE:RELIANCE"], {});
    expect(items.map((i) => i.symbol)).toEqual(["NSE:RELIANCE", "BSE:RELIANCE"]);
    expect(upstream.calls.map((c) => query(c.url).mic_code)).toEqual(["XNSE", "XBOM"]);
  });

  it("says plainly when the plan has no India coverage (HTTP 403)", async () => {
    const { provider, upstream } = setup();
    upstream.setScenario("entitlement");
    const err = await provider.quotes(["NSE:RELIANCE"], {}).catch((e) => e);
    expect(err.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(err.fields.kind).toBe("entitlement");
    expect(err.detail).toBe("Your Twelve Data plan does not include NSE and BSE data. Indian exchanges need the Grow plan or above.");
  });

  it("recognises the plan message when it arrives with HTTP 200 and the code in the body", async () => {
    const { provider } = setup({ scenarios: { ok: () => ({ json: fixture("twelvedata/error_403_plan.json") }) } });
    await expect(provider.quotes(["NSE:RELIANCE"], {})).rejects.toMatchObject({ fields: { kind: "entitlement" } });
  });
});

describe("twelvedata history", () => {
  const req = { symbol: "NSE:RELIANCE", interval: "1d", fromMs: ist("2026-11-01T00:00:00"), toMs: ist("2026-11-08T00:00:00") };

  it("parses daily values (newest-first or not) into ascending IST-midnight candles", async () => {
    const tsData = fixture("twelvedata/time_series.json");
    tsData.values.reverse();
    const { provider, upstream, clock } = setup({ scenarios: { ok: () => ({ json: tsData }) } });
    const res = await provider.history(req, { now: clock.now() });
    expect(res.candles.map((c) => c.time * 1000)).toEqual([ist("2026-11-02T00:00:00"), ist("2026-11-04T00:00:00"), ist("2026-11-05T00:00:00"), ist("2026-11-06T00:00:00")]);
    expect(res.candles[3]).toEqual({ time: ist("2026-11-06T00:00:00") / 1000, open: 1306, high: 1316.2, low: 1303.3, close: 1311.8, volume: 5760000 });
    expect(res.flags).toEqual(["eod"]);
    expect(res.partial).toBeUndefined();
    expect(query(upstream.calls[0].url)).toMatchObject({ symbol: "RELIANCE", mic_code: "XNSE", interval: "1day", start_date: "2026-11-01", end_date: "2026-11-08", order: "asc" });
  });

  it("skips rows with missing prices and says partial when the point cap is reached", async () => {
    const values = Array.from({ length: 5000 }, (_, i) => ({ datetime: new Date(Date.UTC(2026, 10, 6) - i * DAY).toISOString().slice(0, 10), open: "10", high: "11", low: "9", close: "10.5", volume: "1" }));
    values[3].close = null;
    const { provider, clock } = setup({ scenarios: { ok: () => ({ json: { values, status: "ok" } }) } });
    const res = await provider.history({ ...req, fromMs: ist("2000-01-01T00:00:00") }, { now: clock.now() });
    expect(res.candles).toHaveLength(4999);
    expect(res.partial).toBe(true);
  });

  it("refuses non-daily intervals and unsupported capabilities without a request", async () => {
    const { provider, upstream } = setup();
    await expect(provider.history({ ...req, interval: "5m" }, {})).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    await expect(provider.expiries("NIFTY")).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    await expect(provider.optionChain("NIFTY")).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("twelvedata errors", () => {
  it("classifies 401, 404, 429, 5xx, network failure and garbage", async () => {
    const run = async (scenario) => {
      const s = setup();
      s.upstream.setScenario(scenario);
      return s.provider.quotes(["NSE:RELIANCE"], {}).catch((e) => e);
    };
    expect((await run("auth")).fields.kind).toBe("auth");
    expect((await run("not-found")).code).toBe("SYMBOL_NOT_FOUND");
    const limited = await run("rate-limited");
    expect(limited.code).toBe("UPSTREAM_RATE_LIMITED");
    expect(limited.retryAfterMs).toBe(60_000);
    expect((await run("upstream")).code).toBe("UPSTREAM_ERROR");
    expect((await run("network-error")).code).toBe("BROKER_UNAVAILABLE");
    expect((await run("garbage")).code).toBe("UPSTREAM_ERROR");
  });

  it("honours Retry-After on a 429 and sends nothing until it passes", async () => {
    const { provider, upstream, clock } = setup({ scenarios: { "rate-limited": () => ({ status: 429, headers: { "retry-after": "20" }, json: fixture("twelvedata/error_429.json") }) } });
    upstream.setScenario("rate-limited");
    const err = await provider.quotes(["NSE:RELIANCE"], {}).catch((e) => e);
    expect(err.retryAfterMs).toBe(20_000);
    upstream.setScenario("ok");
    await expect(provider.quotes(["NSE:RELIANCE"], {})).rejects.toMatchObject({ code: "UPSTREAM_RATE_LIMITED" });
    expect(upstream.calls).toHaveLength(1);
    clock.advance(21_000);
    await expect(provider.quotes(["NSE:RELIANCE"], {})).resolves.toBeTruthy();
  });

  it("treats a missing key as an auth problem without a request", async () => {
    const { provider, upstream } = setup({ apiKey: "" });
    await expect(provider.quotes(["NSE:RELIANCE"], {})).rejects.toMatchObject({ fields: { kind: "auth" } });
    expect(upstream.calls).toHaveLength(0);
  });

  it("never leaks the key", async () => {
    const { provider, upstream } = setup({ scenarios: { leaky: () => ({ status: 400, json: { code: 400, message: `bad thing with ${KEY}`, status: "error" } }) } });
    upstream.setScenario("leaky");
    const e1 = await provider.quotes(["NSE:RELIANCE"], {}).catch((e) => e);
    upstream.setScenario("network-error");
    const e2 = await provider.quotes(["NSE:RELIANCE"], {}).catch((e) => e);
    for (const e of [e1, e2]) expect(JSON.stringify({ m: e.message, d: e.detail, f: e.fields, s: e.stack })).not.toContain(KEY);
  });
});

describe("twelvedata limits", () => {
  it("sends at most 8 requests a minute and 800 a day, whatever the burst (fake clock)", async () => {
    const { provider, upstream, clock } = setup();
    const burst = (n) => Promise.all(Array.from({ length: n }, () => provider.quotes(["NSE:RELIANCE"], {}).then(() => "ok", (e) => e.code)));
    const first = await burst(20);
    expect(first.filter((r) => r === "ok")).toHaveLength(8);
    expect(upstream.calls).toHaveLength(8);
    for (let i = 0; i < 110; i += 1) {
      clock.advance(61_000);
      await burst(9);
    }
    expect(upstream.calls).toHaveLength(800);
    expect(windowViolations(upstream.calls.map((c) => c.at), provider.descriptor.limits)).toEqual([]);
    clock.advance(DAY);
    await expect(provider.quotes(["NSE:RELIANCE"], {})).resolves.toBeTruthy();
  });

  it("test() reports a plan without India as a plain failure", async () => {
    const { provider, upstream } = setup();
    upstream.setScenario("entitlement");
    const r = await provider.test({});
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/Grow plan/);
  });
});

describe("twelvedata conformance", () => {
  it("passes the conformance harness, including the plan restriction", async () => {
    const { provider, upstream, clock } = setup();
    const report = await runProviderConformance(provider, {
      clock,
      upstream,
      inputs: { quotes: ["NSE:RELIANCE"], history: { symbol: "NSE:RELIANCE", interval: "1d", fromMs: ist("2026-11-01T00:00:00"), toMs: ist("2026-11-08T00:00:00") } },
      secrets: [KEY],
      scenarios: ["rate-limited", "not-found", "upstream", "network-error", "garbage", "auth", "entitlement"],
    });
    expect(report.failures).toEqual([]);
  });
});
