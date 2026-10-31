/**
 * GET /v1/analytics/news/headlines: market-news RSS, NSE filings and SEBI / RBI in one feed, each row tagged with the
 * symbols it names. Fixtures follow the RSS 2.0 shape the papers publish (title, link, guid, pubDate).
 */
import { describe, expect, it } from "vitest";
import { BridgeError } from "../core/errors.mjs";
import { demoNewsFeedsFetcher } from "./demoFeeds.mjs";
import { ENDPOINTS, MARKET_KINDS, headlineName, mapMarketFeed, newsFeedsRoutes, symbolMatchers, tagSymbols } from "./newsFeeds.mjs";

const T0 = Date.parse("2026-10-30T06:00:00Z"); // 11:30 IST

const ET = `<?xml version="1.0"?><rss version="2.0"><channel><title>ET Markets</title>
<item><title>Reliance Industries shares rise 2% after Q2 results</title><link>https://economictimes.indiatimes.com/a1.cms</link><guid>et-1</guid><pubDate>Fri, 30 Oct 2026 10:00:00 +0530</pubDate><description>Long article text that is not kept</description></item>
<item><title>Bank Nifty ends flat; TCS gains</title><link>https://economictimes.indiatimes.com/a2.cms</link><guid>et-2</guid><pubDate>Thu, 29 Oct 2026 16:00:00 +0530</pubDate></item>
<item><title>Old story</title><link>https://economictimes.indiatimes.com/old.cms</link><guid>et-old</guid><pubDate>Mon, 01 Jun 2026 09:00:00 +0530</pubDate></item>
</channel></rss>`;
const MINT = `<rss version="2.0"><channel>
<item><title>Nifty 50 slips 0.4% as IT weighs</title><link>https://www.livemint.com/m1.html</link><pubDate>Fri, 30 Oct 2026 11:00:00 +0530</pubDate></item>
<item><title>Bank Nifty ends flat; TCS gains</title><link>https://economictimes.indiatimes.com/a2.cms</link><pubDate>Thu, 29 Oct 2026 16:00:00 +0530</pubDate></item>
</channel></rss>`;
const EMPTY = `<rss version="2.0"><channel></channel></rss>`;
const ANN = { data: [{ symbol: "INFY", desc: "Outcome of Board Meeting", attchmntFile: "https://nsearchives.nseindia.com/corporate/INFY_1.pdf", an_dt: "30-Oct-2026 09:15:00", sm_name: "Infosys Limited" }] };

function setup(responses, extraDeps = {}) {
  const calls = [];
  const newsFeedsFetcher = async (kind, params) => {
    calls.push(kind);
    const r = responses[kind];
    if (r === undefined) throw new BridgeError("UPSTREAM_ERROR", `no sample for ${kind}`);
    return r;
  };
  const deps = { newsFeedsFetcher, clock: { now: () => T0 }, ...extraDeps };
  const route = newsFeedsRoutes(deps).find(([, p]) => p === "/v1/analytics/news/headlines");
  return { calls, route, call: (qs = "") => route[3]({ requestId: "r1", query: new URLSearchParams(qs) }) };
}
const symbols = { search: async ({ q }) => ({ items: q === "RELIANCE" ? [{ canonical: "NSE:RELIANCE", name: "Reliance Industries Limited" }] : [] }) };

