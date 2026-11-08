/**
 * Round trip canonical <-> broker refs for Dhan, Zerodha, Upstox, Angel One and Fyers.
 * Two layers:
 *  1. snapshot masters (__fixtures__/masters/*.json, the adapters' normalised output) through the full service:
 *     every row maps to a canonical symbol and back to exactly its own token, by token and by trading symbol, and the
 *     chart and compact aliases read back to the same canonical symbol;
 *  2. the REAL adapter modules (server/brokers/<id>.mjs) behind the fake AccountManager, with fetch answered only by
 *     their own contract fixtures (contractHarness createFetchStub): no network, but the actual mapping code.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFetchStub, loadFixtures } from "../../brokers/contractHarness.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { mapContractRow } from "./aliases.mjs";
import { createSymbolService } from "./symbolService.mjs";
import { FIXTURE_BROKERS, accountsFor, brokerIds, createClock, createRecordingScheduler, loadMaster, stubAdapter } from "./__fixtures__/helpers.mjs";

const clock = createClock("2026-10-18T10:00");

function serviceOver(adapters, accounts) {
  return createSymbolService(
    { config: {}, logger: createNullLogger(), clock, paths: {}, brokers: brokerIds(), accounts: accounts ?? accountsFor(adapters), scheduler: createRecordingScheduler() },
    { cache: null },
  );
}

describe("snapshot masters: every row round-trips", () => {
  const svc = serviceOver(Object.fromEntries(FIXTURE_BROKERS.map((b) => [b, stubAdapter(b, loadMaster(b))])));
  beforeAll(() => svc.warm());

  it("loads every row of every broker (nothing skipped or expired)", () => {
    const st = svc.status();
    for (const b of FIXTURE_BROKERS) {
      const row = st.brokers.find((x) => x.broker === b);
      expect(row, b).toMatchObject({ rows: loadMaster(b).length, instruments: loadMaster(b).length, skipped: 0, expired: 0 });
    }
    expect(st.conflicts).toBe(0);
  });

  for (const broker of FIXTURE_BROKERS) {
    describe(broker, () => {
      for (const row of loadMaster(broker)) {
        it(`${row.exchange} ${row.token} (${row.tradingSymbol})`, async () => {
          const mapped = mapContractRow(row);
          expect(mapped).not.toHaveProperty("skip");
          const canonical = mapped.canonical;

          // canonical -> this broker's ref
          const resolved = await svc.resolve(canonical, { broker });
          expect(resolved.canonical).toBe(canonical);
          expect(resolved.lotSize).toBe(row.lotSize);
          expect(await svc.toBroker(canonical, broker)).toEqual({ token: row.token, exchange: row.exchange, tradingSymbol: row.tradingSymbol });

          // broker ref -> canonical (token with and without exchange, trading symbol with exchange)
          expect(await svc.fromBroker(broker, { token: row.token, exchange: row.exchange })).toBe(canonical);
          expect((await svc.resolve(row.token, { broker, from: "broker", exchange: row.exchange })).canonical).toBe(canonical);
          expect((await svc.resolve(row.tradingSymbol, { broker, from: "broker", exchange: row.exchange })).canonical).toBe(canonical);

          // aliases read back
          const { aliases } = await svc.convert({ input: canonical, broker });
          expect(aliases[`broker:${broker}:token`]).toBe(row.token);
          if (aliases.chart) expect((await svc.convert({ input: aliases.chart, from: "chart" })).canonical).toBe(canonical);
          expect((await svc.convert({ input: aliases.compact, exchange: aliases.compactExchange, from: "compact" })).canonical).toBe(canonical);
        });
      }
    });
  }

  it("the same contract from all five brokers is one instrument", async () => {
    const r = await svc.resolve("NFO:NIFTY-2026-10-27-25000-CE");
    expect(Object.keys(r.refs).sort()).toEqual([...FIXTURE_BROKERS].sort());
    expect(new Set(Object.values(r.refs).map((x) => x.token))).toEqual(new Set(["51440", "12010242", "NSE_FO|51440", "NSE:NIFTY26OCT25000CE"]));
  });

  it("indices merge across Zerodha's display names and the others' short names", async () => {
    expect(Object.keys((await svc.resolve("NSE:NIFTY")).refs).sort()).toEqual(["dhan", "upstox", "zerodha"]);
    expect(Object.keys((await svc.resolve("NSE:BANKNIFTY")).refs)).toEqual(["zerodha"]);
    expect(Object.keys((await svc.resolve("BSE:SENSEX")).refs).sort()).toEqual(["dhan", "upstox", "zerodha"]);
  });
});

describe("real adapters behind the fake AccountManager (fixture fetch only)", () => {
  const realFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  for (const broker of FIXTURE_BROKERS) {
    it(`${broker}: fetchInstruments through the scheduler gives the snapshot rows and they all resolve`, async () => {
      const fx = loadFixtures(broker);
      const adapter = await import(`../../brokers/${broker}.mjs`);
      const stub = createFetchStub(fx.byCapability.instruments.responses);
      globalThis.fetch = stub.fetch;
      try {
        const { createFakeAccountManager } = await import("../accounts/fake.mjs");
        const accounts = createFakeAccountManager({
          accounts: [{ id: `${broker}-1`, broker, adapter, capabilities: ["instruments"], creds: { ...fx.manifest.creds, ...(fx.byCapability.instruments.creds ?? {}) } }],
        });
        const svc = serviceOver(null, accounts);
        await svc.warm();
        const st = svc.status().brokers[0];
        expect(st).toMatchObject({ broker, source: "broker", skipped: 0, lastError: null });
        const snapshot = loadMaster(broker);
        expect(st.instruments).toBe(snapshot.length);
        for (const row of snapshot) {
          const canonical = mapContractRow(row).canonical;
          expect(await svc.fromBroker(broker, { token: row.token, exchange: row.exchange })).toBe(canonical);
        }
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  }
});
