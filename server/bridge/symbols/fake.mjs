/**
 * In-memory SymbolService for OTHER modules' tests (market, stream, orders, paper, integrations, hooks). It satisfies SERVICE_CONTRACTS.symbols
 * exactly, runs the real resolution, alias and search code over a fixed instrument list, needs no AccountManager or
 * Scheduler, makes no broker call and touches no disk.
 *
 *   import { createFakeSymbolService } from "../symbols/fake.mjs";
 *   const symbols = createFakeSymbolService();                    // FAKE_INSTRUMENTS under broker "fake"
 *   const symbols = createFakeSymbolService({
 *     instruments: [
 *       { symbol: "NSE:RELIANCE", lotSize: 1, tickSize: 0.1, refs: { dhan: { token: "2885" } } },
 *       { symbol: "NFO:NIFTY-2026-10-27-25000-CE", lotSize: 65, refs: { dhan: { token: "51440", tradingSymbol: "NIFTY-Oct2026-25000-CE" } } },
 *     ],
 *     today: "2026-10-18",            // optional IST day for expiry checks; default: nothing ever counts as expired
 *   });
 *   const symbols = createFakeSymbolService({ masters: { dhan: dhanContractRows } });   // raw contract Instrument rows
 *
 *   await symbols.resolve("NSE:NIFTY1!");      // real continuous-future resolution over the fake list
 *   symbols.calls                              // [["resolve", "NSE:NIFTY1!", {}], ...] for assertions
 *   symbols.setMaster("dhan", rows)            // swap one broker's rows mid-test
 *
 * refresh() never downloads; it reports what is loaded.
 */
import { assertService } from "../core/contracts.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { createInstrumentStore } from "./instrumentStore.mjs";
import { istDay } from "./ist.mjs";
import { createSymbolService } from "./symbolService.mjs";

/** The broker id FAKE_INSTRUMENTS refs use. */
export const FAKE_BROKER = "fake";

const strikes = (from, to, step) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

/**
 * A compact instrument list: indices, a few stocks (including names with "-" and "&"), index and stock futures and a
 * small NIFTY option chain on two expiries, a SENSEX weekly, a stock option and an MCX future.
 * @type {ReadonlyArray<{ symbol: string, kind?: string, lotSize: number, tickSize: number, isin?: string, name?: string }>}
 */
export const FAKE_INSTRUMENTS = Object.freeze([
  { symbol: "NSE:NIFTY", lotSize: 1, tickSize: 0.05, name: "Nifty 50" },
  { symbol: "NSE:BANKNIFTY", lotSize: 1, tickSize: 0.05, name: "Nifty Bank" },
  { symbol: "NSE:FINNIFTY", lotSize: 1, tickSize: 0.05 },
  { symbol: "BSE:SENSEX", lotSize: 1, tickSize: 0.01 },
  { symbol: "NSE:NIFTYIT", kind: "INDEX", lotSize: 1, tickSize: 0.05, name: "Nifty IT" },
  { symbol: "NSE:RELIANCE", lotSize: 1, tickSize: 0.1, isin: "INE002A01018", name: "Reliance Industries" },
  { symbol: "NSE:INFY", lotSize: 1, tickSize: 0.05, isin: "INE009A01021", name: "Infosys" },
  { symbol: "NSE:M&M", lotSize: 1, tickSize: 0.05, isin: "INE101A01026", name: "Mahindra & Mahindra" },
  { symbol: "NSE:BAJAJ-AUTO", lotSize: 1, tickSize: 0.5, isin: "INE917I01010", name: "Bajaj Auto" },
  { symbol: "BSE:RELIANCE", lotSize: 1, tickSize: 0.05, isin: "INE002A01018", name: "Reliance Industries" },
  { symbol: "NFO:NIFTY-2026-10-27-FUT", lotSize: 65, tickSize: 0.1 },
  { symbol: "NFO:NIFTY-2026-11-24-FUT", lotSize: 65, tickSize: 0.1 },
  { symbol: "NFO:BANKNIFTY-2026-10-27-FUT", lotSize: 30, tickSize: 0.2 },
  { symbol: "NFO:RELIANCE-2026-10-27-FUT", lotSize: 500, tickSize: 0.1 },
  ...["2026-10-20", "2026-10-27"].flatMap((expiry) =>
    strikes(24800, 25200, 50).flatMap((k) => ["CE", "PE"].map((r) => ({ symbol: `NFO:NIFTY-${expiry}-${k}-${r}`, lotSize: 65, tickSize: 0.05 }))),
  ),
  { symbol: "BFO:SENSEX-2026-10-22-82000-CE", lotSize: 20, tickSize: 0.05 },
  { symbol: "BFO:SENSEX-2026-10-22-82000-PE", lotSize: 20, tickSize: 0.05 },
  { symbol: "NFO:RELIANCE-2026-10-27-1400-CE", lotSize: 500, tickSize: 0.05 },
  { symbol: "NFO:RELIANCE-2026-10-27-1400-PE", lotSize: 500, tickSize: 0.05 },
  { symbol: "MCX:CRUDEOIL-2026-11-19-FUT", lotSize: 100, tickSize: 1 },
]);

