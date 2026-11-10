/**
 * Test helpers for the recorder: a service on a temp folder with a manual clock and the in-memory fakes of the market
 * service, the live feed, the accounts and the scheduler. No network, no real time. Not shipped behaviour.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createFakeMarketData } from "../market/fake.mjs";
import { createFakeScheduler, createManualClock } from "../ratelimit/fake.mjs";
import { createFakeStreamHub } from "../stream/fake.mjs";
import { createRecorderService } from "./service.mjs";

/** Monday 9 Nov 2026 (a trading day). Tuesday the 10th is a holiday (Diwali-Balipratipada). */
export const MON_0900 = Date.parse("2026-11-09T09:00:00+05:30");
export const at = (iso) => Date.parse(iso.length <= 16 ? `${iso}:00+05:30` : iso.includes("+") || iso.endsWith("Z") ? iso : `${iso}+05:30`);

export const NIFTY = "NSE:NIFTY";
export const BANKNIFTY = "NSE:BANKNIFTY";
export const leg = (u, expiry, strike, right) => `NFO:${u}-${expiry}-${strike}-${right}`;

/** A market service whose answers can be labelled delayed (to prove they are refused). */
export function labelled(md, label) {
  const wrap = (item) => ({ ...item, freshness: { ...item.freshness, ...label.current } });
  return new Proxy(md, {
    get(target, prop) {
      if (prop === "quotes") return async (...a) => {
        const r = await target.quotes(...a);
        return label.current ? { ...r, items: r.items.map(wrap) } : r;
      };
      if (prop === "optionChain") return async (...a) => {
        const r = await target.optionChain(...a);
        return label.current ? wrap(r) : r;
      };
      return target[prop];
    },
  });
}

/**
 * @param {{ start?: number, config?: object, accounts?: any[], library?: any, dir?: string, prices?: Record<string, number>,
 *   free?: number | null, expiries?: Record<string, string[]>, strikeStep?: number }} [o]
 */
export function bootRecorder(o = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "mcb-rec-"));
  const clock = o.clock ?? createManualClock(o.start ?? MON_0900);
  const bus = createEventBus();
  const events = [];
  for (const topic of ["recording.started", "recording.stopped", "recording.gap", "recording.disk_low", "account.login_needed"]) bus.on(topic, (p) => events.push([topic, p]));
  const accounts = o.accountsFake ?? createFakeAccountManager({ accounts: o.accounts ?? [{ id: "main", broker: "dhan", label: "Main" }], bus });
  const hub = o.hub ?? createFakeStreamHub({ bus, clock });
  const scheduler = createFakeScheduler({ bus });
  const prices = { [NIFTY]: 24012, [BANKNIFTY]: 51030, ...(o.prices ?? {}) };
  const md = o.md ?? createFakeMarketData({ prices, clock, source: "broker", strikeStep: o.strikeStep ?? 50 });
  for (const [u, list] of Object.entries(o.expiries ?? { NIFTY: ["2026-11-09", "2026-11-17", "2026-11-24", "2026-11-30"], BANKNIFTY: ["2026-11-24", "2026-12-29"] })) md.setExpiries?.(u, list);
  const label = { current: null };
  const market = labelled(md, label);
  let freeBytes = o.free === undefined ? 50 * 1024 ** 3 : o.free;
  const state = { get free() { return freeBytes; }, set free(v) { freeBytes = v; } };
  const symbols = o.symbols ?? { resolve: async (s) => ({ canonical: s }) };
  const config = { dataDir: dir, recorder: o.config ?? {} };
  const make = () =>
    createRecorderService(
      { config, logger: createNullLogger(), bus, clock, paths: { dataDir: dir }, accounts, scheduler, symbols, streamHub: hub, marketData: market },
      { now: () => clock.now(), statfs: () => state.free, library: () => o.library ?? null },
    );
  let svc = make();
  svc.attach({ library: o.library });
  const world = {
    dir,
    clock,
    bus,
    events,
    accounts,
    hub,
    scheduler,
    md,
    label,
    state,
    get svc() {
      return svc;
    },
    /** A fresh service on the same folder (a restart). The old one is closed first. */
    async restart() {
      await svc.close();
      svc = make();
      svc.attach({ library: o.library });
      await svc.start();
      return svc;
    },
    eventsOf: (topic) => events.filter(([t]) => t === topic).map(([, p]) => p),
    /** Advance time in steps, letting timers fire. */
    async run(ms, step = 1000) {
      for (let left = ms; left > 0; left -= step) await clock.advance(Math.min(step, left));
    },
    async close() {
      await svc.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return world;
}
