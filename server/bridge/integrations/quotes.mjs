/**
 * The batch price table for spreadsheets, and instrument facts.
 *
 *   GET /xl/quotes?symbols=NSE:RELIANCE,NSE:NIFTY&fields=ltp,chg,pct,volume[&format=csv|tsv|json][&cache=1]
 *   GET /xl/instrument?symbol=NSE:RELIANCE[,NFO:NIFTY-2026-11-26-FUT]&field=lot|tick|freeze[&format=]
 *
 * A whole sheet in ONE request: the Bridge asks the broker for all the symbols together (batched, shared with every
 * other reader through its cache and stream) instead of one WEBSERVICE call per cell. One output row per requested
 * symbol, in the order asked, duplicates included. A symbol that cannot be priced gets blank values and a text in its
 * `error` column: one bad symbol never fails the table.
 *
 * Every price row says how current it is: as_of (IST), age_s, class (realtime, delayed or eod), source and stale.
 * These routes never use a backup data source (readOptions sets allowBackup false), so a price here comes from your
 * own broker. In demo mode each row also carries a `demo` column with DEMO.
 */
import { BridgeError } from "../core/errors.mjs";
import { text } from "../core/http.mjs";
import { asOfCell, formatNumber } from "./xl.mjs";
import { asBridgeError, errorHeaders, invalid, opt, readOptions } from "./params.mjs";
import { FRESHNESS_COLUMNS, cacheParam, errorText, formatParam, tableReply } from "./table.mjs";

/** Value columns of /xl/quotes and the quote item key each one reads. */
export const QUOTE_COLUMNS = Object.freeze({
  ltp: "ltp",
  open: "open",
  high: "high",
  low: "low",
  close: "close",
  chg: "change",
  pct: "changePct",
  volume: "volume",
  oi: "oi",
  bid: "bid",
  ask: "ask",
});
export const DEFAULT_QUOTE_FIELDS = Object.freeze(["ltp", "chg", "pct", "volume"]);
/** Every name `fields=` accepts. */
export const QUOTE_FIELD_NAMES = Object.freeze([...Object.keys(QUOTE_COLUMNS), ...FRESHNESS_COLUMNS]);

/**
 * `symbol=` / `symbols=` (comma separated, either name, repeatable) -> the list as typed, blanks dropped.
 * @param {URLSearchParams} query
 * @param {number} max
 */
export function symbolList(query, max) {
  const raw = [...query.getAll("symbols"), ...query.getAll("symbol")];
  const list = raw.flatMap((v) => String(v).split(",")).map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw invalid("symbols", "symbols is required: a comma-separated list such as NSE:RELIANCE,NSE:NIFTY.");
  if (list.length > max) throw invalid("symbols", `Too many symbols (${list.length}). Ask for at most ${max} at a time and split a longer list into several requests.`);
  const tooLong = list.find((s) => s.length > 64);
  if (tooLong) throw invalid("symbols", `"${tooLong.slice(0, 20)}..." is not a symbol: a symbol is at most 64 characters.`);
  return list;
}

/** `fields=` -> data columns in the order asked (unknown names refused, duplicates dropped). */
export function fieldList(query, dflt, allowed) {
  const v = opt(query, "fields");
  if (v === undefined) return [...dflt];
  const out = [];
  for (const f of v.split(",").map((s) => s.trim()).filter(Boolean)) {
    const hit = allowed.find((a) => a.toLowerCase() === f.toLowerCase());
    if (!hit) throw invalid("fields", `fields has an unknown name "${f.slice(0, 20)}". Use any of: ${allowed.join(", ")}.`);
    if (!out.includes(hit)) out.push(hit);
  }
  if (!out.length) return [...dflt];
  return out;
}

/** Canonical symbol for what the person typed, or an Error. Local lookup only: no broker call. */
export async function canonicalOf(symbols, input) {
  try {
    return symbols.parse(input).canonical;
  } catch (parseErr) {
    const r = await symbols.resolve(input);
    if (r?.canonical) return r.canonical;
    throw parseErr;
  }
}

/** Freshness fields of a price item as table cells. */
export function freshCells(f) {
  if (!f) return { as_of: null, age_s: null, class: null, source: null, stale: null };
  return {
    as_of: asOfCell(f.asOf),
    age_s: Number.isFinite(f.ageMs) ? Math.round(f.ageMs / 100) / 10 : null,
    class: f.class ?? "realtime",
    source: f.source ?? null,
    stale: typeof f.stale === "boolean" ? f.stale : null,
  };
}

/** The columns of a freshness-labelled table: the asked data columns, then any freshness column left out, then error. */
export function withFreshness(dataColumns, { demo = false } = {}) {
  const cols = [...dataColumns];
  for (const c of FRESHNESS_COLUMNS) if (!cols.includes(c)) cols.push(c);
  cols.push("error");
  if (demo) cols.push("demo");
  return cols;
}

/** Columns /xl/instrument can show. */
export const INSTRUMENT_FIELDS = Object.freeze(["lot", "tick", "freeze", "name", "kind"]);

/** Retry wait the sheet is told when every symbol came back rate limited (the per-symbol errors carry no wait). */
export const UPSTREAM_RETRY_MS = 5000;

const NEEDS_QUOTE = new Set(Object.keys(QUOTE_COLUMNS).filter((c) => c !== "ltp"));

/**
 * @param {object} deps
 * @param {ReturnType<typeof import("./config.mjs").parseIntegrationsConfig>} cfg
 * @param {{ demo: boolean }} env
 */