const TYPE_FOR = { INDEX: "INDEX", EQ: "EQ", FUT: "FUTIDX", OPT: "OPTIDX" };

/**
 * Turn simple instrument specs into per-broker contract Instrument rows.
 * @param {ReadonlyArray<{ symbol: string, kind?: string, lotSize: number, tickSize?: number, freezeQty?: number,
 *   isin?: string, name?: string, refs?: Record<string, { token: string, exchange?: string, tradingSymbol?: string | null }> }>} specs
 * @returns {Record<string, object[]>} broker -> rows
 */
export function rowsFromSpecs(specs) {
  const out = {};
  specs.forEach((s, i) => {
    const p = parseSymbol(s.symbol);
    const kind = s.kind ?? p.kind;
    const refs = s.refs ?? { [FAKE_BROKER]: { token: `F${i + 1}`, tradingSymbol: p.canonical } };
    for (const [broker, ref] of Object.entries(refs)) {
      (out[broker] ??= []).push({
        token: String(ref.token),
        exchange: ref.exchange ?? p.exchange,
        tradingSymbol: ref.tradingSymbol === undefined ? p.canonical : ref.tradingSymbol,
        underlying: p.underlying,
        instrumentType: TYPE_FOR[kind],
        expiry: p.expiry,
        strike: p.strike,
        optionType: p.right,
        lotSize: s.lotSize,
        tickSize: s.tickSize ?? 0.05,
        ...(s.freezeQty !== undefined ? { freezeQty: s.freezeQty } : {}),
        ...(s.isin ? { isin: s.isin } : {}),
        ...(s.name ? { name: s.name } : {}),
      });
    }
  });
  return out;
}

/**
 * @param {{ instruments?: Parameters<typeof rowsFromSpecs>[0], masters?: Record<string, object[]>, today?: string,
 *   clock?: { now(): number } }} [opts]
 *   masters wins over instruments; with neither, FAKE_INSTRUMENTS. `clock` (or `today`) turns on expiry checks.
 */
export function createFakeSymbolService({ instruments, masters, today, clock } = {}) {
  const rowsByBroker = masters ?? rowsFromSpecs(instruments ?? FAKE_INSTRUMENTS);
  const fixedNow = today ? Date.parse(`${today}T12:00:00+05:30`) : Date.parse("2000-01-01T12:00:00+05:30");
  if (!Number.isFinite(fixedNow)) throw new Error(`fake symbols: bad today ${today}`);
  const effectiveClock = clock ?? { now: () => fixedNow };
  const store = createInstrumentStore();
  const day = () => istDay(effectiveClock.now());
  for (const [broker, rows] of Object.entries(rowsByBroker)) store.setMaster(broker, rows, { source: "fake", loadedAt: null, day: day() }, day());

  const deps = {
    config: {},
    logger: createNullLogger(),
    clock: effectiveClock,
    brokers: { has: (id) => typeof id === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(id) },
  };
  const real = createSymbolService(deps, { store, cache: null });
  const calls = [];
  const wrap = (name, fn) => (...args) => {
    calls.push([name, ...args.map((a) => (a && typeof a === "object" ? structuredClone(a) : a))]);
    return fn(...args);
  };
  const svc = {
    parse: wrap("parse", real.parse),
    format: wrap("format", real.format),
    resolve: wrap("resolve", (input, o = {}) => real.resolve(input, o)),
    toBroker: wrap("toBroker", real.toBroker),
    fromBroker: wrap("fromBroker", real.fromBroker),
    search: wrap("search", real.search),
    convert: wrap("convert", real.convert),
    resolveInput: wrap("resolveInput", real.resolveInput),
    refresh: wrap("refresh", async () => ({ brokers: store.brokers(), instruments: store.size(), errors: [] })),
    status: wrap("status", () => real.status()),
    /** Test helper: replace one broker's contract rows. */
    setMaster(broker, rows) {
      store.setMaster(broker, rows, { source: "fake", loadedAt: null, day: day() }, day());
    },
    calls,
  };
  assertService("symbols", svc);
  return svc;
}
