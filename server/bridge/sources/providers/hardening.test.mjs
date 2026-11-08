/**
 * Built-in providers against hostile vendors: an endless or oversized body is cut off at 2 MB (never buffered), a timestamp
 * in the future or an impossible price is refused, and a key that a vendor echoes back is scrubbed in its URL-encoded and
 * base64 forms as well as verbatim. Fake fetches only: nothing here touches the network.
 */
import { describe, expect, it } from "vitest";
import { createFakeClock, createScriptedFetch } from "../conformance.mjs";
import { secretForms, scrubSecrets } from "../redact.mjs";
import { createAlphaVantageProvider } from "./alphavantage.mjs";
import { FUTURE_SKEW_MS, MAX_BODY_BYTES, MAX_PRICE, price, readCapped, redactText, vendorTime } from "./common.mjs";
import { createTwelveDataProvider } from "./twelvedata.mjs";
import { createYahooProvider } from "./yahoo.mjs";
import { fixture } from "./testkit.mjs";

const MB = 1024 * 1024;

/** A response whose body is produced chunk by chunk on demand, counting what was pulled and whether it was cancelled. */
function streamingResponse({ chunkBytes = 64 * 1024, totalBytes = Infinity, headers = {}, status = 200, fill = 0x20 } = {}) {
  const stats = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(chunkBytes).fill(fill);
  const body = new ReadableStream({
    pull(controller) {
      if (stats.pulled >= totalBytes) return controller.close();
      stats.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      stats.cancelled = true;
    },
  });
  return { res: new Response(body, { status, headers: { "content-type": "application/json", ...headers } }), stats };
}

const rejection = async (p) => {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
};

describe("readCapped: the body is streamed and cut off at the limit", () => {
  it("returns a body under the cap in full, including multi-byte text split across chunks", async () => {
    const text = "héllo wörld 日本語";
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream({
      start(c) {
        c.enqueue(bytes.slice(0, 3)); // splits the é
        c.enqueue(bytes.slice(3));
        c.close();
      },
    });
    expect(await readCapped(new Response(body), 1024)).toBe(text);
  });

  it("an endless body is cancelled right after the cap, having read at most one chunk more", async () => {
    const { res, stats } = streamingResponse();
    const err = await rejection(readCapped(res, 2 * MB));
    expect(err.tooLarge).toBe(true);
    expect(stats.cancelled).toBe(true);
    expect(stats.pulled).toBeLessThanOrEqual(2 * MB + 2 * 64 * 1024);
  });

  it("a body just over the cap is refused and one exactly at the cap is read", async () => {
    expect((await rejection(readCapped(streamingResponse({ totalBytes: 2 * MB + 1, chunkBytes: 1 }).res, 2 * MB))).tooLarge).toBe(true);
    const ok = streamingResponse({ totalBytes: 4096, chunkBytes: 1024 });
    expect((await readCapped(ok.res, 4096)).length).toBe(4096);
  });

  it("a declared Content-Length over the cap is refused before anything is read", async () => {
    const { res, stats } = streamingResponse({ headers: { "content-length": String(300 * MB) } });
    const err = await rejection(readCapped(res, 2 * MB));
    expect(err.tooLarge).toBe(true);
    expect(stats.pulled).toBeLessThanOrEqual(64 * 1024); // only what the stream pre-filled before anyone read
    expect(stats.cancelled).toBe(true);
  });

  it("a response object with only text() is checked after the read", async () => {
    expect(await readCapped({ text: async () => "ok", headers: new Headers() }, 10)).toBe("ok");
    expect((await rejection(readCapped({ text: async () => "x".repeat(11), headers: new Headers() }, 10))).tooLarge).toBe(true);
  });

  it("the cap is 2 MB", () => {
    expect(MAX_BODY_BYTES).toBe(2 * MB);
  });
});

