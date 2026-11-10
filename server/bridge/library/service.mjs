/**
 * LibraryService: named, tagged collections of instruments, and option universes that are worked out when they are used.
 * The contract (core/contracts.mjs `library`) is what downloads, the recorder, the Excel and Sheets routes and the Python
 * library call:
 *
 *   list({ tag?, kind?, q? })               -> summaries (no symbol lists)
 *   get(nameOrId)                           -> the full collection; throws NOT_FOUND. A name the collection had before a rename still finds it.
 *   resolve(nameOrId, opts?)                -> Promise<{ id, name, kind, resolvedAt, rule, symbols, count, atmSource, underlying, expiries, strikeSource, warnings }>
 *        opts: { spot?, allowStale?, requireLive?, priority?, signal?, accountId?, allowedAccounts? }  (see resolver.mjs)
 *        A static collection answers its list; an option universe is computed now. A caller that is about to download or record
 *        calls resolve at that moment, never earlier: the expiry rolls and the ATM moves.
 *   estimate(nameOrId, intervals, days, opts?) -> Promise<{ symbols, rows, bytes, brokerCalls, ... }>   (estimate.mjs)
 *
 * Extras: create, update, remove, duplicate, exportData, importData, usage, registerUsageProvider, status.
 *
 * Usage view: a module that keeps things made from a collection (downloads, recordings, auto-record rules, datasets) registers
 * a provider:  library.registerUsageProvider("downloads", ({ id, name, names }) => [{ id, label, status, active }]).
 * `names` is the name plus any earlier names. An item with `active: true` stops the collection being deleted without `force`.
 *
 * Emits the bus topic `collection.changed` { action, id, name, from?, kind, tags } on every write.
 */
import { BridgeError } from "../core/errors.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { createCalendar, istDateOf } from "../reference/calendar.mjs";
import { shippedHolidayRows, shippedSpecialSessions } from "../reference/shipped.mjs";
import { parseLibraryConfig } from "./config.mjs";
import { estimateSize, parseDays, parseIntervals } from "./estimate.mjs";
import { collectionsFromJson, symbolsFromCsv, symbolsToCsv, toExportJson } from "./interchange.mjs";
import { createResolver } from "./resolver.mjs";
import { checkName, parseCreate, parsePatch } from "./schema.mjs";
import { createCollectionStore } from "./store.mjs";
import { filterByTags } from "./tags.mjs";

const USAGE_KINDS = Object.freeze(["downloads", "recordings", "rules", "datasets"]);

/** Public view of a stored record. `full` adds the symbol list. */
function view(rec, { full = true, via } = {}) {
  const out = {
    id: rec.id,
    name: rec.name,
    description: rec.description,
    tags: [...rec.tags],
    kind: rec.kind,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    previousNames: [...rec.previousNames],
  };
  if (rec.kind === "static") {
    out.symbolCount = rec.symbols.length;
    if (full) out.symbols = [...rec.symbols];
  } else {
    out.symbolCount = null;
    out.universe = structuredClone(rec.universe);
  }
  if (via === "previous-name") out.viaOldName = true;
  return out;
}

/**
 * @param {{ config: any, logger?: any, bus?: any, clock?: { now(): number }, paths?: { dataDir?: string }, marketData: any, symbols: any }} deps
 * @param {{ now?: () => number, calendar?: any, dataDir?: string }} [opts]  tests
 */
