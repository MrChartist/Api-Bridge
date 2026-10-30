/**
 * Events service (stream S28): wires the engine to its store, its inputs (live feed, or the demo simulator in demo
 * mode) and its timers. One per app (module.mjs keeps it in a WeakMap, like the scanner).
 */
import { join } from "node:path";
import { parseEventsConfig } from "./config.mjs";
import { createDemoMarket } from "./demoMarket.mjs";
import { createEventsEngine, istDate, sessionMinute } from "./engine.mjs";
import { createLiveFeed } from "./feed.mjs";
import { createEventStore } from "./store.mjs";

/** Chain-level detectors run on this timer (dirty chains only). */
export const FLUSH_MS = 250;

/**
 * @param {object} deps every service (module register()), plus config, clock, bus, paths, logger
 * @param {{ demoStepMs?: number, backfill?: boolean, autoStart?: boolean }} [opts]
 */
export function createEventsService(deps, opts = {}) {
  const cfg = parseEventsConfig(deps.config?.events);
  const demo = Boolean(deps.config?.demo);
  const log = deps.logger?.child ? deps.logger.child({ module: "events" }) : deps.logger;
  const dataDir = deps.paths?.dataDir ?? deps.config?.dataDir ?? null;
  const store = createEventStore({ dir: dataDir ? join(dataDir, demo ? "events-demo" : "events") : null, clock: deps.clock, keepDays: demo ? 3 : cfg.keepDays, logger: log });
  let demoMarket = null;
  const sessionOf = (ms) => (demoMarket ? demoMarket.sessionOf(ms) : sessionMinute(ms));
  const engine = createEventsEngine({ clock: deps.clock, bus: deps.bus, store, selection: store.loadSelection() ?? undefined, sessionOf, maxEvents: cfg.maxEventsPerDay, chainEveryMs: cfg.chainEveryMs, logger: log });
  const feed = !demo && cfg.enabled ? createLiveFeed({ engine, deps, cfg, store, logger: log }) : null;
  const timers = [];
  let started = false;

  async function start() {
    if (started || !cfg.enabled) return;
    started = true;
    store.prune();
    if (demo) {
      demoMarket = createDemoMarket({ engine, clock: deps.clock, scale: cfg.demoScale });
      if (opts.backfill !== false) await demoMarket.backfillAsync(undefined, undefined, () => !started);
      if (!started) return;
      const stepMs = opts.demoStepMs ?? 1000;
      let last = deps.clock.now();
      const t = setInterval(() => {
        const now = deps.clock.now();
        demoMarket.step(now, { dtSec: Math.max(0.2, (now - last) / 1000) });
        last = now;
      }, stepMs);
      t.unref?.();
      timers.push(t);
    } else {
      engine.restore(await store.readDay(istDate(deps.clock.now())));
      await feed?.start();
      const f = setInterval(() => engine.flush(), FLUSH_MS);
      f.unref?.();
      timers.push(f);
    }
  }

  return {
    engine,
    store,
    cfg,
    demo,
    start,
    async stop() {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      feed?.stop();
      await store.flush();
      started = false;
    },
    setSelection(input) {
      const sel = engine.setSelection(input);
      try {
        store.saveSelection(sel);
      } catch (err) {
        log?.warn?.("could not save the event selection", { err: err?.message });
      }
      feed?.refresh().catch(() => {});
      return sel;
    },
    status() {
      return {
        enabled: cfg.enabled,
        demo,
        mode: demo ? "demo" : "live",
        engine: engine.stats(),
        feed: feed?.status() ?? null,
        demoMarket: demoMarket?.size() ?? null,
        budgetShare: cfg.budgetShare,
      };
    },
    demoMarket: () => demoMarket,
  };
}
