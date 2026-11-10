/**
 * integrations/google-sheets/bridge.gs run in a vm against a REAL demo Bridge (loopback, in this process), for every
 * sheet of the script. The sheet stand-in refuses a block of values of the wrong size, as Google does: Refresh now
 * once threw on every table sheet in demo mode ("The data has 17 but the range has 16") and no test saw it.
 *
 * UrlFetchApp.fetch is synchronous in Apps Script but the Bridge answers asynchronously here, so each pass runs the
 * script against the answers fetched so far, then fetches what it asked for and runs it again until nothing new is
 * asked (the requests are plain GETs, the same every time).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { load, makeSheet } from "./__fixtures__/appsScriptHarness.mjs";

let app;
let base;
let key;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcb-gs-"));
  const { config } = loadConfig({ raw: { dataDir: dir, server: { port: 0 }, logging: { level: "silent" } }, env: {}, demo: true });
  app = await createApp({ config, logger: createNullLogger() });
  const { port } = await app.listen();
  base = `http://127.0.0.1:${port}`;
  key = (await app.deps.keyStore.create({ label: "sheets-demo", scopes: ["read"], accounts: "*", clientKind: "script" })).key;
});
afterAll(async () => {
  await app?.close();
});

/** Run `go(ctx, sheets)` against the demo Bridge. Returns the sheets of the last pass. */
async function runAgainstDemo(makeSheets, go) {
  const answers = new Map();
  for (let pass = 0; pass < 8; pass++) {
    const wanted = new Set();
    const sheets = makeSheets();
    const { ctx } = load({
      sheets,
      props: { BRIDGE_URL: base, BRIDGE_KEY: key },
      respond: (url) => {
        const hit = answers.get(url);
        if (hit) return hit;
        wanted.add(url);
        return { status: 200, body: "" };
      },
    });
    let result;
    let error;
    try {
      result = go(ctx, sheets);
    } catch (e) {
      error = e;
    }
    if (!wanted.size) {
      if (error) throw error;
      return { sheets, result };
    }
    for (const url of wanted) {
      const res = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
      answers.set(url, { status: res.status, body: await res.text(), headers: Object.fromEntries(res.headers) });
    }
  }
  throw new Error("the script kept asking for new addresses");
}

const SAMPLE = ["NSE:NIFTY", "BSE:SENSEX", "NSE:RELIANCE", "NSE:TCS", "NSE:INFY", "NSE:HDFCBANK", "NSE:ICICIBANK", "NSE:SBIN", "NSE:ITC", "NSE:M&M"];
const fresh = () => ({
  Watchlist: makeSheet("Watchlist", Object.fromEntries(SAMPLE.map((s, i) => [`${5 + i},1`, s]))),
  Positions: makeSheet("Positions"),
  Holdings: makeSheet("Holdings"),
  Funds: makeSheet("Funds"),
  Orders: makeSheet("Orders"),
});

describe("bridge.gs against the demo Bridge", () => {
  it("Refresh now fills every sheet and none of them throws or shows an error", async () => {
    const { sheets } = await runAgainstDemo(fresh, (ctx) => ctx.refreshBridge());
    for (const [name, sheet] of Object.entries(sheets)) {
      const status = sheet.at(2, 1);
      expect(status, `${name} status`).toBeTypeOf("string");
      expect(status, `${name} status`).not.toMatch(/^(ERROR|NO ANSWER|REFUSED|Too many)/);
      expect(status, `${name} status`).toMatch(/Refreshed 2026-11-09/);
    }
    // the watchlist carries prices and the DEMO label
    expect(sheets.Watchlist.at(2, 1)).toMatch(/^DEMO DATA, not real prices\./);
    expect(typeof sheets.Watchlist.at(5, 2)).toBe("number");
    // every demo table sheet that the Bridge has rows for was filled, under its own columns
    for (const name of ["Positions", "Holdings", "Funds", "Orders"]) {
      const sheet = sheets[name];
      expect(sheet.at(2, 1), name).toMatch(/^(DEMO DATA, not real\. )?\d+ rows\./);
      if (sheet.at(5, 1) !== undefined) expect(sheet.at(2, 1), name).toMatch(/^DEMO DATA/);
    }
    const filled = ["Positions", "Holdings", "Funds"].filter((n) => sheets[n].at(5, 1) !== undefined);
    expect(filled.length).toBeGreaterThan(0);
    for (const n of filled) expect(String(sheets[n].at(5, 1)).length, n).toBeGreaterThan(0); // an account name, not a shifted column
  });

  it("the custom functions work against it too", async () => {
    const { result } = await runAgainstDemo(fresh, (ctx) => ({ quotes: ctx.BRIDGE_QUOTES([["NSE:NIFTY"], ["NSE:RELIANCE"]]), history: ctx.BRIDGE_HISTORY("NSE:NIFTY", "1d", 3) }));
    expect(result.quotes[0].slice(0, 2)).toEqual(["symbol", "ltp"]);
    expect(result.quotes).toHaveLength(3);
    expect(typeof result.quotes[1][1]).toBe("number");
    expect(result.history[0][0]).toBe("datetime");
    expect(result.history.length).toBeGreaterThan(1);
  });
});