export function createLibraryService(deps, opts = {}) {
  const cfg = parseLibraryConfig(deps.config?.library);
  const now = opts.now ?? (() => (deps.clock?.now ? deps.clock.now() : Date.now()));
  const dataDir = opts.dataDir ?? deps.config?.dataDir ?? deps.paths?.dataDir;
  const cal = opts.calendar ?? createCalendar({ holidays: shippedHolidayRows(), specialSessions: shippedSpecialSessions() });
  const store = createCollectionStore({ dataDir, logger: deps.logger, now });
  const resolver = createResolver({ deps, cfg, cal, now });
  /** @type {Map<string, Function>} */
  const providers = new Map();
  const lastResolved = new Map();

  const emit = (payload) => {
    try {
      deps.bus?.emit("collection.changed", payload);
    } catch {
      /* an event that nobody can take must never fail a write */
    }
  };
  const changed = (action, rec, extra = {}) => emit({ action, id: rec.id, name: rec.name, kind: rec.kind, tags: [...rec.tags], ...extra });

  function ensureOn() {
    if (!cfg.enabled) throw new BridgeError("CAPABILITY_UNSUPPORTED", "The collection library is switched off (library.enabled is false in the config).");
  }

  function find(key) {
    ensureOn();
    const k = typeof key === "string" ? key.trim() : "";
    const hit = k ? store.find(k) : null;
    if (!hit) throw new BridgeError("NOT_FOUND", `There is no collection called "${String(key).slice(0, 64)}". List them with GET /v1/collections.`);
    return hit;
  }

  function ensureRoom() {
    if (store.size() >= cfg.maxCollections) throw new BridgeError("VALIDATION_FAILED", `The library holds at most ${cfg.maxCollections} collections (library.maxCollections). Delete one first.`, { errors: [{ path: "name", message: "library is full" }] });
  }
  function ensureFree(name, exceptId = null) {
    if (store.nameTaken(name, exceptId)) throw new BridgeError("STATE_CONFLICT", `A collection called "${name}" already exists (names are not case-sensitive). Choose another name, or change the existing one.`);
  }

  async function usageOf(rec) {
    const names = [rec.name, ...rec.previousNames];
    const out = {};
    const sources = {};
    for (const kind of USAGE_KINDS) {
      const fn = providers.get(kind);
      sources[kind] = fn ? "available" : "not-available";
      if (!fn) {
        out[kind] = [];
        continue;
      }
      try {
        const rows = await fn({ id: rec.id, name: rec.name, names });
        out[kind] = (Array.isArray(rows) ? rows : []).map((r) => ({ ...r }));
      } catch (err) {
        deps.logger?.warn?.("collection usage provider failed", { kind, err: err?.message });
        out[kind] = [];
        sources[kind] = "error";
      }
    }
    return { out, sources };
  }

  const service = {
    list({ tag, kind, q } = {}) {
      ensureOn();
      let rows = store.list();
      if (kind) rows = rows.filter((r) => r.kind === kind);
      if (q) {
        const needle = String(q).toLowerCase();
        rows = rows.filter((r) => r.name.toLowerCase().includes(needle) || r.description.toLowerCase().includes(needle) || r.tags.some((t) => t.includes(needle)));
      }
      if (tag) rows = filterByTags(rows, tag);
      return rows.map((r) => view(r, { full: false }));
    },

    get(key) {
      const { record, via } = find(key);
      return view(record, { full: true, via });
    },

    create(body) {
      ensureOn();
      const def = parseCreate(body, { maxSymbols: cfg.maxSymbols });
      ensureRoom();
      ensureFree(def.name);
      const rec = store.add(def);
      changed("created", rec);
      return view(rec);
    },

    update(key, body) {
      const { record } = find(key);
      const patch = parsePatch(body, record, { maxSymbols: cfg.maxSymbols });
      if (patch.name !== undefined) ensureFree(patch.name, record.id);
      const { record: next, renamedFrom } = store.update(record.id, patch);
      changed(renamedFrom ? "renamed" : "updated", next, renamedFrom ? { from: renamedFrom } : {});
      return view(next);
    },

    async remove(key, { force = false } = {}) {
      const { record } = find(key);
      if (!force) {
        const { out } = await usageOf(record);
        const active = USAGE_KINDS.flatMap((k) => out[k].filter((r) => r.active === true).map((r) => `${k.replace(/s$/, "")} ${r.label ?? r.id}`));
        if (active.length) {
          throw new BridgeError("STATE_CONFLICT", `"${record.name}" is in use by ${active.slice(0, 5).join(", ")}${active.length > 5 ? ` and ${active.length - 5} more` : ""}. Stop them first, or delete it anyway with force=true.`);
        }
      }
      store.remove(record.id);
      lastResolved.delete(record.id);
      changed("deleted", record);
      return view(record, { full: false });
    },

    duplicate(key, newName) {
      const { record } = find(key);
      ensureRoom();
      let name;
      if (newName !== undefined && newName !== null && newName !== "") {
        name = checkName(newName);
        ensureFree(name);
      } else {
        const base = record.name.slice(0, 58);
        name = `${base}-copy`;
        for (let i = 2; store.nameTaken(name); i += 1) name = `${base}-copy${i}`;
      }
      const fields = { name, description: record.description, tags: [...record.tags], kind: record.kind };
      if (record.kind === "static") fields.symbols = [...record.symbols];
      else fields.universe = structuredClone(record.universe);
      const rec = store.add(fields);
      changed("created", rec, { from: record.name });
      return view(rec);
    },

    /** The concrete symbols for now. */
    async resolve(key, o = {}) {
      const { record, via } = find(key);
      const base = { id: record.id, name: record.name, kind: record.kind, resolvedAt: new Date(now()).toISOString(), ...(via === "previous-name" ? { viaOldName: true } : {}) };
      let result;
      if (record.kind === "static") {
        const warnings = [];
        const today = istDateOf(now());
        const expired = record.symbols.filter((s) => {
          const e = parseSymbol(s).expiry;
          return e && e < today;
        });
        if (expired.length) warnings.push(`${expired.length} contract${expired.length === 1 ? " has" : "s have"} already expired (for example ${expired[0]}). They are kept; remove them if you do not need them.`);
        if (via === "previous-name") warnings.push(`This collection was renamed; "${key}" is its old name. Use "${record.name}".`);
        result = { ...base, rule: "a fixed list of symbols", symbols: [...record.symbols], count: record.symbols.length, atmSource: "not-needed", warnings };
      } else {
        const r = await resolver.resolveUniverse(record.universe, o);
        const warnings = [...r.warnings];
        if (via === "previous-name") warnings.push(`This collection was renamed; "${key}" is its old name. Use "${record.name}".`);
        result = { ...base, rule: r.rule, symbols: r.symbols, count: r.symbols.length, atmSource: r.atmSource, strikeSource: r.strikeSource, underlying: r.underlying, expiries: r.expiries, warnings };
      }
      lastResolved.set(record.id, result.resolvedAt);
      return result;
    },

    /** symbols x intervals x days. A universe is resolved first (a stale price is allowed for a count, and is labelled). */
    async estimate(key, intervals, days, o = {}) {
      const list = parseIntervals(intervals);
      const n = parseDays(days);
      const r = await service.resolve(key, { allowStale: true, ...o });
      const est = estimateSize({ symbols: r.count, intervals: list, days: n, nowMs: now(), cal });
      return { name: r.name, id: r.id, kind: r.kind, resolvedAt: r.resolvedAt, atmSource: r.atmSource, ...est, warnings: r.warnings };
    },

    /** A file for a collection. CSV is the symbols (a universe: as resolved now); JSON is the definition (or the resolved list with resolved: true). */
    async exportData(key, { format = "json", resolved = false, resolve: ro = {} } = {}) {
      const { record } = find(key);
      const safe = record.name.replace(/[^A-Za-z0-9._-]/g, "_");
      if (format === "csv") {
        const r = await service.resolve(record.id, { allowStale: true, ...ro });
        return { contentType: "text/csv; charset=utf-8", filename: `${safe}.csv`, body: symbolsToCsv(r.symbols), resolvedAt: r.resolvedAt, warnings: r.warnings };
      }
      if (format !== "json") throw new BridgeError("VALIDATION_FAILED", "format must be csv or json.", { errors: [{ path: "format", message: "csv or json" }] });
      const v = view(record);
      if (resolved && record.kind === "option-universe") {
        const r = await service.resolve(record.id, { allowStale: true, ...ro });
        const file = toExportJson({ ...v, kind: "static", symbols: r.symbols }, { now: now() });
        return { contentType: "application/json; charset=utf-8", filename: `${safe}.json`, body: JSON.stringify(file, null, 2), resolvedAt: r.resolvedAt, warnings: r.warnings };
      }
      return { contentType: "application/json; charset=utf-8", filename: `${safe}.json`, body: JSON.stringify(toExportJson(v, { now: now() }), null, 2), warnings: [] };
    },

    /**
     * Make collections from CSV or JSON text (or a parsed object).
     * @param {{ data: string | object, format?: "csv"|"json", name?: string, description?: string, tags?: string[], replace?: boolean, skipInvalid?: boolean }} p
     */
    importData({ data, format, name, description, tags, replace = false, skipInvalid = false }) {
      ensureOn();
      let fmt = format;
      if (fmt === undefined) fmt = typeof data === "string" && !/^\s*[[{]/.test(data) ? "csv" : "json";
      const bodies = [];
      const warnings = [];
      if (fmt === "csv") {
        if (typeof data !== "string") throw new BridgeError("VALIDATION_FAILED", "CSV import needs the CSV text.");
        if (!name) throw new BridgeError("VALIDATION_FAILED", "Say what to call the collection: name=<name>.", { errors: [{ path: "name", message: "required for a CSV import" }] });
        const { values, line } = symbolsFromCsv(data);
        const good = [];
        const bad = [];
        values.forEach((v, i) => {
          try {
            good.push(parseSymbol(v).canonical);
          } catch (err) {
            bad.push({ line: line[i], value: v.slice(0, 40), reason: err?.detail ?? "not a symbol" });
          }
        });
        if (bad.length && !skipInvalid) {
          throw new BridgeError("VALIDATION_FAILED", `${bad.length} line${bad.length === 1 ? " is" : "s are"} not a symbol the Bridge understands (first: line ${bad[0].line}, "${bad[0].value}"). Fix them, or import the rest with skipInvalid=true.`, {
            errors: bad.slice(0, 20).map((b) => ({ path: `line ${b.line}`, message: `${b.value}: ${b.reason}` })),
          });
        }
        if (bad.length) warnings.push(`${bad.length} line${bad.length === 1 ? " was" : "s were"} skipped: ${bad.slice(0, 5).map((b) => `line ${b.line} "${b.value}"`).join(", ")}${bad.length > 5 ? ", ..." : ""}.`);
        bodies.push({ name, description, tags, kind: "static", symbols: good });
      } else if (fmt === "json") {
        let parsed = data;
        if (typeof data === "string") {
          try {
            parsed = JSON.parse(data);
          } catch {
            throw new BridgeError("INVALID_JSON", "The text could not be parsed as JSON.");
          }
        }
        bodies.push(...collectionsFromJson(parsed, { name, description, tags }));
      } else throw new BridgeError("VALIDATION_FAILED", "format must be csv or json.", { errors: [{ path: "format", message: "csv or json" }] });

      // Check everything first, write after: a bad entry in a file of ten imports nothing.
      const defs = bodies.map((b) => parseCreate(b, { maxSymbols: cfg.maxSymbols }));
      const seen = new Set();
      for (const d of defs) {
        const k = d.name.toLowerCase();
        if (seen.has(k)) throw new BridgeError("VALIDATION_FAILED", `The file has two collections called "${d.name}".`, { errors: [{ path: "name", message: "duplicate name in the file" }] });
        seen.add(k);
        if (!replace && store.nameTaken(d.name)) throw new BridgeError("STATE_CONFLICT", `A collection called "${d.name}" already exists. Import with another name, or replace it with replace=true.`);
      }
      const fresh = defs.filter((d) => !store.nameTaken(d.name)).length;
      if (store.size() + fresh > cfg.maxCollections) throw new BridgeError("VALIDATION_FAILED", `The library holds at most ${cfg.maxCollections} collections (library.maxCollections).`);
      const created = [];
      const replaced = [];
      for (const d of defs) {
        const existing = store.find(d.name);
        if (existing && existing.via === "name") {
          // A replaced collection may change kind: the other kind's field must not survive.
          const { record } = store.update(existing.record.id, { ...d, symbols: d.symbols, universe: d.universe });
          replaced.push(view(record, { full: false }));
          changed("updated", record, { imported: true });
        } else {
          const rec = store.add(d);
          created.push(view(rec, { full: false }));
          changed("created", rec, { imported: true });
        }
      }
      return { created, replaced, warnings };
    },

    /** What is made from a collection. */
    async usage(key) {
      const { record } = find(key);
      const { out, sources } = await usageOf(record);
      const total = USAGE_KINDS.reduce((s, k) => s + out[k].length, 0);
      return {
        id: record.id,
        name: record.name,
        lastResolvedAt: lastResolved.get(record.id) ?? null,
        ...out,
        total,
        sources,
        note: Object.values(sources).includes("not-available") ? "A kind marked not-available is kept by a part of the Bridge that is switched off or not installed, so none of it is counted." : null,
      };
    },

    /** A module that keeps things made from collections tells the library how to find them (see the top of this file). */
    registerUsageProvider(kind, fn) {
      if (!USAGE_KINDS.includes(kind)) throw new Error(`usage kind must be one of ${USAGE_KINDS.join(", ")}`);
      if (typeof fn !== "function") throw new TypeError("a usage provider is a function");
      providers.set(kind, fn);
      return () => providers.delete(kind);
    },

    status() {
      return { enabled: cfg.enabled, collections: store.size(), file: store.file, loadedFrom: store.loadedFrom, maxCollections: cfg.maxCollections, maxSymbols: cfg.maxSymbols };
    },
  };
  return service;
}
