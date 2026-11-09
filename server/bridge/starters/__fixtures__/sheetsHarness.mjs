// Runs the Google Sheets starter's Code.gs the way Apps Script would, against a real Bridge on loopback, and prints
// the result of =BRIDGE_QUOTES(A1:A2) as JSON. Apps Script's fetch is synchronous, so each fetch runs in a child
// process (spawnSync). Only the few Apps Script services Code.gs uses are stubbed.
//   node sheetsHarness.mjs <path to Code.gs> <Bridge url> <key>
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const [, , file, url, key] = process.argv;

const FETCH = `const [url, auth] = process.argv.slice(1);
fetch(url, { headers: { Authorization: auth }, redirect: "manual" }).then(async (r) => { process.stdout.write(JSON.stringify({ status: r.status, text: await r.text(), headers: Object.fromEntries(r.headers) })); });`;

/** The CSV the Bridge sends, read the way Utilities.parseCsv does (quotes, doubled quotes). */
function parseCsv(text) {
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
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) (row.push(cell), rows.push(row));
  return rows;
}

const store = new Map();
const props = { BRIDGE_URL: url, BRIDGE_KEY: key };
const sandbox = {
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null }) },
  CacheService: { getScriptCache: () => ({ get: (k) => store.get(k) ?? null, put: (k, v) => store.set(k, v) }) },
  UrlFetchApp: {
    fetch(target, opts) {
      const r = spawnSync(process.execPath, ["-e", FETCH, target, opts.headers.Authorization], { encoding: "utf8" });
      const out = JSON.parse(r.stdout);
      return { getResponseCode: () => out.status, getContentText: () => out.text, getHeaders: () => out.headers };
    },
  },
  Utilities: { parseCsv },
  console,
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(file, "utf8"), sandbox, { filename: "Code.gs" });
const table = vm.runInContext('BRIDGE_QUOTES([["NSE:RELIANCE"], ["NSE:NIFTY"]])', sandbox);
process.stdout.write(JSON.stringify(table));
