/**
 * User watchlists: named lists of symbols in the Bridge home (<dataDir>/watchlists/lists.json, atomic writes), and
 * one read that prices a list for the dashboard: last price, % change, OI and its change today for F&O, and ATM IV.
 *
 * Budget: one quotes call for the whole list (the market-data service batches, caches and streams it); the near
 * future of an F&O underlying is found once a day per symbol; IV comes from the vol service's memory summary, which
 * makes no broker call. OI change is measured from the first OI this Bridge saw for the contract today.
 *
 * A list may be marked `events` (it feeds Live events' WATCHLIST universe; the dashboard writes the events selection)
 * and `home` (shown on the Home cockpit). Reads and writes only lists: it places nothing.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BridgeError } from "../core/errors.mjs";
import { writeFileAtomic } from "../auth/fsUtil.mjs";
import { normaliseSymbol, nearFuture, oiChange, watchRow } from "../dashboard/watchlist-core.js";

export const MAX_LISTS = 20;
export const MAX_SYMBOLS = 100;
const NAME_MAX = 40;
const DEMO_LISTS = Object.freeze([
  { name: "Index and F&O", symbols: ["NSE:NIFTY", "NSE:BANKNIFTY", "BSE:SENSEX", "NSE:RELIANCE", "NSE:HDFCBANK", "NSE:INFY", "NSE:TCS", "NSE:ICICIBANK"], events: true, home: true },
  { name: "Banks", symbols: ["NSE:HDFCBANK", "NSE:ICICIBANK", "NSE:SBIN", "NSE:AXISBANK", "NSE:KOTAKBANK"], events: false, home: false },
]);

const istDay = (ms) => new Date(ms + 19_800_000).toISOString().slice(0, 10);

/** @param {object} deps core deps plus marketData and (optional) vol */
export function createWatchlistService(deps) {
  const dir = join(deps.paths.dataDir, "watchlists");
  const file = join(dir, "lists.json");
  const now = () => deps.clock?.now?.() ?? Date.now();
  let state = null;
  /** symbol -> { day, oi }: the first OI seen today. */
  const firstOi = new Map();
  /** underlying -> { day, symbol|null }: the near future, found once a day. */
  const futures = new Map();

  function load() {
    if (state) return state;
    state = { v: 1, seq: 0, lists: [] };
    try {
      if (existsSync(file)) {
        const o = JSON.parse(readFileSync(file, "utf8"));
        if (Array.isArray(o?.lists)) state = { v: 1, seq: Number(o.seq) || o.lists.length, lists: o.lists };
      }
    } catch {
      // A broken file starts empty; it is replaced on the next save.
    }
    if (!state.lists.length && deps.config?.demo) {
      for (const l of DEMO_LISTS) state.lists.push({ id: `w${++state.seq}`, ...l, symbols: [...l.symbols], createdAt: new Date(now()).toISOString() });
    }
    return state;
  }
  function persist() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(file, JSON.stringify(state));
  }
  function find(id) {
    const l = load().lists.find((x) => x.id === id);
    if (!l) throw new BridgeError("NOT_FOUND", `No watchlist ${id}.`);
    return l;
  }
  function clean(body, cur = null) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new BridgeError("VALIDATION_FAILED", "Send the watchlist as a JSON object.");
    const extra = Object.keys(body).filter((k) => !["name", "symbols", "events", "home"].includes(k));
    if (extra.length) throw new BridgeError("VALIDATION_FAILED", `Unknown field ${extra[0]}: send name, symbols, events or home.`);
    const name = body.name === undefined ? cur?.name : String(body.name).trim();
    if (!name || name.length > NAME_MAX) throw new BridgeError("VALIDATION_FAILED", `Give the list a name of 1 to ${NAME_MAX} characters.`);
    let symbols = cur?.symbols ?? [];
    if (body.symbols !== undefined) {
      if (!Array.isArray(body.symbols)) throw new BridgeError("VALIDATION_FAILED", "symbols must be a list such as [\"NSE:RELIANCE\"].");
      const bad = [];
      symbols = [];
      for (const s of body.symbols) {
        const n = normaliseSymbol(s);
        if (!n) bad.push(String(s));
        else if (!symbols.includes(n)) symbols.push(n);
      }
      if (bad.length) throw new BridgeError("VALIDATION_FAILED", `Not a symbol: ${bad.slice(0, 3).join(", ")}. Use EXCHANGE:NAME, for example NSE:RELIANCE.`);
      if (symbols.length > MAX_SYMBOLS) throw new BridgeError("VALIDATION_FAILED", `At most ${MAX_SYMBOLS} symbols in a list.`);
    }
    return { name, symbols, events: body.events === undefined ? Boolean(cur?.events) : Boolean(body.events), home: body.home === undefined ? Boolean(cur?.home) : Boolean(body.home) };
  }
  /** One list may drive Live events and one may show on Home: setting the flag clears it elsewhere. */
  function exclusive(l, v) {
    for (const k of ["events", "home"]) if (v[k]) for (const o of load().lists) if (o !== l) o[k] = false;
  }

  return {
    list: () => load().lists.map((l) => ({ ...l, symbols: [...l.symbols] })),
    get: (id) => ({ ...find(id) }),
    create(body) {
      const s = load();
      if (s.lists.length >= MAX_LISTS) throw new BridgeError("VALIDATION_FAILED", `At most ${MAX_LISTS} watchlists.`);
      const v = clean(body);
      const l = { id: `w${++s.seq}`, ...v, createdAt: new Date(now()).toISOString() };
      exclusive(l, v);
      s.lists.push(l);
      persist();
      return { ...l };
    },
    update(id, body) {
      const l = find(id);
      const v = clean(body, l);
      exclusive(l, v);
      Object.assign(l, v, { updatedAt: new Date(now()).toISOString() });
      persist();
      return { ...l };
    },
    remove(id) {
      const l = find(id);
      state.lists = state.lists.filter((x) => x !== l);
      persist();
      return { id, deleted: true };
    },

    /** Price a list: { id, name, rows: [{ symbol, ltp, change, changePct, future, oi, oiChange, oiChangePct, iv, ivr, hv20 }], errors }. */
    async quotes(id) {
      const l = find(id);
      const t = now();
      const day = istDay(t);
      const errors = [];
      // The near future of each F&O underlying, once a day.
      for (const s of l.symbols) {
        const u = s.split(":")[1];
        const f = futures.get(u);
        if (f?.day === day) continue;
        let sym = null;
        try {
          const ex = await deps.marketData.expiries(u, { priority: "background" });
          sym = nearFuture(s, ex?.expiries ?? [], day);
        } catch {
          sym = null;
        }
        futures.set(u, { day, symbol: sym });
      }
      const futOf = (s) => futures.get(s.split(":")[1])?.symbol ?? null;
      const want = [...new Set([...l.symbols, ...l.symbols.map(futOf).filter(Boolean)])];
      const q = new Map();
      if (want.length) {
        try {
          const r = await deps.marketData.quotes(want, { priority: "interactive" });
          for (const it of r?.items ?? []) q.set(it.symbol, it);
          for (const e of r?.errors ?? []) errors.push({ symbol: e.symbol, message: e.message });
        } catch (err) {
          errors.push({ symbol: null, message: err?.message ?? "Quotes are unavailable." });
        }
      }
      let vol = new Map();
      const unders = [...new Set(l.symbols.map((s) => s.split(":")[1]))].slice(0, 20);
      if (deps.vol && typeof deps.vol.summary === "function" && unders.length) {
        for (const u of unders) {
          try {
            const r = await deps.vol.summary({ underlyings: [u] });
            const it = r?.items?.[0];
            if (it?.available) vol.set(u, it);
          } catch {
            // Not an F&O underlying, or no IV history yet: the IV column stays empty.
          }
        }
      }
      const rows = l.symbols.map((s) => {
        const f = futOf(s);
        const fq = f ? q.get(f) : null;
        let oi = null;
        if (fq && Number.isFinite(Number(fq.oi))) {
          const first = firstOi.get(f);
          if (!first || first.day !== day) firstOi.set(f, { day, oi: Number(fq.oi) });
          oi = oiChange(Number(fq.oi), firstOi.get(f).oi);
        }
        return watchRow(s, q.get(s) ?? null, { future: f, oi, vol: vol.get(s.split(":")[1]) ?? null });
      });
      return { id: l.id, name: l.name, at: new Date(t).toISOString(), rows, errors };
    },
  };
}
