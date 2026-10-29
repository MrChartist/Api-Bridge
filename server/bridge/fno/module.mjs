/**
 * fno module — stream S19 (docs/spec/p1-06-stocks.md): stock options everywhere. Routes only (no contract service),
 * like `scanner`: other streams do not call it. register() builds the F&O universe, the sweeper and the store
 * (dataDir/fno/) from marketData, symbols, accounts, scheduler and reference (recorder and backupData optional) and
 * hands them to the routes. Config section `fno` (config.mjs). Nothing here can place an order: the ban gate itself
 * lives in safety (fnoBan) and orders (heldQty); the sweep and the expiry costs are read-only.
 */
import { join } from "node:path";
import { isStub } from "../core/contracts.mjs";
import { defineModule } from "../core/modules.mjs";
import { demoOptionOi } from "../demo/demoAdapter.mjs";
import { FNO_CONFIG_SCHEMA, fnoConfigOf } from "./config.mjs";
import { createFnoRoutes } from "./routes.mjs";
import { createSweepStore } from "./sweepStore.mjs";
import { createSweeper } from "./sweep.mjs";
import { createUniverse } from "./universe.mjs";

const READ = Object.freeze({ scope: "read" });
const WRITE = Object.freeze({ scope: "admin", loopbackOnly: true });

/** [method, path, route options, handler name] — docs/openapi.yaml, x-stream S19. */
export const ROUTES = Object.freeze([
  ["GET", "/v1/options/underlyings", READ, "list"],
  ["GET", "/v1/options/underlyings/:underlying", READ, "detail"],
  ["POST", "/v1/options/expiry-costs", READ, "expiryCosts"],
  ["POST", "/v1/options/sweeps/plan", READ, "plan"],
  ["POST", "/v1/options/sweeps", READ, "start"],
  ["GET", "/v1/options/sweeps/current", READ, "current"],
  ["GET", "/v1/options/sweeps/current/chains", READ, "chains"],
  ["DELETE", "/v1/options/sweeps/current", { ...READ, body: "none" }, "cancel"],
  ["GET", "/v1/options/sweeps/settings", READ, "getSettings"],
  ["PUT", "/v1/options/sweeps/settings", WRITE, "putSettings"],
]);

/** One fno instance per app (tests build many apps in one process). */
const instances = new WeakMap();

/** The fno instance register() built for these deps (MCP tools), or null. */
export function fnoFor(deps) {
  return instances.get(deps) ?? null;
}

const usable = (s) => Boolean(s) && !isStub(s);
const optional = (deps, key) => {
  try {
    return usable(deps[key]) ? deps[key] : null;
  } catch {
    return null;
  }
};

/**
 * Build the fno instance (exported for tests).
 * @param {object} deps services plus config, logger, bus, clock, paths
 */
