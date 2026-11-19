/**
 * ticks module: when `ticks.record` is on, writes every tick the StreamHub emits to the tick log (tickLog.mjs) in
 * <dataDir>/ticks/. Off by default: a Bridge that never turns it on writes nothing and subscribes nothing.
 *
 * It only listens to the bus "tick" event, so it adds no work to the live path beyond one buffered line per tick, and the
 * recorder, stream and market modules do not know it exists. With `ticks.symbols` set it also subscribes those symbols
 * on the hub as its own client ("tick-log"), so they are recorded even when nothing else is watching them; it tries
 * again whenever a broker session or feed comes up. Every hour it deletes days past `keepDays` and, with
 * `compressFinished`, gzips finished days; `maxDiskMb` and `minFreeDiskMb` stop writes before a limit is passed.
 *
 * The research side (stores, signals, replay, comparison) is a library with no service: see index.mjs and
 * docs/guides/tick-research.md. Owns config section `ticks` (config.mjs). No routes.
 */
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { addDays, istDateOf } from "../reference/calendar.mjs";
import { defineModule } from "../core/modules.mjs";
import { addMetrics } from "../core/metrics.mjs";
import { TICKS_CONFIG_SCHEMA, ticksSettings } from "./config.mjs";
import { TICK_FILE_RE, compressDay, createTickLog, listTickDays } from "./tickLog.mjs";

const CLIENT_ID = "tick-log";
/** @type {WeakMap<object, { log: ReturnType<typeof createTickLog>, off: Array<() => void>, timer: any }>} */
const running = new WeakMap();

/** Delete day files older than `keepDays` (today counts as one). Returns the names removed. */
export function pruneTickLog(root, keepDays, nowMs) {
  if (!keepDays) return [];
  const oldest = addDays(istDateOf(nowMs), -(keepDays - 1));
  const removed = [];
  let names = [];
  try {
    names = readdirSync(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    const m = TICK_FILE_RE.exec(name);
    if (!m || m[1] >= oldest) continue;
    try {
      unlinkSync(join(root, name));
      removed.push(name);
    } catch {
      /* in use or gone: next pass */
    }
  }
  return removed;
}

/** @param {{ setInterval?: typeof setInterval, clearInterval?: typeof clearInterval }} [opts] */
export function createTicksModule(opts = {}) {
  const setI = opts.setInterval ?? setInterval;
  const clearI = opts.clearInterval ?? clearInterval;
  return defineModule({
    name: "ticks",
    configKey: "ticks",
    configSchema: TICKS_CONFIG_SCHEMA,
    register(_app, deps) {
      addMetrics(deps, () => {
        const r = running.get(deps);
        if (!r) return [];
        const s = r.log.stats();
        return [
          { name: "bridge_ticks_written_total", help: "Ticks written to the tick log since start.", value: s.written },
          { name: "bridge_ticks_lost_total", help: "Ticks the tick log had to give up (the disk refused writes).", value: s.lost },
          { name: "bridge_ticks_buffered", help: "Ticks waiting in memory for the next write.", value: s.buffered },
        ];
      });
    },
    async start(deps) {
      const cfg = ticksSettings(deps.config);
      if (!cfg.record) return;
      const log = deps.logger.child({ module: "ticks" });
      const root = join(deps.paths.dataDir, "ticks");
      const wanted = cfg.symbols ? new Set(cfg.symbols) : null;
      const tickLog = createTickLog({
        root,
        maxBufferedTicks: cfg.maxBufferedTicks,
        flushEveryMs: cfg.flushEveryMs,
        depthLevels: cfg.depthLevels,
        maxBytes: cfg.maxDiskMb ? cfg.maxDiskMb * 1024 * 1024 : null,
        minFreeBytes: cfg.minFreeDiskMb * 1024 * 1024,
        symbols: wanted ? (s) => wanted.has(s) : () => true,
        onLoss: (l) => log.warn("tick log gave up ticks the disk would not take", l),
      });
      const off = [tickLog.attach(deps.bus)];
      const hub = deps.streamHub;
      if (wanted && hub?.subscribe) {
        const subscribe = async () => {
          try {
            const { rejected } = await hub.subscribe(CLIENT_ID, [...wanted], "quote");
            if (rejected?.length) log.info("tick log could not subscribe some symbols yet", { count: rejected.length, first: rejected[0]?.code });
          } catch (err) {
            log.debug("tick log subscribe failed; will retry", { code: err?.code });
          }
        };
        await subscribe();
        off.push(deps.bus.on("account.status", (e) => (e?.session === "connected" ? subscribe() : undefined)));
        off.push(deps.bus.on("stream.status", (e) => (e?.connected ? subscribe() : undefined)));
      }
      const tidy = () => {
        const removed = pruneTickLog(root, cfg.keepDays, deps.clock.now());
        if (removed.length) log.info("old tick log days removed", { count: removed.length });
        let compressed = 0;
        if (cfg.compressFinished) {
          const today = istDateOf(deps.clock.now());
          for (const d of listTickDays(root)) {
            if (d.gz || d.date >= today) continue;
            try {
              compressDay(root, d.date);
              compressed += 1;
            } catch (err) {
              log.warn("a tick log day could not be compressed", { date: d.date, code: err?.code });
            }
          }
          if (compressed) log.info("finished tick log days compressed", { count: compressed });
        }
        if (removed.length || compressed) tickLog.rescan();
      };
      tidy();
      const timer = cfg.keepDays || cfg.compressFinished ? setI(tidy, 3600_000) : null;
      timer?.unref?.();
      running.set(deps, { log: tickLog, off, timer });
      log.info("recording every tick", { root, symbols: wanted ? wanted.size : "all streamed" });
    },
    async stop(deps) {
      const r = running.get(deps);
      if (!r) return;
      for (const f of r.off) f();
      if (r.timer) clearI(r.timer);
      try {
        deps.streamHub?.dropClient?.(CLIENT_ID);
      } catch {
        /* the hub may already be stopped */
      }
      r.log.close();
      running.delete(deps);
    },
  });
}

export default createTicksModule();
