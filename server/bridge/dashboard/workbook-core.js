// workbook-core.js: the Bridge's Excel workbook (Integrations › Excel and Sheets › Download workbook). Pure: data in,
// sheets out (xlsx-core.js writes the file). It reads prices and your book with ONE request per sheet per refresh:
//
//  - Setup     the Bridge address, the key (see "Key" below), the refresh switch, and the steps in short.
//  - Watchlist your symbols in column A; Last, change, volume and how current each price is. One request, all rows.
//  - Positions, Holdings, Funds, Orders   each is one request (/xl/positions ...), one row per line. Optional.
//  - Feed      helper: every request's address and answer, and the formulas that cut the answers into cells.
//
// How a request becomes cells (no dynamic-array functions, so it works in Excel 2013 and later on Windows): the
// answer comes back as tab-separated text (format=tsv) in one cell (WEBSERVICE); the Feed sheet cuts it into lines with
// FIND and SUBSTITUTE, and each sheet cuts a line into fields the same way. A failed request is a blank answer, and
// every sheet says so in words (Status) instead of showing #VALUE! in rows.
//
// Key. The workbook never contains a key unless the person asks for it (`key`): then it is stored as a workbook name
// (Formulas › Name Manager), not in a cell. Otherwise the key goes into the yellow cell on Setup, with a check that
// says whether one is there and a reminder to clear it before sharing the file.
//
// Functions newer than Excel 2007 are stored with the "_xlfn." prefix by xlsx-core.js (prefixNewFunctions): that is the
// fix for #NAME? in the first version of this file. WEBSERVICE needs Excel for Windows.
import { buildXlsx, cellRef } from "./xlsx-core.js";

/** Columns of each table the Bridge serves, in the Bridge's order: [heading, column name, "t"ext or "n"umber]. */
export const TABLES = Object.freeze({
  quotes: [
    ["Symbol", "symbol", "t"],
    ["Last", "ltp", "n"],
    ["Change", "chg", "n"],
    ["Change %", "pct", "n"],
    ["Volume", "volume", "n"],
    ["As of (IST)", "as_of", "t"],
    ["Age (s)", "age_s", "n"],
    ["Class", "class", "t"],
    ["Source", "source", "t"],
    ["Stale", "stale", "t"],
    ["Error", "error", "t"],
    ["Demo", "demo", "t"],
  ],
  positions: [
    ["Account", "account", "t"],
    ["Mode", "mode", "t"],
    ["Symbol", "symbol", "t"],
    ["Product", "product", "t"],
    ["Qty", "qty", "n"],
    ["Avg price", "avg_price", "n"],
    ["Last", "ltp", "n"],
    ["P&L", "pnl", "n"],
    ["Realised P&L", "realised_pnl", "n"],
    ["Unrealised P&L", "unrealised_pnl", "n"],
    ["As of (IST)", "as_of", "t"],
    ["Age (s)", "age_s", "n"],
    ["Class", "class", "t"],
    ["Source", "source", "t"],
    ["Stale", "stale", "t"],
    ["Error", "error", "t"],
    ["Demo", "demo", "t"],
  ],
  holdings: [
    ["Account", "account", "t"],
    ["Mode", "mode", "t"],
    ["Symbol", "symbol", "t"],
    ["ISIN", "isin", "t"],
    ["Qty", "qty", "n"],
    ["Avg price", "avg_price", "n"],
    ["Last", "ltp", "n"],
    ["P&L", "pnl", "n"],
    ["As of (IST)", "as_of", "t"],
    ["Age (s)", "age_s", "n"],
    ["Class", "class", "t"],
    ["Source", "source", "t"],
    ["Stale", "stale", "t"],
    ["Error", "error", "t"],
    ["Demo", "demo", "t"],
  ],
  funds: [
    ["Account", "account", "t"],
    ["Mode", "mode", "t"],
    ["Available cash", "available_cash", "n"],
    ["Used margin", "used_margin", "n"],
    ["Total balance", "total_balance", "n"],
    ["Collateral", "collateral", "n"],
    ["Withdrawable", "withdrawable", "n"],
    ["Realised P&L", "realised_pnl", "n"],
    ["Unrealised P&L", "unrealised_pnl", "n"],
    ["As of (IST)", "as_of", "t"],
    ["Age (s)", "age_s", "n"],
    ["Class", "class", "t"],
    ["Source", "source", "t"],
    ["Stale", "stale", "t"],
    ["Error", "error", "t"],
    ["Demo", "demo", "t"],
  ],
  orders: [
    ["Account", "account", "t"],
    ["Mode", "mode", "t"],
    ["Order id", "order_id", "t"],
    ["Client order id", "client_order_id", "t"],
    ["Symbol", "symbol", "t"],
    ["Side", "side", "t"],
    ["Product", "product", "t"],
    ["Type", "order_type", "t"],
    ["Qty", "qty", "n"],
    ["Filled", "filled_qty", "n"],
    ["Avg price", "avg_price", "n"],
    ["Price", "price", "n"],
    ["Trigger", "trigger_price", "n"],
    ["Status", "status", "t"],
    ["Message", "status_message", "t"],
    ["Placed (IST)", "placed_at", "t"],
    ["Updated (IST)", "updated_at", "t"],
    ["As of (IST)", "as_of", "t"],
    ["Age (s)", "age_s", "n"],
    ["Class", "class", "t"],
    ["Source", "source", "t"],
    ["Stale", "stale", "t"],
    ["Error", "error", "t"],
    ["Demo", "demo", "t"],
  ],
});

