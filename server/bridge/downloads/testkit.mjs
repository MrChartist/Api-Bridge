/**
 * Test helpers for the downloads module: a manager wired to fakes (no network, no broker), a history generator that
 * builds bars the way a broker would, and small waiting helpers. Imported by tests only.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { BridgeError } from "../core/errors.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { SESSION_OPEN_MIN } from "../market/history.mjs";
import { istMidnight, istParts } from "../market/time.mjs";
import { createFakeScheduler } from "../ratelimit/fake.mjs";
import { parseDownloadsConfig } from "./config.mjs";
import { EXTENSIONS, encodeBars, headerText } from "./bars.mjs";
import { createDownloadManager } from "./manager.mjs";

export const at = (iso) => Date.parse(iso);
/** Tuesday 20 October 2026, 11:00 IST. */
export const TUESDAY_11AM = at("2026-10-20T11:00:00+05:30");

const DAY = 86_400;

/**
 * A MarketDataService.history that makes bars on demand: daily bars stamped at 09:15 IST (as some brokers do), and
 * intraday bars on the session grid. Weekdays only. Records every call with its options.
 */
export function createFakeHistory({ broker = "fake", dataClass = "realtime", source = "broker", skip = () => false } = {}) {
  const calls = [];
  const failures = [];
  const api = {
    calls,
    /** Fail the next `times` calls with this code. */
    fail(code, times = 1, extra = {}) {
      failures.push({ code, times, extra });
    },
    async history(params, opts = {}) {
      calls.push({ params: { ...params }, opts: { ...opts, signal: undefined } });
      const f = failures.find((x) => x.times > 0);
      if (f) {
        f.times -= 1;
        throw new BridgeError(f.code, `fake ${f.code}`, f.extra);
      }
      if (opts.signal?.aborted) throw opts.signal.reason ?? new DOMException("aborted", "AbortError");
      const sym = parseSymbol(params.symbol).canonical;
      const from = Math.floor(Number(params.from));
      const to = Math.floor(Number(params.to));
      const out = [];
      const stepMin = { "1m": 1, "5m": 5, "15m": 15, "60m": 60 }[params.interval];
      for (let d = istMidnight(from * 1000); d <= to * 1000; d += DAY * 1000) {
        if ([0, 6].includes(istParts(d).weekday)) continue;
        const open = Math.floor(d / 1000) + SESSION_OPEN_MIN.NSE * 60;
        if (params.interval === "1d") {
          const t = open; // 09:15 IST, like a broker that stamps the open
          if (t >= from && t <= to && !skip(sym, t)) out.push(bar(t, 100 + ((t / DAY) % 17)));
        } else {
          for (let k = 0; k < Math.floor(375 / stepMin); k += 1) {
            const t = open + k * stepMin * 60;
            if (t >= from && t <= to && !skip(sym, t)) out.push(bar(t, 100 + (k % 9)));
          }
        }
      }
      return { symbol: sym, interval: params.interval, candles: out, partial: false, freshness: { source, class: dataClass, broker, accountId: opts.accountId ?? "acc1", official: true, delaySec: dataClass === "realtime" ? null : 900, asOf: "2026-10-20T11:00:00.000+05:30", ageMs: 0, stale: false, flags: [] } };
    },
  };
  return api;
}

const bar = (time, base) => ({ time, open: base, high: base + 2, low: base - 1, close: base + 1, volume: 1000 + (time % 50) });

/**
 * A manager over fakes in a fresh data folder.
 * @param {{ config?: object, clock?: { now(): number }, history?: ReturnType<typeof createFakeHistory>, dataDir?: string,
 *   library?: any, killed?: { value: boolean }, accounts?: any[], symbols?: any, sleep?: Function, statfs?: (dir: string) => number | null }} [o]
 */
export function makeManager(o = {}) {
  const dataDir = o.dataDir ?? mkdtempSync(join(tmpdir(), "mcb-dl-"));
  const clock = o.clock ?? { now: () => TUESDAY_11AM };
  const bus = createEventBus();
  const events = [];
  for (const t of ["download.progress", "download.done", "download.failed"]) bus.on(t, (e) => events.push({ topic: t, ...e }));
  const history = o.history ?? createFakeHistory();
  const accounts = createFakeAccountManager({ accounts: o.accounts ?? [{ id: "acc1", broker: "fake" }], bus });
  const scheduler = createFakeScheduler({ bus });
  const killed = o.killed ?? { value: false };
  const deps = {
    config: { downloads: parseDownloadsConfig({ progressThrottleMs: 100, ...(o.config ?? {}) }), market: {} },
    logger: createNullLogger(),
    bus,
    clock,
    paths: { dataDir },
    accounts,
    scheduler,
    marketData: { history: history.history },
    ...(o.symbols ? { symbols: o.symbols } : {}),
    safety: { killSwitchStatus: () => ({ engaged: killed.value }) },
  };
  const manager = createDownloadManager(deps, { sleep: o.sleep ?? (() => new Promise((r) => setImmediate(r))), getLibrary: () => o.library, ...(o.statfs ? { statfs: o.statfs } : {}) });
  return { manager, deps, dataDir, bus, events, history, accounts, scheduler, killed, clock };
}

/**
 * Write a dataset folder by hand: dataset.json and one file per series, in the format the downloads module writes.
 * @param {string} dataDir
 * @param {string} name
 * @param {{ format?: string, dataClass?: string, source?: string, official?: boolean, delaySec?: number | null, tags?: string[],
 *   series: Array<{ symbol: string, interval: string, bars: object[], coverage?: { from: number, to: number } | null, holes?: object[] }> }} spec
 */
export function writeDatasetFixture(dataDir, name, { format = "csv", dataClass = "realtime", source = "fake", official = true, delaySec = null, tags = [], series }) {
  const dir = join(dataDir, "downloads", "datasets", name);
  mkdirSync(dir, { recursive: true });
  const meta = { name, title: null, tags, format, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z", lastJobId: null, request: {}, dataClass, source, official, delaySec, notes: [], series: {} };
  for (const s of series) {
    const file = `${s.symbol.replace(/[^A-Za-z0-9]+/g, "_")}_${s.interval}.${EXTENSIONS[format]}`;
    writeFileSync(join(dir, file), headerText({ format, layout: "per-symbol", interval: s.interval }) + encodeBars(s.bars, { symbol: s.symbol, interval: s.interval, format, layout: "per-symbol" }));
    meta.series[`${s.symbol}|${s.interval}`] = {
      symbol: s.symbol,
      interval: s.interval,
      file,
      rows: s.bars.length,
      bytes: 0,
      firstBar: s.bars[0]?.time ?? null,
      lastBar: s.bars.at(-1)?.time ?? null,
      coverage: s.coverage === undefined ? (s.bars.length ? { from: s.bars[0].time, to: s.bars.at(-1).time } : null) : s.coverage,
      holes: s.holes ?? [],
      holesTotal: (s.holes ?? []).length,
      sha256: null,
      updatedAt: "2026-10-20T04:00:00.000Z",
    };
  }
  writeFileSync(join(dir, "dataset.json"), JSON.stringify(meta, null, 2));
  return dir;
}

/** Poll until `fn()` is truthy. */
export async function eventually(fn, { ms = 5000, every = 5 } = {}) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`condition not met in ${ms} ms (last: ${JSON.stringify(last)})`);
}

/** Wait until the job reaches one of `statuses`. */
export const waitStatus = (manager, id, statuses = ["done", "failed", "cancelled"], ms = 8000) => eventually(() => (statuses.includes(manager.get(id).status) ? manager.get(id) : null), { ms });
