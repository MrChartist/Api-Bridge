/**
 * Route handlers for the symbols module (docs/openapi.yaml, tag Instruments). Every handler answers { data, meta }.
 *
 *   GET  /v1/instruments/search     ranked search with cursor pagination (meta.nextCursor)
 *   GET  /v1/instruments/{symbol}   resolve any accepted form; include=refs adds each broker's token/trading symbol
 *   GET  /v1/symbols/convert        one symbol -> canonical + aliases
 *   POST /v1/symbols/convert        up to 200, one result or ItemError per item, in order
 *   GET  /v1/symbols/resolve        free text -> one instrument with the reason; AMBIGUOUS_SYMBOL (with candidates) rather than a guess
 *   GET  /v1/symbols/validate       check one symbol: canonical form, lot size, tradable; never an error for a bad symbol
 *   POST /v1/symbols/validate       the same for up to 200 symbols, one result per item, in order
 *
 * The wire shape of an instrument is the OpenAPI `Instrument` (field `symbol` holds the canonical symbol).
 * Instrument names are third-party text; they are returned as data and never interpreted.
 */
import { z } from "zod";
import { BridgeError, fromValidation } from "../core/errors.mjs";
import { parseFields, pickAll } from "../core/fields.mjs";
import { FROM_FORMATS, SEARCH_LIMIT_MAX } from "./symbolService.mjs";

export const CONVERT_BATCH_MAX = 200;

/** The fields `fields=` may name on instrument search (the OpenAPI `Instrument`, without `refs`; a test keeps them equal). `symbol` is always kept. */
export const INSTRUMENT_FIELDS = Object.freeze(["symbol", "exchange", "kind", "underlying", "name", "expiry", "strike", "right", "lotSize", "tickSize", "freezeQty", "freezeQtySource", "isin"]);

const convertItemSchema = z
  .object({
    input: z.string().min(1).max(64),
    from: z.enum(FROM_FORMATS).optional(),
    exchange: z.string().min(1).max(12).optional(),
    broker: z.string().min(1).max(32).optional(),
  })
  .strict();
const validateItemSchema = z.object({ symbol: z.string().min(1).max(64), exchange: z.string().min(1).max(12).optional() }).strict();
const validateBatchSchema = z.object({ items: z.array(validateItemSchema).min(1).max(CONVERT_BATCH_MAX) }).strict();
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

/** One candidate on the wire: the instrument's key fields plus why it matched. */
const publicCandidate = (c) => {
  const i = c.instrument;
  return { symbol: i.canonical, exchange: i.exchange, kind: i.kind, name: i.name ?? null, expiry: i.expiry, strike: i.strike, right: i.right, lotSize: i.lotSize, tickSize: i.tickSize, reason: c.reason };
};

/** One validation result: a symbol the Bridge cannot use is a `valid: false` result, never an error response. */
async function validateOne(symbols, { symbol, exchange }) {
  try {
    const r = await symbols.resolveInput({ q: symbol, exchange });
    if (r.status !== "resolved") {
      return {
        input: symbol,
        valid: false,
        code: r.status === "ambiguous" ? "AMBIGUOUS_SYMBOL" : "SYMBOL_NOT_FOUND",
        message: r.rule,
        candidates: r.candidates.map(publicCandidate),
      };
    }
    const i = r.instrument;
    return {
      input: symbol,
      valid: true,
      symbol: i.canonical,
      exchange: i.exchange,
      kind: i.kind,
      underlying: i.underlying,
      expiry: i.expiry,
      strike: i.strike,
      right: i.right,
      name: i.name ?? null,
      lotSize: i.lotSize,
      tickSize: i.tickSize,
      freezeQty: i.freezeQty ?? null,
      tradable: i.kind !== "INDEX",
      tradableNote: i.kind === "INDEX" ? "An index can be read but not traded. Trade its futures or options." : null,
      normalised: r.rules.length > 0,
      rule: r.rule,
      rules: r.rules,
      confidence: r.confidence,
    };
  } catch (err) {
    if (!(err instanceof BridgeError)) throw err;
    return { input: symbol, valid: false, code: err.code, message: err.detail, candidates: [] };
  }
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
      // fields=symbol,lotSize: only these columns per instrument (symbol is always kept).
      const fields = parseFields(q, { allowed: INSTRUMENT_FIELDS, always: ["symbol"] });
      const page = await symbols.search(params);
      return { data: pickAll(page.items.map((r) => toPublicInstrument(r)), fields), meta: meta(ctx, { nextCursor: page.nextCursor, ...(fields ? { fields: fields.names } : {}) }) };
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

    async resolve(ctx) {
      const q = ctx.query;
      const text = opt(q, "q") ?? opt(q, "input");
      if (text === undefined) throw new BridgeError("VALIDATION_FAILED", "q is required: the symbol or name to look up.", { errors: [{ path: "q", message: "required" }] });
      const limitText = opt(q, "limit");
      if (limitText !== undefined && (!/^\d+$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > 50)) {
        throw new BridgeError("VALIDATION_FAILED", "limit must be a whole number from 1 to 50.", { errors: [{ path: "limit", message: "out of range" }] });
      }
      const explainText = opt(q, "explain");
      if (explainText !== undefined && !["1", "0", "true", "false"].includes(explainText.toLowerCase())) {
        throw new BridgeError("VALIDATION_FAILED", "explain must be 1 or true to include the steps.", { errors: [{ path: "explain", message: "not a boolean" }] });
      }
      const explain = explainText === "1" || explainText?.toLowerCase() === "true";
      const r = await symbols.resolveInput({ q: text, exchange: opt(q, "exchange"), kind: opt(q, "kind"), ...(limitText ? { limit: Number(limitText) } : {}) });
      const candidates = r.candidates.map(publicCandidate);
      if (r.status === "ambiguous") {
        throw new BridgeError("AMBIGUOUS_SYMBOL", `"${r.input}" matches more than one instrument: ${r.rule}. Nothing was picked; choose one of the candidates.`, { fields: { candidates, rule: r.rule } });
      }
      if (r.status === "not_found") {
        throw new BridgeError("SYMBOL_NOT_FOUND", `"${r.input}" was not found: ${r.rule}.`, { fields: { candidates, rule: r.rule } });
      }
      const data = { input: r.input, symbol: r.symbol, instrument: toPublicInstrument({ ...r.instrument, canonical: r.instrument.canonical }), confidence: r.confidence, rule: r.rule, rules: r.rules, candidates };
      if (explain) data.steps = r.steps;
      return { data, meta: meta(ctx) };
    },

    async validateOne(ctx) {
      const q = ctx.query;
      const symbol = opt(q, "symbol") ?? opt(q, "q");
      if (symbol === undefined) throw new BridgeError("VALIDATION_FAILED", "symbol is required: the symbol to check.", { errors: [{ path: "symbol", message: "required" }] });
      if (symbol.length > 64) throw new BridgeError("VALIDATION_FAILED", "A symbol is at most 64 characters.", { errors: [{ path: "symbol", message: "too long" }] });
      return { data: await validateOne(symbols, { symbol, exchange: opt(q, "exchange") }), meta: meta(ctx) };
    },

    async validateMany(ctx) {
      const parsed = validateBatchSchema.safeParse(ctx.body);
      if (!parsed.success) throw fromValidation(parsed.error, `Send { "items": [ { "symbol": ... } ] } with 1 to ${CONVERT_BATCH_MAX} items.`);
      const data = [];
      for (const item of parsed.data.items) data.push(await validateOne(symbols, item));
      return { data, meta: meta(ctx) };
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
