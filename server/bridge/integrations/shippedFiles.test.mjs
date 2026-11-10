/**
 * Checks the files shipped in integrations/ and sdk/: AmiBroker formats match what /xl/history emits, no API key is
 * ever written into a shipped file, the AFL include reads the key from the environment or a key file, and every /xl
 * path the examples use exists.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { workbookSheets } from "../dashboard/workbook-core.js";
import { ROUTES } from "./module.mjs";
import { AMIBROKER_EOD_COLUMNS, AMIBROKER_INTRADAY_COLUMNS } from "./xl.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const walk = (dir) =>
  readdirSync(join(ROOT, dir)).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f === "__pycache__") return [];
    return statSync(join(ROOT, p)).isDirectory() ? walk(p) : [p];
  });
const SHIPPED = [...walk("integrations"), ...walk("sdk")];

describe("AmiBroker formats", () => {
  const formatColumns = (file) => {
    const line = read(`integrations/amibroker/${file}`).split(/\r?\n/).find((l) => l.startsWith("$FORMAT "));
    return line.slice(8).split(",").map((c) => c.trim().replace(/^Date_YMD$/i, "Date"));
  };
  it("intraday and EOD formats match the CSV /xl/history?layout=amibroker writes", () => {
    expect(formatColumns("mrchartist-intraday.format")).toEqual([...AMIBROKER_INTRADAY_COLUMNS]);
    expect(formatColumns("mrchartist-eod.format")).toEqual([...AMIBROKER_EOD_COLUMNS]);
  });
  it("skip the header line and use commas", () => {
    for (const f of ["mrchartist-intraday.format", "mrchartist-eod.format"]) {
      const src = read(`integrations/amibroker/${f}`);
      expect(src).toMatch(/^\$SKIPLINES 1$/m);
      expect(src).toMatch(/^\$SEPARATOR ,$/m);
      for (const line of src.trim().split(/\r?\n/)) expect(line, f).toMatch(/^\$[A-Z]+ /);
    }
  });
});

describe("keys never live in shipped files", () => {
  it("no Bridge API key literal anywhere", () => {
    for (const f of SHIPPED) {
      if (/\.(png|ico)$/.test(f)) continue;
      // the tests' fake key "mcb_test_key" is not a real key format (mcb_<keyId>_<secret>)
      expect(read(f), f).not.toMatch(/mcb_[A-Za-z0-9]{6,}_[A-Za-z0-9]{12,}/);
    }
  });
  it("the AFL include reads the key from the environment or a key file, and the example never holds one", () => {
    const inc = read("integrations/amibroker/mrchartist-bridge.afl");
    expect(inc).toMatch(/MCB_AMIBROKER_KEY/);
    expect(inc).toMatch(/\.mc-bridge\\\\amibroker\.key/);
    expect(inc).toMatch(/ExpandEnvironmentStrings/);
    const ex = read("integrations/amibroker/example-display.afl");
    expect(ex).toMatch(/#include_once <mrchartist-bridge\.afl>/);
    expect(ex).not.toMatch(/key=|mcb_/);
  });
  it("INT-05: every name a Power Query file reads is a plain cell range in the workbook, never a formula name", () => {
    const { names } = workbookSheets({ host: "http://127.0.0.1:4300" });
    for (const f of ["integrations/excel/history.pq", "integrations/excel/chain.pq", "integrations/excel/quotes.pq"]) {
      const used = [...read(f).matchAll(/(?:Cell\(|Name = )"([A-Za-z]+)"/g)].map((m) => m[1]);
      expect(used.length, f).toBeGreaterThan(0);
      for (const name of used) {
        // Excel.CurrentWorkbook() returns tables, named ranges and dynamic arrays; a name that holds a formula is not one.
        expect(names[name], `${f} reads ${name}`).toMatch(/^[A-Za-z]+!\$[A-Z]+\$\d+(:\$[A-Z]+\$\d+)?$/);
      }
      expect(read(f), f).not.toMatch(/"BridgeKey"/);
    }
  });
  it("Power Query and Apps Script send the key as a header", () => {
    for (const f of ["integrations/excel/history.pq", "integrations/excel/chain.pq", "integrations/excel/quotes.pq"]) {
      expect(read(f), f).toMatch(/Authorization = "Bearer " & Key/);
      expect(read(f), f).not.toMatch(/key\s*=/);
    }
    const gs = read("integrations/google-sheets/bridge.gs");
    expect(gs).toMatch(/Authorization: "Bearer " \+ cfg\.key/);
    expect(gs).not.toMatch(/[?&]key=/);
  });
});

describe("examples only use routes that exist and are read-only", () => {
  const known = new Set(ROUTES.map(([, p]) => p));
  it("every /xl path mentioned exists", () => {
    for (const f of SHIPPED.filter((x) => x.startsWith("integrations"))) {
      for (const m of read(f).matchAll(/\/(xl)\/([a-z]+)/g)) expect(known.has(`/${m[1]}/${m[2]}`), `${relative(ROOT, join(ROOT, f))}: ${m[0]}`).toBe(true);
    }
  });
  it("no spreadsheet or AmiBroker code calls an order route", () => {
    for (const f of SHIPPED.filter((x) => x.startsWith("integrations") && !x.endsWith(".md"))) expect(read(f), f).not.toMatch(/\/v1\/orders|placeOrder|place_order/);
  });
});
