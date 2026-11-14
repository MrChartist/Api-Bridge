/**
 * /xl/quotes?collection=<name>: a sheet asks for a library collection instead of pasting symbols. A static collection is its
 * list; an option universe is worked out at the time of the request. A price that cannot be trusted refuses the request (as a
 * one-row table), and the headers say when and how the symbols were worked out.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notImplementedService } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { createLibraryService } from "../library/service.mjs";
import { KEYS, createFakeMarketData, createFakeSymbols } from "./__fixtures__/fakes.mjs";
import { bearer, startTestApp } from "./__fixtures__/testApp.mjs";

const dataDir = mkdtempSync(join(tmpdir(), "mcb-xlcol-"));
const mkMarket = createFakeMarketData();
const library = createLibraryService({ config: { dataDir }, logger: { warn() {} }, bus: { emit() {} }, clock: { now: () => Date.now() }, marketData: mkMarket, symbols: createFakeSymbols() });
library.create({ name: "watch", tags: ["xl"], symbols: ["NSE:RELIANCE", "NSE:NIFTY", "NSE:M&M"] });
library.create({ name: "big", symbols: ["NSE:RELIANCE", "NSE:NIFTY", "NSE:M&M"] });

/** A library whose universe answers are set by the test. */
let next = null;
const resolveCalls = [];
const scripted = {
  ...notImplementedService("library"),
  async resolve(name, o) {
    resolveCalls.push([name, o]);
    if (next instanceof Error) throw next;
    return next;
  },
};

let t;
let tScripted;
beforeAll(async () => {
  t = await startTestApp({ overrides: { library } });
  tScripted = await startTestApp({ overrides: { library: scripted } });
});
afterAll(async () => {
  await t.close();
  await tScripted.close();
  rmSync(dataDir, { recursive: true, force: true });
});
const R = bearer(KEYS.READ);
const rows = (r) => r.raw.trimEnd().split("\r\n").map((l) => l.split(","));

