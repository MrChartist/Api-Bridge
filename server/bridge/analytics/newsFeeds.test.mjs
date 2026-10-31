import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeError } from "../core/errors.mjs";
import { ENDPOINTS, banChanges, mapAnnouncements, newsAlertCheck, newsFeedsRoutes, parseBanList, parseFeed, tagText, upcomingBankDates } from "./newsFeeds.mjs";
import { CENTRAL_BANK_DATES } from "./centralBankDates.mjs";

const T0 = Date.parse("2026-10-30T06:00:00Z"); // 11:30 IST

const SEBI = `<?xml version="1.0"?><rss version="2.0"><channel><title>SEBI</title>
<item><title>Circular on revision in lot size for F&amp;O contracts</title><link>https://www.sebi.gov.in/c1.html</link><guid>sebi-1</guid><pubDate>Thu, 29 Oct 2026 10:00:00 +0530</pubDate><description><![CDATA[<p>Margin <b>framework</b> update</p>]]></description></item>
<item><title>Master circular on mutual funds</title><link>https://www.sebi.gov.in/c2.html</link><guid>sebi-2</guid><pubDate>Fri, 30 Oct 2026 09:00:00 +0530</pubDate></item>
<item><title>Old press release</title><link>https://www.sebi.gov.in/old.html</link><guid>sebi-old</guid><pubDate>Mon, 01 Jun 2026 09:00:00 +0530</pubDate></item>
</channel></rss>`;
const RBI_PRESS = `<rss version="2.0"><channel>
<item><title>Expiry of regulatory relaxations</title><link>https://www.rbi.org.in/p1</link><pubDate>Fri, 30 Oct 2026 12:00:00 +0530</pubDate></item>
<item><title>Master circular on mutual funds</title><link>https://www.sebi.gov.in/c2.html</link><pubDate>Fri, 30 Oct 2026 09:00:00 +0530</pubDate></item>
</channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Speech by Governor</title><link rel="alternate" href="https://www.rbi.org.in/s1"/><id>urn:s1</id><updated>2026-10-28T10:00:00+05:30</updated><summary>On margin of safety</summary></entry></feed>`;
const EMPTY_RSS = `<rss version="2.0"><channel></channel></rss>`;

const ANN = {
  data: [
    { symbol: "TCS", desc: "Outcome of Board Meeting", attchmntText: "Results declared", attchmntFile: "https://nsearchives.nseindia.com/corporate/TCS_301020261.pdf", an_dt: "30-Oct-2026 10:15:00", sm_name: "Tata Consultancy" },
    { symbol: "TCS", desc: "Outcome of Board Meeting (dup)", attchmntFile: "https://nsearchives.nseindia.com/corporate/TCS_301020261.pdf", an_dt: "30-Oct-2026 10:16:00" },
    { symbol: "INFY", desc: "Lot size change", seq_id: "99", an_dt: "29-Oct-2026 09:00:00" },
  ],
};
const BAN1 = "Securities in Ban For Trade Date 30-OCT-2026:\n1,ABFRL\n2,SAIL\n";
const BAN2 = "Securities in Ban For Trade Date 31-OCT-2026:\n1,SAIL\n2,ZEEL\n";

const ctx = (qs = "") => ({ requestId: "r1", query: new URLSearchParams(qs) });
function setup({ responses = {}, extraDeps = {} } = {}) {
  let t = T0;
  const calls = [];
  const newsFeedsFetcher = async (kind, params) => {
    calls.push([kind, params]);
    const list = responses[kind];
    const r = Array.isArray(list) ? list[Math.min(calls.filter((c) => c[0] === kind).length - 1, list.length - 1)] : list;
    if (r === undefined) throw new BridgeError("UPSTREAM_ERROR", `no sample for ${kind}`);
    if (r instanceof Error) throw r;
    return r;
  };
  const deps = { newsFeedsFetcher, clock: { now: () => t }, ...extraDeps };
  const routes = Object.fromEntries(newsFeedsRoutes(deps).map(([, p, , h]) => [p.split("/v1/analytics/")[1], h]));
  return { deps, routes, calls, tick: (ms) => (t += ms) };
}
const FEEDS = { sebi: SEBI, rbiPress: RBI_PRESS, rbiNotifications: EMPTY_RSS, rbiSpeeches: ATOM };

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "news-"));
  dirs.push(d);
  return d;
};

