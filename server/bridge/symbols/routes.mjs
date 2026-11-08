/**
 * Route handlers for the symbols module (docs/openapi.yaml, tag Instruments). Every handler answers { data, meta }.
 *
 *   GET  /v1/instruments/search     ranked search with cursor pagination (meta.nextCursor)
 *   GET  /v1/instruments/{symbol}   resolve any accepted form; include=refs adds each broker's token/trading symbol
 *   GET  /v1/symbols/convert        one symbol -> canonical + aliases
 *   POST /v1/symbols/convert        up to 200, one result or ItemError per item, in order
 *
 * The wire shape of an instrument is the OpenAPI `Instrument` (field `symbol` holds the canonical symbol).
 * Instrument names are third-party text; they are returned as data and never interpreted.
 */
import { z } from "zod";
import { BridgeError, fromValidation } from "../core/errors.mjs";
import { FROM_FORMATS, SEARCH_LIMIT_MAX } from "./symbolService.mjs";

export const CONVERT_BATCH_MAX = 200;

const convertItemSchema = z
  .object({
    input: z.string().min(1).max(64),
    from: z.enum(FROM_FORMATS).optional(),
    exchange: z.string().min(1).max(12).optional(),
    broker: z.string().min(1).max(32).optional(),
  })
  .strict();
const convertBatchSchema = z.object({ items: z.array(convertItemSchema).min(1).max(CONVERT_BATCH_MAX) }).strict();

/**
 * ResolvedInstrument -> OpenAPI Instrument.
 * @param {object} r ResolvedInstrument (refs optional)
 * @param {{ withRefs?: boolean }} [opts]
 */
export function toPublicInstrument(r, { withRefs = false } = {}) {
  const out = {
    symbol: r.canonical,
    exchange: r.exchange,
    kind: r.kind,
    underlying: r.underlying,
    name: r.name ?? null,
    expiry: r.expiry,
    strike: r.strike,
    right: r.right,
    lotSize: r.lotSize,
    tickSize: r.tickSize,
    freezeQty: r.freezeQty ?? null,
    freezeQtySource: r.freezeQtySource ?? null,
    isin: r.isin ?? null,
  };
  if (withRefs && r.refs) out.refs = r.refs;
  return out;
}

const meta = (ctx, extra = {}) => ({ requestId: ctx.requestId, ...extra });

/** Optional query string value: absent or empty -> undefined. */
const opt = (q, name) => {
  const v = q.get(name);
  return v === null || v === "" ? undefined : v;
};

/**
 * @param {object} deps full deps passed to register()
 */
export function createSymbolRoutes(deps) {
  const symbols = deps.symbols;

  return {
    async search(ctx) {
      const q = ctx.query;
      const limitText = opt(q, "limit");
      let limit;
      if (limitText !== undefined) {
        limit = Number(limitText);
        if (!/^\d+$/.test(limitText) || limit < 1 || limit > SEARCH_LIMIT_MAX) {
          throw new BridgeError("VALIDATION_FAILED", `limit must be a whole number from 1 to ${SEARCH_LIMIT_MAX}.`, { errors: [{ path: "limit", message: "out of range" }] });
        }
      }
      const params = { q: q.get("q") ?? "" };
      for (const name of ["exchange", "kind", "underlying", "expiry", "cursor"]) {
        const v = opt(q, name);
        if (v !== undefined) params[name] = name === "exchange" || name === "kind" ? v.toUpperCase() : v;
      }
      if (limit !== undefined) params.limit = limit;
      const page = await symbols.search(params);
      return { data: page.items.map((r) => toPublicInstrument(r)), meta: meta(ctx, { nextCursor: page.nextCursor }) };
    },

    async instrument(ctx) {
      const include = opt(ctx.query, "include");
      if (include !== undefined && include !== "refs") throw new BridgeError("VALIDATION_FAILED", "include accepts only refs.");
      const r = await symbols.resolve(ctx.params.symbol);
      return { data: toPublicInstrument(r, { withRefs: include === "refs" }), meta: meta(ctx) };
    },

    async convertOne(ctx) {
      const q = ctx.query;
      const req = { input: q.get("input") ?? "" };
      for (const name of ["from", "exchange", "broker"]) {
        const v = opt(q, name);
        if (v !== undefined) req[name] = v;
      }
      const parsed = convertItemSchema.safeParse(req);
      if (!parsed.success) throw fromValidation(parsed.error);
      return { data: await symbols.convert(parsed.data), meta: meta(ctx) };
    },

    async convertMany(ctx) {
      const parsed = convertBatchSchema.safeParse(ctx.body);
      if (!parsed.success) throw fromValidation(parsed.error, `Send { "items": [ { "input": ... } ] } with 1 to ${CONVERT_BATCH_MAX} items.`);
      const data = [];
      for (const item of parsed.data.items) {
        try {
          data.push(await symbols.convert(item));
        } catch (err) {
          if (!(err instanceof BridgeError)) throw err;
          data.push({ symbol: item.input, code: err.code, message: err.detail });
        }
      }
      return { data, meta: meta(ctx) };
    },
  };
}
