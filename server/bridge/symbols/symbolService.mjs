/**
 * SymbolService — stream S4 (docs/STREAMS.md §S4). The contract (methods, argument and return types, rules) is
 * SERVICE_CONTRACTS.symbols in ../core/contracts.mjs.
 *
 *  - parse/format delegate to core/symbolFormat.mjs (the canonical format is a core decision; it is not forked here).
 *  - Instrument masters come from each connected broker's adapter.fetchInstruments, always through
 *    deps.scheduler.schedule({ endpointClass: "master", priority: "background" }), one download per broker (coalesced),
 *    from one of that broker's connected accounts. They are cached per broker per IST day in <dataDir>/instruments/
 *    and fetched again once after `symbols.refreshAfterIst` (08:30 IST) if the cached copy is older, or on refresh().
 *  - Masters are merged into ResolvedInstrument records (instrumentStore.mjs). Lot sizes are never guessed: an unknown
 *    lot size is SYMBOL_NOT_FOUND. Expired contracts never resolve.
 *  - resolve() accepts canonical symbols, the venue form (NSE: for derivatives), chart tickers (continuous 1!/2!
 *    become the nearest/next futures expiry from the master), compact symbols with an exchange (or written
 *    "NFO:NIFTY27OCT2625000CE"), and, with { broker }, that broker's own tokens and trading symbols.
 *
 * Nothing here holds or logs credentials: creds() is called inside the scheduled function and handed straight to the
 * adapter.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { isStub } from "../core/contracts.mjs";
import { BridgeError, fromBrokerError, fromValidation } from "../core/errors.mjs";
import {
  EXCHANGES,
  detectFormat,
  formatSymbol,
  parseCompact,
  parseSymbol,
  parseChartTicker,
  toCompact,
  toChartTicker,
} from "../core/symbolFormat.mjs";
import { FREEZE_LIST_AS_OF } from "./freezeQuantities.mjs";
import { createInstrumentStore } from "./instrumentStore.mjs";
import { istDay, istTimeOnDay, toIstIso } from "./ist.mjs";
import { createMasterCache } from "./masterCache.mjs";
import { SYMBOLS_CONFIG_DEFAULTS } from "./symbolsConfig.mjs";

export const FROM_FORMATS = Object.freeze(["auto", "canonical", "chart", "compact", "broker"]);
export const KINDS = Object.freeze(["INDEX", "EQ", "FUT", "OPT"]);
export const SEARCH_LIMIT_DEFAULT = 100;
export const SEARCH_LIMIT_MAX = 500;
const MAX_INPUT = 64;

const notFound = (detail) => new BridgeError("SYMBOL_NOT_FOUND", detail);
const invalid = (detail) => new BridgeError("VALIDATION_FAILED", detail);

const searchSchema = z
  .object({
    q: z.string().trim().min(1, "q is required.").max(64),
    exchange: z.enum(EXCHANGES).optional(),
    kind: z.enum(KINDS).optional(),
    underlying: z.string().trim().min(1).max(30).optional(),
    expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expiry must be YYYY-MM-DD.").optional(),
    limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).default(SEARCH_LIMIT_DEFAULT),
    cursor: z.string().max(512).optional(),
  })
  .strict();

/** Extract rows from an adapter's fetchInstruments result ({ status, data } or a bare array). */
export function masterRows(result, brokerId) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && Array.isArray(result.data)) return result.data;
  throw new BridgeError("UPSTREAM_ERROR", `${brokerId}: the instrument master came back in an unexpected shape.`, { broker: { id: brokerId } });
}

/** Public copy of a stored record (ResolvedInstrument). refs are omitted when `withRefs` is false. */
export function toResolved(rec, { withRefs = true } = {}) {
  const out = {
    canonical: rec.canonical,
    exchange: rec.exchange,
    kind: rec.kind,
    underlying: rec.underlying,
    expiry: rec.expiry,
    strike: rec.strike,
    right: rec.right,
    name: rec.name,
    lotSize: rec.lotSize,
    tickSize: rec.tickSize,
    freezeQty: rec.freezeQty,
    freezeQtySource: rec.freezeQtySource,
    isin: rec.isin,
  };
  if (withRefs) out.refs = Object.fromEntries(Object.entries(rec.refs).map(([b, r]) => [b, { ...r }]));
  return out;
}

