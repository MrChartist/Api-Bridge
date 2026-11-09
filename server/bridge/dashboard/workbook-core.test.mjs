import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import * as zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildXlsx, cellRef, crc32, prefixNewFunctions, zipStore } from "./xlsx-core.js";
import { ADDRESS_LIMIT, CAPACITY, SAMPLE_SYMBOLS, SHEET_CHOICES, TABLES, bridgeWorkbook, fieldExpr, lineFormula, numberField, requestAddress, sheetNames, staticAnswer, textField, workbookSheets } from "./workbook-core.js";
import { FUND_COLUMNS, HOLDING_COLUMNS, ORDER_COLUMNS, POSITION_COLUMNS } from "../integrations/portfolio.mjs";
import { DEFAULT_QUOTE_FIELDS } from "../integrations/quotes.mjs";
import { FRESHNESS_COLUMNS } from "../integrations/table.mjs";

/** Read a stored ZIP: { name → text }, checking each CRC. */
function unzip(bytes) {
  const out = {};
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  while (dv.getUint32(p, true) === 0x04034b50) {
    const method = dv.getUint16(p + 8, true);
    const crc = dv.getUint32(p + 14, true);
    const size = dv.getUint32(p + 18, true);
    const nlen = dv.getUint16(p + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + nlen));
    const data = bytes.subarray(p + 30 + nlen, p + 30 + nlen + size);
    expect(method).toBe(0);
    expect(crc32(data)).toBe(crc);
    out[name] = new TextDecoder().decode(method ? inflateRawSync(data) : data);
    p += 30 + nlen + size;
  }
  expect(dv.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
  return out;
}

/** A small XML well-formedness check: one root, tags nest, attributes are quoted, entities are known. Throws on a fault. */
function assertWellFormed(xml, name) {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, "");
  const stack = [];
  let roots = 0;
  let i = 0;
  const fail = (m) => {
    throw new Error(`${name}: ${m} near "${body.slice(Math.max(0, i - 30), i + 30)}"`);
  };
  while (i < body.length) {
    const lt = body.indexOf("<", i);
    const text = body.slice(i, lt === -1 ? body.length : lt);
    for (const m of text.matchAll(/&([^;\s]{0,10});?/g)) if (!/^(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+)$/.test(m[1]) || !m[0].endsWith(";")) fail(`bad entity ${m[0]}`);
    if (text.includes(">") && lt !== -1) fail("stray >");
    if (lt === -1) break;
    i = lt;
    const gt = body.indexOf(">", i);
    if (gt === -1) fail("unterminated tag");
    const tag = body.slice(i + 1, gt);
    if (tag.startsWith("/")) {
      const open = stack.pop();
      if (open !== tag.slice(1).trim()) fail(`closing ${tag} does not match ${open}`);
    } else {
      const m = /^([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)$/.exec(tag);
      if (!m) fail(`bad tag <${tag.slice(0, 60)}>`);
      if (!stack.length) roots += 1;
      if (!m[3]) stack.push(m[1]);
    }
    i = gt + 1;
  }
  if (stack.length) fail(`unclosed ${stack.at(-1)}`);
  expect(roots, name).toBe(1);
}

