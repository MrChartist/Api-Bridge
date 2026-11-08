/**
 * Tests for the example plugin, offline. Two layers, both worth copying into your own plugin:
 *
 *  1. Unit: call the plugin's methods with a stub `ctx` that answers from files in fixtures/. This is fast and shows
 *     exactly how the plugin maps the vendor's answers and failures.
 *  2. Conformance: start the plugin for real through the Bridge's plugin host, with every request answered from the
 *     fixtures, and run the provider conformance harness. The same check is available on the command line:
 *       mc-bridge sources plugins check examples/source-plugin
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import plugin from "./index.mjs";
import { checkPluginFolder } from "../../server/bridge/sources/plugin/check.mjs";
import { inspectPluginFolder } from "../../server/bridge/sources/plugin/loader.mjs";

const HERE = import.meta.dirname;
const fixture = (name) => readFileSync(resolve(HERE, "fixtures", name), "utf8");

/** A stub of the ctx the host gives a plugin. `answer` is what the vendor returns for a request. */
function stubCtx(answer) {
  const requests = [];
  return {
    requests,
    config: { market: "NSE" },
    now: Date.parse("2026-10-19T10:00:00+05:30"),
    signal: new AbortController().signal,
    fail(code, message, retryAfterMs) {
      throw Object.assign(new Error(message), { code, retryAfterMs });
    },
    async fetch(url, init) {
      requests.push({ url, init });
      const { status = 200, body = "", headers = {} } = answer(url);
      return {
        ok: status >= 200 && status < 300,
        status,
        headers,
        text: async () => body,
        json: async () => {
          try {
            return JSON.parse(body);
          } catch {
            throw Object.assign(new Error("the response was not JSON"), { code: "BAD_RESPONSE" });
          }
        },
      };
    },
  };
}

describe("example plugin: unit", () => {
  it("maps the vendor's quotes, using the vendor's own timestamps", async () => {
    const ctx = stubCtx(() => ({ body: fixture("quotes.json") }));
    const r = await plugin.quotes(["NSE:RELIANCE", "NSE:TCS"], ctx);
    expect(ctx.requests).toHaveLength(1);
    expect(ctx.requests[0].url).toBe("https://quotes.example.com/v1/quotes?symbols=NSE%3ARELIANCE%2CNSE%3ATCS&market=NSE");
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toEqual({ symbol: "NSE:RELIANCE", at: Date.parse("2026-10-19T09:45:00+05:30"), fields: { ltp: 2891.4, open: 2880, high: 2899.9, low: 2872.1, close: 2875.55, volume: 4182211 } });
    expect(r.items.every((i) => i.at < ctx.now)).toBe(true); // delayed data is never stamped "now"
  });

  it.each([
    [429, { "retry-after": "12" }, "RATE_LIMITED", 12_000],
    [401, {}, "AUTH", undefined],
    [404, {}, "NOT_FOUND", undefined],
    [503, {}, "UNAVAILABLE", undefined],
    [418, {}, "BAD_RESPONSE", undefined],
  ])("reports a %i answer as %s", async (status, headers, code, retryAfterMs) => {
    const ctx = stubCtx(() => ({ status, headers, body: "no" }));
    await expect(plugin.quotes(["NSE:X"], ctx)).rejects.toMatchObject({ code, retryAfterMs });
  });

  it("reports an answer that is not JSON as BAD_RESPONSE", async () => {
    await expect(plugin.quotes(["NSE:X"], stubCtx(() => ({ body: "<html>maintenance</html>" })))).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("skips quotes without a vendor timestamp and fails when nothing is left", async () => {
    const body = JSON.stringify({ quotes: [{ symbol: "NSE:X", last: 5 }] });
    await expect(plugin.quotes(["NSE:X"], stubCtx(() => ({ body })))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("test() reports the vendor's status", async () => {
    expect((await plugin.test(stubCtx(() => ({ body: "{}" })))).ok).toBe(true);
    expect((await plugin.test(stubCtx(() => ({ status: 500 })))).ok).toBe(false);
  });
});

describe("example plugin: manifest and conformance", () => {
  it("has a valid manifest and descriptor", () => {
    const info = inspectPluginFolder(HERE);
    expect(info.problems).toEqual([]);
    expect(info.descriptor).toMatchObject({ id: "example-delayed", tier: "plugin", official: false, class: "delayed", delaySec: 900, capabilities: ["quotes"] });
  });

  it.skipIf(!existsSync(resolve(HERE, "../../server/bridge/sources/conformance.mjs")))("passes the provider conformance harness, offline", async () => {
    const r = await checkPluginFolder(HERE);
    expect(r.steps.filter((s) => !s.ok)).toEqual([]);
    expect(r.ok).toBe(true);
  }, 60_000);
});