function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  try {
    const obj = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (obj && obj.v === 1 && Number.isInteger(obj.o) && obj.o >= 0 && typeof obj.h === "string" && Number.isInteger(obj.b)) return obj;
  } catch {
    // fall through
  }
  throw invalid("The cursor is not valid. Start the search again without a cursor.");
}

/**
 * @param {object} deps  Core deps (config, logger, bus, clock, paths, brokers) plus accounts and scheduler.
 * @param {{ store?: ReturnType<typeof createInstrumentStore>, cache?: ReturnType<typeof createMasterCache> | null,
 *   settings?: Partial<typeof SYMBOLS_CONFIG_DEFAULTS> }} [opts]
 *   store: inject a pre-filled store (fake.mjs); cache: null disables the disk cache; settings override config.symbols.
 * @returns {object} SymbolService (contract methods plus warm() and close())
 */
export function createSymbolService(deps, opts = {}) {
  const settings = { ...SYMBOLS_CONFIG_DEFAULTS, ...(deps.config?.symbols ?? {}), ...(opts.settings ?? {}) };
  const log = deps.logger?.child ? deps.logger.child({ service: "symbols" }) : deps.logger;
  const clock = deps.clock ?? { now: () => Date.now() };
  const store = opts.store ?? createInstrumentStore();
  const cache =
    opts.cache !== undefined
      ? opts.cache
      : settings.diskCache && deps.paths?.dataDir
        ? createMasterCache({ dir: join(deps.paths.dataDir, "instruments"), logger: log })
        : null;

  /** broker -> { fetchedAt, lastError, lastAttemptAt, failedAt } */
  const brokerState = new Map();
  /** broker -> in-flight load promise (single flight per broker) */
  const inflight = new Map();
  const unsubscribers = [];
  let closed = false;

  const now = () => clock.now();
  const today = () => istDay(now());

  // ── Accounts: which brokers can supply a master ──

  /** broker -> connected, enabled account ids that declare "instruments", in config order. */
  function brokerSources() {
    const out = new Map();
    let list = [];
    try {
      if (deps.accounts && !isStub(deps.accounts)) list = deps.accounts.list();
    } catch (err) {
      log?.warn("account list unavailable", { code: err?.code });
    }
    for (const a of list) {
      if (!a || a.broker === "paper" || a.enabled === false) continue;
      if (a.session?.state !== "connected") continue;
      if (Array.isArray(a.capabilities) && !a.capabilities.includes("instruments")) continue;
      if (!out.has(a.broker)) out.set(a.broker, []);
      out.get(a.broker).push(a.id);
    }
    if (out.size) store.setBrokerOrder([...out.keys()]);
    return out;
  }

  function pickAccount(candidates) {
    if (candidates.length > 1 && deps.scheduler && !isStub(deps.scheduler)) {
      try {
        const picked = deps.scheduler.pickAccount({ candidates, endpointClass: "master" });
        if (picked && candidates.includes(picked)) return picked;
      } catch {
        // fall back to config order
      }
    }
    return candidates[0];
  }

  /** A copy is current when fetched today (IST) and not before the refresh time once that time has passed. */
  function isFresh(fetchedAt, at = now()) {
    if (!Number.isFinite(fetchedAt) || istDay(fetchedAt) !== istDay(at)) return false;
    const cutoff = istTimeOnDay(at, settings.refreshAfterIst);
    return at < cutoff || fetchedAt >= cutoff;
  }

  function install(broker, rows, fetchedAt, source) {
    const day = today();
    const st = store.setMaster(broker, rows, { loadedAt: toIstIso(fetchedAt), source, day }, day);
    brokerState.set(broker, { ...(brokerState.get(broker) ?? {}), fetchedAt, lastError: null, failedAt: null });
    log?.info("instrument master loaded", { broker, source, rows: st.rows, instruments: st.instruments, skipped: st.skipped, expired: st.expired });
    const conflicts = store.conflicts();
    if (conflicts.length) log?.warn("brokers disagree on lot sizes; using the first connected broker's figure", { count: conflicts.length, sample: conflicts.slice(0, 3) });
    return st;
  }

  /**
   * Load one broker's master: today's disk copy when current (unless forced), else a scheduled download.
   * Single flight per broker. Throws BridgeError on failure (the previous master, if any, stays in use).
   */
  function loadBroker(broker, { force = false } = {}) {
    const running = inflight.get(broker);
    if (running) return running;
    const p = (async () => {
      const day = today();
      let cached = null;
      if (cache) {
        cached = await cache.read(broker, day);
        if (!force && cached && isFresh(cached.fetchedAt)) return install(broker, cached.rows, cached.fetchedAt, "disk");
      }
      /** Record a failure; with no master in memory, fall back to today's older disk copy (same IST day only). */
      const fail = (e, accountId) => {
        if (cached && !store.hasMaster(broker)) install(broker, cached.rows, cached.fetchedAt, "disk");
        brokerState.set(broker, { ...(brokerState.get(broker) ?? {}), lastError: { code: e.code, message: e.detail }, failedAt: now() });
        log?.warn("instrument master download failed", { broker, accountId, code: e.code });
        return e;
      };
      const candidates = brokerSources().get(broker) ?? [];
      if (!candidates.length) {
        throw fail(new BridgeError("SESSION_EXPIRED", `No connected ${broker} account can supply the instrument master. Log in to the broker first.`), null);
      }
      const accountId = pickAccount(candidates);
      brokerState.set(broker, { ...(brokerState.get(broker) ?? {}), lastAttemptAt: now() });
      let rows;
      try {
        rows = await deps.scheduler.schedule({ accountId, endpointClass: "master", priority: "background", coalesceKey: `master:${broker}` }, async () => {
          const adapter = deps.accounts.adapter(accountId);
          if (typeof adapter?.fetchInstruments !== "function") throw new BridgeError("CAPABILITY_UNSUPPORTED", `${broker} does not publish an instrument master.`);
          const creds = await deps.accounts.creds(accountId);
          return masterRows(await adapter.fetchInstruments(creds), broker);
        });
      } catch (err) {
        throw fail(fromBrokerError(err, { brokerId: broker }), accountId);
      }
      const fetchedAt = now();
      const st = install(broker, rows, fetchedAt, "broker");
      if (cache) {
        try {
          await cache.write(broker, day, { rows, fetchedAt });
          await cache.prune(broker, day);
        } catch (err) {
          log?.warn("instrument cache write failed", { broker, code: err?.code });
        }
      }
      return st;
    })();
    inflight.set(broker, p);
    p.finally(() => inflight.delete(broker)).catch(() => {});
    return p;
  }

  const backingOff = (broker) => {
    const s = brokerState.get(broker);
    return Boolean(s?.failedAt && now() - s.failedAt < settings.failureBackoffMs);
  };

  /**
   * Make sure every connected broker's master is present: wait for missing ones (unless that broker failed moments
   * ago), refresh stale ones in the background. Never throws: missing data shows up as SYMBOL_NOT_FOUND.
   */
  async function ensureLoaded() {
    store.ensureDay(today());
    const waits = [];
    for (const broker of brokerSources().keys()) {
      if (inflight.has(broker)) {
        if (!store.hasMaster(broker)) waits.push(inflight.get(broker).catch(() => {}));
        continue;
      }
      if (backingOff(broker)) continue;
      if (!store.hasMaster(broker)) waits.push(loadBroker(broker).catch(() => {}));
      else if (!isFresh(brokerState.get(broker)?.fetchedAt)) loadBroker(broker).catch(() => {});
    }
    if (waits.length) await Promise.all(waits);
  }

  // ── Input forms -> canonical ──

  function checkInput(input) {
    if (typeof input !== "string" || !input.trim()) throw invalid("A symbol is required.");
    if (input.length > MAX_INPUT) throw invalid(`A symbol is at most ${MAX_INPUT} characters.`);
    return input.trim();
  }

  function checkBroker(broker) {
    if (broker === undefined || broker === null || broker === "") return null;
    if (typeof broker !== "string" || !deps.brokers?.has?.(broker)) throw invalid(`Unknown broker ${broker}.`);
    return broker;
  }

  /** Chart ticker -> canonical, resolving continuous futures (1!, 2!) against the master. */
  function fromChartTicker(input) {
    const ct = parseChartTicker(input);
    if (!ct.continuous) return ct.canonical;
    const expiries = store.futuresExpiries(ct.exchange, ct.underlying, today());
    const expiry = expiries[ct.continuous - 1];
    if (!expiry) throw notFound(`No ${ct.continuous === 1 ? "current" : `number ${ct.continuous}`} ${ct.underlying} future in the loaded instrument masters.`);
    return formatSymbol({ exchange: ct.exchange, underlying: ct.underlying, kind: "FUT", expiry });
  }

  /** Compact symbol: exchange from the argument, or written as "NFO:NIFTY27OCT2625000CE". */
  function fromCompact(input, exchange) {
    if (exchange) return parseCompact(input, exchange).canonical;
    const i = input.indexOf(":");
    if (i > 0) return parseCompact(input.slice(i + 1), input.slice(0, i)).canonical;
    throw invalid("Compact symbols need an exchange (for example exchange=NFO).");
  }

  /** Broker-native token or trading symbol -> canonical. */
  function fromBrokerNative(broker, input, exchange) {
    if (!broker) throw invalid("Give the broker whose token or trading symbol this is (broker=...).");
    if (!store.hasMaster(broker)) throw notFound(`The ${broker} instrument master is not loaded. Connect a ${broker} account first.`);
    const ex = exchange ? String(exchange).toUpperCase() : undefined;
    const lookup = (value, e) => [...new Set([...store.byToken(broker, value, e), ...store.byTradingSymbol(broker, value, e)])];
    let hits = lookup(input, ex);
    if (!hits.length && !ex) {
      const i = input.indexOf(":");
      const prefix = i > 0 ? input.slice(0, i).toUpperCase() : "";
      if (EXCHANGES.includes(prefix)) hits = lookup(input.slice(i + 1), prefix);
    }
    const day = today();
    hits = hits.filter((c) => store.get(c, day));
    if (hits.length > 1) throw invalid(`"${input}" matches ${hits.length} ${broker} instruments (${hits.slice(0, 3).join(", ")}). Add the exchange.`);
    if (!hits.length) throw notFound(`"${input}" is not in the ${broker} instrument master.`);
    return hits[0];
  }

  /**
   * Any accepted input -> canonical string. `from: "auto"` tries, in order: chart ticker, canonical/venue form,
   * compact, and (with a broker) broker-native, keeping the most useful error.
   */
  function toCanonical(rawInput, { from = "auto", broker = null, exchange } = {}) {
    const input = checkInput(rawInput);
    if (!FROM_FORMATS.includes(from)) throw invalid(`from must be one of ${FROM_FORMATS.join(", ")}.`);
    if (from === "canonical") return parseSymbol(input).canonical;
    if (from === "chart") return fromChartTicker(input);
    if (from === "compact") return fromCompact(input, exchange);
    if (from === "broker") return fromBrokerNative(broker, input, exchange);

    const fmt = detectFormat(input, exchange);
    const attempts = [];
    if (fmt === "chart") attempts.push(() => fromChartTicker(input));
    if (fmt === "canonical" && !exchange) attempts.push(() => parseSymbol(input).canonical);
    if (fmt === "compact" || exchange || input.includes(":")) attempts.push(() => fromCompact(input, exchange));
    if (fmt === "canonical" && exchange) attempts.push(() => parseSymbol(input).canonical);
    let firstError = null;
    for (const attempt of attempts) {
      try {
        const c = attempt();
        // A syntactically valid symbol the master does not know may still be a broker token ("NSE:2885").
        if (broker && store.hasMaster(broker) && !store.get(c, today())) {
          try {
            return fromBrokerNative(broker, input, exchange);
          } catch {
            return c;
          }
        }
        return c;
      } catch (err) {
        firstError ??= err;
      }
    }
    if (broker) return fromBrokerNative(broker, input, exchange);
    throw firstError ?? invalid(`"${input}" is not a symbol the Bridge understands. Examples: NSE:RELIANCE, NFO:NIFTY-2026-10-27-25000-CE, NSE:NIFTY1!.`);
  }

  /** Stored live record or a clear SYMBOL_NOT_FOUND (expired, unknown, no lot size, not at this broker). */
  function requireRecord(canonical, broker) {
    const day = today();
    const rec = store.get(canonical, day);
    if (!rec) {
      const parsed = parseSymbol(canonical);
      if (store.isExpired(canonical, day) || (parsed.expiry && parsed.expiry < day)) throw notFound(`${canonical} has expired.`);
      if (!store.brokers().length) throw notFound(`${canonical} could not be checked: no broker instrument master is loaded yet. Connect a broker account.`);
      throw notFound(`${canonical} is not in any connected broker's instrument master. Try /v1/instruments/search.`);
    }
    if (rec.lotSize === null || rec.tickSize === null) throw notFound(`${canonical}: no connected broker publishes its lot size and tick size, so it cannot be used.`);
    if (broker && !rec.refs[broker]) throw notFound(`${canonical} is not in the ${broker} instrument master.`);
    return rec;
  }

  // ── Aliases ──

  function aliasesFor(canonical, rec, broker) {
    const p = parseSymbol(canonical);
    const kind = rec?.kind ?? p.kind;
    const aliases = {};
    if (kind === "FUT") {
      const expiries = store.futuresExpiries(p.exchange, p.underlying, today());
      const i = expiries.indexOf(p.expiry);
      const venue = p.exchange === "NFO" ? "NSE" : p.exchange === "BFO" ? "BSE" : p.exchange;
      aliases.chart = i >= 0 && i < 2 ? `${venue}:${p.underlying}${i + 1}!` : null;
    } else {
      aliases.chart = toChartTicker(canonical);
    }
    if (kind === "INDEX") {
      aliases.compact = p.underlying;
      aliases.compactExchange = `${p.exchange}_INDEX`;
    } else if (kind === "EQ") {
      aliases.compact = p.underlying;
      aliases.compactExchange = p.exchange;
    } else {
      const oa = toCompact(canonical);
      aliases.compact = oa.symbol;
      aliases.compactExchange = oa.exchange;
    }
    const brokers = broker ? [broker] : Object.keys(rec?.refs ?? {}).sort();
    for (const b of brokers) {
      const ref = rec?.refs?.[b] ?? null;
      aliases[`broker:${b}`] = ref ? (ref.tradingSymbol ?? ref.token) : null;
      aliases[`broker:${b}:token`] = ref ? ref.token : null;
    }
    return aliases;
  }

  // ── Bus: load a broker's master as soon as one of its accounts connects ──

  if (deps.bus?.on) {
    unsubscribers.push(
      deps.bus.on("account.status", (evt) => {
        if (closed || evt?.session !== "connected" || !evt.broker || evt.broker === "paper") return;
        const broker = evt.broker;
        if (store.hasMaster(broker) && isFresh(brokerState.get(broker)?.fetchedAt)) return;
        setImmediate(() => {
          if (!closed && !backingOff(broker)) loadBroker(broker).catch(() => {});
        });
      }),
    );
  }

  // ── Contract ──

  const service = {
    /**
     * Parse without data: canonical, venue form or a dated chart ticker. Continuous futures need resolve().
     * @param {string} input
     * @returns {import("../core/contracts.mjs").ParsedSymbol}
     */
    parse(input) {
      const s = checkInput(input);
      if (detectFormat(s) === "chart") {
        const ct = parseChartTicker(s);
        if (ct.canonical) return parseSymbol(ct.canonical);
        throw invalid(`${s} is a continuous future; resolve it to get a contract.`);
      }
      return parseSymbol(s);
    },

    /** @param {object} parts @returns {string} canonical symbol */
    format(parts) {
      return formatSymbol(parts);
    },

    /**
     * @param {string} input any accepted form
     * @param {{ broker?: string, exchange?: string, from?: string }} [options]
     *   broker: require that broker's ref (and accept its native tokens/trading symbols); exchange: for compact
     *   or broker-native input; from: force one input format.
     * @returns {Promise<import("../core/contracts.mjs").ResolvedInstrument>}
     */
    async resolve(input, options = {}) {
      const broker = checkBroker(options.broker);
      checkInput(input);
      await ensureLoaded();
      const canonical = toCanonical(input, { from: options.from ?? "auto", broker, exchange: options.exchange });
      return toResolved(requireRecord(canonical, broker));
    },

    /** @returns {Promise<import("../core/contracts.mjs").BrokerRef>} */
    async toBroker(symbol, brokerId) {
      const broker = checkBroker(brokerId);
      if (!broker) throw invalid("A broker id is required.");
      const rec = await service.resolve(symbol, { broker });
      return { ...rec.refs[broker] };
    },

    /** @returns {Promise<string | null>} canonical symbol, or null when unknown, ambiguous or expired */
    async fromBroker(brokerId, ref) {
      const broker = checkBroker(brokerId);
      if (!broker) throw invalid("A broker id is required.");
      if (!ref || ref.token === undefined || ref.token === null || ref.token === "") throw invalid("A broker token is required.");
      await ensureLoaded();
      const day = today();
      const hits = store.byToken(broker, String(ref.token), ref.exchange).filter((c) => store.get(c, day));
      return hits.length === 1 ? hits[0] : null;
    },

    /**
     * Ranked search: exact symbol first, then exact underlying, prefix, substring and fuzzy name matches; inside a
     * name, spot before futures before options, nearest expiry first.
     * @param {{ q: string, exchange?: string, kind?: string, underlying?: string, expiry?: string, limit?: number, cursor?: string }} params
     * @returns {Promise<{ items: object[], nextCursor: string | null }>}
     */
    async search(params) {
      const parsed = searchSchema.safeParse(params ?? {});
      if (!parsed.success) throw fromValidation(parsed.error);
      const { limit, cursor, ...query } = parsed.data;
      await ensureLoaded();
      const hash = createHash("sha256")
        .update(JSON.stringify([query.q.toUpperCase(), query.exchange, query.kind, query.underlying?.toUpperCase(), query.expiry, limit]))
        .digest("base64url")
        .slice(0, 16);
      let offset = 0;
      if (cursor) {
        const c = decodeCursor(cursor);
        if (c.h !== hash) throw invalid("This cursor belongs to a different search.");
        if (c.b !== store.version()) throw invalid("The instrument list was refreshed since this cursor was issued. Start the search again.");
        offset = c.o;
      }
      let exact = null;
      try {
        exact = toCanonical(query.q, {});
      } catch {
        exact = null;
      }
      const all = store.search({ ...query, exact }, today());
      const page = all.slice(offset, offset + limit);
      const next = offset + limit < all.length ? encodeCursor({ v: 1, h: hash, b: store.version(), o: offset + limit }) : null;
      return { items: page.map((r) => toResolved(r, { withRefs: false })), nextCursor: next };
    },

    /**
     * @param {{ input: string, from?: string, broker?: string, exchange?: string }} req
     * @returns {Promise<{ input: string, canonical: string, aliases: Record<string, string | null> }>}
     */
    async convert(req) {
      if (!req || typeof req !== "object") throw invalid("Send { input, from?, broker?, exchange? }.");
      const broker = checkBroker(req.broker);
      const input = checkInput(req.input);
      if (req.exchange !== undefined && req.exchange !== null && (typeof req.exchange !== "string" || req.exchange.length > 12)) {
        throw invalid("exchange is at most 12 characters.");
      }
      await ensureLoaded();
      const canonical = toCanonical(input, { from: req.from ?? "auto", broker, exchange: req.exchange || undefined });
      const rec = store.get(canonical, today());
      return { input, canonical, aliases: aliasesFor(canonical, rec, broker) };
    },

    /**
     * Download masters again (bypassing today's disk copy).
     * @param {{ broker?: string }} [options]
     * @returns {Promise<{ brokers: string[], instruments: number, errors: Array<{ broker: string, code: string, message: string }> }>}
     */
    async refresh(options = {}) {
      const only = checkBroker(options.broker);
      const targets = only ? [only] : [...brokerSources().keys()];
      const results = await Promise.allSettled(targets.map((b) => loadBroker(b, { force: true })));
      const brokers = [];
      const errors = [];
      results.forEach((r, i) => {
        if (r.status === "fulfilled") brokers.push(targets[i]);
        else errors.push({ broker: targets[i], code: r.reason?.code ?? "INTERNAL", message: r.reason?.detail ?? "Download failed." });
      });
      if (only && errors.length) throw results[0].reason;
      return { brokers, instruments: store.size(), errors };
    },

    /** Loaded masters and their health. Synchronous. */
    status() {
      const stats = new Map(store.stats().map((s) => [s.broker, s]));
      const names = new Set([...stats.keys(), ...brokerState.keys()]);
      const brokers = [...names].sort().map((broker) => {
        const s = stats.get(broker);
        const st = brokerState.get(broker);
        return {
          broker,
          instruments: s?.instruments ?? 0,
          loadedAt: s?.loadedAt ?? null,
          source: s?.source ?? null,
          day: s?.day ?? null,
          rows: s?.rows ?? 0,
          skipped: s?.skipped ?? 0,
          expired: s?.expired ?? 0,
          fresh: st?.fetchedAt ? isFresh(st.fetchedAt) : false,
          loading: inflight.has(broker),
          lastError: st?.lastError ?? null,
        };
      });
      return {
        brokers,
        instruments: store.size(),
        conflicts: store.conflicts().length,
        refreshAfterIst: settings.refreshAfterIst,
        freezeList: { asOf: FREEZE_LIST_AS_OF, verified: false },
      };
    },

    /** Load every connected broker's master (module start()). Never throws. */
    async warm() {
      await ensureLoaded();
      return service.status();
    },

    /** Stop listening to the bus (module stop()). */
    close() {
      closed = true;
      for (const off of unsubscribers.splice(0)) off();
    },
  };
  return service;
}