describe("xlsx writer", () => {
  it("CRC-32 matches zlib's and cell references run past Z", () => {
    const b = new TextEncoder().encode("The quick brown fox");
    if (typeof zlib.crc32 === "function") expect(crc32(b)).toBe(zlib.crc32(b));
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect([cellRef(0, 0), cellRef(9, 25), cellRef(0, 26), cellRef(2, 701)]).toEqual(["A1", "Z10", "AA1", "ZZ3"]);
  });

  it("writes a stored ZIP with the workbook parts, inline text, numbers, formulas, styles and defined names", () => {
    const z = unzip(buildXlsx({ sheets: [{ name: "One/Two", rows: [["A & B", 1.5, { f: "=SUM(B1:B1)" }, { v: "x", s: "input" }, { f: "=1", s: "number" }]] }], names: { BridgeKey: "Setup!$B$3" } }));
    expect(Object.keys(z).sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
    expect(z["xl/workbook.xml"]).toContain('<sheet name="One Two" sheetId="1" r:id="rId1"/>');
    expect(z["xl/workbook.xml"]).toContain('<definedName name="BridgeKey">Setup!$B$3</definedName>');
    const sh = z["xl/worksheets/sheet1.xml"];
    expect(sh).toContain("<t xml:space=\"preserve\">A &amp; B</t>");
    expect(sh).toContain('<c r="B1" s="1"><v>1.5</v></c>');
    expect(sh).toContain("<f>SUM(B1:B1)</f>");
    expect(sh).toContain('<c r="D1" s="4" t="inlineStr">');
    expect(sh).toContain('<c r="E1" s="6"><f>1</f></c>');
    expect(zipStore([]).length).toBe(22);
    for (const [n, x] of Object.entries(z)) assertWellFormed(x, n);
  });

  it("freeze panes, validations and a tab colour keep the sheet XML in the order Excel requires", () => {
    const z = unzip(buildXlsx({ sheets: [{ name: "S", rows: [["a"], ["b"]], freeze: { row: 1 }, validations: [{ ref: "B8", list: ["Yes", "No"] }], tab: "FF999999", widths: [20] }] }));
    const sh = z["xl/worksheets/sheet1.xml"];
    expect(sh.indexOf("<sheetPr>")).toBeLessThan(sh.indexOf("<sheetViews>"));
    expect(sh.indexOf("<sheetViews>")).toBeLessThan(sh.indexOf("<cols>"));
    expect(sh.indexOf("<cols>")).toBeLessThan(sh.indexOf("<sheetData>"));
    expect(sh.indexOf("<sheetData>")).toBeLessThan(sh.indexOf("<dataValidations"));
    expect(sh).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(sh).toContain('<formula1>&quot;Yes,No&quot;</formula1>');
    assertWellFormed(sh, "sheet1");
  });
});

describe("the _xlfn. prefix (without it Excel shows #NAME?)", () => {
  it("is added to functions newer than Excel 2007, once", () => {
    expect(prefixNewFunctions('VALUE(WEBSERVICE("http://x/"&ENCODEURL(A2)))')).toBe('VALUE(_xlfn.WEBSERVICE("http://x/"&_xlfn.ENCODEURL(A2)))');
    expect(prefixNewFunctions('NUMBERVALUE(A1,".")')).toBe('_xlfn.NUMBERVALUE(A1,".")');
    expect(prefixNewFunctions("TEXTJOIN(\",\",TRUE,A1:A3)")).toBe('_xlfn.TEXTJOIN(",",TRUE,A1:A3)');
    expect(prefixNewFunctions("FILTER(A1:A3,B1:B3>1)")).toBe("_xlfn._xlws.FILTER(A1:A3,B1:B3>1)");
    expect(prefixNewFunctions("_xlfn.WEBSERVICE(A1)")).toBe("_xlfn.WEBSERVICE(A1)");
    expect(prefixNewFunctions("webservice(A1)")).toBe("_xlfn.WEBSERVICE(A1)");
  });
  it("leaves old functions and text in quotes alone", () => {
    expect(prefixNewFunctions('IFERROR(INDEX(A1:A3,MATCH("WEBSERVICE(",B1:B3,0)),"ENCODEURL(")')).toBe('IFERROR(INDEX(A1:A3,MATCH("WEBSERVICE(",B1:B3,0)),"ENCODEURL(")');
    expect(prefixNewFunctions("MYWEBSERVICE(1)+SUM(1)")).toBe("MYWEBSERVICE(1)+SUM(1)");
    expect(prefixNewFunctions('IF(A1="a ""WEBSERVICE(""",1,2)')).toBe('IF(A1="a ""WEBSERVICE(""",1,2)');
  });
});

describe("the Bridge workbook", () => {
  const host = "http://127.0.0.1:4300";
  const parts = (d) => unzip(bridgeWorkbook({ host, ...d }));
  const sheetXmls = (z) => Object.entries(z).filter(([n]) => n.startsWith("xl/worksheets/"));

  it("has Setup, Watchlist, Positions, Holdings, Funds, Orders and Feed, or only what was chosen", () => {
    const z = parts({});
    expect([...z["xl/workbook.xml"].matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1])).toEqual(["Setup", "Watchlist", "Positions", "Holdings", "Funds", "Orders", "Feed"]);
    expect(sheetNames()).toEqual(["Setup", "Watchlist", "Positions", "Holdings", "Funds", "Orders", "Feed"]);
    const some = workbookSheets({ host, include: { positions: false, holdings: false, funds: false, orders: false } });
    expect(some.sheets.map((s) => s.name)).toEqual(["Setup", "Watchlist", "Feed"]);
    expect(Object.keys(some.datasets)).toEqual(["quotes"]);
    const book = workbookSheets({ host, include: { watchlist: false, holdings: false, funds: false, orders: false } });
    expect(book.sheets.map((s) => s.name)).toEqual(["Setup", "Positions", "Feed"]);
    expect(book.names.WatchlistSymbols).toBeUndefined();
    expect(sheetNames({ watchlist: false })).not.toContain("Watchlist");
    expect(SHEET_CHOICES.map((c) => c.id)).toEqual(["watchlist", "positions", "holdings", "funds", "orders"]);
  });

  it("every function newer than Excel 2007 is stored with the _xlfn. prefix: no #NAME? on open", () => {
    const z = parts({});
    const all = Object.values(z).join("\n");
    for (const fn of ["WEBSERVICE", "ENCODEURL", "NUMBERVALUE"]) {
      expect(all, fn).toContain(`_xlfn.${fn}(`);
      expect(all, `${fn} without prefix`).not.toMatch(new RegExp(`(^|[^.\\w])${fn}\\(`));
    }
    // and the old ones are not prefixed
    for (const fn of ["IFERROR", "INDEX", "MATCH", "SUBSTITUTE", "COUNTIF", "SUMPRODUCT"]) {
      expect(all, fn).toContain(`${fn}(`);
      expect(all, fn).not.toContain(`_xlfn.${fn}(`);
    }
    // nothing in the workbook needs a dynamic-array function (Excel 2013 and later on Windows is enough)
    expect(all).not.toMatch(/TEXTSPLIT|XLOOKUP|FILTERXML|TEXTJOIN|LET\(|FILTER\(/);
  });

  it("the request addresses: one per sheet, the key and the refresh stamp from names, tsv, a symbol list from the Watchlist", () => {
    const { sheets, datasets } = workbookSheets({ host });
    const feed = sheets.at(-1);
    const rowOf = (id) => feed.rows[datasets[id].row - 1];
    expect(rowOf("quotes")[1].f).toBe('=BridgeURL&"/xl/quotes?format=tsv&fields=ltp,chg,pct,volume&symbols="&$P$62&"&key="&BridgeKey&"&_="&RefreshStamp');
    expect(rowOf("positions")[1].f).toBe('=BridgeURL&"/xl/positions?format=tsv&key="&BridgeKey&"&_="&RefreshStamp');
    expect(rowOf("orders")[1].f).toBe(`=BridgeURL&"/xl/orders?format=tsv&limit=${CAPACITY.orders}&key="&BridgeKey&"&_="&RefreshStamp`);
    expect(requestAddress("/xl/funds")).toBe('=BridgeURL&"/xl/funds?format=tsv&key="&BridgeKey&"&_="&RefreshStamp');
    // the answer is one WEBSERVICE per request, with carriage returns removed and a failed call turned into a blank
    expect(rowOf("quotes")[2].f).toBe('=IFERROR(SUBSTITUTE(WEBSERVICE(B4),CHAR(13),""),"")');
    expect(rowOf("positions")[2].f).toBe('=IFERROR(SUBSTITUTE(WEBSERVICE(B5),CHAR(13),""),"")');
    // symbols are joined from the Watchlist, "&" and the like encoded, ":" kept readable
    const cumulative = feed.rows[12][15].f;
    expect(cumulative).toBe('=IF(LEN(TRIM(Watchlist!$A5))=0,$P12,$P12&IF(LEN($P12)=0,"",",")&SUBSTITUTE(ENCODEURL(TRIM(Watchlist!$A5)),"%3A",":"))');
    expect(feed.rows[11 + CAPACITY.quotes][15].f).toContain("Watchlist!$A54");
  });

  it("the cutting formulas: a line of the answer and a field of a line", () => {
    expect(lineFormula("Feed!$C$4", 1)).toBe('=IFERROR(MID(Feed!$C$4,1,FIND("~~",SUBSTITUTE(Feed!$C$4,CHAR(10),"~~",1))-1),"")');
    expect(lineFormula("Feed!$C$4", 3)).toBe('=IFERROR(MID(Feed!$C$4,FIND("~~",SUBSTITUTE(Feed!$C$4,CHAR(10),"~~",2))+1,FIND("~~",SUBSTITUTE(Feed!$C$4,CHAR(10),"~~",3))-FIND("~~",SUBSTITUTE(Feed!$C$4,CHAR(10),"~~",2))-1),"")');
    expect(fieldExpr("$A12", 1)).toBe('MID($A12,1,FIND("~~",SUBSTITUTE($A12&CHAR(9),CHAR(9),"~~",1))-1)');
    expect(textField("$A12", 2)).toMatch(/^=IFERROR\(MID\(\$A12,FIND\("~~",SUBSTITUTE\(\$A12&CHAR\(9\),CHAR\(9\),"~~",1\)\)\+1,/);
    // a number: blank stays blank (NUMBERVALUE("") is 0), the "." decimal point is explicit
    expect(numberField("$A12", 2)).toMatch(/^=IFERROR\(IF\(MID\(.*\)="","",NUMBERVALUE\(MID\(.*\),"\."\)\),""\)$/);
  });

  it("Watchlist: a filled sample, symbols in column A, one INDEX/MATCH row per symbol, an IFERROR on every value, a Status", () => {
    const { sheets } = workbookSheets({ host });
    const wl = sheets.find((s) => s.name === "Watchlist");
    expect(wl.rows[3].map((c) => c.v)).toEqual(["Symbol", "Last", "Change", "Change %", "Volume", "As of (IST)", "Age (s)", "Class", "Source", "Stale", "Error", "Feed row"]);
    expect(wl.rows.slice(4, 4 + SAMPLE_SYMBOLS.length).map((r) => r[0].v)).toEqual([...SAMPLE_SYMBOLS]);
    expect(wl.rows).toHaveLength(4 + CAPACITY.quotes);
    expect(wl.rows[4][1].f).toBe('=IF($L5="","",IFERROR(IF(INDEX(Feed!$C$13:$C$62,$L5)="","",NUMBERVALUE(INDEX(Feed!$C$13:$C$62,$L5),".")),""))');
    expect(wl.rows[4][11].f).toBe('=IF(LEN(TRIM($A5))=0,"",IFERROR(MATCH(TRIM($A5),Feed!$B$13:$B$62,0),""))');
    for (const row of wl.rows.slice(4)) for (const c of row.slice(1, 10)) expect(c.f, "every value cell is guarded").toMatch(/IFERROR/);
    expect(wl.rows[1][0].f).toBe("=Feed!$B$10");
    // the person's own list wins over the sample, and is capped to the room there is
    const mine = workbookSheets({ host, symbols: ["NSE:SBIN", "NFO:NIFTY-2026-11-24-FUT"] }).sheets.find((s) => s.name === "Watchlist");
    expect(mine.rows.slice(4, 7).map((r) => r[0].v)).toEqual(["NSE:SBIN", "NFO:NIFTY-2026-11-24-FUT", ""]);
    const many = workbookSheets({ host, symbols: Array.from({ length: 80 }, (_, i) => `NSE:S${i}`) }).sheets.find((s) => s.name === "Watchlist");
    expect(many.rows[4 + CAPACITY.quotes - 1][0].v).toBe("NSE:S49");
  });

  it("the Status says what happened in words: no answer, errors, demo, stale, too many symbols", () => {
    const feed = workbookSheets({ host }).sheets.at(-1);
    const status = feed.rows[9][1].f;
    expect(status).toContain("NO ANSWER: the Bridge did not reply");
    expect(status).toContain(`LEN($B$4)>${ADDRESS_LIMIT}`);
    expect(status).toContain("TOO MANY SYMBOLS");
    expect(status).toContain('COUNTIF($M$13:$M$62,"DEMO")>0,"DEMO DATA, not real prices. "');
    expect(status).toContain("symbols could not be priced (see the Error column)");
    expect(status).toContain('" stale"');
    expect(status).toContain('" not realtime"');
    expect(status).toContain("newest ");
    expect(status).toContain("s old");
    const setup = workbookSheets({ host }).sheets[0];
    expect(setup.rows[3][1].f).toBe("=Feed!$B$10");
  });

  it("Positions, Holdings, Funds and Orders: headings, one formula per cell, a status line, the P&L total", () => {
    const { sheets } = workbookSheets({ host });
    for (const [name, id, rows] of [["Positions", "positions", CAPACITY.positions], ["Holdings", "holdings", CAPACITY.holdings], ["Funds", "funds", CAPACITY.funds], ["Orders", "orders", CAPACITY.orders]]) {
      const sh = sheets.find((s) => s.name === name);
      const heads = TABLES[id].slice(0, -1).map(([h]) => h);
      expect(sh.rows[3].map((c) => c.v), name).toEqual(heads);
      expect(sh.rows, name).toHaveLength(4 + rows);
      for (const row of sh.rows.slice(4)) {
        expect(row, name).toHaveLength(heads.length);
        for (const c of row) expect(c.f, name).toMatch(/^=IFERROR\(/);
      }
      expect(sh.rows[1][0].f, name).toContain("NO ANSWER");
      expect(sh.freeze).toEqual({ row: 4 });
    }
    const pos = sheets.find((s) => s.name === "Positions");
    expect(pos.rows[2][7].f).toBe(`=SUM(H5:H${4 + CAPACITY.positions})`);
    expect(pos.rows[1][0].f).toContain('FIND(CHAR(9)&"DEMO"&CHAR(10),Feed!$C$5)');
  });

  it("the columns match what the Bridge serves, in the same order", () => {
    const names = (id) => TABLES[id].map(([, c]) => c);
    expect(names("positions")).toEqual([...POSITION_COLUMNS, "demo"]);
    expect(names("holdings")).toEqual([...HOLDING_COLUMNS, "demo"]);
    expect(names("funds")).toEqual([...FUND_COLUMNS, "demo"]);
    expect(names("orders")).toEqual([...ORDER_COLUMNS, "demo"]);
    // quotes: symbol, the fields the workbook asks for, the freshness columns, error, demo
    expect(names("quotes")).toEqual(["symbol", "ltp", "chg", "pct", "volume", ...FRESHNESS_COLUMNS, "error", "demo"]);
    expect(DEFAULT_QUOTE_FIELDS).toEqual(["ltp", "chg", "pct", "volume"]);
    expect(FRESHNESS_COLUMNS).toEqual(["as_of", "age_s", "class", "source", "stale"]);
  });

  it("the key: never in the file by default, never in a cell when stored, and Setup says which case it is", () => {
    const plain = parts({});
    expect(Object.values(plain).join("\n")).not.toMatch(/mcb_[A-Za-z0-9]{6,}_/);
    const stored = parts({ key: "mcb_abcdefghij_KEYKEYKEYKEYKEYKEYKEYKEY" });
    const where = Object.entries(stored).filter(([, x]) => x.includes("KEYKEYKEY")).map(([n]) => n);
    expect(where).toEqual(["xl/workbook.xml"]);
    expect(stored["xl/workbook.xml"]).toContain('<definedName name="BridgeKeyStored">&quot;mcb_abcdefghij_KEYKEYKEYKEYKEYKEYKEYKEY&quot;</definedName>');
    expect(plain["xl/workbook.xml"]).toContain('<definedName name="BridgeKeyStored">&quot;&quot;</definedName>');
    expect(plain["xl/workbook.xml"]).toContain('<definedName name="BridgeKey">IF(Setup!$B$6&lt;&gt;&quot;&quot;,Setup!$B$6,BridgeKeyStored)</definedName>');
    expect(plain["xl/workbook.xml"]).toContain('<definedName name="BridgeURL">Setup!$B$5</definedName>');
    expect(plain["xl/workbook.xml"]).toContain('<definedName name="WatchlistSymbols">Watchlist!$A$5:$A$54</definedName>');
    const setup = workbookSheets({ host }).sheets[0];
    expect(setup.rows[5]).toEqual([{ v: "Key (read-only)", s: "status" }, { v: "", s: "input" }]);
    expect(setup.rows[6][1].f).toContain("Clear the cell before you share or email this file");
    expect(setup.rows[6][1].f).toContain("A key is stored inside this file");
    expect(setup.rows[6][1].f).toContain("No key yet");
    expect(setup.rows[4][1]).toEqual({ v: host, s: "input" });
  });

  it("Setup: short correct steps (Windows only, F9, rates, IST), not the old wrong ones", () => {
    const setup = workbookSheets({ host, madeAt: "2026-11-09" }).sheets[0];
    const text = setup.rows.flat().map((c) => (c && typeof c === "object" ? c.v ?? "" : c)).join("\n");
    expect(text).toContain("Excel for Windows");
    expect(text).toContain("Excel for Mac and Excel for the web do not have it");
    expect(text).toContain("Press F9");
    expect(text).toContain("no more than once every 5 seconds");
    expect(text).toContain("All times are IST");
    expect(text).toContain("cannot place, change or cancel an order");
    expect(text).not.toMatch(/Windows or Mac/);
    expect(text).not.toContain("Data › Refresh All");
    expect(setup.validations).toEqual([{ ref: "B8", list: ["Yes", "No"] }]);
    expect(setup.rows.length).toBeLessThanOrEqual(21);
  });

  it("every part is well-formed XML, every sheet is declared and related, formulas fit Excel's limits", () => {
    const z = parts({ key: "mcb_abcdefghij_xxxxxxxxxxxxxxxxxxxx", symbols: ["NSE:M&M", 'NSE:"Q"', "NSE:<X>"] });
    for (const [n, x] of Object.entries(z)) assertWellFormed(x, n);
    const sheets = sheetXmls(z);
    expect(sheets).toHaveLength(7);
    for (let i = 1; i <= 7; i++) {
      expect(z["[Content_Types].xml"]).toContain(`/xl/worksheets/sheet${i}.xml`);
      expect(z["xl/_rels/workbook.xml.rels"]).toContain(`Id="rId${i}"`);
      expect(z["xl/workbook.xml"]).toContain(`r:id="rId${i}"`);
    }
    expect(z["xl/_rels/workbook.xml.rels"]).toContain('Id="rId8"');
    for (const [n, x] of sheets) {
      for (const m of x.matchAll(/<f>([^<]*)<\/f>/g)) {
        const f = m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
        expect(f.length, `${n} formula length`).toBeLessThan(8192);
        expect(f.startsWith("="), "no leading = in the file").toBe(false);
        // every string literal is under Excel's 255 character limit
        for (const lit of f.matchAll(/"((?:[^"]|"")*)"/g)) expect(lit[1].length).toBeLessThan(256);
        // parentheses balance outside string literals
        const bare = f.replace(/"(?:[^"]|"")*"/g, '""');
        expect([...bare].filter((c) => c === "(").length, f.slice(0, 60)).toBe([...bare].filter((c) => c === ")").length);
      }
      // inline text that came from the person is escaped
      expect(x).not.toContain("<X>");
    }
    expect(z["xl/worksheets/sheet2.xml"]).toContain("NSE:M&amp;M");
    expect(z["xl/worksheets/sheet2.xml"]).toContain("NSE:&lt;X&gt;");
    // sheet names stay within Excel's rules
    for (const s of workbookSheets({ host }).sheets) expect(s.name.length).toBeLessThanOrEqual(31);
  });

  it("the file is a few megabytes at most", () => {
    expect(bridgeWorkbook({ host }).length).toBeLessThan(3_000_000);
  });

  it("staticAnswer builds a fixed answer out of CHAR(9) and CHAR(10) pieces", () => {
    const f = staticAnswer("a\tb\r\nc\t\nlong" + "x".repeat(300) + "\n");
    expect(f.startsWith('="a"&CHAR(9)&"b"&CHAR(10)&"c"&CHAR(9)&""&CHAR(10)&"long')).toBe(true);
    expect(f.endsWith('&CHAR(10)&""')).toBe(true);
    for (const lit of f.matchAll(/"([^"]*)"/g)) expect(lit[1].length).toBeLessThanOrEqual(200);
  });
});

// The strongest check: let a real spreadsheet program calculate the workbook. LibreOffice is not on every machine,
// so this runs only where `soffice` exists. It cannot run WEBSERVICE (no network, and its own link prompt), so the
// answers are fixed here; everything else (the address, the cutting of lines and fields, the lookups, the status) is
// the real formulas.
const HAS_SOFFICE = spawnSync("soffice", ["--version"], { encoding: "utf8" }).status === 0;
describe.skipIf(!HAS_SOFFICE)("calculated by LibreOffice", () => {
  const TSV = (rows) => rows.map((r) => r.join("\t")).join("\n") + "\n";
  const quotes = TSV([
    ["symbol", "ltp", "chg", "pct", "volume", "as_of", "age_s", "class", "source", "stale", "error", "demo"],
    ["NSE:NIFTY", "24849.4", "-71.4", "-0.2865", "0", "2026-11-09 11:00:27", "0", "realtime", "broker", "false", "", ""],
    ["NSE:RELIANCE", "1458.8", "5.6", "0.3854", "431131", "2026-11-09 11:00:20", "7.5", "realtime", "stream", "false", "", ""],
    ["NSE:NOPE", "", "", "", "", "", "", "", "", "", "SYMBOL_NOT_FOUND: NSE:NOPE is not in any connected broker's instrument master.", ""],
    ["NSE:SLOW", "100", "1", "1", "5", "2026-11-09 10:00:00", "4000", "delayed", "broker", "true", "", ""],
  ]);
  const positions = TSV([
    [...POSITION_COLUMNS, "demo"],
    ["dhan-main", "live", "NFO:NIFTY-2026-11-24-FUT", "MARGIN", "-75", "24900.5", "24850", "3787.5", "0", "3787.5", "2026-11-09 11:00:27", "0", "realtime", "broker", "false", "", ""],
    ["paper-1", "paper", "NSE:RELIANCE", "CNC", "10", "1400", "1458.8", "588", "0", "588", "2026-11-09 11:00:27", "0", "realtime", "paper", "false", "", ""],
  ]);
  const funds = TSV([
    [...FUND_COLUMNS, "demo"],
    ["dhan-main", "live", "250000.5", "48210", "298210.5", "0", "250000", "", "", "2026-11-09 11:00:27", "0", "realtime", "broker", "false", "", "DEMO"],
    ["dhan-off", "live", "", "", "", "", "", "", "", "", "", "", "", "", "SESSION_EXPIRED: The broker session has expired. Log in again.", "DEMO"],
  ]);

  function calculate(d) {
    const dir = mkdtempSync(join(tmpdir(), "mcb-lo-"));
    const file = join(dir, "book.xlsx");
    writeFileSync(file, bridgeWorkbook({ host: "http://127.0.0.1:4300", ...d }));
    const r = spawnSync("soffice", ["--headless", "--convert-to", "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1", "--outdir", dir, file], { encoding: "utf8", timeout: 100_000 });
    expect(r.status, r.stderr).toBe(0);
    const sheet = (name) => {
      const csv = readFileSync(join(dir, `book-${name}.csv`), "utf8");
      const rows = [];
      let row = [];
      let cell = "";
      let q = false;
      for (let i = 0; i < csv.length; i++) {
        const c = csv[i];
        if (q) {
          if (c === '"' && csv[i + 1] === '"') (cell += '"'), i++;
          else if (c === '"') q = false;
          else cell += c;
        } else if (c === '"') q = true;
        else if (c === ",") (row.push(cell), (cell = ""));
        else if (c === "\n") (row.push(cell), rows.push(row), (row = []), (cell = ""));
        else cell += c;
      }
      return rows;
    };
    expect(readdirSync(dir).filter((f) => f.endsWith(".csv")).length).toBeGreaterThanOrEqual(3);
    return sheet;
  }

  it("cuts the answers into cells, looks rows up by symbol, labels freshness and writes the status", () => {
    const sheet = calculate({ symbols: ["NSE:RELIANCE", "NSE:NIFTY", "nse:nope", "NSE:SLOW", "NSE:MISSING"], answers: { quotes, positions, holdings: TSV([[...Array(3)]]), funds, orders: "" }, key: "mcb_abcdefghij_xxxxxxxxxxxxxxxxxxxx" });
    const wl = sheet("Watchlist");
    expect(wl[3].slice(0, 4)).toEqual(["Symbol", "Last", "Change", "Change %"]);
    // rows follow the person's order, whatever order the answer came in
    expect(wl[4].slice(0, 11)).toEqual(["NSE:RELIANCE", "1458.8", "5.6", "0.3854", "431131", "2026-11-09 11:00:20", "7.5", "realtime", "stream", "false", ""]);
    expect(wl[5].slice(0, 5)).toEqual(["NSE:NIFTY", "24849.4", "-71.4", "-0.2865", "0"]);
    // a bad symbol: blank values and the reason, matched without regard to case
    expect(wl[6].slice(0, 2)).toEqual(["nse:nope", ""]);
    expect(wl[6][10]).toMatch(/^SYMBOL_NOT_FOUND/);
    // delayed and stale rows are labelled, never hidden
    expect(wl[7].slice(1, 10)).toEqual(["100", "1", "1", "5", "2026-11-09 10:00:00", "4000", "delayed", "broker", "true"]);
    // a symbol the answer does not contain says so
    expect(wl[8][10]).toBe("not in the answer: press F9");
    // rows below the list are empty
    expect(wl[9].every((c) => c === "")).toBe(true);
    const status = wl[1][0];
    expect(status).toContain("CHECK: 1 of 5 symbols could not be priced");
    expect(status).toContain("3 prices, newest 2026-11-09 11:00:27 IST, oldest 4000 s old");
    expect(status).toContain("1 stale");
    expect(status).toContain("1 not realtime");
    expect(status).not.toContain("DEMO");
    // the Setup sheet repeats the status and checks the key
    const setup = sheet("Setup");
    expect(setup[3][1]).toBe(status);
    expect(setup[4][1]).toBe("http://127.0.0.1:4300");
    expect(setup[6][1]).toContain("A key is stored inside this file");
    // the address that went out: one request, the encoded list, the key from the name, the refresh stamp
    const feed = sheet("Feed");
    expect(feed[3][1]).toMatch(/^http:\/\/127\.0\.0\.1:4300\/xl\/quotes\?format=tsv&fields=ltp,chg,pct,volume&symbols=NSE:RELIANCE,NSE:NIFTY,nse:nope,NSE:SLOW,NSE:MISSING&key=mcb_abcdefghij_xxxxxxxxxxxxxxxxxxxx&_=\d+/);
    // positions: numbers are numbers, the total adds the rows, the status counts them
    const pos = sheet("Positions");
    expect(pos[4].slice(0, 10)).toEqual(["dhan-main", "live", "NFO:NIFTY-2026-11-24-FUT", "MARGIN", "-75", "24900.5", "24850", "3787.5", "0", "3787.5"]);
    expect(pos[5][5]).toBe("1400");
    expect(pos[2][7]).toBe("4375.5");
    expect(pos[1][0]).toBe("2 rows. Times are IST.");
    // funds: a demo marker and an account that could not answer
    const funds2 = sheet("Funds");
    expect(funds2[1][0]).toBe("2 rows. CHECK: some rows have an error (see the Error column). DEMO DATA, not real. Times are IST.");
    expect(funds2[4].slice(0, 5)).toEqual(["dhan-main", "live", "250000.5", "48210", "298210.5"]);
    expect(funds2[5][14]).toMatch(/^SESSION_EXPIRED/);
    // an empty answer: the words, not #VALUE!
    const orders = sheet("Orders");
    expect(orders[1][0]).toContain("NO ANSWER");
    expect(orders[4].every((c) => c === "")).toBe(true);
  }, 120_000);

  it("a blank answer (the Bridge is off, the key is wrong, a 429) says NO ANSWER on every sheet", () => {
    const sheet = calculate({ answers: { quotes: "", positions: "", holdings: "", funds: "", orders: "" } });
    for (const name of ["Positions", "Holdings", "Funds", "Orders"]) expect(sheet(name)[1][0], name).toContain("NO ANSWER");
    const wl = sheet("Watchlist");
    expect(wl[1][0]).toContain("NO ANSWER: the Bridge did not reply");
    expect(wl[4][10]).toBe("no answer from the Bridge");
    expect(sheet("Setup")[6][1]).toContain("No key yet");
  }, 120_000);

  it("demo answers are marked on the sheet", () => {
    const demoQuotes = TSV([
      ["symbol", "ltp", "chg", "pct", "volume", "as_of", "age_s", "class", "source", "stale", "error", "demo"],
      ["NSE:NIFTY", "24849.4", "-71.4", "-0.2865", "0", "2026-11-09 11:00:27", "0", "realtime", "broker", "false", "", "DEMO"],
    ]);
    const sheet = calculate({ symbols: ["NSE:NIFTY"], include: { positions: false, holdings: false, funds: false, orders: false }, answers: { quotes: demoQuotes } });
    expect(sheet("Watchlist")[1][0]).toBe("DEMO DATA, not real prices. OK. 1 prices, newest 2026-11-09 11:00:27 IST, oldest 0 s old.");
  }, 120_000);
});
