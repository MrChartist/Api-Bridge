/**
 * Saved watchlists with live quotes — stream S15. Replaces the browser-side lists of the retired OptionsDesk and
 * india-s-best-option-hub Watchlist pages: the lists live with the Bridge, per key, and the quotes come from the
 * Bridge's own market data.
 *
 *   GET    /v1/analytics/watchlists                       the caller's lists (the default list is created on first use)
 *   POST   /v1/analytics/watchlists                       create { name, symbols[<=100] }
 *   PUT    /v1/analytics/watchlists/:listId               rename and/or replace symbols, or add / remove some
 *   DELETE /v1/analytics/watchlists/:listId               remove a list
 *   GET    /v1/analytics/watchlists/:listId/quotes        ltp, change, changePct, volume, oi, dayHigh, dayLow per symbol
 *
 * Symbols go through core/symbolFormat.mjs parseSymbol; a bare name (NIFTY, RELIANCE) is read as NSE:NAME, or BSE:NAME
 * for the BSE indices. Lists are de-duplicated, at most 100 symbols each and 20 lists per key. A list belongs to the
 * key that made it (the local operator and admin keys see all). Saved atomically with mode 0600 to
 * <dataDir>/analytics/watchlists.json; a write that fails is rolled back and answered as INTERNAL. Quotes are read with
 * marketData.quotes in chunks of 50; a symbol that fails comes back in `errors` and never fails the call. Read scope
 * only: nothing here can place an order.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../auth/fsUtil.mjs";
import { BridgeError, fromValidation } from "../core/errors.mjs";
import { json } from "../core/http.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { defaultOptionExchange } from "../market/chain.mjs";
import { autoBackupFor, readOptionsBase } from "../market/routes.mjs";

export const MAX_SYMBOLS_PER_LIST = 100;
export const MAX_LISTS_PER_KEY = 20;
export const QUOTE_CHUNK = 50;
export const DEFAULT_LIST_NAME = "Index & F&O leaders";
export const DEFAULT_SYMBOLS = Object.freeze([
  "NSE:NIFTY", "NSE:BANKNIFTY", "NSE:FINNIFTY", "BSE:SENSEX",
  "NSE:RELIANCE", "NSE:HDFCBANK", "NSE:ICICIBANK", "NSE:INFY", "NSE:TCS", "NSE:SBIN", "NSE:AXISBANK", "NSE:LT", "NSE:BHARTIARTL", "NSE:ITC",
]);

const name = z.string().trim().min(1).max(80);
const symbols = z.array(z.string()).max(MAX_SYMBOLS_PER_LIST);
const createSchema = z.object({ name, symbols: symbols.default([]) }).strict();
const updateSchema = z
  .object({ name: name.optional(), symbols: symbols.optional(), add: z.array(z.string()).max(MAX_SYMBOLS_PER_LIST).optional(), remove: z.array(z.string()).max(MAX_SYMBOLS_PER_LIST).optional() })
  .strict()
  .superRefine((u, ctx) => {
    if (u.name === undefined && u.symbols === undefined && u.add === undefined && u.remove === undefined) ctx.addIssue({ code: "custom", path: [], message: "Give name, symbols, add or remove." });
    if (u.symbols !== undefined && (u.add !== undefined || u.remove !== undefined)) ctx.addIssue({ code: "custom", path: ["symbols"], message: "symbols replaces the list; do not combine it with add or remove." });
  });

const invalid = (path, message) => new BridgeError("VALIDATION_FAILED", message, { errors: [{ path, message }] });

/** Canonical symbol for user input, or a VALIDATION_FAILED naming the field and position. */
export function normaliseSymbol(input, path) {
  const raw = String(input ?? "").trim();
  const withVenue = raw && !raw.includes(":") ? `${defaultOptionExchange(raw.toUpperCase()) === "BFO" ? "BSE" : "NSE"}:${raw}` : raw;
  try {
    return parseSymbol(withVenue).canonical;
  } catch (err) {
    throw invalid(path, err?.detail ?? `"${raw}" is not a Bridge symbol.`);
  }
}