export function createQuoteRoutes(deps, cfg, { demo = false } = {}) {
  return {
    async quotes(ctx) {
      const q = ctx.query;
      const format = formatParam(q);
      const inputs = symbolList(q, cfg.xl.maxSymbols);
      const fields = fieldList(q, DEFAULT_QUOTE_FIELDS, QUOTE_FIELD_NAMES);
      const columns = withFreshness(["symbol", ...fields.filter((f) => f !== "symbol")], { demo });
      const opts = readOptions(ctx);
      const cache = cacheParam(ctx, cfg.xl.cacheSeconds);

      // 1. what each typed symbol means (local lookup; a bad one only fails its own row)
      const unique = [...new Set(inputs)];
      const canon = new Map();
      const bad = new Map();
      await Promise.all(
        unique.map(async (input) => {
          try {
            canon.set(input, await canonicalOf(deps.symbols, input));
          } catch (err) {
            const e = asBridgeError(err);
            bad.set(input, errorText(e.code, e.detail));
          }
        }),
      );

      // 2. one batched read for the distinct good symbols
      const wanted = [...new Set(canon.values())];
      const items = new Map();
      const failed = new Map();
      if (wanted.length) {
        const wantQuote = fields.some((f) => NEEDS_QUOTE.has(f));
        const first = wantQuote ? await deps.marketData.quotes(wanted, opts) : await deps.marketData.ltp(wanted, opts);
        for (const it of first?.items ?? []) items.set(it.symbol, it);
        for (const e of first?.errors ?? []) failed.set(e.symbol, e);
        // A broker with no quotes API can still give a last price: fall back to it for those symbols only.
        const ltpOnly = [...failed.values()].filter((e) => e.code === "CAPABILITY_UNSUPPORTED" && wanted.includes(e.symbol)).map((e) => e.symbol);
        if (wantQuote && ltpOnly.length) {
          const second = await deps.marketData.ltp(ltpOnly, opts);
          for (const it of second?.items ?? []) {
            items.set(it.symbol, it);
            failed.delete(it.symbol);
          }
        }
        // Every symbol refused for rate limits: say so with a real 429 (a sheet keeps its old values and shows the wait).
        if (!items.size && failed.size && [...failed.values()].every((e) => e.code === "UPSTREAM_RATE_LIMITED" || e.code === "RATE_LIMITED")) {
          throw new BridgeError("UPSTREAM_RATE_LIMITED", "The broker's rate limit was reached.", { retryAfterMs: UPSTREAM_RETRY_MS });
        }
      }

      // 3. one row per requested symbol, in order
      const records = inputs.map((input) => {
        const rec = { symbol: input };
        if (demo) rec.demo = "DEMO";
        if (bad.has(input)) {
          rec.error = bad.get(input);
          return rec;
        }
        const c = canon.get(input);
        const item = items.get(c);
        if (!item) {
          const e = failed.get(c);
          rec.error = e ? errorText(e.code, e.message) : errorText("SYMBOL_NOT_FOUND", `No price for ${c}.`);
          return rec;
        }
        for (const f of Object.keys(QUOTE_COLUMNS)) rec[f] = item[QUOTE_COLUMNS[f]] ?? null;
        Object.assign(rec, freshCells(item.freshness));
        return rec;
      });
      return tableReply({ format, columns, records, cache });
    },

    /** Lot size, tick size and freeze quantity: static facts from the instrument master. */
    async instrument(ctx) {
      const q = ctx.query;
      const inputs = symbolList(q, cfg.xl.maxSymbols);
      const asked = opt(q, "field") ?? opt(q, "fields");
      const wanted = fieldList(new URLSearchParams(asked === undefined ? "" : { fields: asked }), INSTRUMENT_FIELDS, INSTRUMENT_FIELDS);
      const format = opt(q, "format");
      const resolveOne = async (input) => {
        const canonical = await canonicalOf(deps.symbols, input);
        const r = await deps.symbols.resolve(canonical);
        return { canonical, lot: r.lotSize ?? null, tick: r.tickSize ?? null, freeze: r.freezeQty ?? null, name: r.name ?? null, kind: r.kind ?? null };
      };
      // One symbol and one field, no ?format=: a bare value for a single cell (like /xl/ltp).
      if (inputs.length === 1 && wanted.length === 1 && asked !== undefined && format === undefined) {
        try {
          const row = await resolveOne(inputs[0]);
          const v = typeof row[wanted[0]] === "number" ? formatNumber(row[wanted[0]]) : row[wanted[0]];
          if (v === null || v === undefined) throw new BridgeError("NOT_FOUND", `${wanted[0]} has no value for ${row.canonical}.`);
          return text(String(v));
        } catch (err) {
          const e = asBridgeError(err);
          return text("#N/A", { status: e.status, headers: { "X-Error-Code": e.code, "Cache-Control": "no-store", ...errorHeaders(e) } });
        }
      }
      const fmt = formatParam(q);
      const columns = ["symbol", ...wanted, "error", ...(demo ? ["demo"] : [])];
      const cache = cacheParam(ctx, cfg.xl.cacheSeconds);
      const unique = [...new Set(inputs)];
      const out = new Map();
      await Promise.all(
        unique.map(async (input) => {
          try {
            out.set(input, await resolveOne(input));
          } catch (err) {
            const e = asBridgeError(err);
            out.set(input, { error: errorText(e.code, e.detail) });
          }
        }),
      );
      const records = inputs.map((input) => ({ symbol: input, ...(out.get(input) ?? {}), ...(demo ? { demo: "DEMO" } : {}) }));
      return tableReply({ format: fmt, columns, records, cache });
    },
  };
}
