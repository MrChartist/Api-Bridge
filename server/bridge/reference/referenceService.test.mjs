/**
 * ReferenceData service (S16) with a fake clock, a temp dataDir, the fake symbol service and a fake fetch serving the
 * fixtures: SOURCE_OFF without a single request, sync and merge, unchanged files, parse failures, corrupt stores,
 * retention, the daily request cap, the scheduler (morning job, holidays, retry) and the reference.updated event.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger, redact } from "../core/logger.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { istInstant } from "./calendar.mjs";
import { parseReferenceConfig } from "./config.mjs";
import { DAILY_REQUEST_CAP, createReferenceService } from "./referenceService.mjs";

const fixture = (name) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));
const THU_1000 = istInstant("2026-10-29", "10:00");

function fakeFetch(files = {}) {
  const calls = [];
  const serve = {
    mktlots: () => fixture("fo_mktlots.csv"),
    secban: () => fixture("fo_secban.csv"),
    combineoi: () => fixture("combineoi.zip"),
    ...files,
  };
  const fn = async (url) => {
    calls.push(String(url));
    const kind = /fo_mktlots/.test(url) ? "mktlots" : /fo_secban/.test(url) ? "secban" : /combineoi/.test(url) ? "combineoi" : null;
    const body = kind ? serve[kind]() : null;
    if (body instanceof Error) throw body;
    if (body === null) return new Response("not found", { status: 404 });
    if (typeof body === "number") return new Response("err", { status: body });
    return new Response(body, { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

function setup({ reference = {}, t = THU_1000, fetch = fakeFetch(), dataDir = mkdtempSync(join(tmpdir(), "mcb-ref-")), demo = false, symbols: symbolsIn } = {}) {
  const clock = { t, now: () => clock.t };
  const bus = createEventBus({ logger: createNullLogger() });
  const events = [];
  bus.on("reference.updated", (e) => events.push(e));
  const symbols = symbolsIn ?? createFakeSymbolService();
  const make = () =>
    createReferenceService(
      { config: { reference: parseReferenceConfig(reference), demo }, logger: createNullLogger(), bus, clock, paths: { dataDir }, symbols },
      { fetchImpl: fetch, sleep: async () => {}, jitterMs: 0, timers: { setInterval: () => null, clearInterval: () => {}, setTimeout: () => null, clearTimeout: () => {} } },
    );
  return { svc: make(), make, clock, bus, events, fetch, dataDir };
}

const ON = { sources: { nseArchives: { enabled: true } } };

describe("archives off (the default)", () => {
  it("answers SOURCE_OFF with zero fetch calls", async () => {
    const h = setup();
    const r = await h.svc.sync({ datasets: ["lots", "ban", "mwpl"] });
    expect(r.results.map((x) => x.code)).toEqual(["SOURCE_OFF", "SOURCE_OFF", "SOURCE_OFF"]);
    expect(h.fetch.calls).toEqual([]);
    const st = h.svc.status();
    expect(st.sources.nseArchives).toMatchObject({ enabled: false, setBy: "default" });
    expect(st.datasets.ban).toMatchObject({ available: false, reason: "SOURCE_OFF" });
    expect(h.svc.banList()).toMatchObject({ available: false, reason: "SOURCE_OFF", items: [] });
    expect(h.svc.universe({ date: "2026-10-29" })).toMatchObject({ coverage: "not-recorded", available: false, reason: "SOURCE_OFF" });
  });

  it("settings.json (a dashboard choice) overrides config, with who and when", async () => {
    const h = setup();
    h.svc.setSources({ nseArchives: true }, "local:dashboard");
    expect(h.svc.status().sources.nseArchives).toMatchObject({ enabled: true, setBy: "dashboard" });
    const again = h.make();
    expect(again.status().sources.nseArchives.enabled).toBe(true);
  });
});

describe("sync", () => {
  it("lots: raw copy with sha256, lot history, universe and the reference.updated event", async () => {
    const h = setup({ reference: ON });
    const r = await h.svc.sync({ datasets: ["lots"] });
    expect(r.results).toEqual([{ dataset: "lots", ok: true, changed: true }]);
    expect(h.fetch.calls).toEqual(["https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv"]);
    expect(existsSync(join(h.dataDir, "reference/raw/2026-10-29/fo_mktlots.csv"))).toBe(true);
    expect(readFileSync(join(h.dataDir, "reference/raw/2026-10-29/fo_mktlots.csv.sha256"), "utf8")).toMatch(/^[0-9a-f]{64}  fo_mktlots.csv/);
    expect(h.events).toEqual([{ dataset: "lots", asOf: "2026-10-29", source: "nse-archives:fo_mktlots.csv", changed: true }]);
    const lots = await h.svc.lots("NIFTY", {});
    expect(lots.history.map((x) => [x.expiryMonth, x.lot])).toEqual([["2026-10", 65], ["2026-11", 65], ["2026-12", 65]]);
    expect(h.svc.universe({ date: "2026-10-29", kind: "stock" })).toMatchObject({ coverage: "recorded", knownSince: "2026-10-29", count: 4 });
    expect(h.svc.status().datasets.lots).toMatchObject({ available: true, asOf: "2026-10-29", rows: 7, error: null });
  });

  it("an unchanged file only updates lastSuccessAt (changed: false)", async () => {
    const h = setup({ reference: ON });
    await h.svc.sync({ datasets: ["lots"] });
    h.clock.t += 3_600_000;
    const r = await h.svc.sync({ datasets: ["lots"] });
    expect(r.results[0]).toEqual({ dataset: "lots", ok: true, changed: false });
    expect(h.events.at(-1)).toMatchObject({ dataset: "lots", changed: false });
  });

  it("a parse failure keeps the previous data in force", async () => {
    let body = fixture("fo_mktlots.csv");
    const h = setup({ reference: ON, fetch: fakeFetch({ mktlots: () => body }) });
    await h.svc.sync({ datasets: ["lots"] });
    body = Buffer.from("<html>maintenance</html>");
    const r = await h.svc.sync({ datasets: ["lots"] });
    expect(r.results[0]).toEqual({ dataset: "lots", ok: false, code: "PARSE_FAILED" });
    expect(h.svc.status().datasets.lots).toMatchObject({ available: true, error: { code: "PARSE_FAILED" } });
    expect((await h.svc.lots("NIFTY", {})).history).toHaveLength(3);
  });

  it("ban list and MWPL: band from the ban list, % from the combined OI file", async () => {
    const h = setup({ reference: ON });
    await h.svc.sync({ datasets: ["ban", "mwpl"] });
    expect(h.fetch.calls[0]).toMatch(/fo_secban_29102026\.csv$/);
    expect(h.fetch.calls[1]).toMatch(/combineoi_29102026\.zip$/);
    expect(h.svc.banList("2026-10-30")).toMatchObject({ available: true, items: [{ symbol: "ABC", mwplPct: 96.2 }, { symbol: "PQR", mwplPct: null }, { symbol: "XYZ", mwplPct: null }] });
    expect(h.svc.banStatus("ABC", "2026-10-30")).toMatchObject({ inBan: true, mwplPct: 96.2, band: "ban", forDate: "2026-10-30" });
    expect(h.svc.banStatus("DEF", "2026-10-30")).toMatchObject({ inBan: false, mwplPct: 84.2, band: "high" });
    expect(h.svc.mwplList({ date: "2026-10-29", symbol: "GHI" }).items).toEqual([{ symbol: "GHI", mwpl: 50000000, oi: 7500000, limitNextDay: 40000000, mwplPct: 15, band: "normal" }]);
  });

  it("upstream errors map to Bridge codes and leave the data alone", async () => {
    const h = setup({ reference: ON, fetch: fakeFetch({ mktlots: () => 429 }) });
    const r = await h.svc.sync({ datasets: ["lots"] });
    expect(r.results[0]).toMatchObject({ ok: false, code: "UPSTREAM_RATE_LIMITED" });
    expect(h.svc.status().datasets.lots).toMatchObject({ available: false, error: { code: "UPSTREAM_RATE_LIMITED" } });
  });

  it("refuses a second sync while one runs, and unknown datasets", async () => {
    const h = setup({ reference: ON });
    const first = h.svc.startSync({ datasets: ["lots"] });
    expect(() => h.svc.startSync({ datasets: ["ban"] })).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_IN_PROGRESS" }));
    await first.promise;
    expect(() => h.svc.startSync({ datasets: ["quotes"] })).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it(`stops at ${DAILY_REQUEST_CAP} requests a day`, async () => {
    const h = setup({ reference: ON });
    for (let i = 0; i < DAILY_REQUEST_CAP + 3; i += 1) await h.svc.sync({ datasets: ["ban"] });
    expect(h.fetch.calls).toHaveLength(DAILY_REQUEST_CAP);
    expect(h.svc.status().datasets.ban.error).toMatchObject({ code: "UPSTREAM_RATE_LIMITED" });
    h.clock.t += 86_400_000;
    await h.svc.sync({ datasets: ["ban"] });
    expect(h.fetch.calls).toHaveLength(DAILY_REQUEST_CAP + 1);
  });
});

describe("stores", () => {
  it("a corrupt lots.json is moved aside and the service starts empty", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-ref-"));
    mkdirSync(join(dataDir, "reference"), { recursive: true });
    writeFileSync(join(dataDir, "reference/lots.json"), "{ not json");
    const h = setup({ dataDir, reference: ON });
    expect(h.svc.status().datasets.lots.available).toBe(false);
    expect(readdirSync(join(dataDir, "reference")).some((f) => /^lots\.json\.corrupt-/.test(f))).toBe(true);
  });

  it("retention removes raw folders older than retentionDays", async () => {
    const h = setup({ reference: { ...ON, retentionDays: 30 }, t: istInstant("2026-10-29", "08:20") });
    mkdirSync(join(h.dataDir, "reference/raw/2026-08-01"), { recursive: true });
    mkdirSync(join(h.dataDir, "reference/raw/2026-10-20"), { recursive: true });
    await h.svc.runJob("morning");
    const left = readdirSync(join(h.dataDir, "reference/raw"));
    expect(left).toContain("2026-10-20");
    expect(left).not.toContain("2026-08-01");
  });
});

describe("scheduler", () => {
  it("runs the morning job at 08:20 IST on a trading day, once", async () => {
    const h = setup({ reference: ON, t: istInstant("2026-10-29", "08:19") });
    expect(await h.svc.tick()).toBe(null);
    expect(h.fetch.calls).toEqual([]);
    h.clock.t = istInstant("2026-10-29", "08:20");
    const r = await h.svc.tick();
    expect(r).toMatchObject({ job: "morning", failed: false });
    expect(h.fetch.calls.some((u) => /fo_mktlots/.test(u))).toBe(true);
    const n = h.fetch.calls.length;
    h.clock.t = istInstant("2026-10-29", "08:21");
    expect(await h.svc.tick()).toBe(null);
    h.clock.t = istInstant("2026-10-29", "08:50");
    expect(await h.svc.tick()).toBe(null); // the retry only runs after a failure
    expect(h.fetch.calls).toHaveLength(n);
  });

  it("a scheduled job holds the sync slot: a manual sync is refused and status shows it", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const fetch = fakeFetch({ mktlots: () => fixture("fo_mktlots.csv") });
    const slow = async (url) => {
      await gate;
      return fetch(url);
    };
    slow.calls = fetch.calls;
    const h = setup({ reference: ON, fetch: slow, t: istInstant("2026-10-29", "08:20") });
    const job = h.svc.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.svc.status().syncing).toMatchObject({ datasets: ["lots", "ban", "corporateActions"] });
    expect(() => h.svc.startSync({ datasets: ["lots"] })).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_IN_PROGRESS" }));
    expect(await h.svc.startupSync()).toBe(null);
    release();
    expect(await job).toMatchObject({ job: "morning", failed: false });
    expect(h.svc.status().syncing).toBe(null);
    expect(fetch.calls.filter((u) => /fo_mktlots/.test(u))).toHaveLength(1);
  });

  it("skips holidays and weekends", async () => {
    const holiday = setup({ reference: ON, t: istInstant("2026-11-24", "08:25") });
    expect(await holiday.svc.tick()).toBe(null);
    const sunday = setup({ reference: ON, t: istInstant("2026-11-01", "08:25") });
    expect(await sunday.svc.tick()).toBe(null);
    expect(holiday.fetch.calls).toEqual([]);
    expect(sunday.fetch.calls).toEqual([]);
  });

  it("retries at 08:50 after a failure", async () => {
    let fail = true;
    const fetch = fakeFetch({ mktlots: () => (fail ? 503 : fixture("fo_mktlots.csv")) });
    const h = setup({ reference: ON, fetch, t: istInstant("2026-10-29", "08:20") });
    expect(await h.svc.tick()).toMatchObject({ job: "morning", failed: true });
    fail = false;
    h.clock.t = istInstant("2026-10-29", "08:49");
    expect(await h.svc.tick()).toBe(null);
    h.clock.t = istInstant("2026-10-29", "08:50");
    expect(await h.svc.tick()).toMatchObject({ job: "morningRetry", failed: false });
    expect(h.svc.status().datasets.lots).toMatchObject({ available: true, error: null });
  });

  it("the evening job fetches the next trading day's ban list and today's MWPL", async () => {
    const h = setup({ reference: ON, t: istInstant("2026-10-29", "19:35") });
    await h.svc.runJob("morning").catch(() => {});
    h.fetch.calls.length = 0;
    expect(await h.svc.tick()).toMatchObject({ job: "evening" });
    expect(h.fetch.calls[0]).toMatch(/fo_secban_30102026/);
    expect(h.fetch.calls[1]).toMatch(/combineoi_29102026/);
  });
});

describe("lots and staleness", () => {
  it("stale after more than one trading day; lotFor carries the flag and the master's lot", async () => {
    const h = setup({ reference: ON });
    await h.svc.sync({ datasets: ["lots"] });
    const fresh = await h.svc.lotFor("NIFTY", "2026-10-27", {});
    expect(fresh).toMatchObject({ lot: 65, stale: false, staleTradingDays: 0, conflict: null });
    h.clock.t = istInstant("2026-11-02", "10:00"); // Fri 30 Oct and Mon 2 Nov: 2 trading days
    const stale = await h.svc.lotFor("NIFTY", "2026-10-27", {});
    expect(stale).toMatchObject({ stale: true, staleTradingDays: 2, asOf: "2026-10-29" });
  });

  it("the same market-lots file on three trading days keeps the lots fresh (asOf follows the fetch)", async () => {
    const h = setup({ reference: ON });
    await h.svc.sync({ datasets: ["lots"] });
    h.clock.t = istInstant("2026-10-30", "10:00");
    expect((await h.svc.sync({ datasets: ["lots"] })).results[0]).toEqual({ dataset: "lots", ok: true, changed: false });
    h.clock.t = istInstant("2026-11-02", "10:00");
    expect((await h.svc.sync({ datasets: ["lots"] })).results[0]).toEqual({ dataset: "lots", ok: true, changed: false });
    const st = h.svc.status().datasets;
    expect(st.lots).toMatchObject({ asOf: "2026-11-02", stale: false, staleTradingDays: 0 });
    expect(st.universe).toMatchObject({ asOf: "2026-11-02", stale: false });
    expect(await h.svc.lotFor("NIFTY", "2026-10-27", {})).toMatchObject({ stale: false, asOf: "2026-11-02" });
    expect(h.events.at(-1)).toMatchObject({ dataset: "lots", asOf: "2026-11-02", changed: false });
  });

  it("a lot revision in the market-lots file becomes a lot-revision event inside the banner window", async () => {
    const revision = Buffer.from("UNDERLYING,SYMBOL,OCT-26,NOV-26\nNifty 50,NIFTY,65,75\n");
    const h = setup({ reference: ON, fetch: fakeFetch({ mktlots: () => revision }), t: istInstant("2026-10-22", "10:00") });
    await h.svc.sync({ datasets: ["lots"] });
    const ev = await h.svc.events({ days: 7, underlying: "NIFTY" });
    // The fake master lists NIFTY 27 Oct as the last October expiry: the new lot applies from Wed 28 Oct.
    expect(ev.find((e) => e.kind === "lot-revision")).toMatchObject({ underlying: "NIFTY", effectiveOn: "2026-10-28", daysAway: 6 });
    expect(ev.find((e) => e.kind === "lot-revision").text).toMatch(/^NIFTY lot size changes from 65 to 75 for contracts from the Nov 2026 series/);
  });
});

describe("rate", () => {
  it("default, config and dashboard precedence; stale after rateStaleDays", () => {
    const d = setup();
    expect(d.svc.rate()).toMatchObject({ value: 0.065, quality: "default", source: "default (not sourced)", stale: true });
    const c = setup({ reference: { rate: { value: 0.0571, asOf: "2026-10-28", source: "91-day T-bill" } } });
    expect(c.svc.rate()).toMatchObject({ value: 0.0571, quality: "config", stale: false });
    c.svc.setRate({ value: 0.06, asOf: "2026-10-01", source: "my rate" }, "local:dashboard");
    expect(c.svc.rate()).toMatchObject({ value: 0.06, quality: "user", setBy: "dashboard", stale: true });
    expect(() => c.svc.setRate({ value: 6, source: "percent by mistake" })).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});

describe("events", () => {
  it("site-wide events include a holiday expiry shift of an index (no underlying given)", async () => {
    const opt = (e) => ["CE", "PE"].map((r) => ({ symbol: `NFO:NIFTY-${e}-25000-${r}`, lotSize: 65, tickSize: 0.05 }));
    const symbols = createFakeSymbolService({ instruments: [{ symbol: "NSE:NIFTY", lotSize: 1, tickSize: 0.05 }, ...["2026-11-03", "2026-11-09", "2026-11-17", "2026-12-01", "2026-12-08", "2026-12-15", "2026-12-29"].flatMap(opt)] });
    const h = setup({ symbols });
    const ev = await h.svc.events({ days: 14 });
    // Tue 10 Nov is a holiday: the weekly expiry moves to Mon 9 Nov.
    expect(ev.find((e) => e.kind === "holiday-expiry-shift")).toMatchObject({ underlying: "NIFTY", effectiveOn: "2026-11-09" });
  });
});

describe("security (spec section 7.2)", () => {
  /** Every file under dir, recursively. */
  const filesUnder = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? filesUnder(join(dir, f)) : [join(dir, f)]));
  /** Token-shaped: what the logger would mask (Bridge keys, bearer tokens, JWTs). Scanned in overlapping windows. */
  const tokenShaped = (text) => {
    for (let i = 0; i < text.length; i += 800) {
      const w = text.slice(i, i + 1000);
      if (redact(w) !== w) return true;
    }
    return false;
  };

  it("no file under dataDir/reference holds a token-shaped string", async () => {
    const h = setup({ reference: ON });
    await h.svc.sync({ datasets: ["lots", "ban", "mwpl"] });
    h.svc.setRate({ value: 0.0571, asOf: "2026-10-28", source: "91-day T-bill cut-off" }, "key:k_admin01");
    h.svc.addAction({ symbol: "RELIANCE", type: "bonus", ratio: { new: 1, held: 1 }, exDate: "2026-11-20", source: "exchange circular" });
    const files = filesUnder(join(h.dataDir, "reference"));
    expect(files.length).toBeGreaterThan(4);
    expect(tokenShaped("key mcb_abcdefgh12_secretpart")).toBe(true); // the detector works
    for (const f of files) expect(tokenShaped(readFileSync(f, "latin1")), f).toBe(false);
  });
});
