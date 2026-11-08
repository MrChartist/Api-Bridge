// workbook-core.js: the Bridge's Excel workbook (Accounts and Watchlists › Excel workbook). Pure: data in, sheets
// out (xlsx-core.js writes the file). Three sheets, every price a live formula against this Bridge:
//  - Setup: where the key goes (the cell named BridgeKey) and what each sheet does. The key is never written in.
//  - Watchlist: symbol, last price and % change by WEBSERVICE (/xl/ltp, /xl/quote).
//  - Positions: account, symbol, quantity, average, live last price and P&L = (last − average) × quantity, with a total.
import { excelFormula } from "./flows.js";
import { buildXlsx } from "./xlsx-core.js";

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * @param {{ host: string, watchlist?: { name: string, symbols: string[] }|null, positions?: object[], madeAt?: string }} d
 * @returns {{ sheets: object[], names: Record<string, string> }}
 */
export function workbookSheets({ host, watchlist = null, positions = [], madeAt = "" }) {
  const setup = {
    name: "Setup",
    widths: [22, 70],
    rows: [
      ["API Bridge", "Live workbook"],
      ["Bridge", host],
      ["BridgeKey", ""],
      ["", "Paste a read-only API key in B3 (API › Keys › Create, for Excel). This cell is named BridgeKey; every formula reads it."],
      ["", "Prices recalculate when Excel recalculates (F9, or Data › Refresh All). WEBSERVICE needs Excel for Windows or Mac and a Bridge this computer can reach."],
      ["Made", madeAt],
    ],
  };
  const syms = watchlist?.symbols ?? [];
  const wl = {
    name: "Watchlist",
    widths: [26, 14, 12],
    rows: [["Symbol", "Last", "Change %"], ...syms.map((s) => [s, { f: excelFormula(host, s) }, { f: excelFormula(host, s, "changePct") }])],
  };
  if (watchlist?.name) wl.rows.push([], [`List: ${watchlist.name}`]);
  const open = (positions ?? []).filter((p) => num(p.netQty));
  const pos = {
    name: "Positions",
    widths: [20, 40, 10, 12, 12, 14],
    rows: [
      ["Account", "Symbol", "Quantity", "Average", "Last", "P&L"],
      ...open.map((p, i) => {
        const r = i + 2;
        return [p.accountId ?? p.account ?? "", p.symbol, num(p.netQty), num(p.avgPrice), { f: excelFormula(host, p.symbol) }, { f: `=(E${r}-D${r})*C${r}` }];
      }),
    ],
  };
  if (open.length) pos.rows.push(["Total", "", "", "", "", { f: `=SUM(F2:F${open.length + 1})` }]);
  return { sheets: [setup, wl, pos], names: { BridgeKey: "Setup!$B$3" } };
}

/** The workbook as .xlsx bytes. */
export const bridgeWorkbook = (d) => buildXlsx(workbookSheets(d));
