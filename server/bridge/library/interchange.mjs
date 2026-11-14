/**
 * Import and export of collections as CSV or JSON. Pure functions.
 *
 * CSV export:  header `symbol,exchange,kind,underlying,expiry,strike,right`, one row per symbol (an option universe exports
 *              the symbols it resolves to at that moment). Cells that start with = + - @ get a leading apostrophe (core toCsv).
 * CSV import:  a column named symbol (also ticker, instrument, canonical); or, with no header, the first column. Other columns
 *              are ignored. A leading apostrophe added by a spreadsheet is removed. Blank lines are skipped.
 * JSON export: { version: 1, exportedAt, collection: { name, description, tags, kind, symbols | universe } }, which JSON import
 *              reads back. JSON import also takes a plain array of symbols, a bare collection object, and { collections: [...] }.
 */
import { BridgeError } from "../core/errors.mjs";
import { toCsv } from "../core/http.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";

export const CSV_COLUMNS = Object.freeze(["symbol", "exchange", "kind", "underlying", "expiry", "strike", "right"]);
const SYMBOL_HEADERS = new Set(["symbol", "ticker", "instrument", "canonical", "symbols"]);
export const EXPORT_VERSION = 1;

/** CSV text for a list of canonical symbols. */
export function symbolsToCsv(symbols) {
  const rows = [[...CSV_COLUMNS]];
  for (const s of symbols) {
    let p = null;
    try {
      p = parseSymbol(s);
    } catch {
      /* a stored symbol is always canonical; a row of just the text is still better than a crash */
    }
    rows.push([s, p?.exchange ?? "", p?.kind ?? "", p?.underlying ?? "", p?.expiry ?? "", p?.strike ?? "", p?.right ?? ""]);
  }
  return toCsv(rows);
}

/** RFC 4180 reader: quoted cells, doubled quotes, CRLF or LF. Returns rows of cells. */
export function parseCsv(text) {
  const src = String(text).replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let any = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      any = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
      any = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      if (any || cell !== "") {
        row.push(cell);
        rows.push(row);
      }
      row = [];
      cell = "";
      any = false;
    } else {
      cell += ch;
      any = true;
    }
  }
  if (quoted) throw new BridgeError("VALIDATION_FAILED", "The CSV has an opening quote that is never closed.");
  if (any || cell !== "") {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/**
 * Symbols from CSV text.
 * @returns {{ values: string[], line: number[] }}  raw symbol text per data row and its 1-based line number
 */
export function symbolsFromCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new BridgeError("VALIDATION_FAILED", "The CSV is empty. Put one symbol per line, with an optional header named symbol.");
  const headerIdx = rows[0].findIndex((c) => SYMBOL_HEADERS.has(c.trim().toLowerCase()));
  let col = 0;
  let start = 0;
  if (headerIdx >= 0) {
    col = headerIdx;
    start = 1;
  } else {
    let parses = true;
    try {
      parseSymbol(unguard(rows[0][0]));
    } catch {
      parses = false;
    }
    if (!parses) start = 1; // the first line is a header with another name; its first column is the symbol column
  }
  const values = [];
  const line = [];
  for (let i = start; i < rows.length; i += 1) {
    const v = unguard(rows[i][col] ?? "");
    if (v === "") continue;
    values.push(v);
    line.push(i + 1);
  }
  return { values, line };
}

/** Remove the apostrophe a spreadsheet or toCsv puts in front of a cell that would otherwise look like a formula. */
function unguard(cell) {
  const s = String(cell ?? "").trim();
  return s.startsWith("'") ? s.slice(1).trim() : s;
}

/** The JSON file for one collection view. */
export function toExportJson(view, { now = Date.now() } = {}) {
  const c = { name: view.name, description: view.description, tags: view.tags, kind: view.kind };
  if (view.kind === "static") c.symbols = view.symbols;
  else c.universe = view.universe;
  return { version: EXPORT_VERSION, exportedAt: new Date(now).toISOString(), collection: c };
}

/**
 * Collection bodies from a parsed JSON import, ready for the create checks. A plain array is one static collection.
 * @param {unknown} data
 * @param {{ name?: string, tags?: string[], description?: string }} o  overrides from the request (a single collection only)
 * @returns {object[]}
 */
export function collectionsFromJson(data, o = {}) {
  let list;
  if (Array.isArray(data)) list = [{ symbols: data }];
  else if (data && typeof data === "object" && Array.isArray(data.collections)) list = data.collections;
  else if (data && typeof data === "object" && data.collection && typeof data.collection === "object") list = [data.collection];
  else if (data && typeof data === "object") list = [data];
  else throw new BridgeError("VALIDATION_FAILED", "The JSON is not a collection: send { name, kind, symbols | universe }, a list of symbols, or a file this Bridge exported.");
  if (!list.length) throw new BridgeError("VALIDATION_FAILED", "The JSON holds no collections.");
  if (list.length > 100) throw new BridgeError("VALIDATION_FAILED", "At most 100 collections can be imported at once.");
  return list.map((c, i) => {
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new BridgeError("VALIDATION_FAILED", `collections.${i} is not a collection.`, { errors: [{ path: `collections.${i}`, message: "not an object" }] });
    // Only the fields of a definition: ids, dates and anything else another export carried are ignored.
    const body = {};
    for (const k of ["name", "description", "tags", "kind", "symbols", "universe"]) if (c[k] !== undefined) body[k] = c[k];
    if (list.length === 1) {
      if (o.name !== undefined) body.name = o.name;
      if (o.tags !== undefined) body.tags = o.tags;
      if (o.description !== undefined) body.description = o.description;
    }
    return body;
  });
}