/**
 * Rows each sheet has room for (the formulas are written for this many). The sheet asks the Bridge for at most this
 * many rows (`limit=`), so an answer can never grow past WEBSERVICE's 32,767 characters, however big the book is.
 */
export const CAPACITY = Object.freeze({ quotes: 50, positions: 40, holdings: 60, funds: 10, orders: 60 });

/** Tables that end with a visible "(more rows)" row when the book is bigger than CAPACITY: they get one extra row slot. */
const NOTICE_TABLES = new Set(["positions", "holdings", "funds"]);
/** Formula rows of a table sheet: the capacity, plus the slot for the "showing N of M" row. */
export const rowSlots = (id) => CAPACITY[id] + (NOTICE_TABLES.has(id) ? 1 : 0);
/** The account cell of that row, as the Bridge writes it (portfolio.mjs MORE_ROWS_ACCOUNT). */
export const MORE_ROWS = "(more rows)";

/** The sheets a person may choose to include, with their label in the dashboard. */
export const SHEET_CHOICES = Object.freeze([
  { id: "watchlist", label: "Watchlist (prices)", sheet: "Watchlist" },
  { id: "positions", label: "Positions", sheet: "Positions" },
  { id: "holdings", label: "Holdings", sheet: "Holdings" },
  { id: "funds", label: "Funds", sheet: "Funds" },
  { id: "orders", label: "Orders", sheet: "Orders" },
]);

/** Symbols in the sample watchlist when the person has none (they exist in a real broker's master and in the demo). */
export const SAMPLE_SYMBOLS = Object.freeze(["NSE:NIFTY", "BSE:SENSEX", "NSE:RELIANCE", "NSE:TCS", "NSE:INFY", "NSE:HDFCBANK", "NSE:ICICIBANK", "NSE:SBIN", "NSE:ITC", "NSE:M&M"]);

/** Characters WEBSERVICE refuses past: the address limit of the function. */
export const ADDRESS_LIMIT = 2048;

/** What the answer to each request starts with (its first two column names), and what a refusal starts with. */
const FIRST_COLUMNS = Object.freeze({
  quotes: '="symbol"&CHAR(9)&"ltp"',
  positions: '="account"&CHAR(9)&"mode"',
  holdings: '="account"&CHAR(9)&"mode"',
  funds: '="account"&CHAR(9)&"mode"',
  orders: '="account"&CHAR(9)&"mode"',
});
const REFUSAL_START = '"status"&CHAR(9)&"code"';

