/**
 * SymbolService with stub adapters, the fake AccountManager (S1) and a recording Scheduler stub. Covers master
 * loading through the scheduler, single flight, the per-IST-day disk cache and the 08:30 refresh, every accepted
 * input form, the never-guess rules, search pagination, convert aliases, failures and secret hygiene.
 */
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SERVICE_CONTRACTS, assertService, notImplementedService } from "../core/contracts.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createSymbolService, masterRows } from "./symbolService.mjs";
import {
  FIXTURE_BROKERS,
  accountsFor,
  brokerIds,
  createCapturingLogger,
  createClock,
  createRecordingScheduler,
  istMs,
  loadMaster,
  stubAdapter,
} from "./__fixtures__/helpers.mjs";

/** Wait until no master download or cache write is in flight. */
async function settled(svc) {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 5));
    if (!svc.status().brokers.some((b) => b.loading)) return;
  }
  throw new Error("downloads did not settle");
}

let dataDir;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mcb-symbols-"));
});

/** Build a service over stub adapters for the given brokers (default: all five fixture masters). */
function setup({ brokers = FIXTURE_BROKERS, adapters, clock = createClock(), logger = createNullLogger(), bus, settings, scheduler = createRecordingScheduler(), cacheDir = dataDir, extraAccounts } = {}) {
  const ads = adapters ?? Object.fromEntries(brokers.map((b) => [b, stubAdapter(b, loadMaster(b))]));
  const accounts = accountsFor(ads, { bus, extra: extraAccounts });
  const deps = { config: {}, logger, bus, clock, paths: { dataDir: cacheDir }, brokers: brokerIds(), accounts, scheduler };
  const svc = createSymbolService(deps, { settings });
  return { svc, adapters: ads, accounts, scheduler, clock, deps };
}

