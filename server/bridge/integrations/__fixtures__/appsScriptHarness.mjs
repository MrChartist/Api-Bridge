/**
 * A stand-in for Google's Apps Script services, to run integrations/google-sheets/bridge.gs in a node:vm sandbox.
 * The sheet refuses a setValues block whose size differs from its range, as Google does (an unchecked stand-in once
 * hid a refresh that threw on every table sheet in demo mode). No network here; callers supply `respond`.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

export const SOURCE = readFileSync(new URL("../../../../integrations/google-sheets/bridge.gs", import.meta.url), "utf8");
export const KEY = "mcb_abcdefghij_SECRETSECRETSECRETSECRET";

/** Small RFC 4180 parser, like Utilities.parseCsv. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") (row.push(cell), (cell = ""));
    else if (c === "\r") continue;
    else if (c === "\n") (row.push(cell), rows.push(row), (row = []), (cell = ""));
    else cell += c;
  }
  if (cell || row.length) (row.push(cell), rows.push(row));
  return rows;
}

/** A sheet stand-in: a grid with getRange(...).getValues/setValues/clearContent/setValue. */
export function makeSheet(name, grid = {}) {
  const cells = new Map(Object.entries(grid));
  const key = (r, c) => `${r},${c}`;
  const range = (r, c, nr = 1, nc = 1) => ({
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cells.get(key(r + i, c + j)) ?? "")),
    setValues(v) {
      if (v.length !== nr || v.some((row) => row.length !== nc)) {
        throw new Error(`The number of columns in the data does not match the number of columns in the range. The data has ${v[0]?.length} but the range has ${nc}.`);
      }
      v.forEach((row, i) => row.forEach((x, j) => cells.set(key(r + i, c + j), x)));
      return this;
    },
    setValue(x) {
      cells.set(key(r, c), x);
      return this;
    },
    clearContent() {
      for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) cells.delete(key(r + i, c + j));
      return this;
    },
    setFontWeight: () => range(r, c, nr, nc),
    setFontSize: () => range(r, c, nr, nc),
    setFontStyle: () => range(r, c, nr, nc),
  });
  return {
    name,
    cells,
    getRange: (a, b, c, d) => (typeof a === "string" ? range(Number(a.slice(1)), a.charCodeAt(0) - 64) : range(a, b, c, d)),
    getLastRow: () => Math.max(0, ...[...cells.keys()].map((k) => Number(k.split(",")[0]))),
    setFrozenRows() {},
    at: (r, c) => cells.get(key(r, c)),
  };
}

/** Load bridge.gs with fake Google services. `respond(url, options)` plays the Bridge. */
export function load({ respond, sheets = {}, props = { BRIDGE_URL: "https://tunnel.example.com/", BRIDGE_KEY: KEY } } = {}) {
  const fetches = [];
  const triggers = [];
  const cache = new Map();
  const ctx = {
    UrlFetchApp: {
      fetch(url, options) {
        fetches.push({ url, options });
        const r = respond(url, options);
        return { getResponseCode: () => r.status ?? 200, getContentText: () => r.body ?? "", getHeaders: () => r.headers ?? {} };
      },
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v) }) },
    Utilities: { parseCsv, formatDate: () => "2026-11-09 11:00:27" },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { getActive: () => ({ getSheetByName: (n) => sheets[n] ?? null, toast() {} }) },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => ({
        timeBased: () => ({
          everyMinutes(n) {
            return { create: () => triggers.push({ fn, minutes: n, getHandlerFunction: () => fn }) };
          },
        }),
      }),
    },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);
  return { ctx, fetches, triggers };
}