describe("every built-in provider drops an oversized answer with a plain UPSTREAM_ERROR", () => {
  const providers = [
    ["yahoo", (fetch, clock) => createYahooProvider({ fetch, clock }), "NSE:RELIANCE"],
    ["twelvedata", (fetch, clock) => createTwelveDataProvider({ fetch, clock, apiKey: "TD-KEY-123456" }), "NSE:RELIANCE"],
    ["alphavantage", (fetch, clock) => createAlphaVantageProvider({ fetch, clock, apiKey: "AV-KEY-123456" }), "BSE:RELIANCE"],
  ];

  it.each(providers)("%s: an endless body", async (_id, make, symbol) => {
    const clock = createFakeClock();
    const { res, stats } = streamingResponse();
    const err = await rejection(make(async () => res, clock).quotes([symbol], { now: clock.now() }));
    expect(err.code).toBe("UPSTREAM_ERROR");
    expect(err.fields.kind).toBe("upstream");
    expect(err.detail).toMatch(/larger than 2 MB/);
    expect(stats.cancelled).toBe(true);
    expect(stats.pulled).toBeLessThan(3 * MB);
  });

  it.each(providers)("%s: a 300 MB Content-Length", async (_id, make, symbol) => {
    const clock = createFakeClock();
    const { res, stats } = streamingResponse({ headers: { "content-length": String(300 * MB) } });
    const err = await rejection(make(async () => res, clock).quotes([symbol], { now: clock.now() }));
    expect(err.code).toBe("UPSTREAM_ERROR");
    expect(err.detail).toMatch(/larger than 2 MB/);
    expect(stats.pulled).toBeLessThanOrEqual(64 * 1024); // only what the stream pre-filled before anyone read: the provider read nothing
    expect(stats.cancelled).toBe(true);
  });
});

describe("price() and vendorTime()", () => {
  it("accepts a finite price above 0 up to 1e9 and refuses everything else", () => {
    for (const v of [0.05, 1, 25_000, MAX_PRICE, "1311.8"]) expect(price(v)).not.toBeNull();
    for (const v of [0, -1, -0.01, NaN, Infinity, -Infinity, "Infinity", "1e400", 1e300, MAX_PRICE * 1.0001, MAX_PRICE + 1, "", null, undefined, {}, [], "abc"]) expect(price(v), String(v)).toBeNull();
  });

  it("clamps a time up to 5 minutes ahead to now and refuses further ahead, zero, negative and non-finite", () => {
    const now = 1_800_000_000_000;
    expect(vendorTime(now - 900_000, now)).toBe(now - 900_000);
    expect(vendorTime(now, now)).toBe(now);
    expect(vendorTime(now + 1000, now)).toBe(now);
    expect(vendorTime(now + FUTURE_SKEW_MS, now)).toBe(now);
    for (const v of [now + FUTURE_SKEW_MS + 1, now + 86_400_000, 0, -5, NaN, Infinity, "1800000000000", null, undefined]) expect(vendorTime(v, now), String(v)).toBeNull();
    expect(FUTURE_SKEW_MS).toBe(5 * 60_000);
  });
});

