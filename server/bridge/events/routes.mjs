/**
 * Route handlers for stream S28 (docs/openapi.yaml, tag "Events"). Reading needs the "read" scope; saving the event
 * selection too (it is a preference of this Bridge, like a saved scan). Nothing here can place an order.
 *
 *   GET /v1/events                 today's events, newest first (filters: since, kind, side, asset, symbol, q, minPrice, first, limit, date)
 *   GET /v1/events/catalogue       kinds with definitions and parameters, categories, presets, universes
 *   GET /v1/events/selection       the selected kinds, their parameters, universes, option mode, watchlist, cool-down
 *   PUT /v1/events/selection       replace it (validated and clamped against the catalogue)
 *   GET /v1/events/summary         counts by kind and side, bull/bear balance
 *   GET /v1/events/symbols/:symbol one symbol today: its events and key levels (prev H/L, pivots, VWAP, bands)
 *   GET /v1/events/chain           one strike's chain row (?underlying=&expiry=&strike=)
 *   GET /v1/events/status          what is tracked, where data comes from, and the engine's per-tick timing
 */
import { BridgeError } from "../core/errors.mjs";
import { CATEGORIES, KINDS, OPTION_MODES, PRESETS, UNIVERSES } from "./catalogue.mjs";

const SIDES = new Set(["bull", "bear", "neutral"]);
const listOf = (v) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []);
const intParam = (ctx, name, def, max) => {
  const v = ctx.query.get(name);
  if (v === null || v === "") return def;
  if (!/^\d+$/.test(v) || Number(v) > max) throw new BridgeError("VALIDATION_FAILED", `${name} must be a whole number from 0 to ${max}.`, { errors: [{ path: name, message: "out of range" }] });
  return Number(v);
};

/** Parse GET /v1/events filters (shared with the MCP tool). */
export function parseEventQuery(get) {
  const kinds = listOf(get("kind"));
  const known = new Set(KINDS.map((k) => k.kind));
  const bad = kinds.filter((k) => !known.has(k));
  if (bad.length) throw new BridgeError("VALIDATION_FAILED", `Unknown event kind ${bad.join(", ")}. See GET /v1/events/catalogue.`, { errors: [{ path: "kind", message: "unknown" }] });
  const sides = listOf(get("side"));
  if (sides.some((s) => !SIDES.has(s))) throw new BridgeError("VALIDATION_FAILED", "side is bull, bear or neutral.", { errors: [{ path: "side", message: "unknown" }] });
  const asset = get("asset") || null;
  if (asset && asset !== "stock" && asset !== "option") throw new BridgeError("VALIDATION_FAILED", "asset is stock or option.", { errors: [{ path: "asset", message: "unknown" }] });
  const minPrice = get("minPrice");
  return {
    kinds,
    sides,
    asset,
    symbol: get("symbol") ? String(get("symbol")).toUpperCase() : null,
    q: get("q") ? String(get("q")).slice(0, 40) : null,
    minPrice: minPrice !== null && minPrice !== "" && Number.isFinite(Number(minPrice)) ? Number(minPrice) : null,
    firstOnly: ["1", "true"].includes(String(get("first") ?? "")),
  };
}

export function createEventsRoutes(svc) {
  const meta = (ctx, extra = {}) => {
    svc.touch?.();
    return { requestId: ctx.requestId, ...extra };
  };
  const handlers = {
    async list(ctx) {
      const f = parseEventQuery((k) => ctx.query.get(k));
      const since = intParam(ctx, "since", 0, Number.MAX_SAFE_INTEGER);
      const limit = intParam(ctx, "limit", 500, 5000);
      const date = ctx.query.get("date");
      const today = svc.engine.day();
      if (date && date !== today) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BridgeError("VALIDATION_FAILED", "date is YYYY-MM-DD.", { errors: [{ path: "date", message: "format" }] });
        // A past day: read its file and replay updates over the records.
        const rows = await svc.store.readDay(date);
        const byId = new Map();
        for (const r of rows) {
          if (r.update) {
            const o = byId.get(r.id);
            if (o) Object.assign(o, { count: r.count, lastAt: r.lastAt, ltp: r.ltp, changePct: r.changePct });
          } else byId.set(r.id, r);
        }
        let list = [...byId.values()].reverse();
        if (f.kinds.length) list = list.filter((r) => f.kinds.includes(r.kind));
        if (f.sides.length) list = list.filter((r) => f.sides.includes(r.side));
        if (f.asset) list = list.filter((r) => r.asset === f.asset);
        if (f.symbol) list = list.filter((r) => r.symbol === f.symbol);
        return { data: list.slice(0, limit), meta: meta(ctx, { date, count: list.length }) };
      }
      const data = svc.engine.list({ ...f, since, limit });
      return { data, meta: meta(ctx, { date: today, lastSeq: svc.engine.summary().lastSeq, count: data.length }) };
    },
    async catalogue(ctx) {
      return { data: { kinds: KINDS, categories: CATEGORIES, presets: PRESETS, universes: UNIVERSES, optionModes: OPTION_MODES }, meta: meta(ctx) };
    },
    async getSelection(ctx) {
      return { data: svc.engine.selection(), meta: meta(ctx) };
    },
    async putSelection(ctx) {
      if (!ctx.body || typeof ctx.body !== "object") throw new BridgeError("VALIDATION_FAILED", "Send the selection as a JSON object.", { errors: [{ path: "", message: "expected object" }] });
      return { data: svc.setSelection(ctx.body), meta: meta(ctx) };
    },
    async summary(ctx) {
      const asset = ctx.query.get("asset");
      return { data: svc.engine.summary({ asset: asset === "stock" || asset === "option" ? asset : null }), meta: meta(ctx) };
    },
    async symbol(ctx) {
      const sym = String(ctx.params.symbol ?? "").toUpperCase();
      if (!/^[A-Z]{2,5}:[A-Z0-9&_.\-]{1,40}$/.test(sym)) throw new BridgeError("VALIDATION_FAILED", "symbol is EXCHANGE:SYMBOL, e.g. NSE:RELIANCE.", { errors: [{ path: "symbol", message: "format" }] });
      return { data: svc.engine.symbolView(sym), meta: meta(ctx) };
    },
    async chain(ctx) {
      const u = String(ctx.query.get("underlying") ?? "").toUpperCase();
      const e = String(ctx.query.get("expiry") ?? "");
      const k = Number(ctx.query.get("strike"));
      if (!u || !/^\d{4}-\d{2}-\d{2}$/.test(e) || !Number.isFinite(k)) throw new BridgeError("VALIDATION_FAILED", "Give underlying, expiry (YYYY-MM-DD) and strike.", { errors: [{ path: "underlying", message: "required" }] });
      const row = svc.engine.chainRow(u, e, k);
      if (!row) throw new BridgeError("NOT_FOUND", `The events engine does not track ${u} ${e}.`);
      return { data: row, meta: meta(ctx) };
    },
    async status(ctx) {
      return { data: svc.status(), meta: meta(ctx) };
    },
  };
  // Every read wakes the demo session first (the first list may still be empty while the morning replays).
  for (const [k, fn] of Object.entries(handlers)) handlers[k] = (ctx) => (svc.touch?.(), fn(ctx));
  return handlers;
}