export function createFno(deps) {
  const cfg = fnoConfigOf(deps.config);
  const demo = deps.config?.demo === true;
  const now = () => (deps.clock ? deps.clock.now() : Date.now());
  const log = typeof deps.logger?.child === "function" ? deps.logger.child({ module: "fno" }) : deps.logger;
  const dataDir = deps.paths?.dataDir ?? deps.config?.dataDir ?? null;
  // Demo mode keeps the store in memory (settings apply with persisted: false).
  const store = createSweepStore(dataDir ? join(dataDir, "fno") : null, { now, logger: log, memory: demo || !dataDir });
  const reference = optional(deps, "reference");
  const symbols = optional(deps, "symbols");
  let sweeper = null;
  const universe = createUniverse({ reference, symbols, clock: deps.clock, logger: log, cfg, coverageFor: (u) => sweeper?.coverageFor(u) ?? { covered: false, method: null } });
  /** Demo ΔOI baseline (§4.2): the OI formula at the session open (reference session), labelled with that time. */
  const demoBaseline = demo
    ? async (canonical, date) => {
        try {
          const open = reference?.session?.("NFO", Date.parse(`${date}T12:00:00+05:30`))?.open;
          if (!/^\d{2}:\d{2}$/.test(String(open ?? ""))) return null;
          const ref = await symbols.toBroker(canonical, "demo");
          const oi = demoOptionOi(ref?.token, Date.parse(`${date}T${open}:00+05:30`));
          return Number.isFinite(oi) ? [open, oi] : null;
        } catch {
          return null;
        }
      }
    : null;
  sweeper = createSweeper({
    cfg,
    demo,
    clock: deps.clock,
    logger: log,
    bus: deps.bus,
    scheduler: deps.scheduler,
    accounts: deps.accounts,
    marketData: deps.marketData,
    symbols,
    reference,
    backupData: optional(deps, "backupData"),
    universe,
    store,
    demoBaseline,
  });

  // Picker prices (§3.3 withQuotes=1): one batched interactive read, cached 60 s, skipped without headroom.
  let quoteCache = { at: 0, byUnderlying: new Map(), key: "" };
  async function pickerQuotes(items) {
    const spots = items.map((i) => i.spot).filter(Boolean);
    const key = spots.join(",");
    if (key === quoteCache.key && now() - quoteCache.at < 60_000) return { byUnderlying: quoteCache.byUnderlying, meta: { loaded: true, cachedAt: new Date(quoteCache.at).toISOString() } };
    let account = null;
    try {
      account = deps.accounts.marketDataCandidates({ capability: "quotes" })[0] ?? null;
    } catch {
      account = null;
    }
    if (!account) return { byUnderlying: new Map(), meta: { loaded: false, reason: "BROKER_UNAVAILABLE" } };
    try {
      const h = deps.scheduler.headroom(account, "quote");
      if (Number.isFinite(h?.remaining) && h.remaining < 2) return { byUnderlying: new Map(), meta: { loaded: false, reason: "NO_HEADROOM" } };
    } catch {
      // unknown headroom: try the read
    }
    const byUnderlying = new Map();
    const bySpot = new Map(items.map((i) => [i.spot, i.underlying]));
    try {
      for (let i = 0; i < spots.length; i += 200) {
        const r = await deps.marketData.quotes(spots.slice(i, i + 200), { priority: "interactive", maxAgeMs: 60_000 });
        for (const q of r?.items ?? []) {
          const u = bySpot.get(q.symbol);
          if (!u) continue;
          const changePct = Number.isFinite(q.close) && q.close > 0 && Number.isFinite(q.ltp) ? Math.round(((q.ltp - q.close) / q.close) * 10_000) / 100 : null;
          byUnderlying.set(u, { ltp: q.ltp ?? null, changePct });
        }
      }
    } catch (err) {
      return { byUnderlying, meta: { loaded: byUnderlying.size > 0, reason: err?.code ?? "UPSTREAM_ERROR" } };
    }
    quoteCache = { at: now(), byUnderlying, key };
    return { byUnderlying, meta: { loaded: true } };
  }

  // Holdings of one stock in one account (positions in the stock's cash symbol plus broker holdings), cached 60 s.
  const heldCache = new Map();
  async function heldShares(ctx, accountId, underlying, spotSymbol) {
    const k = `${accountId}|${underlying}`;
    const hit = heldCache.get(k);
    if (hit && now() - hit.at < 60_000) return hit.value;
    const orders = optional(deps, "orders");
    if (!orders) return null;
    let value = 0;
    try {
      const pos = await orders.positions(ctx, accountId);
      for (const p of pos?.items ?? []) if (p.symbol === spotSymbol) value += Number(p.netQty) || 0;
      try {
        const hold = await orders.holdings(ctx, accountId);
        for (const h of hold?.items ?? []) if (h.symbol === spotSymbol) value += Number(h.quantity ?? h.qty) || 0;
      } catch {
        // positions alone
      }
    } catch {
      value = null;
    }
    heldCache.set(k, { at: now(), value });
    if (heldCache.size > 200) heldCache.delete(heldCache.keys().next().value);
    return value;
  }

  return { cfg, demo, now, store, universe, sweeper, pickerQuotes, heldShares };
}

export default defineModule({
  name: "fno",
  stream: "S19",
  configKey: "fno",
  configSchema: FNO_CONFIG_SCHEMA,
  register(app, deps) {
    const f = createFno(deps);
    instances.set(deps, f);
    const handlers = createFnoRoutes(f, deps);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], { ...options });
  },
  async start(deps) {
    const f = instances.get(deps);
    if (!f) return;
    if (f.cfg.ban.blockOpening === false) {
      deps.logger?.warn?.("fno.ban.blockOpening is false: opening orders in ban-period stocks are only warned, not refused (each one is audited)");
    }
    const offs = [];
    for (const topic of ["reference.updated"]) {
      try {
        const off = deps.bus?.on?.(topic, () => f.universe.invalidate());
        if (typeof off === "function") offs.push(off);
      } catch {
        // no bus in some tests
      }
    }
    f.offs = offs;
    // Build the list once in the background so the first picker open is fast.
    f.universe.ensure().catch(() => {});
    f.sweeper.startTimers();
  },
  async stop(deps) {
    const f = instances.get(deps);
    if (!f) return;
    f.sweeper.stopTimers();
    for (const off of f.offs ?? []) off();
  },
});