/** Canonical, de-duplicated, order kept. */
function normaliseAll(list, path) {
  const out = [];
  const seen = new Set();
  list.forEach((s, i) => {
    const c = normaliseSymbol(s, `${path}.${i}`);
    if (!seen.has(c)) (seen.add(c), out.push(c));
  });
  return out;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const newId = () => `wl_${randomBytes(8).toString("hex")}`;
const LOCAL = "local";

/**
 * The store. State is { lists, seeded } where seeded names the owners that already got the default list (so a
 * deleted default does not come back).
 * @param {{ clock: { now(): number }, paths?: { dataDir: string }, logger?: object }} deps
 */
export function createWatchlists(deps) {
  const log = deps.logger?.child ? deps.logger.child({ module: "watchlists" }) : deps.logger;
  const iso = () => new Date(deps.clock?.now ? deps.clock.now() : Date.now()).toISOString();
  const filePath = deps.paths?.dataDir ? join(deps.paths.dataDir, "analytics", "watchlists.json") : null;

  function load() {
    if (!filePath || !existsSync(filePath)) return { lists: [], seeded: [] };
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8"));
      const lists = (Array.isArray(raw?.lists) ? raw.lists : []).filter((l) => l && typeof l.id === "string" && typeof l.name === "string" && Array.isArray(l.symbols));
      return { lists, seeded: Array.isArray(raw?.seeded) ? raw.seeded.filter((s) => typeof s === "string") : [] };
    } catch (err) {
      log?.warn?.("could not read watchlists; starting with none", { err: err?.message });
      return { lists: [], seeded: [] };
    }
  }
  let state = load();

  /** Run `mutate` on a copy-safe state; if the disk write fails, put everything back and answer INTERNAL. */
  function commit(mutate, failure) {
    const before = structuredClone(state);
    try {
      const result = mutate();
      if (filePath) writeFileAtomic(filePath, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`);
      return result;
    } catch (err) {
      state = before;
      if (err instanceof BridgeError) throw err;
      log?.warn?.("could not save watchlists", { err: err?.message });
      throw new BridgeError("INTERNAL", failure);
    }
  }

  const ownerOf = (who) => who.keyId ?? null;
  const seedKey = (who) => who.keyId ?? LOCAL;
  const countFor = (who) => state.lists.filter((l) => (l.keyId ?? null) === ownerOf(who)).length;

  const api = {
    list: () => state.lists.map((l) => structuredClone(l)),
    get: (id) => state.lists.find((l) => l.id === id) ?? null,
    /** Give this owner the default list the first time they use watchlists. */
    ensureSeeded(who) {
      if (state.seeded.includes(seedKey(who))) return;
      commit(() => {
        state.seeded.push(seedKey(who));
        const t = iso();
        state.lists.push({ id: newId(), keyId: ownerOf(who), name: DEFAULT_LIST_NAME, symbols: [...DEFAULT_SYMBOLS], isDefault: true, createdAt: t, updatedAt: t });
      }, "The default watchlist could not be saved to disk.");
    },
    create(input, who = {}) {
      const p = createSchema.safeParse(input ?? {});
      if (!p.success) throw fromValidation(p.error);
      const syms = normaliseAll(p.data.symbols, "symbols");
      return commit(() => {
        if (countFor(who) >= MAX_LISTS_PER_KEY) throw invalid("name", `At most ${MAX_LISTS_PER_KEY} watchlists.`);
        const t = iso();
        const list = { id: newId(), keyId: ownerOf(who), name: p.data.name, symbols: syms, createdAt: t, updatedAt: t };
        state.lists.push(list);
        return structuredClone(list);
      }, "The watchlist could not be saved to disk.");
    },
    update(id, input) {
      const p = updateSchema.safeParse(input ?? {});
      if (!p.success) throw fromValidation(p.error);
      const u = p.data;
      const replace = u.symbols !== undefined ? normaliseAll(u.symbols, "symbols") : null;
      const add = u.add ? normaliseAll(u.add, "add") : [];
      const remove = new Set(u.remove ? normaliseAll(u.remove, "remove") : []);
      return commit(() => {
        const list = api.get(id);
        if (!list) throw new BridgeError("NOT_FOUND", `No watchlist ${id}.`);
        let next = replace ?? list.symbols.filter((s) => !remove.has(s));
        if (!replace) for (const s of add) if (!next.includes(s)) next.push(s);
        if (next.length > MAX_SYMBOLS_PER_LIST) throw invalid("symbols", `A watchlist holds at most ${MAX_SYMBOLS_PER_LIST} symbols.`);
        if (u.name !== undefined) list.name = u.name;
        list.symbols = next;
        list.updatedAt = iso();
        return structuredClone(list);
      }, "The watchlist could not be saved to disk, so it was left as it was.");
    },
    remove(id) {
      return commit(() => {
        const i = state.lists.findIndex((l) => l.id === id);
        if (i < 0) throw new BridgeError("NOT_FOUND", `No watchlist ${id}.`);
        return state.lists.splice(i, 1)[0];
      }, "The watchlist could not be removed from disk, so it was kept.");
    },
  };
  return api;
}

const services = new WeakMap();
/** The one watchlist store for these deps. */
export function watchlistsFor(deps) {
  let s = services.get(deps);
  if (!s) services.set(deps, (s = createWatchlists(deps)));
  return s;
}

const seesAll = (ctx) => ctx.principal?.kind === "local" || ctx.scopes?.has?.("admin");
// A list with no keyId belongs to the local owner; a caller with no key must not match it by both being null.
const owns = (ctx, rec) => seesAll(ctx) || (rec.keyId != null && rec.keyId === ctx.key?.id);
const who = (ctx) => ({ keyId: ctx.key?.id ?? null });
const view = ({ keyId: _k, ...l }) => l;

const quoteRow = (q) => ({
  symbol: q.symbol,
  ltp: num(q.ltp),
  change: num(q.change),
  changePct: num(q.changePct),
  volume: num(q.volume),
  oi: num(q.oi),
  dayHigh: num(q.high),
  dayLow: num(q.low),
  open: num(q.open),
  prevClose: num(q.close),
});

/** The error entry for a failed chunk: codes of BridgeErrors pass through, anything else is INTERNAL. */
const chunkError = (symbol, err) => ({ symbol, code: err instanceof BridgeError ? err.code : "INTERNAL", message: err instanceof BridgeError ? (err.detail ?? err.message) : "The quote read failed." });

/**
 * Quotes for a symbol list in chunks, in list order. Never throws for one bad symbol or a failed chunk.
 * @returns {Promise<{ items: object[], errors: object[], freshness: object | null, stale: boolean }>}
 */
export async function quotesFor(marketData, list, opts = {}) {
  const bySymbol = new Map();
  const errors = new Map();
  for (let i = 0; i < list.length; i += QUOTE_CHUNK) {
    const chunk = list.slice(i, i + QUOTE_CHUNK);
    try {
      const r = await marketData.quotes(chunk, opts);
      for (const q of r.items ?? []) bySymbol.set(q.symbol, q);
      for (const e of r.errors ?? []) errors.set(e.symbol, { symbol: e.symbol, code: e.code ?? "INTERNAL", message: e.message ?? "No quote." });
    } catch (err) {
      for (const s of chunk) errors.set(s, chunkError(s, err));
    }
  }
  const items = [];
  const errs = [];
  let stalest = null;
  let stale = false;
  for (const s of list) {
    const q = bySymbol.get(s);
    if (q) {
      items.push(quoteRow(q));
      if (q.freshness?.stale) stale = true;
      if (q.freshness && (!stalest || q.freshness.ageMs > stalest.ageMs)) stalest = q.freshness;
    } else errs.push(errors.get(s) ?? { symbol: s, code: "SYMBOL_NOT_FOUND", message: `No quote came back for ${s}.` });
  }
  return { items, errors: errs, freshness: stalest, stale };
}

/** @returns {Array<[string, string, object, (ctx: object) => Promise<object>]>} */
export function watchlistRoutes(deps) {
  const svc = watchlistsFor(deps);
  const find = (ctx) => {
    const l = svc.get(ctx.params.listId);
    if (!l || !owns(ctx, l)) throw new BridgeError("NOT_FOUND", `No watchlist ${ctx.params.listId}.`);
    return l;
  };
  const seeded = (ctx) => svc.ensureSeeded(who(ctx));
  const meta = (ctx) => ({ requestId: ctx.requestId });
  return [
    [
      "GET",
      "/v1/analytics/watchlists",
      { scope: "read" },
      async (ctx) => {
        seeded(ctx);
        return { data: svc.list().filter((l) => owns(ctx, l)).map(view), meta: meta(ctx) };
      },
    ],
    [
      "POST",
      "/v1/analytics/watchlists",
      { scope: "read" },
      async (ctx) => {
        seeded(ctx);
        return json({ data: view(svc.create(ctx.body, who(ctx))), meta: meta(ctx) }, { status: 201 });
      },
    ],
    [
      "PUT",
      "/v1/analytics/watchlists/:listId",
      { scope: "read" },
      async (ctx) => {
        const l = find(ctx);
        return { data: view(svc.update(l.id, ctx.body)), meta: meta(ctx) };
      },
    ],
    [
      "DELETE",
      "/v1/analytics/watchlists/:listId",
      { scope: "read", body: "none" },
      async (ctx) => {
        const l = find(ctx);
        svc.remove(l.id);
        return { data: { id: l.id, deleted: true }, meta: meta(ctx) };
      },
    ],
    [
      "GET",
      "/v1/analytics/watchlists/:listId/quotes",
      { scope: "read" },
      async (ctx) => {
        seeded(ctx);
        const l = find(ctx);
        const opts = readOptionsBase(ctx, { autoBackup: autoBackupFor(deps) });
        const r = l.symbols.length ? await quotesFor(deps.marketData, l.symbols, opts) : { items: [], errors: [], freshness: null, stale: false };
        return {
          data: { id: l.id, name: l.name, count: l.symbols.length, items: r.items },
          errors: r.errors,
          meta: { requestId: ctx.requestId, accountId: opts.accountId ?? null, requested: l.symbols.length, quoted: r.items.length, stale: r.stale, ...(r.freshness ? { freshness: r.freshness } : {}) },
        };
      },
    ],
  ];
}