describe("pure helpers", () => {
  it("headlineName drops the corporate tail", () => {
    expect(headlineName("Reliance Industries Limited")).toBe("Reliance Industries");
    expect(headlineName("State Bank of India")).toBe("State Bank");
    expect(headlineName("Infosys (Demo)")).toBe("Infosys");
    expect(headlineName("")).toBeNull();
    expect(headlineName("AB Ltd")).toBeNull();
  });

  it("tags tickers in capitals, names in any case, and the index names", () => {
    const m = symbolMatchers([{ symbol: "TCS" }, { symbol: "RELIANCE", name: "Reliance Industries Ltd" }, { symbol: "M&M" }, { symbol: "bad sym" }]);
    expect(tagSymbols("Bank Nifty ends flat; TCS gains", m)).toEqual(["BANKNIFTY", "TCS"]);
    expect(tagSymbols("reliance industries to raise funds", m)).toEqual(["RELIANCE"]);
    expect(tagSymbols("Nifty 50 slips", m)).toEqual(["NIFTY"]);
    expect(tagSymbols("Nifty IT index falls", m)).toEqual([]);
    expect(tagSymbols("tcs is lower case here; TCSL is another word", m)).toEqual([]);
    expect(tagSymbols("M&M rallies", m)).toEqual(["M&M"]);
  });

  it("market rows keep the title and link only", () => {
    const rows = mapMarketFeed(ET, "etMarkets");
    expect(rows[0]).toEqual({ id: "et:et-1", kind: "market", source: "et", sourceName: "The Economic Times", title: "Reliance Industries shares rise 2% after Q2 results", link: "https://economictimes.indiatimes.com/a1.cms", publishedAt: "2026-10-30T04:30:00.000Z", tags: [] });
    expect(JSON.stringify(rows)).not.toContain("Long article text");
  });

  it("market feeds: ET and Mint verified, Business Standard unverified, Moneycontrol retired (its RSS stopped in 2024)", () => {
    expect(MARKET_KINDS).toEqual(["etMarkets", "bsMarkets", "mintMarkets"]);
    for (const k of MARKET_KINDS) expect(ENDPOINTS[k].url).toMatch(/^https:\/\//);
    expect([ENDPOINTS.etMarkets.verified, ENDPOINTS.mintMarkets.verified, ENDPOINTS.bsMarkets.verified]).toEqual([true, true, false]);
    expect(ENDPOINTS.mcMarkets).toMatchObject({ retired: true, verified: false });
  });
});

describe("GET /v1/analytics/news/headlines", () => {
  const ALL = { etMarkets: ET, bsMarkets: EMPTY, mintMarkets: MINT, announcements: ANN, sebi: EMPTY, rbiPress: EMPTY, rbiNotifications: EMPTY, rbiSpeeches: EMPTY };

  it("merges the sources newest first, drops old rows and duplicate links, and tags the asked symbols", async () => {
    const { call, route } = setup(ALL, { symbols });
    expect(route[2]).toEqual({ scope: "read" });
    const r = await call("symbols=NSE:RELIANCE,TCS,INFY");
    const titles = r.data.items.map((i) => i.title);
    expect(titles).toEqual(["Nifty 50 slips 0.4% as IT weighs", "Reliance Industries shares rise 2% after Q2 results", "Infosys Limited: Outcome of Board Meeting", "Bank Nifty ends flat; TCS gains"]);
    const by = Object.fromEntries(r.data.items.map((i) => [i.title, i]));
    expect(by["Reliance Industries shares rise 2% after Q2 results"].symbols).toEqual(["RELIANCE"]);
    expect(by["Bank Nifty ends flat; TCS gains"].symbols).toEqual(["BANKNIFTY", "TCS"]);
    expect(by["Infosys Limited: Outcome of Board Meeting"]).toMatchObject({ kind: "filing", source: "nse", symbols: ["INFY"] });
    expect(r.meta).toMatchObject({ source: "all", days: 2, symbols: ["RELIANCE", "TCS", "INFY"], failedFeeds: [] });
    expect(r.meta.note).toMatch(/unverified|not verified/i);
    expect(r.data.sources).toMatchObject({ et: "The Economic Times", mint: "Mint" });
  });

  it("only=symbols keeps rows that name an asked symbol; q filters titles", async () => {
    const { call } = setup(ALL, { symbols });
    const r = await call("symbols=TCS&only=symbols");
    expect(r.data.items.map((i) => i.title)).toEqual(["Bank Nifty ends flat; TCS gains"]);
    const q = await call("q=nifty slips");
    expect(q.data.items).toHaveLength(1);
  });

  it("a failed feed is listed and does not fail the call; all failing raises", async () => {
    const { call } = setup({ ...ALL, mintMarkets: undefined, announcements: undefined });
    const r = await call("source=all");
    expect(r.meta.failedFeeds).toEqual(["mint", "nse"]);
    expect(r.data.items.length).toBeGreaterThan(0);
    const none = setup({});
    await expect(none.call("source=market")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("source=market reads only the three papers", async () => {
    const { call, calls } = setup(ALL);
    await call("source=market");
    expect([...calls].sort()).toEqual([...MARKET_KINDS].sort());
  });

  it("validates source, days, symbols and only", async () => {
    const { call } = setup(ALL);
    for (const qs of ["source=twitter", "days=0", "days=15", "symbols=a b", "only=all"]) await expect(call(qs)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("demo mode has headlines for every paper", async () => {
    const { call } = setup(Object.fromEntries(await Promise.all(Object.keys(ALL).map(async (k) => [k, await demoNewsFeedsFetcher(k, {})]))), {});
    const r = await call("source=market&days=14");
    expect(new Set(r.data.items.map((i) => i.source))).toEqual(new Set(["et", "business-standard", "mint"]));
    expect(r.data.items.every((i) => /\(demo\)$/.test(i.title))).toBe(true);
  });
});