describe("feed parser", () => {
  it("parses RSS with CDATA and entities, and Atom with rel=alternate", () => {
    const rss = parseFeed(SEBI);
    expect(rss[0]).toMatchObject({ guid: "sebi-1", title: "Circular on revision in lot size for F&O contracts", link: "https://www.sebi.gov.in/c1.html", summary: "Margin framework update", publishedAt: "2026-10-29T04:30:00.000Z" });
    const atom = parseFeed(ATOM);
    expect(atom[0]).toMatchObject({ guid: "urn:s1", link: "https://www.rbi.org.in/s1", publishedAt: "2026-10-28T04:30:00.000Z" });
  });
  it("rejects DOCTYPE and ENTITY, oversize input, and non-feeds", () => {
    expect(() => parseFeed(`<!DOCTYPE rss [<!ENTITY a "b">]><rss><channel></channel></rss>`)).toThrow(/DOCTYPE/);
    expect(() => parseFeed(`<rss><!ENTITY x "y"></rss>`)).toThrow(BridgeError);
    expect(() => parseFeed(`<rss>${"x".repeat(100)}</rss>`, { maxBytes: 50 })).toThrow(/larger/);
    expect(() => parseFeed("<html><body>blocked</body></html>")).toThrow(/not an RSS/);
    expect(() => parseFeed(null)).toThrow(BridgeError);
  });
  it("does not expand unknown entities and caps the item count", () => {
    const [i] = parseFeed(`<rss><item><title>a &foo; &#65; &#x42; b</title><link>l</link></item></rss>`);
    expect(i.title).toBe("a &foo; A B b");
    const many = `<rss>${Array.from({ length: 10 }, (_, n) => `<item><title>t${n}</title><link>l${n}</link></item>`).join("")}</rss>`;
    expect(parseFeed(many, { maxItems: 3 })).toHaveLength(3);
  });
  it("tags F&O, margin, lot size, circular, expiry", () => {
    expect(tagText("Circular: lot size and margin changes for F&O expiry")).toEqual(["fno", "margin", "lot-size", "circular", "expiry"]);
    expect(tagText("Nothing to see")).toEqual([]);
  });
});

