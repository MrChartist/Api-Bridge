/**
 * Flat tables for spreadsheets (the batch routes /xl/quotes, /xl/positions, /xl/holdings, /xl/funds, /xl/orders and
 * /xl/instrument): one header row, one row per thing, the same columns in the same order every time.
 *
 *  - Formats: csv (RFC 4180, CRLF), tsv (tab separated, LF; tabs and line breaks inside a value become spaces, so a
 *    sheet can split it without quote rules) and json (an array of records).
 *  - Numbers: "." decimal point, no thousands separator, no exponent (formatNumber). Blank means "no value".
 *  - Times: IST, "YYYY-MM-DD HH:MM:SS" (the form Excel and Sheets read as a date-time); the column name says so.
 *  - Text that starts with = + - @ is prefixed with an apostrophe (a spreadsheet never evaluates it).
 *  - Errors never break a table: a bad row has blank values and a text in its `error` column. A failure of the whole
 *    request answers a small table of its own (tableError) so a sheet shows the message instead of a parse error.
 *  - Caching is opt-in (?cache=1): Cache-Control max-age plus an ETag. The default stays no-store.
 */
import { createHash } from "node:crypto";
import { Reply, toCsv } from "../core/http.mjs";
import { asBridgeError, enumParam, errorHeaders, boolParam } from "./params.mjs";
import { formatNumber, guardCell } from "./xl.mjs";

export const TABLE_FORMATS = Object.freeze(["csv", "tsv", "json"]);

/** Freshness columns that come with every price or portfolio row. */
export const FRESHNESS_COLUMNS = Object.freeze(["as_of", "age_s", "class", "source", "stale"]);

const TYPES = { csv: "text/csv; charset=utf-8", tsv: "text/tab-separated-values; charset=utf-8" };

/** A value as one table cell: numbers plain, booleans true/false, null blank. */
function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** Tab-separated text. */
export function toTsv(rows) {
  const cell = (v) => {
    let s = v === null || v === undefined ? "" : String(v);
    s = s.replace(/[\t\r\n]+/g, " ");
    return /^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  };
  return rows.map((r) => r.map(cell).join("\t")).join("\n") + "\n";
}

/**
 * The reply body for a table.
 * @param {"csv"|"tsv"|"json"} format
 * @param {string[]} columns
 * @param {Array<Record<string, unknown>>} records  keyed by column name
 */
export function tableBody(format, columns, records) {
  if (format === "json") {
    return JSON.stringify(
      records.map((r) =>
        Object.fromEntries(
          columns.map((c) => {
            const v = r[c] ?? null;
            return [c, typeof v === "number" ? (Number.isFinite(v) ? v : null) : guardCell(v)];
          }),
        ),
      ),
    );
  }
  const rows = [columns, ...records.map((r) => columns.map((c) => cellValue(r[c])))];
  return format === "tsv" ? toTsv(rows) : toCsv(rows);
}

/** ?format= for a table route (csv unless the route's default says otherwise). */
export function formatParam(query, dflt = "csv") {
  return enumParam(query, "format", TABLE_FORMATS, dflt);
}

/**
 * Reply with a table. `cache` (from cacheParam) adds the opt-in caching headers and answers 304 when the client's
 * If-None-Match still matches.
 * @param {{ format: string, columns: string[], records: object[], cache?: { seconds: number, ifNoneMatch?: string } | null, headers?: Record<string, string> }} o
 */
export function tableReply({ format, columns, records, cache = null, headers = {} }) {
  const body = tableBody(format, columns, records);
  const h = { "Content-Type": format === "json" ? "application/json; charset=utf-8" : TYPES[format], ...headers };
  if (cache) {
    const etag = `W/"${createHash("sha1").update(body).digest("base64url").slice(0, 22)}"`;
    h["Cache-Control"] = `private, max-age=${cache.seconds}`;
    h.ETag = etag;
    h.Vary = "Authorization, X-Api-Key";
    const inm = cache.ifNoneMatch;
    if (typeof inm === "string" && inm.split(",").some((t) => t.trim() === etag || t.trim() === "*")) return new Reply(304, "", h);
  }
  return new Reply(200, body, h);
}

/**
 * Opt-in caching: ?cache=1 (or true) -> { seconds, ifNoneMatch }; otherwise null (no-store, the default).
 * @param {import("../core/context.mjs").RequestContext} ctx
 * @param {number} seconds  the max-age from config
 */
export function cacheParam(ctx, seconds) {
  if (!boolParam(ctx.query, "cache", false)) return null;
  const inm = ctx.req?.headers?.["if-none-match"];
  return { seconds, ifNoneMatch: Array.isArray(inm) ? inm.join(",") : inm };
}

/** Short wording for an error code a sheet can show next to a row. */
export function errorText(code, message) {
  const m = String(message ?? "").replace(/\s+/g, " ").trim();
  return m ? `${code}: ${m}`.slice(0, 240) : String(code);
}

/** The text a person should see when a whole request is refused. */
export function plainReason(err) {
  const e = asBridgeError(err);
  const wait = e.retryAfterMs !== undefined ? Math.max(1, Math.ceil(e.retryAfterMs / 1000)) : null;
  if (e.code === "RATE_LIMITED" || e.code === "UPSTREAM_RATE_LIMITED") {
    return wait ? `Too many refreshes: wait ${wait} ${wait === 1 ? "second" : "seconds"} and try again.` : "Too many refreshes: wait a few seconds and try again.";
  }
  if (e.code === "UNAUTHENTICATED" && /web address/.test(e.detail ?? "")) return e.detail;
  if (e.code === "UNAUTHENTICATED") return "The key was not accepted: it may be wrong, expired or revoked. Make a new one in the dashboard (Integrations > Excel and Sheets).";
  return e.detail ?? e.message ?? e.code;
}

/**
 * Error reply for the table routes: a one-row table (status, code, message, retry_after_s) in the format the caller
 * asked for, with the real HTTP status, Retry-After and X-Error-Code. A sheet that imports it shows the reason.
 * With `?errors=200` (for WEBSERVICE, which gives #VALUE! for any non-200 reply and so cannot show the reason) the
 * reply status is 200 and the table's `status` column still carries the real one; X-Error-Code stays too.
 * @param {unknown} err
 * @param {URLSearchParams} [query]
 */
export function tableError(err, query) {
  const e = asBridgeError(err);
  let format = "csv";
  try {
    format = formatParam(query ?? new URLSearchParams());
  } catch {
    /* a bad ?format= is what failed: answer CSV */
  }
  const retry = e.retryAfterMs !== undefined ? Math.max(1, Math.ceil(e.retryAfterMs / 1000)) : null;
  const rec = { status: e.status, code: e.code, message: plainReason(e), retry_after_s: retry };
  const reply = tableReply({ format, columns: ["status", "code", "message", "retry_after_s"], records: [rec] });
  const soft = query?.get?.("errors") === "200";
  return new Reply(soft ? 200 : e.status, reply.body, { ...reply.headers, "Cache-Control": "no-store", "X-Error-Code": e.code, ...errorHeaders(e) });
}