describe("a static collection", () => {
  it("is read as if its symbols were typed: one batched read, one row per symbol, in the collection's order", async () => {
    const before = t.marketData.calls.length;
    const r = await t.request("/xl/quotes?collection=watch&fields=ltp", { headers: R });
    expect(r.status).toBe(200);
    expect(rows(r).map((x) => x[0])).toEqual(["symbol", "NSE:RELIANCE", "NSE:NIFTY", "NSE:M&M"]);
    expect(rows(r)[1][1]).toBe("2900");
    expect(t.marketData.calls.slice(before).filter((c) => c[0] === "ltp")).toHaveLength(1);
    expect(r.headers["x-collection-atm-source"]).toBe("not-needed");
    expect(r.headers["x-collection-resolved-at"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.headers["x-collection-rule"]).toBe("a fixed list of symbols");
    expect(r.headers["x-collection-warnings"]).toBeUndefined();
  });

  it("works in json, with the key in the URL like every other sheet request", async () => {
    const r = await t.request(`/xl/quotes?collection=WATCH&format=json&fields=ltp&key=${KEYS.XL}`);
    expect(r.status).toBe(200);
    expect(r.json.map((x) => x.symbol)).toEqual(["NSE:RELIANCE", "NSE:NIFTY", "NSE:M&M"]);
  });

  it("an unknown collection is a one-row table with NOT_FOUND, not a broken sheet", async () => {
    const r = await t.request("/xl/quotes?collection=nope", { headers: R });
    expect(r.status).toBe(404);
    expect(r.headers["x-error-code"]).toBe("NOT_FOUND");
    expect(rows(r)[0]).toEqual(["status", "code", "message", "retry_after_s"]);
    expect(rows(r)[1][1]).toBe("NOT_FOUND");
  });

  it("symbols and collection together are refused; a collection above the sheet limit is refused with the numbers", async () => {
    const both = await t.request("/xl/quotes?collection=watch&symbols=NSE:NIFTY", { headers: R });
    expect(both.status).toBe(400);
    expect(both.raw).toMatch(/not both/);
    const small = await startTestApp({ integrations: { xl: { maxSymbols: 2 } }, overrides: { library } });
    const r = await small.request("/xl/quotes?collection=big", { headers: R });
    await small.close();
    expect(r.status).toBe(400);
    expect(r.raw).toMatch(/resolves to 3 symbols.*at most 2/);
  });

  it("a request with neither symbols nor collection still says symbols is required", async () => {
    const r = await t.request("/xl/quotes", { headers: R });
    expect(r.status).toBe(400);
    expect(r.raw).toMatch(/symbols is required/);
  });
});

describe("an option universe", () => {
  const universe = (o = {}) => ({
    id: "col_aaaaaaaaaa",
    name: "u",
    kind: "option-universe",
    resolvedAt: "2026-10-16T09:30:00.000Z",
    rule: "NIFTY options; expiries: current-weekly; strikes: 1 each side",
    symbols: ["NSE:NIFTY", "NFO:NIFTY-2026-10-27-25000-CE"],
    count: 2,
    atmSource: "live",
    warnings: [],
    ...o,
  });

  it("is resolved at the time of the request with the key's account limits and interactive priority, and the headers say how", async () => {
    next = universe({ warnings: ["The market is closed"] });
    resolveCalls.length = 0;
    const r = await tScripted.request("/xl/quotes?collection=u&fields=ltp", { headers: bearer(KEYS.ONE_ACCOUNT) });
    expect(r.status).toBe(200);
    expect(rows(r).map((x) => x[0])).toEqual(["symbol", "NSE:NIFTY", "NFO:NIFTY-2026-10-27-25000-CE"]);
    expect(resolveCalls[0][0]).toBe("u");
    expect(resolveCalls[0][1]).toMatchObject({ priority: "interactive", allowedAccounts: ["dhan-main"] });
    expect(resolveCalls[0][1].allowStale).toBe(false); // never a stale price for a sheet, whatever library.allowStaleAtm says
    expect(r.headers["x-collection-atm-source"]).toBe("live");
    expect(r.headers["x-collection-resolved-at"]).toBe("2026-10-16T09:30:00.000Z");
    expect(r.headers["x-collection-rule"]).toMatch(/current-weekly/);
    expect(r.headers["x-collection-warnings"]).toBe("1");
  });

  it("a price the library refuses (delayed, stale) is a one-row table with the real status and code", async () => {
    next = new BridgeError("CAPABILITY_UNSUPPORTED", "Only a delayed NIFTY price is available, and it is not used to pick the at-the-money strike.");
    const r = await tScripted.request("/xl/quotes?collection=u", { headers: R });
    expect(r.status).toBe(422);
    expect(r.headers["x-error-code"]).toBe("CAPABILITY_UNSUPPORTED");
    expect(rows(r)[1][1]).toBe("CAPABILITY_UNSUPPORTED");
    expect(r.raw).toMatch(/delayed NIFTY price/);
    next = new BridgeError("BROKER_UNAVAILABLE", "The NIFTY price is stale.");
    expect((await tScripted.request("/xl/quotes?collection=u", { headers: R })).status).toBe(503);
  });

  it("a universe that resolves to nothing is refused", async () => {
    next = universe({ symbols: [], count: 0 });
    const r = await tScripted.request("/xl/quotes?collection=u", { headers: R });
    expect(r.status).toBe(400);
    expect(r.raw).toMatch(/no symbols right now/);
  });

  it("a Bridge without the library answers a clear 501 table", async () => {
    const bare = await startTestApp();
    const r = await bare.request("/xl/quotes?collection=u", { headers: R });
    await bare.close();
    expect(r.status).toBe(501);
    expect(r.headers["x-error-code"]).toBe("NOT_IMPLEMENTED");
  });
});