describe("regulatory route", () => {
  it("declares all six routes with read scope", () => {
    const rs = newsFeedsRoutes({ newsFeedsFetcher: async () => "" });
    expect(rs.map(([m, p, o]) => [m, p, o.scope])).toEqual([
      ["GET", "/v1/analytics/news/regulatory", "read"],
      ["GET", "/v1/analytics/news/announcements", "read"],
      ["GET", "/v1/analytics/news/headlines", "read"],
      ["GET", "/v1/analytics/calendar/central-banks", "read"],
      ["GET", "/v1/analytics/calendar/fno-ban", "read"],
      ["GET", "/v1/analytics/calendar/timeline", "read"],
    ]);
  });
  it("merges, dedupes by guid/link, tags, windows by days and notes unverified endpoints", async () => {
    const { routes } = setup({ responses: FEEDS });
    const r = await routes["news/regulatory"](ctx("days=7"));
    expect(r.data.items.map((i) => i.title)).toEqual(["Expiry of regulatory relaxations", "Master circular on mutual funds", "Circular on revision in lot size for F&O contracts", "Speech by Governor"]);
    const first = r.data.items.find((i) => i.id === "sebi:sebi-1");
    expect(first.tags).toEqual(["fno", "margin", "lot-size", "circular"]);
    expect(r.data.items.some((i) => i.title === "Old press release")).toBe(false);
    expect(r.meta).toMatchObject({ source: "sebi+rbi", stale: false, fetchedAt: new Date(T0).toISOString() });
    expect(r.meta.note).toMatch(/not verified/);
  });
  it("filters by source and q (all tokens, case-insensitive)", async () => {
    const { routes, calls } = setup({ responses: FEEDS });
    const s = await routes["news/regulatory"](ctx("source=sebi&days=90"));
    expect(s.data.items.map((i) => i.source)).toEqual(["sebi", "sebi"]);
    expect(calls.map((c) => c[0])).toEqual(["sebi"]);
    const q = await routes["news/regulatory"](ctx("days=90&q=LOT%20size"));
    expect(q.data.items.map((i) => i.id)).toEqual(["sebi:sebi-1"]);
  });
  it("validates params", async () => {
    const { routes } = setup({ responses: FEEDS });
    await expect(routes["news/regulatory"](ctx("source=x"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(routes["news/regulatory"](ctx("days=0"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(routes["news/regulatory"](ctx(`q=${"a".repeat(101)}`))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("reports a failed feed but still answers, and errors when all fail", async () => {
    const { routes } = setup({ responses: { ...FEEDS, rbiSpeeches: new BridgeError("UPSTREAM_ERROR", "down") } });
    const r = await routes["news/regulatory"](ctx());
    expect(r.meta.failedFeeds).toEqual(["rbiSpeeches"]);
    const bad = setup({ responses: { sebi: "<html/>" } });
    await expect(bad.routes["news/regulatory"](ctx("source=sebi"))).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });
  it("caches, dedupes in-flight requests, and serves stale on failure", async () => {
    const { routes, calls, tick } = setup({ responses: { ...FEEDS, sebi: [SEBI, new BridgeError("UPSTREAM_ERROR", "down")] } });
    await Promise.all([routes["news/regulatory"](ctx("source=sebi")), routes["news/regulatory"](ctx("source=sebi"))]);
    await routes["news/regulatory"](ctx("source=sebi"));
    expect(calls).toHaveLength(1);
    tick(11 * 60_000);
    const r = await routes["news/regulatory"](ctx("source=sebi&days=90"));
    expect(calls).toHaveLength(2);
    expect(r.meta.stale).toBe(true);
    expect(r.data.items.length).toBeGreaterThan(0);
  });
  it("persists to disk and reloads, moving a corrupt file aside", async () => {
    const dir = tmp();
    const a = setup({ responses: FEEDS, extraDeps: { paths: { dataDir: dir } } });
    await a.routes["news/regulatory"](ctx("source=sebi"));
    const file = join(dir, "analytics", "news-feeds.json");
    expect(JSON.parse(readFileSync(file, "utf8")).entries["rss|sebi"].rows).toHaveLength(3);
    const b = setup({ responses: {}, extraDeps: { paths: { dataDir: dir } } });
    const r = await b.routes["news/regulatory"](ctx("source=sebi"));
    expect(r.data.items.length).toBe(2);
    expect(b.calls).toHaveLength(0);
    writeFileSync(file, "{nope");
    const c = setup({ responses: FEEDS, extraDeps: { paths: { dataDir: dir } } });
    await c.routes["news/regulatory"](ctx("source=sebi"));
    expect(readdirSync(join(dir, "analytics")).some((f) => f.includes(".corrupt-"))).toBe(true);
  });
});

describe("announcements route", () => {
  it("dedupes by attachment id, filters by symbol and q, reports meta", async () => {
    const { routes, calls } = setup({ responses: { announcements: ANN } });
    const r = await routes["news/announcements"](ctx("days=3"));
    expect(r.data.items.map((i) => [i.symbol, i.id])).toEqual([
      ["TCS", "TCS_301020261.pdf"],
      ["INFY", "99"],
    ]);
    expect(calls[0][1]).toEqual({ from: "2026-10-27", to: "2026-10-30", symbol: null });
    expect(r.data.items[1].tags).toEqual(["lot-size"]);
    expect(r.meta).toMatchObject({ source: "nse", stale: false });
    expect(r.meta.note).toMatch(/not verified/);
    const q = await routes["news/announcements"](ctx("days=3&q=results"));
    expect(q.data.items.map((i) => i.symbol)).toEqual(["TCS"]);
    const s = await routes["news/announcements"](ctx("symbol=infy"));
    expect(s.data.items.map((i) => i.symbol)).toEqual(["INFY"]);
    await expect(routes["news/announcements"](ctx("symbol=bad%20sym"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("rejects an unexpected shape", () => {
    expect(() => mapAnnouncements({ nope: 1 })).toThrow(/unexpected shape/);
    expect(() => mapAnnouncements([{ foo: 1 }])).toThrow(/recognisable/);
  });
});

describe("central banks", () => {
  it("computes a countdown from the injected clock and respects bank and days", async () => {
    const { routes, tick } = setup();
    const r = await routes["calendar/central-banks"](ctx());
    expect(r.data.dates.map((d) => [d.bank, d.date, d.daysUntil])).toEqual([
      ["FOMC", "2026-12-09", 40],
      ["ECB", "2026-12-17", 48],
    ]);
    expect(r.data.note).toMatch(/Verify/i);
    expect(r.meta).toMatchObject({ source: "curated", stale: false });
    expect((await routes["calendar/central-banks"](ctx("bank=ecb"))).data.dates).toHaveLength(1);
    expect((await routes["calendar/central-banks"](ctx("days=10"))).data.dates).toHaveLength(0);
    tick(41 * 86_400_000);
    expect((await routes["calendar/central-banks"](ctx())).data.dates.map((d) => d.bank)).toEqual(["ECB"]);
    await expect(routes["calendar/central-banks"](ctx("bank=BOE"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("accepts an injected list and the shipped data is well formed", () => {
    expect(upcomingBankDates([{ bank: "RBI", name: "MPC", date: "2026-11-02" }], "2026-10-30", 365)[0].daysUntil).toBe(3);
    for (const d of CENTRAL_BANK_DATES) expect(d.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("fno ban", () => {
  it("parses the csv", () => {
    expect(parseBanList(BAN1)).toEqual({ tradeDate: "2026-10-30", symbols: ["ABFRL", "SAIL"] });
    expect(parseBanList("Securities in Ban For Trade Date 30-OCT-2026:\n")).toEqual({ tradeDate: "2026-10-30", symbols: [] });
    expect(() => parseBanList("<html>blocked</html>")).toThrow(BridgeError);
    expect(banChanges(["A", "B"], ["B", "C"])).toEqual({ entries: ["C"], exits: ["A"] });
  });
  it("reports baseline, then entries and exits versus the persisted list, across restarts", async () => {
    const dir = tmp();
    const a = setup({ responses: { ban: [BAN1] }, extraDeps: { paths: { dataDir: dir } } });
    const r1 = await a.routes["calendar/fno-ban"](ctx());
    expect(r1.data).toMatchObject({ tradeDate: "2026-10-30", count: 2, baseline: true, entries: [], exits: [] });
    expect(r1.meta).toMatchObject({ source: "nse", stale: false });
    expect(r1.meta.note).toMatch(/not verified/);
    a.tick(20 * 60_000);
    const b = setup({ responses: { ban: [BAN2] }, extraDeps: { paths: { dataDir: dir } } });
    b.tick(20 * 60_000);
    const r2 = await b.routes["calendar/fno-ban"](ctx());
    expect(r2.data).toMatchObject({ tradeDate: "2026-10-31", baseline: false, previousTradeDate: "2026-10-30", entries: ["ZEEL"], exits: ["ABFRL"] });
    expect(JSON.parse(readFileSync(join(dir, "analytics", "news-feeds.json"), "utf8")).ban.previous.symbols).toEqual(["ABFRL", "SAIL"]);
  });
  it("serves the stale list when a refresh fails and errors with nothing cached", async () => {
    const { routes, tick } = setup({ responses: { ban: [BAN1, new BridgeError("UPSTREAM_ERROR", "down")] } });
    await routes["calendar/fno-ban"](ctx());
    tick(20 * 60_000);
    expect((await routes["calendar/fno-ban"](ctx())).meta.stale).toBe(true);
    const bad = setup({ responses: { ban: new BridgeError("UPSTREAM_ERROR", "down") } });
    await expect(bad.routes["calendar/fno-ban"](ctx())).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });
});

describe("timeline", () => {
  const events = [{ symbol: "TCS", company: "TCS", purpose: "Results", date: "30-Oct-2026" }, { symbol: "INFY", company: "Infosys", purpose: "Results", date: "05-Nov-2026" }, { symbol: "LATE", purpose: "Results", date: "30-Dec-2026" }];
  const marketData = { expiries: async (u) => ({ underlying: u, expiries: u === "NIFTY" ? ["2026-10-27", "2026-11-03", "2026-11-10"] : ["2026-11-03"] }) };

  it("merges events, central banks and expiries into one sorted list", async () => {
    const { routes } = setup({ responses: { events: [events] }, extraDeps: { marketData, centralBankDates: [{ bank: "RBI", name: "MPC decision", date: "2026-11-05" }] } });
    const r = await routes["calendar/timeline"](ctx("days=14&underlyings=NIFTY,BANKNIFTY"));
    expect(r.data.items.map((i) => `${i.date} ${i.type} ${i.title}`)).toEqual([
      "2026-10-30 event TCS: Results",
      "2026-11-03 expiry BANKNIFTY expiry",
      "2026-11-03 expiry NIFTY expiry",
      "2026-11-05 central-bank MPC decision",
      "2026-11-05 event INFY: Results",
      "2026-11-10 expiry NIFTY expiry",
    ]);
    expect(r.meta.sources).toMatchObject({ centralBanks: { ok: true }, events: { ok: true }, expiries: { ok: true, failed: [] } });
    expect(r.meta).toMatchObject({ source: "composite", stale: false });
    expect(r.meta.note).toMatch(/not verified/);
  });
  it("uses an injected marketEventsFetcher and degrades per source", async () => {
    const calls = [];
    const marketEventsFetcher = async (kind, p) => (calls.push([kind, p]), events);
    const a = setup({ extraDeps: { marketEventsFetcher, marketData: { expiries: async () => { throw new Error("boom"); } } } });
    const r = await a.routes["calendar/timeline"](ctx());
    expect(calls[0]).toEqual(["events", { from: "2026-10-30", to: "2026-11-13", symbol: null }]);
    expect(r.meta.sources.expiries.failed).toEqual(["NIFTY"]);
    expect(r.data.items.filter((i) => i.type === "event")).toHaveLength(2);
    const b = setup({ responses: {} });
    const r2 = await b.routes["calendar/timeline"](ctx());
    expect(r2.meta.sources.events.ok).toBe(false);
    expect(r2.meta.sources.expiries.ok).toBe(false);
    expect(r2.data.items.map((i) => i.type)).toEqual([]);
    await expect(b.routes["calendar/timeline"](ctx("days=99"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(b.routes["calendar/timeline"](ctx("underlyings=A,B,C,D,E,F"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("newsAlertCheck", () => {
  it("keyword rule: baseline, then fires only on new matches", async () => {
    const { deps, tick } = setup({ responses: { ...FEEDS, sebi: [SEBI, SEBI.replace("</channel>", `<item><title>New margin rules for F&amp;O</title><link>https://www.sebi.gov.in/c3.html</link><guid>sebi-3</guid><pubDate>Fri, 30 Oct 2026 11:00:00 +0530</pubDate></item></channel>`)] } });
    const rule = { kind: "news_keywords", keywords: ["margin"], source: "sebi" };
    const base = await newsAlertCheck(deps, rule);
    expect(base).toMatchObject({ fired: false, status: "baseline" });
    expect(base.state.seen).toEqual(["sebi:sebi-1"]);
    const same = await newsAlertCheck(deps, { ...rule, state: base.state });
    expect(same.fired).toBe(false);
    tick(11 * 60_000);
    const hit = await newsAlertCheck(deps, { ...rule, state: base.state });
    expect(hit).toMatchObject({ fired: true, status: "ok", hits: [{ id: "sebi:sebi-3", source: "sebi" }] });
    expect(hit.message).toMatch(/margin/);
    expect(hit.state.seen).toContain("sebi:sebi-3");
    expect(base.state.seen).toEqual(["sebi:sebi-1"]); // input state not mutated
  });
  it("keyword rule over NSE announcements and validation", async () => {
    const { deps } = setup({ responses: { announcements: ANN } });
    const rule = { kind: "news_keywords", keywords: ["lot size"], source: "nse" };
    const base = await newsAlertCheck(deps, { ...rule, state: { seen: [] } });
    expect(base.hits.map((h) => h.title)).toEqual(["INFY: Lot size change"]);
    await expect(newsAlertCheck(deps, { kind: "news_keywords", keywords: [] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(newsAlertCheck(deps, { kind: "other" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("ban rule: baseline, then entries and exits, with a watch list", async () => {
    const { deps, tick } = setup({ responses: { ban: [BAN1, BAN2] } });
    const rule = { kind: "fno_ban_change" };
    const base = await newsAlertCheck(deps, rule);
    expect(base).toMatchObject({ fired: false, status: "baseline", state: { symbols: ["ABFRL", "SAIL"] } });
    tick(20 * 60_000);
    const hit = await newsAlertCheck(deps, { ...rule, state: base.state });
    expect(hit).toMatchObject({ fired: true, entries: ["ZEEL"], exits: ["ABFRL"], message: "entered F&O ban: ZEEL; left F&O ban: ABFRL" });
    const watched = await newsAlertCheck(deps, { ...rule, symbols: ["sail"], state: base.state });
    expect(watched.fired).toBe(false);
    const none = await newsAlertCheck(deps, { ...rule, state: hit.state });
    expect(none.fired).toBe(false);
  });
});

describe("misc", () => {
  it("lists every assumed URL as unverified", () => {
    for (const e of Object.values(ENDPOINTS)) expect(e.verified).toBe(false);
  });
  it("default fetcher primes NSE cookies and reads text through the client", async () => {
    const urls = [];
    const fetchImpl = async (url, init) => {
      urls.push([String(url), init?.headers?.Cookie ?? null]);
      const h = new Headers();
      if (String(url).endsWith("/")) h.append("set-cookie", "nsit=abc; Path=/");
      const body = String(url).endsWith(".csv") ? BAN1 : String(url).includes("sebi") ? SEBI : "{}";
      return new Response(body, { status: 200, headers: h });
    };
    const rs = newsFeedsRoutes({ fetchImpl, clock: { now: () => T0 } });
    const ban = rs.find(([, p]) => p.endsWith("fno-ban"))[3];
    const r = await ban(ctx());
    expect(r.data.symbols).toEqual(["ABFRL", "SAIL"]);
    expect(urls[0][0]).toBe("https://www.nseindia.com/");
    expect(urls[1]).toEqual([ENDPOINTS.nseFoBan.url, "nsit=abc"]);
    const reg = rs.find(([, p]) => p.endsWith("regulatory"))[3];
    const g = await reg(ctx("source=sebi"));
    expect(g.data.items).toHaveLength(2);
  });
});
