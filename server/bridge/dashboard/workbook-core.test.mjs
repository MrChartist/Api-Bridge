import { inflateRawSync } from "node:zlib";
import * as zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildXlsx, cellRef, crc32, zipStore } from "./xlsx-core.js";
import { bridgeWorkbook, workbookSheets } from "./workbook-core.js";
import { accountToday } from "./today-core.js";

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

describe("xlsx writer", () => {
  it("CRC-32 matches zlib's and cell references run past Z", () => {
    const b = new TextEncoder().encode("The quick brown fox");
    if (typeof zlib.crc32 === "function") expect(crc32(b)).toBe(zlib.crc32(b));
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect([cellRef(0, 0), cellRef(9, 25), cellRef(0, 26), cellRef(2, 701)]).toEqual(["A1", "Z10", "AA1", "ZZ3"]);
  });

  it("writes a stored ZIP with the workbook parts, inline text, numbers, formulas and defined names", () => {
    const z = unzip(buildXlsx({ sheets: [{ name: "One/Two", rows: [["A & B", 1.5, { f: "=SUM(B1:B1)" }]] }], names: { BridgeKey: "Setup!$B$3" } }));
    expect(Object.keys(z).sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
    expect(z["xl/workbook.xml"]).toContain('<sheet name="One Two" sheetId="1" r:id="rId1"/>');
    expect(z["xl/workbook.xml"]).toContain('<definedName name="BridgeKey">Setup!$B$3</definedName>');
    const sh = z["xl/worksheets/sheet1.xml"];
    expect(sh).toContain("<t xml:space=\"preserve\">A &amp; B</t>");
    expect(sh).toContain('<c r="B1" s="1"><v>1.5</v></c>');
    expect(sh).toContain("<f>SUM(B1:B1)</f>");
    expect(zipStore([]).length).toBe(22);
  });
});

describe("the Bridge workbook", () => {
  const d = { host: "http://127.0.0.1:4320", watchlist: { name: "F&O", symbols: ["NSE:RELIANCE", "NSE:NIFTY"] }, positions: [{ accountId: "demo-paper", symbol: "NFO:NIFTY-2026-11-03-26850-CE", netQty: -65, avgPrice: 105.8 }, { symbol: "X", netQty: 0 }], madeAt: "2026-10-30" };
  it("Setup names the key cell and never holds a key; prices and P&L are live formulas", () => {
    const { sheets, names } = workbookSheets(d);
    expect(names).toEqual({ BridgeKey: "Setup!$B$3" });
    expect(sheets.map((s) => s.name)).toEqual(["Setup", "Watchlist", "Positions"]);
    expect(sheets[0].rows[2]).toEqual(["BridgeKey", ""]);
    expect(sheets[1].rows[1][1].f).toBe('=VALUE(WEBSERVICE("http://127.0.0.1:4320/xl/ltp?symbol=NSE%3ARELIANCE&key="&BridgeKey))');
    expect(sheets[1].rows[1][2].f).toContain("field=changePct");
    expect(sheets[2].rows).toHaveLength(3);
    expect(sheets[2].rows[1].slice(0, 4)).toEqual(["demo-paper", "NFO:NIFTY-2026-11-03-26850-CE", -65, 105.8]);
    expect(sheets[2].rows[1][5].f).toBe("=(E2-D2)*C2");
    expect(sheets[2].rows[2][5].f).toBe("=SUM(F2:F2)");
    const z = unzip(bridgeWorkbook(d));
    expect(z["xl/worksheets/sheet3.xml"]).toContain("<f>(E2-D2)*C2</f>");
    expect(JSON.stringify(z)).not.toMatch(/mcb_/);
  });
});

describe("Accounts › Today", () => {
  const NOW = Date.parse("2026-10-30T12:00:00+05:30");
  it("P&L, open positions, today's orders and margin", () => {
    const t = accountToday({
      accountId: "a",
      positions: [{ pnl: 1000, netQty: 65 }, { pnl: -400, netQty: 0 }],
      funds: { usedMargin: 169790, availableCash: 2_330_000 },
      orders: [{ accountId: "a", placedAt: "2026-10-30T09:20:00+05:30", status: "filled" }, { accountId: "a", placedAt: "2026-10-29T09:20:00+05:30", status: "filled" }, { accountId: "b", placedAt: "2026-10-30T09:20:00+05:30" }, { accountId: "a", placedAt: "2026-10-30T10:00:00+05:30", status: "open" }],
      nowMs: NOW,
    });
    expect(t).toEqual({ pnl: 600, open: 1, orders: 2, filled: 1, margin: 169790, free: 2_330_000 });
    expect(accountToday({ accountId: "a", positions: null, nowMs: NOW }).pnl).toBeNull();
    expect(accountToday({ accountId: "a", positions: [], funds: { funds: { usedMargin: 5 } }, nowMs: NOW })).toMatchObject({ pnl: 0, margin: 5 });
  });
});