describe("hostile payloads", () => {
  const clock0 = () => createFakeClock();
  const respond = (clock, scenario) => createScriptedFetch({ clock, scenarios: { ok: () => scenario } });

  const yahooChart = (clock, over = {}) => ({
    json: { chart: { result: [{ meta: { regularMarketTime: Math.floor(clock.now() / 1000) - 600, regularMarketPrice: 1311.8, previousClose: 1300, ...over }, timestamp: [], indicators: { quote: [{}] } }], error: null } },
  });

  it("yahoo: a time more than 5 minutes ahead is refused, a few minutes ahead is clamped to now, the past is kept", async () => {
    const clock = clock0();
    const ahead = (sec) => Math.floor(clock.now() / 1000) + sec;
    const ask = async (over) => createYahooProvider({ fetch: respond(clock, yahooChart(clock, over)), clock }).quotes(["NSE:RELIANCE"], { now: clock.now() });
    expect((await rejection(ask({ regularMarketTime: ahead(3600) }))).code).toBe("UPSTREAM_ERROR");
    expect((await rejection(ask({ regularMarketTime: ahead(301) }))).detail).toMatch(/no usable price/);
    expect((await ask({ regularMarketTime: ahead(120) })).items[0].at).toBe(clock.now());
    const past = Math.floor(clock.now() / 1000) - 900;
    expect((await ask({ regularMarketTime: past })).items[0].at).toBe(past * 1000);
  });

  it.each([1e300, "1e400", -5, 0, "Infinity", 2e9, null, "NaN", "abc"])("yahoo: a price of %j is refused", async (bad) => {
    const clock = clock0();
    const p = createYahooProvider({ fetch: respond(clock, yahooChart(clock, { regularMarketPrice: bad })), clock });
    expect((await rejection(p.quotes(["NSE:RELIANCE"], { now: clock.now() }))).code).toBe("UPSTREAM_ERROR");
  });

  it("twelvedata: a far-future timestamp, a future date and impossible prices are refused", async () => {
    const clock = clock0();
    const q = fixture("twelvedata/quote.json");
    const ask = async (over) => createTwelveDataProvider({ apiKey: "TD-KEY-123456", fetch: respond(clock, { json: { ...q, ...over } }), clock }).quotes(["NSE:RELIANCE"], { now: clock.now() });
    expect((await ask({})).items).toHaveLength(1);
    const future = Math.floor(clock.now() / 1000) + 3600;
    expect((await rejection(ask({ timestamp: future }))).code).toBe("SYMBOL_NOT_FOUND");
    expect((await rejection(ask({ timestamp: null, datetime: "2999-01-01" }))).code).toBe("SYMBOL_NOT_FOUND");
    for (const close of ["1e12", "-3", "0", "1e400", "NaN"]) expect((await rejection(ask({ close }))).code, close).toBe("SYMBOL_NOT_FOUND");
  });

  it("twelvedata: a candle dated in the future is dropped from history", async () => {
    const clock = clock0();
    const series = fixture("twelvedata/time_series.json");
    const values = [...series.values, { datetime: "2999-01-01", open: "1", high: "2", low: "1", close: "1.5", volume: "1" }, { datetime: "2026-11-05", open: "1", high: "2", low: "1", close: "1e12", volume: "1" }];
    const p = createTwelveDataProvider({ apiKey: "TD-KEY-123456", fetch: respond(clock, { json: { ...series, values } }), clock });
    const out = await p.history({ symbol: "NSE:RELIANCE", interval: "1d", fromMs: clock.now() - 40 * 86_400_000, toMs: clock.now() }, { now: clock.now() });
    expect(out.candles.every((c) => c.time * 1000 <= clock.now() + FUTURE_SKEW_MS)).toBe(true);
    expect(out.candles.every((c) => c.close <= MAX_PRICE)).toBe(true);
    expect(out.candles.length).toBe(series.values.length);
  });

  it("alphavantage: a trading day in the future and impossible prices are refused, and future days are dropped from history", async () => {
    const clock = clock0();
    const q = fixture("alphavantage/global_quote.json");
    const withQuote = (patch) => ({ json: { "Global Quote": { ...q["Global Quote"], ...patch } } });
    const ask = (patch) => createAlphaVantageProvider({ apiKey: "AV-KEY-123456", fetch: respond(clock, withQuote(patch)), clock }).quotes(["BSE:RELIANCE"], { now: clock.now() });
    expect((await ask({})).items).toHaveLength(1);
    expect((await rejection(ask({ "07. latest trading day": "2999-01-01" }))).code).toBe("SYMBOL_NOT_FOUND");
    for (const bad of ["1e12", "-1", "0", "Infinity", "abc"]) expect((await rejection(ask({ "05. price": bad }))).code, bad).toBe("SYMBOL_NOT_FOUND");
    const daily = fixture("alphavantage/daily.json");
    const series = { ...daily["Time Series (Daily)"], "2999-01-01": { "1. open": "1", "2. high": "2", "3. low": "1", "4. close": "1.5", "5. volume": "1" } };
    const p = createAlphaVantageProvider({ apiKey: "AV-KEY-123456", fetch: respond(clock, { json: { ...daily, "Time Series (Daily)": series } }), clock });
    const out = await p.history({ symbol: "BSE:RELIANCE", interval: "1d", fromMs: clock.now() - 200 * 86_400_000, toMs: clock.now() + 3000 * 86_400_000 }, { now: clock.now() });
    expect(out.candles.every((c) => c.time * 1000 <= clock.now() + FUTURE_SKEW_MS)).toBe(true);
    const real = Object.values(daily["Time Series (Daily)"]).filter((r) => Number(r["1. open"]) > 0).length; // the fixture has a zero-price holiday
    expect(out.candles.length).toBe(real);
  });
});