const FIRST_DATA_ROW_FEED = 12; // Feed row of line 1 (the header line); line k is on row 11 + k.
const WATCH_FIRST_ROW = 5;

// ── formula pieces ──

const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

/** Line k (1 = the header line) of the answer text in `raw`. "" when there is no such line. */
export function lineFormula(raw, k) {
  const cut = (n) => `FIND("~~",SUBSTITUTE(${raw},CHAR(10),"~~",${n}))`;
  return k === 1 ? `=IFERROR(MID(${raw},1,${cut(1)}-1),"")` : `=IFERROR(MID(${raw},${cut(k - 1)}+1,${cut(k)}-${cut(k - 1)}-1),"")`;
}

/** Field j (1 = first) of a tab-separated line held in `line`. The expression errors when the field does not exist. */
export function fieldExpr(line, j) {
  const cut = (n) => `FIND("~~",SUBSTITUTE(${line}&CHAR(9),CHAR(9),"~~",${n}))`;
  return j === 1 ? `MID(${line},1,${cut(1)}-1)` : `MID(${line},${cut(j - 1)}+1,${cut(j)}-${cut(j - 1)}-1)`;
}

/** A text field as a cell formula. */
export const textField = (line, j) => `=IFERROR(${fieldExpr(line, j)},"")`;
/** A number field: blank stays blank (NUMBERVALUE("") would be 0), "." is the decimal point in every locale. */
export const numberField = (line, j) => {
  const f = fieldExpr(line, j);
  return `=IFERROR(IF(${f}="","",NUMBERVALUE(${f},".")),"")`;
};

/**
 * The address of one request: the Bridge address, the route and its options, the key and the refresh stamp.
 * `errors=200` makes the Bridge answer a refusal (wrong key, too many refreshes) as a normal answer holding its reason:
 * WEBSERVICE shows #VALUE! for every other HTTP status and so could not say what went wrong.
 */
export function requestAddress(route, options = "") {
  return `=BridgeURL&${q(`${route}?format=tsv&errors=200${options}&key=`)}&BridgeKey&"&_="&RefreshStamp`;
}

/**
 * A formula that yields a fixed answer text (tabs and line breaks built with CHAR, pieces under Excel's 255-character
 * string limit). For tests and previews: spreadsheet programs differ in how they read a raw tab inside stored text.
 */
export function staticAnswer(text) {
  const lines = String(text).replace(/\r/g, "").split("\n");
  const piece = (s) => (s === "" ? '""' : (s.match(/.{1,200}/g) ?? []).map(q).join("&"));
  return "=" + lines.map((l, i) => l.split("\t").map(piece).join("&CHAR(9)&") + (i < lines.length - 1 ? "&CHAR(10)&" : "")).join("");
}

// ── sheets ──

const NO_ANSWER = "NO ANSWER: the Bridge did not reply. Is it running? Are the address and key on the Setup sheet right? Too many refreshes in a row also look like this: wait a few seconds and press F9.";

/**
 * @param {{ host: string, include?: Partial<Record<"watchlist"|"positions"|"holdings"|"funds"|"orders", boolean>>, symbols?: string[],
 *   key?: string, madeAt?: string, answers?: Record<string, string> }} d
 *   key: put this key inside the file as a workbook name (default: no key).
 *   answers: fixed answers instead of live requests, to check how the sheets cut an answer into cells (tests, previews).
 * @returns {{ sheets: object[], names: Record<string, string>, datasets: Record<string, { row: number, line: string }> }}
 */
