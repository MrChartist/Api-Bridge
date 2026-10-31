/**
 * The market-data tools in the opt-in "options" toolset (get_market_movers, get_technicals, get_depth_profile,
 * get_headlines): read-only annotations, inputs that parse, and handlers that answer from the Bridge's own services
 * (fake market data here), never from a broker-specific API.
 */
import { describe, expect, it } from "vitest";
import { createFakeMarketData } from "../market/fake.mjs";
import { TOOL_DEFS } from "./tools.mjs";

const NOW = Date.parse("2026-10-30T05:00:00Z");
const LAST = Date.parse("2026-10-29T00:00:00+05:30") / 1000;
const tool = (name) => TOOL_DEFS.find((t) => t.name === name);
const ctx = { principal: { kind: "local" }, requestId: "m1", scopes: new Set(["read"]), requireAccountAccess: () => {} };

function deps() {
  const clock = { now: () => NOW };
  const marketData = createFakeMarketData({ clock });
  marketData.setCandles("NSE:AAA", "1d", Array.from({ length: 260 }, (_, i) => ({ time: LAST - (259 - i) * 86_400, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1000 })));
  marketData.setDepth("NSE:AAA", { bids: [{ price: 99, qty: 10 }], asks: [{ price: 100, qty: 30 }] });
  for (const [s, ltp, close] of [["NSE:AAA", 110, 100], ["NSE:BBB", 95, 100], ["NSE:CCC", 101, 100]]) marketData.setQuote(s, { ltp, close, volume: 10 });
  const universes = { list: () => [{ name: "MINE" }], resolve: async () => ["NSE:AAA", "NSE:BBB", "NSE:CCC"] };
  const newsFeedsFetcher = async (kind) => (kind === "etMarkets" ? `<rss version="2.0"><channel><item><title>AAA rises on results</title><link>https://economictimes.indiatimes.com/x</link><pubDate>Fri, 30 Oct 2026 09:00:00 +0530</pubDate></item></channel></rss>` : `<rss version="2.0"><channel></channel></rss>`);
  return { marketData, clock, universes, newsFeedsFetcher };
}
const rt = (d) => ({ deps: d, now: () => NOW });

describe("market data tools", () => {
  it("are read-only, in the opt-in options toolset", () => {
    for (const n of ["get_market_movers", "get_technicals", "get_depth_profile", "get_headlines"]) {
      const t = tool(n);
      expect(t.toolset).toBe("options");
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
  });

  it("get_market_movers ranks a universe from quotes", async () => {
    const t = tool("get_market_movers");
    const a = t.input({}).parse({ universe: "MINE", by: "losers", limit: 2, account: null });
    const r = await t.handler(a, ctx, rt(deps()));
    expect(r.data.items.map((i) => i.symbol)).toEqual(["NSE:BBB", "NSE:CCC"]);
    expect(r.data.summary).toMatchObject({ advances: 2, declines: 1 });
  });

  it("get_technicals reads candles and states facts", async () => {
    const t = tool("get_technicals");
    const r = await t.handler(t.input({}).parse({ symbols: ["NSE:AAA"], account: null }), ctx, rt(deps()));
    expect(r.data.items[0]).toMatchObject({ symbol: "NSE:AAA", trend: { state: "above-all" } });
    expect(Array.isArray(r.data.items[0].facts)).toBe(true);
  });

  it("get_depth_profile profiles the book", async () => {
    const t = tool("get_depth_profile");
    const r = await t.handler(t.input({}).parse({ symbol: "NSE:AAA", levels: 200, account: null }), ctx, rt(deps()));
    expect(r.data).toMatchObject({ requestedLevels: 200, bestBid: 99, bestAsk: 100, imbalance: -0.5 });
  });

  it("get_headlines tags the symbols and can keep only those rows", async () => {
    const t = tool("get_headlines");
    const r = await t.handler(t.input({}).parse({ symbols: ["AAA"], source: "market", days: 2, onlySymbols: true }), ctx, rt(deps()));
    expect(r.data.items.map((i) => [i.title, i.symbols])).toEqual([["AAA rises on results", ["AAA"]]]);
  });
});