describe("a key echoed back is scrubbed in every form", () => {
  const KEYS = ["AV-KEY-0123456789", "k/e+y=with&odd chars?x", "plainkey1234", "ünïcode-ключ-key"];

  it("secretForms covers verbatim, URL-encoded (both hex cases), form-encoded and base64 parts, and no form is empty or tiny", () => {
    for (const key of KEYS.filter((k) => !k.includes(" "))) {
      const forms = secretForms(key);
      expect(forms).toContain(key);
      expect(forms).toContain(encodeURIComponent(key));
      expect(forms.every((f) => f.length >= 6 || f === key)).toBe(true);
      const std = Buffer.from(key).toString("base64").replace(/=+$/, "");
      expect(forms.some((f) => std.includes(f) && f.length >= 6)).toBe(true);
    }
    expect(secretForms("abc")).toEqual([]);
    expect(secretForms("")).toEqual([]);
    expect(secretForms(undefined)).toEqual([]);
    expect(secretForms("x".repeat(600))).toEqual([]);
  });

  it.each(KEYS)("scrubSecrets and redactText remove %j however it was written", (key) => {
    const b64 = Buffer.from(key).toString("base64");
    const b64url = Buffer.from(key).toString("base64url");
    const basic = Buffer.from(`user:${key}`).toString("base64");
    const basic1 = Buffer.from(`u:${key}:tail`).toString("base64");
    const basic2 = Buffer.from(`${key}:x`).toString("base64");
    const spellings = [key, encodeURIComponent(key), encodeURIComponent(key).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()), b64, b64.replace(/=+$/, ""), b64url, basic, basic1, basic2, `Authorization: Basic ${basic}`];
    for (const s of spellings) {
      const text = `upstream said: bad request for ${s} (see docs)`;
      for (const out of [scrubSecrets(text, [key]), redactText(text, [key])]) {
        expect(out, s).toContain("***");
        // nothing recognisable is left: not the key, and not a 6-character piece of its base64 or encoded form
        for (const form of secretForms(key)) expect(out.includes(form), `${s} -> ${form}`).toBe(false);
      }
    }
  });

  it("leaves unrelated text alone and never builds a regular expression from the key", () => {
    expect(scrubSecrets("nothing to hide here", ["AV-KEY-0123456789"])).toBe("nothing to hide here");
    expect(scrubSecrets("a(b)c [x] .* \\", ["(.*)[a-z]+$^"])).toBe("a(b)c [x] .* \\");
    expect(scrubSecrets("x", [null, undefined, 5, "ab"])).toBe("x");
  });

  it("a vendor that echoes the key URL-encoded or as base64 in its error does not get it through the provider's message", async () => {
    const key = "TD/KEY+0123456789=";
    const forms = [encodeURIComponent(key), Buffer.from(key).toString("base64"), Buffer.from(`apikey ${key}`).toString("base64")];
    for (const echoed of forms) {
      const clock = createFakeClock();
      const upstream = createScriptedFetch({ clock, scenarios: { ok: () => ({ status: 400, json: { code: 400, status: "error", message: `Bad request: ${echoed}` } }) } });
      const err = await rejection(createTwelveDataProvider({ apiKey: key, fetch: upstream, clock }).quotes(["NSE:RELIANCE"], { now: clock.now() }));
      const text = JSON.stringify([err.message, err.detail]);
      for (const form of secretForms(key)) expect(text.includes(form), `${echoed} -> ${form}`).toBe(false);
    }
  });
});

describe("alphavantage test() reports success only for the documented shape", () => {
  const run = async (answer) => {
    const clock = createFakeClock();
    const upstream = createScriptedFetch({ clock, scenarios: { ok: () => answer } });
    return createAlphaVantageProvider({ apiKey: "AV-KEY-123456", fetch: upstream, clock }).test({ now: clock.now() });
  };

  it("fails for {}, an empty Global Quote, a quote without a price or a day, an unrelated document and an array", async () => {
    for (const json of [{}, { "Global Quote": {} }, { "Global Quote": { "05. price": "1311.8" } }, { "Global Quote": { "05. price": "abc", "07. latest trading day": "2026-11-06" } }, { "Global Quote": "yes" }, { hello: "world" }, { ok: true }]) {
      const r = await run({ json });
      expect(r.ok, JSON.stringify(json)).toBe(false);
      expect(r.detail).toMatch(/documented shape/);
    }
  });

  it("succeeds for a real Global Quote", async () => {
    const r = await run({ json: fixture("alphavantage/global_quote.json") });
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/key was accepted/);
  });
});