describe("contract", () => {
  it("implements every SymbolService method", () => {
    const { svc } = setup();
    expect(() => assertService("symbols", svc)).not.toThrow();
    for (const m of SERVICE_CONTRACTS.symbols.methods) expect(typeof svc[m]).toBe("function");
  });

  it("parse/format delegate to the core codec", () => {
    const { svc } = setup();
    expect(svc.parse("nse:nifty-2026-10-27-fut")).toMatchObject({ canonical: "NFO:NIFTY-2026-10-27-FUT", kind: "FUT" });
    expect(svc.parse("NSE:NIFTY261027C25000").canonical).toBe("NFO:NIFTY-2026-10-27-25000-CE");
    expect(() => svc.parse("NSE:NIFTY1!")).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(svc.format({ exchange: "NFO", underlying: "NIFTY", expiry: "2026-10-27", strike: 25000, right: "CE" })).toBe("NFO:NIFTY-2026-10-27-25000-CE");
    expect(() => svc.parse("")).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("masterRows accepts the envelope or a bare array and refuses anything else", () => {
    expect(masterRows([1], "x")).toEqual([1]);
    expect(masterRows({ status: "success", data: [2] }, "x")).toEqual([2]);
    expect(() => masterRows({ status: "error" }, "x")).toThrow(expect.objectContaining({ code: "UPSTREAM_ERROR" }));
  });
});

describe("loading masters", () => {
  it("downloads each connected broker's master once, through the scheduler at background priority", async () => {
    const { svc, scheduler, adapters } = setup();
    await Promise.all([svc.resolve("NSE:RELIANCE"), svc.resolve("NSE:NIFTY"), svc.search({ q: "nifty" })]);
    expect(scheduler.calls).toHaveLength(5);
    for (const c of scheduler.calls) expect(c).toMatchObject({ endpointClass: "master", priority: "background", coalesceKey: `master:${c.accountId.replace(/-1$/, "")}` });
    for (const a of Object.values(adapters)) expect(a.calls).toBe(1);
    // The adapter receives creds from AccountManager.
    expect(adapters.dhan.seenCreds[0]).toMatchObject({ clientId: "dhan-client" });
    const st = svc.status();
    expect(st.brokers.map((b) => b.broker)).toEqual(["angelone", "dhan", "fyers", "upstox", "zerodha"]);
    expect(st.brokers.every((b) => b.source === "broker" && b.fresh && b.instruments > 0 && b.lastError === null)).toBe(true);
    expect(st.freezeList.verified).toBe(false);
  });

  it("skips paper, disabled, disconnected and instrument-less accounts", async () => {
    const zerodha = stubAdapter("zerodha", loadMaster("zerodha"));
    const { svc, scheduler } = setup({
      adapters: { dhan: stubAdapter("dhan", loadMaster("dhan")) },
      extraAccounts: [
        { id: "paper", broker: "paper" },
        { id: "z-off", broker: "zerodha", adapter: zerodha, enabled: false, capabilities: ["instruments"] },
        { id: "z-exp", broker: "zerodha", adapter: zerodha, state: "expired", capabilities: ["instruments"] },
        { id: "z-noinst", broker: "zerodha", adapter: zerodha, capabilities: ["ltp"] },
      ],
    });
    await svc.resolve("NSE:RELIANCE");
    expect(scheduler.calls.map((c) => c.accountId)).toEqual(["dhan-1"]);
    expect(zerodha.calls).toBe(0);
  });

  it("serves today's disk copy after a restart with no download, 0600 permissions, and prunes older days", async () => {
    const first = setup();
    await first.svc.resolve("NSE:RELIANCE");
    const dir = join(dataDir, "instruments");
    writeFileSync(join(dir, "dhan-2026-10-01.json"), "{}");
    await first.svc.refresh({ broker: "dhan" });
    const files = readdirSync(dir).sort();
    expect(files).toEqual(FIXTURE_BROKERS.map((b) => `${b}-2026-10-18.json`).sort());
    if (process.platform !== "win32") expect(statSync(join(dir, "dhan-2026-10-18.json")).mode & 0o077).toBe(0);

    const second = setup();
    const r = await second.svc.resolve("NFO:NIFTY-2026-10-27-25000-CE");
    expect(Object.keys(r.refs).sort()).toEqual([...FIXTURE_BROKERS].sort());
    expect(second.scheduler.calls).toEqual([]);
    expect(second.svc.status().brokers.every((b) => b.source === "disk")).toBe(true);
  });

  it("ignores a corrupt or foreign cache file and downloads instead", async () => {
    const dir = join(dataDir, "instruments");
    const first = setup({ brokers: ["dhan"] });
    await first.svc.resolve("NSE:RELIANCE");
    writeFileSync(join(dir, "dhan-2026-10-18.json"), "not json");
    const second = setup({ brokers: ["dhan"] });
    await second.svc.resolve("NSE:RELIANCE");
    expect(second.scheduler.calls).toHaveLength(1);
    writeFileSync(join(dir, "dhan-2026-10-18.json"), JSON.stringify({ version: 1, broker: "zerodha", day: "2026-10-18", fetchedAt: 1, rows: [] }));
    const third = setup({ brokers: ["dhan"] });
    await third.svc.resolve("NSE:RELIANCE");
    expect(third.scheduler.calls).toHaveLength(1);
  });

  it("a copy fetched before 08:30 IST is fetched again once 08:30 has passed, in the background", async () => {
    const clock = createClock("2026-10-18T07:00");
    const first = setup({ brokers: ["dhan"], clock });
    await first.svc.resolve("NSE:RELIANCE");
    clock.set("2026-10-18T08:00");
    await first.svc.resolve("NSE:RELIANCE");
    expect(first.scheduler.calls).toHaveLength(1); // still before the cut-off: current

    clock.set("2026-10-18T09:00");
    await first.svc.resolve("NSE:RELIANCE"); // answered from the old copy; reload starts in the background
    await settled(first.svc);
    expect(first.scheduler.calls).toHaveLength(2);
    expect(first.svc.status().brokers[0].fresh).toBe(true);

    // A new process at 09:30 accepts the 09:00 copy.
    clock.set("2026-10-18T09:30");
    const second = setup({ brokers: ["dhan"], clock });
    await second.svc.resolve("NSE:RELIANCE");
    expect(second.scheduler.calls).toEqual([]);
  });

  it("the refresh time is configurable", async () => {
    const clock = createClock("2026-10-18T07:00");
    const { svc, scheduler } = setup({ brokers: ["dhan"], clock, settings: { refreshAfterIst: "07:30", diskCache: false } });
    await svc.resolve("NSE:RELIANCE");
    clock.set("2026-10-18T07:45");
    await svc.resolve("NSE:RELIANCE");
    await settled(svc);
    expect(scheduler.calls).toHaveLength(2);
  });

  it("a new IST day drops expired contracts even before the reload finishes", async () => {
    const clock = createClock("2026-10-22T10:00");
    const { svc } = setup({ brokers: ["dhan"], clock });
    expect((await svc.resolve("BFO:SENSEX-2026-10-22-82000-CE")).lotSize).toBe(20);
    clock.set("2026-10-23T10:00");
    await expect(svc.resolve("BFO:SENSEX-2026-10-22-82000-CE")).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND", message: expect.stringMatching(/expired/) });
  });

  it("loads a broker's master when one of its accounts connects (account.status)", async () => {
    const bus = createEventBus({ logger: createNullLogger() });
    const { svc, scheduler, accounts } = setup({ brokers: ["dhan"], bus });
    accounts.setState("dhan-1", "expired");
    accounts.setState("dhan-1", "connected");
    await new Promise((r) => setImmediate(r));
    await settled(svc);
    expect(scheduler.calls).toHaveLength(1);
    expect(svc.status().brokers[0].instruments).toBeGreaterThan(0);
    svc.close();
    accounts.setState("dhan-1", "expired");
    accounts.setState("dhan-1", "connected");
    await new Promise((r) => setImmediate(r));
    expect(scheduler.calls).toHaveLength(1);
  });
});

describe("failures", () => {
  it("a failed broker does not block the others, is reported, and is not retried during the back-off", async () => {
    const err = Object.assign(new Error("Session expired"), { code: "SESSION_LOGIN_REQUIRED", statusCode: 422 });
    const clock = createClock();
    const { svc, scheduler } = setup({
      clock,
      adapters: { dhan: stubAdapter("dhan", loadMaster("dhan")), zerodha: stubAdapter("zerodha", [], { error: err }) },
    });
    expect((await svc.resolve("NSE:RELIANCE")).refs).toHaveProperty("dhan");
    const z = svc.status().brokers.find((b) => b.broker === "zerodha");
    expect(z.lastError).toEqual({ code: "SESSION_EXPIRED", message: "Session expired" });
    await svc.resolve("NSE:RELIANCE");
    expect(scheduler.calls.filter((c) => c.accountId === "zerodha-1")).toHaveLength(1);
    clock.advance(61_000);
    await svc.resolve("NSE:RELIANCE");
    expect(scheduler.calls.filter((c) => c.accountId === "zerodha-1")).toHaveLength(2);
  });

  it("refresh() keeps the previous master when the new download fails, and reports it", async () => {
    const dhan = stubAdapter("dhan", loadMaster("dhan"));
    const { svc } = setup({ adapters: { dhan }, settings: { diskCache: false } });
    await svc.resolve("NSE:RELIANCE");
    dhan.fetchInstruments = async () => {
      throw Object.assign(new Error("gateway"), { code: "UPSTREAM_ERROR", statusCode: 502 });
    };
    await expect(svc.refresh({ broker: "dhan" })).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect((await svc.resolve("NSE:RELIANCE")).refs.dhan.token).toBe("2885");
    const all = await svc.refresh();
    expect(all).toMatchObject({ brokers: [], errors: [{ broker: "dhan", code: "UPSTREAM_ERROR" }] });
  });

  it("after 08:30, a failed re-download falls back to today's earlier disk copy instead of no data", async () => {
    const clock = createClock("2026-10-18T07:00");
    const first = setup({ brokers: ["dhan"], clock });
    await first.svc.resolve("NSE:RELIANCE");
    clock.set("2026-10-18T09:00");
    const err = Object.assign(new Error("down"), { code: "UPSTREAM_TIMEOUT" });
    const second = setup({ clock, adapters: { dhan: stubAdapter("dhan", [], { error: err }) } });
    expect((await second.svc.resolve("NSE:RELIANCE")).refs.dhan.token).toBe("2885");
    expect(second.svc.status().brokers[0]).toMatchObject({ source: "disk", fresh: false, lastError: { code: "UPSTREAM_TIMEOUT" } });
    // A copy from an earlier IST day is never used.
    clock.set("2026-10-19T09:00");
    const third = setup({ clock, adapters: { dhan: stubAdapter("dhan", [], { error: err }) } });
    await expect(third.svc.resolve("NSE:RELIANCE")).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND" });
  });

  it("refresh() of a broker with no connected account says so; an unknown broker is a validation error", async () => {
    const { svc } = setup({ brokers: ["dhan"] });
    await expect(svc.refresh({ broker: "zerodha" })).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    await expect(svc.refresh({ broker: "nope" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await svc.refresh()).toMatchObject({ brokers: ["dhan"], errors: [] });
  });

  it("a scheduler that is not built yet means no data, not a crash", async () => {
    const { svc } = setup({ brokers: ["dhan"], scheduler: notImplementedService("scheduler") });
    await expect(svc.resolve("NSE:RELIANCE")).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND", message: expect.stringMatching(/no broker instrument master/) });
    expect(svc.status().brokers[0].lastError.code).toBe("NOT_IMPLEMENTED");
  });

  it("never logs a credential", async () => {
    const cap = createCapturingLogger();
    const err = Object.assign(new Error("bad token"), { code: "UPSTREAM_AUTH" });
    const { svc } = setup({ logger: cap.logger, adapters: { dhan: stubAdapter("dhan", loadMaster("dhan")), zerodha: stubAdapter("zerodha", [], { error: err }) } });
    await svc.resolve("NSE:RELIANCE");
    await svc.refresh().catch(() => {});
    expect(cap.lines.length).toBeGreaterThan(0);
    expect(cap.text()).not.toMatch(/secret-token/);
    expect(cap.text()).not.toMatch(/accessToken/);
  });
});

describe("resolve", () => {
  let svc;
  beforeEach(async () => {
    ({ svc } = setup());
    await svc.warm();
  });

  it.each([
    ["NFO:NIFTY-2026-10-27-25000-CE", "NFO:NIFTY-2026-10-27-25000-CE"],
    ["nfo:nifty-2026-10-27-25000-ce", "NFO:NIFTY-2026-10-27-25000-CE"],
    ["NSE:NIFTY-2026-10-27-25000-CE", "NFO:NIFTY-2026-10-27-25000-CE"],
    ["NSE:NIFTY261027C25000", "NFO:NIFTY-2026-10-27-25000-CE"],
    ["NFO:NIFTY27OCT2625000CE", "NFO:NIFTY-2026-10-27-25000-CE"],
    ["NSE:BANKNIFTY1!", "NFO:BANKNIFTY-2026-10-27-FUT"],
    ["NSE:NIFTY1!", "NFO:NIFTY-2026-10-27-FUT"],
    ["BSE:SENSEX", "BSE:SENSEX"],
    ["NSE:RELIANCE", "NSE:RELIANCE"],
  ])("%s -> %s", async (input, canonical) => {
    expect((await svc.resolve(input)).canonical).toBe(canonical);
  });

  it("returns a full ResolvedInstrument with refs, lot, tick and freeze quantity", async () => {
    const r = await svc.resolve("BFO:SENSEX-2026-10-22-82000-CE");
    expect(r).toMatchObject({
      canonical: "BFO:SENSEX-2026-10-22-82000-CE",
      exchange: "BFO",
      kind: "OPT",
      underlying: "SENSEX",
      expiry: "2026-10-22",
      strike: 82000,
      right: "CE",
      lotSize: 20,
      tickSize: 0.05,
      freezeQty: expect.any(Number),
      freezeQtySource: "exchange-list",
    });
    expect(Object.keys(r.refs).sort()).toEqual(["angelone", "dhan", "fyers", "zerodha"]);
    // Callers get a copy: mutating it does not touch the store.
    r.refs.dhan.token = "x";
    expect((await svc.resolve("BFO:SENSEX-2026-10-22-82000-CE")).refs.dhan.token).toBe("1125429");
  });

  it("accepts OpenAlgo-style symbols with an exchange", async () => {
    expect((await svc.resolve("NIFTY27OCT2625000CE", { exchange: "NFO" })).canonical).toBe("NFO:NIFTY-2026-10-27-25000-CE");
    expect((await svc.resolve("NIFTY", { exchange: "NSE_INDEX" })).canonical).toBe("NSE:NIFTY");
    await expect(svc.resolve("NIFTY27OCT2625000CE")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("accepts broker-native tokens and trading symbols with { broker }", async () => {
    expect((await svc.resolve("51440", { broker: "dhan" })).canonical).toBe("NFO:NIFTY-2026-10-27-25000-CE");
    expect((await svc.resolve("NIFTY26OCT25000CE", { broker: "zerodha" })).canonical).toBe("NFO:NIFTY-2026-10-27-25000-CE");
    expect((await svc.resolve("NSE_FO|51440", { broker: "upstox" })).canonical).toBe("NFO:NIFTY-2026-10-27-25000-CE");
    expect((await svc.resolve("NSE:NIFTY26OCT25000CE", { broker: "fyers" })).canonical).toBe("NFO:NIFTY-2026-10-27-25000-CE");
    expect((await svc.resolve("NSE:2885", { broker: "dhan" })).canonical).toBe("NSE:RELIANCE");
    expect((await svc.resolve("2885", { broker: "dhan", exchange: "NSE", from: "broker" })).canonical).toBe("NSE:RELIANCE");
    // Zerodha's RELIANCE trading symbol exists on NSE and BSE: ambiguous without the exchange.
    await expect(svc.resolve("RELIANCE", { broker: "zerodha", from: "broker" })).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringMatching(/Add the exchange/) });
    expect((await svc.resolve("RELIANCE", { broker: "zerodha", from: "broker", exchange: "BSE" })).canonical).toBe("BSE:RELIANCE");
  });

  it("corrects index vs equity from the master", async () => {
    expect((await svc.resolve("NSE:NIFTY")).kind).toBe("INDEX");
    expect((await svc.resolve("NSE:RELIANCE")).kind).toBe("EQ");
  });

  it("with { broker } the instrument must be in that broker's master", async () => {
    await expect(svc.resolve("BFO:SENSEX-2026-10-22-82000-CE", { broker: "upstox" })).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND", message: expect.stringMatching(/upstox/) });
    await expect(svc.resolve("NSE:RELIANCE", { broker: "nosuch" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("unknown, expired and malformed inputs fail clearly", async () => {
    await expect(svc.resolve("NSE:NOSUCHSTOCK")).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND" });
    await expect(svc.resolve("NFO:NIFTY-2026-10-17-25000-CE")).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND", message: expect.stringMatching(/expired/) });
    await expect(svc.resolve("NSE:FINNIFTY2!")).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND" });
    await expect(svc.resolve("???")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(svc.resolve("x".repeat(65))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(svc.resolve(42)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("never guesses a lot size", async () => {
    const rows = [{ token: "1", exchange: "NFO", tradingSymbol: "X", underlying: "NIFTY", instrumentType: "FUTIDX", expiry: "2026-12-29", strike: null, optionType: null, lotSize: null, tickSize: 0.1 }];
    const { svc: s2 } = setup({ adapters: { dhan: stubAdapter("dhan", rows) }, settings: { diskCache: false } });
    await expect(s2.resolve("NFO:NIFTY-2026-12-29-FUT")).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND", message: expect.stringMatching(/lot size/) });
  });

  it("toBroker and fromBroker map both ways", async () => {
    expect(await svc.toBroker("NFO:NIFTY-2026-10-27-25000-CE", "zerodha")).toEqual({ token: "12010242", exchange: "NFO", tradingSymbol: "NIFTY26OCT25000CE" });
    expect(await svc.fromBroker("zerodha", { token: "12010242", exchange: "NFO" })).toBe("NFO:NIFTY-2026-10-27-25000-CE");
    expect(await svc.fromBroker("zerodha", { token: "12010242" })).toBe("NFO:NIFTY-2026-10-27-25000-CE");
    expect(await svc.fromBroker("zerodha", { token: "999" })).toBeNull();
    await expect(svc.toBroker("NSE:RELIANCE")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(svc.fromBroker("zerodha", {})).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(svc.toBroker("BFO:SENSEX-2026-10-22-82000-CE", "upstox")).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND" });
  });
});

describe("search", () => {
  let svc;
  beforeEach(async () => {
    ({ svc } = setup());
  });

  it("ranks and paginates with an opaque cursor", async () => {
    const all = (await svc.search({ q: "nifty", limit: 500 })).items.map((i) => i.canonical);
    expect(all[0]).toBe("NSE:NIFTY");
    expect(all).not.toContain("NSE:RELIANCE");
    const seen = [];
    let cursor;
    do {
      const page = await svc.search({ q: "nifty", limit: 4, ...(cursor ? { cursor } : {}) });
      expect(page.items.length).toBeLessThanOrEqual(4);
      for (const i of page.items) expect(i).not.toHaveProperty("refs");
      seen.push(...page.items.map((i) => i.canonical));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all);
  });

  it("an exact symbol comes first", async () => {
    expect((await svc.search({ q: "NFO:NIFTY-2026-11-03-25000-PE" })).items[0].canonical).toBe("NFO:NIFTY-2026-11-03-25000-PE");
  });

  it("rejects bad parameters and foreign or stale cursors", async () => {
    await expect(svc.search({ q: "" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(svc.search({ q: "nifty", limit: 0 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(svc.search({ q: "nifty", kind: "BOND" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(svc.search({ q: "nifty", cursor: "garbage" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const { nextCursor } = await svc.search({ q: "nifty", limit: 1 });
    await expect(svc.search({ q: "sensex", limit: 1, cursor: nextCursor })).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringMatching(/different search/) });
    await svc.refresh({ broker: "dhan" });
    await expect(svc.search({ q: "nifty", limit: 1, cursor: nextCursor })).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringMatching(/refreshed/) });
  });
});

describe("convert", () => {
  let svc;
  beforeEach(async () => {
    ({ svc } = setup());
  });

  it("gives canonical plus TradingView, OpenAlgo and every connected broker's alias", async () => {
    const r = await svc.convert({ input: "NSE:NIFTY261027C25000" });
    expect(r).toEqual({
      input: "NSE:NIFTY261027C25000",
      canonical: "NFO:NIFTY-2026-10-27-25000-CE",
      aliases: {
        tradingview: "NSE:NIFTY261027C25000",
        openalgo: "NIFTY27OCT2625000CE",
        openalgoExchange: "NFO",
        "broker:angelone": "NIFTY27OCT2625000CE",
        "broker:angelone:token": "51440",
        "broker:dhan": "NIFTY-Oct2026-25000-CE",
        "broker:dhan:token": "51440",
        "broker:fyers": "NIFTY26OCT25000CE",
        "broker:fyers:token": "NSE:NIFTY26OCT25000CE",
        "broker:upstox": "NIFTY 25000 CE 27 OCT 26",
        "broker:upstox:token": "NSE_FO|51440",
        "broker:zerodha": "NIFTY26OCT25000CE",
        "broker:zerodha:token": "12010242",
      },
    });
  });

  it("names futures by their continuous TradingView ticker and indices with the _INDEX exchange", async () => {
    expect((await svc.convert({ input: "NFO:BANKNIFTY-2026-10-27-FUT" })).aliases.tradingview).toBe("NSE:BANKNIFTY1!");
    expect((await svc.convert({ input: "NSE:NIFTY" })).aliases).toMatchObject({ tradingview: "NSE:NIFTY", openalgo: "NIFTY", openalgoExchange: "NSE_INDEX" });
    expect((await svc.convert({ input: "NSE:RELIANCE" })).aliases).toMatchObject({ openalgo: "RELIANCE", openalgoExchange: "NSE" });
  });

  it("from=broker reads a native token; a given broker without the instrument gets a null alias", async () => {
    expect(await svc.convert({ input: "12010242", from: "broker", broker: "zerodha" })).toMatchObject({ canonical: "NFO:NIFTY-2026-10-27-25000-CE", aliases: { "broker:zerodha": "NIFTY26OCT25000CE" } });
    const r = await svc.convert({ input: "BFO:SENSEX-2026-10-22-82000-CE", broker: "upstox" });
    expect(r.aliases).toMatchObject({ "broker:upstox": null, "broker:upstox:token": null });
    expect(Object.keys(r.aliases).filter((k) => k.startsWith("broker:"))).toEqual(["broker:upstox", "broker:upstox:token"]);
  });

  it("works as a pure format converter for symbols no master lists", async () => {
    expect(await svc.convert({ input: "NIFTY30DEC2626000PE", from: "openalgo", exchange: "NFO" })).toMatchObject({ canonical: "NFO:NIFTY-2026-12-30-26000-PE", aliases: { tradingview: "NSE:NIFTY261230P26000" } });
  });

  it("validates its input", async () => {
    await expect(svc.convert(null)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(svc.convert({ input: "NSE:RELIANCE", from: "bloomberg" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(svc.convert({ input: "51440", from: "broker" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(svc.convert({ input: "NSE:RELIANCE", exchange: "X".repeat(13) })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(svc.convert({ input: "NIFTY", from: "openalgo" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("clock", () => {
  afterEach(() => {});
  it("istMs helper sanity", () => {
    expect(new Date(istMs("2026-10-18T05:30")).toISOString()).toBe("2026-10-18T00:00:00.000Z");
  });
});
