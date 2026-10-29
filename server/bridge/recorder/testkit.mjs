/**
 * Test helpers for the recorder (stream S17): a recorder service over fakes (manual clock, fake hub, fake accounts,
 * fake scheduler, an instrument master and a reference calendar), so service tests drive whole sessions in
 * milliseconds without a broker or the network.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { toIstIso } from "../market/time.mjs";
import { createFakeScheduler, createManualClock } from "../ratelimit/fake.mjs";
import { createCalendar } from "../reference/calendar.mjs";
import { createFakeStreamHub } from "../stream/fake.mjs";
import { parseRecorderConfig } from "./config.mjs";
import { createRecorderService } from "./recorderService.mjs";

export const IST = (s) => Date.parse(`${s}+05:30`);
export const EXPIRY = "2026-10-27";
export const FUT = "2026-10-27";
export const STRIKES = Array.from({ length: 41 }, (_, i) => 24000 + i * 50);

/** An instrument master with NIFTY options (one expiry) and a future. */
export function fakeSymbols({ underlyings = ["NIFTY"], expiry = EXPIRY } = {}) {
  return {
    async search(q) {
      if (!underlyings.includes(q.underlying)) return { items: [], nextCursor: null };
      if (q.kind === "FUT") return { items: [{ underlying: q.underlying, expiry: FUT, kind: "FUT", exchange: "NFO", lotSize: 75 }], nextCursor: null };
      const items = [];
      for (const k of STRIKES) for (const right of ["CE", "PE"]) items.push({ canonical: `NFO:${q.underlying}-${expiry}-${k}-${right}`, underlying: q.underlying, expiry, strike: k, right, kind: "OPT", exchange: "NFO", lotSize: 75 });
      return { items, nextCursor: null };
    },
  };
}

/** A reference service over the real calendar maths (one holiday on Tue 20 Oct 2026 for the tests). */
export function fakeReference({ holidays = [{ date: "2026-10-20", exchanges: ["NSE", "BSE"], label: "Test holiday", verified: true }] } = {}) {
  const cal = createCalendar({ holidays });
  return {
    session: (exchange, t) => {
      const s = cal.sessionAt(exchange, t);
      return { ...s, tradingDay: cal.isTradingDay(s.date, exchange) };
    },
    calendar: () => ({ isTradingDay: cal.isTradingDay, prevTradingDay: cal.prevTradingDay, nextTradingDay: cal.nextTradingDay, tradingDaysBetween: cal.tradingDaysBetween, holidays: cal.holidays }),
    rate: () => ({ value: 0.065, quality: "default", source: "test" }),
  };
}

/** A chain the fake marketData returns: strikes around `spot`, two-sided quotes, OI in lots of 75. */
export function fakeChain({ spot = 25010, t, n = 2, volume = 1500, accountId = "acc-1", broker = "upstox" } = {}) {
  const atm = Math.round(spot / 50) * 50;
  const rows = [];
  for (let i = -n; i <= n; i++) {
    const k = atm + i * 50;
    const c = Math.max(1, 100 + (spot - k) * 0.55);
    const p = Math.max(1, 100 + (k - spot) * 0.45);
    rows.push({ strike: k, ce: { ltp: c, bid: c - 0.5, ask: c + 0.5, oi: 75 * (1000 + i), volume, oiChange: 75 }, pe: { ltp: p, bid: p - 0.5, ask: p + 0.5, oi: 75 * (900 - i), volume, oiChange: -75 } });
  }
  return { underlying: "NIFTY", expiry: EXPIRY, underlyingLtp: spot, atmStrike: atm, lotSize: 75, rows, freshness: { source: "broker", asOf: toIstIso(t), ageMs: 0, stale: false, accountId, broker } };
}

/**
 * A recorder over fakes.
 * @param {{ start: number, recorder?: object, accounts?: object[], dataDir?: string, marketData?: object, hubLimit?: number,
 *   reference?: object, demo?: boolean }} o
 */
export function makeRecorder(o) {
  const clock = o.clock ?? createManualClock(o.start);
  const bus = o.bus ?? createEventBus();
  const dataDir = o.dataDir ?? mkdtempSync(join(tmpdir(), "mcb-rec-svc-"));
  const config = { dataDir, demo: Boolean(o.demo), stream: {}, market: {}, recorder: parseRecorderConfig({ indices: ["NIFTY"], indexExpiries: 1, indexStrikes: 2, slotOffsetMs: 2000, restSpreadMs: 0, strikeBuffer: 0, ...(o.recorder ?? {}) }) };
  const accounts = o.accountsSvc ?? createFakeAccountManager({ accounts: o.accounts ?? [{ id: "acc-1", broker: "upstox" }], bus });
  const scheduler = o.scheduler ?? createFakeScheduler({ bus });
  const calls = [];
  const marketData = o.marketData ?? {
    async optionChain(p, opts) {
      calls.push({ p, opts, at: clock.now() });
      return fakeChain({ t: clock.now(), accountId: opts.accountId });
    },
    async quotes() {
      return { items: [], errors: [] };
    },
  };
  const hub = o.hub ?? createFakeStreamHub({ bus, clock, accountId: "acc-1", broker: "upstox", limit: o.hubLimit ?? 2000 });
  const deps = { config, logger: createNullLogger(), bus, clock, paths: { dataDir, configFile: null }, marketData, streamHub: hub, accounts, scheduler, symbols: o.symbols ?? fakeSymbols(), reference: o.reference ?? fakeReference(), backupData: notImplementedService("backupData") };
  const svc = createRecorderService(deps);
  /** Advance one minute at a time and let each minute's work finish. */
  const minutes = async (n) => {
    for (let i = 0; i < n; i++) {
      await clock.advance(60_000);
      await svc.idle();
    }
  };
  return { svc, clock, bus, hub, accounts, scheduler, marketData, calls, dataDir, config, deps, minutes };
}