export function workbookSheets({ host, include = {}, symbols = [], key = "", madeAt = "", answers = null }) {
  const want = { watchlist: true, positions: true, holdings: true, funds: true, orders: true, ...include };
  const list = want.watchlist ? [...(symbols.length ? symbols : SAMPLE_SYMBOLS)].map((s) => String(s).trim()).filter(Boolean).slice(0, CAPACITY.quotes) : [];

  // Which requests exist, and which Feed row and line column each lives in.
  const order = [];
  if (want.watchlist) order.push(["quotes", "Prices", "/xl/quotes", `&fields=ltp,chg,pct,volume&symbols=`]);
  if (want.positions) order.push(["positions", "Positions", "/xl/positions", `&limit=${CAPACITY.positions}`]);
  if (want.holdings) order.push(["holdings", "Holdings", "/xl/holdings", `&limit=${CAPACITY.holdings}`]);
  if (want.funds) order.push(["funds", "Funds", "/xl/funds", `&limit=${CAPACITY.funds}`]);
  if (want.orders) order.push(["orders", "Orders", "/xl/orders", `&limit=${CAPACITY.orders}`]);
  const LINE_COLS = { quotes: 0, positions: 17, holdings: 18, funds: 19, orders: 20 }; // Feed columns A, R, S, T, U
  const datasets = {};
  order.forEach(([id, label, route, opts], i) => {
    const row = 4 + i;
    // Feed columns of a request: B address, C the answer once it passed the check (empty otherwise), D the answer as it
    // arrived, E the first columns an answer must start with, F the check (0 no answer, 1 a Bridge table, 2 the Bridge
    // refused, 3 something else), G the answer's second line, H the refusal's message.
    datasets[id] = { id, label, route, opts, row, url: `Feed!$B$${row}`, raw: `Feed!$C$${row}`, got: `Feed!$D$${row}`, check: `Feed!$F$${row}`, msg: `Feed!$H$${row}`, lineCol: LINE_COLS[id] };
  });
  const lineRef = (id, k) => `Feed!$${cellRef(0, datasets[id].lineCol).replace(/\d+/, "")}${FIRST_DATA_ROW_FEED + k - 1}`;

  // ── Setup ──
  const setup = {
    name: "Setup",
    widths: [30, 96],
    boldFirst: false,
    validations: [{ ref: "B8", list: ["Yes", "No"] }],
    rows: [
      [{ v: "API Bridge for Excel", s: "title" }],
      [{ v: "Read-only: this workbook only looks at prices and your book. It cannot place, change or cancel an order.", s: "note" }],
      [],
      [{ v: "Status", s: "status" }, { f: want.watchlist ? "=Feed!$B$10" : '="Prices are not in this workbook."', s: "status" }],
      [{ v: "Bridge address", s: "status" }, { v: host, s: "input" }],
      [{ v: "Key (read-only)", s: "status" }, { v: "", s: "input" }],
      ["", { f: '=IF(LEN(Setup!$B$6)>0,IF(LEFT(Setup!$B$6,4)="mcb_","A key is in the yellow cell. Clear the cell before you share or email this file.","That does not look like a Bridge key: it starts with mcb_."),IF(LEN(BridgeKeyStored)>0,"A key is stored inside this file (Formulas > Name Manager). Do not share the file.","No key yet: paste one in the yellow cell above."))', s: "warn" }],
      [{ v: "Refresh on every recalculation", s: "status" }, { v: "Yes", s: "input" }],
      [{ v: "Refresh stamp (Excel fills this in)", s: "note" }, { f: '=IF(Setup!$B$8="Yes",NOW(),0)', s: "note" }],
      [],
      [{ v: "Steps", s: "status" }],
      ["1", { v: "In the dashboard open Integrations > Excel and Sheets and make a key for Excel. It is read-only and expires. Paste it into the yellow Key cell above.", s: "wrap" }],
      ["2", { v: "Check the Bridge address. Excel and the Bridge on the same computer: http://127.0.0.1:4300 (use your own port). Another computer needs the address that reaches it.", s: "wrap" }],
      ["3", { v: want.watchlist ? "Open Watchlist, type your symbols in column A (a Bridge symbol such as NSE:RELIANCE or NFO:NIFTY-2026-11-24-FUT). One request fills the whole list." : "Open the sheet you want. Each sheet is one request.", s: "wrap" }],
      ["Refresh", { v: "Press F9. Every refresh is one request per sheet: prices are one request for all rows, not one per cell. Set the switch above to No if you want to refresh only by pressing Ctrl+Alt+F9. A timer needs a macro: see the guide.", s: "wrap" }],
      ["How often", { v: "Prices: no more than once every 5 seconds. Positions, Holdings, Funds, Orders: once a minute is plenty. The Bridge allows each key about 50 requests a second, and your broker has its own limits.", s: "wrap" }],
      ["Needs", { v: "Excel for Windows (the WEBSERVICE function). Excel for Mac and Excel for the web do not have it: use Power Query (integrations/excel) or Google Sheets (Apps Script in the dashboard).", s: "wrap" }],
      ["Times", { v: "All times are IST. Each price row says how current it is (As of, Age, Class, Source, Stale). Delayed or backup prices are never shown here.", s: "wrap" }],
      ["The key", { v: "The key travels in the web address of each request, so it can end up in logs on the way. Use a read-only key with an expiry. Do not put it in a file you share.", s: "wrap" }],
      ["Made", { v: madeAt ? `${madeAt} by the Bridge dashboard` : "", s: "note" }],
    ],
  };

  const sheets = [setup];

  // ── Watchlist ──
  if (want.watchlist) {
    const T = TABLES.quotes;
    const fr = (col) => `Feed!$${col}$13:$${col}$${12 + CAPACITY.quotes}`;
    const feedCol = (j) => String.fromCharCode(65 + j); // Feed fields sit in B..M for j = 1..12
    const rows = [
      [{ v: "Watchlist", s: "title" }],
      [{ f: "=Feed!$B$10", s: "status" }],
      [{ v: `Type Bridge symbols in column A (up to ${CAPACITY.quotes}). One request fills every row. Times are IST.`, s: "note" }],
      [...T.slice(0, 11).map(([h]) => ({ v: h, s: "header" })), { v: "Feed row", s: "header" }],
    ];
    for (let i = 0; i < CAPACITY.quotes; i++) {
      const r = WATCH_FIRST_ROW + i;
      const L = `$L${r}`;
      const pick = (j) => `INDEX(${fr(feedCol(j))},${L})`;
      const num = (j, s) => ({ f: `=IF(${L}="","",IFERROR(IF(${pick(j)}="","",NUMBERVALUE(${pick(j)},".")),""))`, s });
      const txt = (j) => ({ f: `=IF(${L}="","",IFERROR(${pick(j)},""))` });
      rows.push([
        i < list.length ? { v: list[i], s: "input" } : { v: "", s: "input" },
        num(2, "number"),
        num(3, "number"),
        num(4, "number"),
        num(5, "integer"),
        txt(6),
        num(7, "number"),
        txt(8),
        txt(9),
        txt(10),
        { f: `=IF(LEN(TRIM($A${r}))=0,"",IF(${datasets.quotes.check}=0,"no answer from the Bridge",IF(${datasets.quotes.check}>1,"no prices: read the Status line above",IF(${L}="","not in the answer: press F9",${pick(11)}))))` },
        { f: `=IF(LEN(TRIM($A${r}))=0,"",IFERROR(MATCH(TRIM($A${r}),${fr("B")},0),""))`, s: "note" },
      ]);
    }
    sheets.push({ name: "Watchlist", widths: [30, 12, 11, 11, 13, 20, 9, 10, 9, 8, 52, 9], boldFirst: false, freeze: { row: 4 }, rows });
  }

  // ── Positions, Holdings, Funds, Orders ──
  const tableSheet = (id, name, title, noteText, totalCol) => {
    const T = TABLES[id];
    const n = rowSlots(id);
    const head = T.slice(0, -1); // the demo column is read for the status line, not shown
    const rows = [[{ v: title, s: "title" }], [], [{ v: noteText, s: "note" }], head.map(([h]) => ({ v: h, s: "header" }))];
    const errJ = T.findIndex(([, c]) => c === "error") + 1;
    const staleJ = T.findIndex(([, c]) => c === "stale") + 1;
    for (let i = 0; i < n; i++) {
      const line = lineRef(id, i + 2);
      rows.push(head.map(([, , kind], c) => ({ f: kind === "n" ? numberField(line, c + 1) : textField(line, c + 1), ...(kind === "n" ? { s: "number" } : {}) })));
    }
    const col = (j) => cellRef(0, j - 1).replace(/\d+/, "");
    const rng = (j) => `${col(j)}5:${col(j)}${4 + n}`;
    const { raw: answer, got, check, msg } = datasets[id];
    // "(more rows)" in the Account column is the Bridge's own row saying how many rows it left out (it is not data).
    const more = NOTICE_TABLES.has(id) ? `COUNTIF(${rng(1)},"${MORE_ROWS}")` : "0";
    const shown = `(COUNTIF(${rng(1)},"?*")-${more})`;
    const errors = `(COUNTIF(${rng(errJ)},"?*")-${more})`;
    const notice = `IFERROR(INDEX(${rng(errJ)},MATCH("${MORE_ROWS}",${rng(1)},0)),"")`;
    const note = NOTICE_TABLES.has(id) ? `IF(${more}>0,${notice}&" ","")` : `IF(${shown}>=${CAPACITY[id]},"Showing the latest ${CAPACITY[id]}: older ones are not shown. ","")`;
    const statusFormula = `=IF(${check}=0,"${NO_ANSWER}",IF(${check}=2,"REFUSED: "&${msg},IF(${check}=3,"CHECK: the answer is not a Bridge table (a login page or a tunnel notice?). It starts: "&LEFT(${got},80),${shown}&" rows. "&${note}&IF(${errors}>0,"CHECK: "&${errors}&IF(${errors}=1," row has"," rows have")&" an error (see the Error column). ","")&IF(COUNTIF(${rng(staleJ)},"true")>0,COUNTIF(${rng(staleJ)},"true")&" stale. ","")&IF(ISNUMBER(FIND(CHAR(9)&"DEMO"&CHAR(10),${answer})),"DEMO DATA, not real. ","")&"Times are IST.")))`;
    rows[1] = [{ f: statusFormula, s: "status" }];
    // The total adds the rows shown. When rows are left out or an account could not answer it says PARTIAL instead of
    // passing a smaller number off as the total.
    if (totalCol) rows[2] = [{ v: noteText, s: "note" }, "", "", "", "", "", "", { f: `=IF(${check}<>1,"",IF(OR(${more}>0,${errors}>0),"PARTIAL: "&SUM(${rng(totalCol)})&" (not every row is included)",SUM(${rng(totalCol)})))`, s: "status" }];
    const width = ([, c, kind]) => (c === "symbol" ? 32 : c === "error" || c === "status_message" ? 40 : kind === "n" ? 13 : 16);
    sheets.push({ name, widths: head.map(width), boldFirst: false, freeze: { row: 4 }, rows });
  };
  if (want.positions) tableSheet("positions", "Positions", "Positions", "Every account this key may use. P&L total (paper and live mixed; it says PARTIAL when rows are missing) at the right of this line.", 8);
  if (want.holdings) tableSheet("holdings", "Holdings", "Holdings", "Long-term holdings of every account this key may use.", 0);
  if (want.funds) tableSheet("funds", "Funds", "Funds", "One row per account.", 0);
  if (want.orders) tableSheet("orders", "Orders", "Orders", `The latest ${CAPACITY.orders} orders, newest first. This sheet only reads: orders are placed and approved elsewhere.`, 0);

  // ── Feed ──
  const feed = { name: "Feed", widths: [60, 60, 30, 14, 14, 14, 20, 10, 10, 10, 10, 10, 10, 18, 10, 40, 3, 60, 60, 60, 60], boldFirst: false, tab: "FF999999", rows: [] };
  const at = (r, c, v) => {
    while (feed.rows.length <= r) feed.rows.push([]);
    feed.rows[r][c] = v;
  };
  at(0, 0, { v: "Helper sheet. Excel fills this in: each answer below is one request to the Bridge. You do not need to edit it.", s: "note" });
  at(2, 0, { v: "Request", s: "header" });
  at(2, 1, { v: "Address", s: "header" });
  at(2, 2, { v: "Answer (a Bridge table)", s: "header" });
  at(2, 3, { v: "Answer as it came", s: "header" });
  at(2, 4, { v: "Must start with", s: "header" });
  at(2, 5, { v: "Check", s: "header" });
  at(2, 6, { v: "Second line", s: "header" });
  at(2, 7, { v: "Refusal message", s: "header" });
  for (const ds of Object.values(datasets)) {
    const r = ds.row - 1;
    at(r, 0, ds.label);
    if (ds.id === "quotes") at(r, 1, { f: `=BridgeURL&${q(`${ds.route}?format=tsv&errors=200${ds.opts}`)}&$P$${FIRST_DATA_ROW_FEED + CAPACITY.quotes}&"&key="&BridgeKey&"&_="&RefreshStamp` });
    else at(r, 1, { f: requestAddress(ds.route, ds.opts) });
    const fixed = answers?.[ds.id];
    // D is what came back. C keeps it only when it is a table of the right kind, so a login page, a tunnel notice or
    // a refusal never turns into rows; F says which of those it was and the sheets say so in words.
    at(r, 3, fixed !== undefined ? { f: staticAnswer(fixed) } : { f: `=IFERROR(SUBSTITUTE(WEBSERVICE(B${ds.row}),CHAR(13),""),"")` });
    at(r, 4, { f: FIRST_COLUMNS[ds.id] });
    at(r, 5, { f: `=IF(LEN(D${ds.row})=0,0,IF(LEFT(D${ds.row},LEN(E${ds.row}))=E${ds.row},1,IF(LEFT(D${ds.row},LEN(${REFUSAL_START}))=${REFUSAL_START},2,3)))` });
    at(r, 2, { f: `=IF(F${ds.row}=1,D${ds.row},"")` });
    at(r, 6, { f: lineFormula(`D${ds.row}`, 2) });
    at(r, 7, { f: `=IFERROR(${fieldExpr(`G${ds.row}`, 3)},"")` });
  }

  if (want.watchlist) {
    const qd = datasets.quotes;
    const R1 = 13;
    const RN = 12 + CAPACITY.quotes;
    const rngF = (col) => `$${col}$${R1}:$${col}$${RN}`;
    // Status for the Watchlist (also on Setup).
    const asked = `SUMPRODUCT(--(LEN(TRIM(Watchlist!$A$${WATCH_FIRST_ROW}:$A$${WATCH_FIRST_ROW + CAPACITY.quotes - 1}))>0))`;
    const status = `=IF(LEN($B$${qd.row})>${ADDRESS_LIMIT},"TOO MANY SYMBOLS: Excel cannot send an address this long. Remove some symbols (about 60 fit) or use Power Query.",IF(${qd.check}=0,"${NO_ANSWER}",IF(${qd.check}=2,"REFUSED: "&${qd.msg},IF(${qd.check}=3,"CHECK: the answer is not a Bridge table (a login page or a tunnel notice?). It starts: "&LEFT(${qd.got},80),IF(${asked}=0,"Type some symbols in column A of the Watchlist sheet.",IF(COUNTIF(${rngF("M")},"DEMO")>0,"DEMO DATA, not real prices. ","")&IF(COUNTIF(${rngF("L")},"?*")=0,"OK. ","CHECK: "&COUNTIF(${rngF("L")},"?*")&" of "&${asked}&" symbols could not be priced (see the Error column). ")&COUNTIF(${rngF("C")},"?*")&" prices, newest "&IFERROR(INDEX(${rngF("G")},MATCH(MAX(${rngF("N")}),${rngF("N")},0)),"?")&" IST, oldest "&IFERROR(MAX(${rngF("O")}),"?")&" s old"&IF(COUNTIF(${rngF("K")},"true")>0,", "&COUNTIF(${rngF("K")},"true")&" stale","")&IF(COUNTIF(${rngF("I")},"delayed")+COUNTIF(${rngF("I")},"eod")>0,", "&(COUNTIF(${rngF("I")},"delayed")+COUNTIF(${rngF("I")},"eod"))&" not realtime","")&".")))))`;
    at(9, 0, { v: "Prices status", s: "status" });
    at(9, 1, { f: status, s: "status" });
    at(10, 0, { v: "Prices, cut into columns (Symbol, Last, Change, Change %, Volume, As of, Age, Class, Source, Stale, Error, Demo)", s: "note" });
    at(10, 15, { v: "Symbols asked for (built from the Watchlist)", s: "note" });
    for (let k = 1; k <= CAPACITY.quotes + 1; k++) {
      const r = FIRST_DATA_ROW_FEED + k - 2; // 0-based row index
      at(r, 0, { f: lineFormula(qd.raw, k) });
      const A = `$A${r + 1}`;
      for (let j = 1; j <= 12; j++) at(r, j, { f: textField(A, j) });
      if (k >= 2) {
        const G = `G${r + 1}`;
        at(r, 13, { f: `=IFERROR(IF(${G}="","",DATE(VALUE(MID(${G},1,4)),VALUE(MID(${G},6,2)),VALUE(MID(${G},9,2)))+TIME(VALUE(MID(${G},12,2)),VALUE(MID(${G},15,2)),VALUE(MID(${G},18,2)))),"")` });
        at(r, 14, { f: `=IFERROR(IF(H${r + 1}="","",NUMBERVALUE(H${r + 1},".")),"")` });
        const symCell = `Watchlist!$A${WATCH_FIRST_ROW + k - 2}`;
        const prev = `$P${r}`;
        // Comma-separated, ":" kept readable, and every other special character encoded.
        at(r, 15, { f: `=IF(LEN(TRIM(${symCell}))=0,${prev},${prev}&IF(LEN(${prev})=0,"",",")&SUBSTITUTE(ENCODEURL(TRIM(${symCell})),"%3A",":"))` });
      } else at(r, 15, "");
    }
  }
  for (const [id, ds] of Object.entries(datasets)) {
    if (id === "quotes") continue;
    for (let k = 1; k <= rowSlots(id) + 1; k++) at(FIRST_DATA_ROW_FEED + k - 2, ds.lineCol, { f: lineFormula(ds.raw, k) });
  }
  if (!want.watchlist) at(9, 0, "");
  sheets.push(feed);

  // The key lives in a workbook name, never in a cell, unless the person typed it into Setup.
  const names = {
    BridgeURL: "Setup!$B$5",
    BridgeKeyStored: key ? q(key) : '""',
    BridgeKey: 'IF(Setup!$B$6<>"",Setup!$B$6,BridgeKeyStored)',
    RefreshStamp: "Setup!$B$9",
    // Plain ranges for the Power Query alternative (integrations/excel/quotes.pq): a query reads names that are ranges.
    BridgeKeyCell: "Setup!$B$6",
    ...(want.watchlist ? { WatchlistSymbols: `Watchlist!$A$${WATCH_FIRST_ROW}:$A$${WATCH_FIRST_ROW + CAPACITY.quotes - 1}` } : {}),
  };
  return { sheets, names, datasets };
}

/** The workbook as .xlsx bytes. */
export const bridgeWorkbook = (d) => {
  const { sheets, names } = workbookSheets(d);
  return buildXlsx({ sheets, names });
};

/** Sheet names in a workbook for these choices (for tests and the dashboard summary). */
export function sheetNames(include = {}) {
  const want = { watchlist: true, positions: true, holdings: true, funds: true, orders: true, ...include };
  return ["Setup", ...SHEET_CHOICES.filter((c) => want[c.id]).map((c) => c.sheet), "Feed"];
}

