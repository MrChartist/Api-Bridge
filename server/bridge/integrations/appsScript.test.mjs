/**
 * integrations/google-sheets/bridge.gs, run in a sandbox with stand-ins for Google's services: one request per
 * refresh however many rows, the key only in a header, long lists split by address length, the 429 message shown,
 * timer intervals Google accepts. No network.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(new URL("../../../integrations/google-sheets/bridge.gs", import.meta.url), "utf8");
const KEY = "mcb_abcdefghij_SECRETSECRETSECRETSECRET";

/** Small RFC 4180 parser, like Utilities.parseCsv. */
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
    else if (c === "\r") continue;
    else if (c === "\n") (row.push(cell), rows.push(row), (row = []), (cell = ""));
    else cell += c;
  }
  if (cell || row.length) (row.push(cell), rows.push(row));
  return rows;
}

/** A sheet stand-in: a grid with getRange(...).getValues/setValues/clearContent/setValue. */
function makeSheet(name, grid = {}) {
  const cells = new Map(Object.entries(grid));
  const key = (r, c) => `${r},${c}`;
  const range = (r, c, nr = 1, nc = 1) => ({
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cells.get(key(r + i, c + j)) ?? "")),
    setValues(v) {
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
function load({ respond, sheets = {}, props = { BRIDGE_URL: "https://tunnel.example.com/", BRIDGE_KEY: KEY } } = {}) {
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

const csv = (rows) => rows.map((r) => r.join(",")).join("\r\n") + "\r\n";
const QUOTE_HEAD = ["symbol", "ltp", "chg", "pct", "volume", "as_of", "age_s", "class", "source", "stale", "error"];
const quotesFor = (url) => {
  const list = decodeURIComponent(new URL(url).searchParams.get("symbols") ?? "").split(",");
  return csv([QUOTE_HEAD, ...list.map((s, i) => [s, String(100 + i), "1.5", "0.5", "1000", "2026-11-09 11:00:27", "0.1", "realtime", "stream", "false", ""])]);
};

describe("bridge.gs", () => {
  it("BRIDGE_QUOTES asks for a whole range with one request and returns the labelled table", () => {
    const { ctx, fetches } = load({ respond: (u) => ({ body: quotesFor(u) }) });
    const out = ctx.BRIDGE_QUOTES([["NSE:RELIANCE"], ["NSE:M&M"], [""], ["NSE:INFY"]]);
    expect(fetches).toHaveLength(1);
    expect(fetches[0].url).toBe("https://tunnel.example.com/xl/quotes?format=csv&fields=ltp,chg,pct,volume&symbols=NSE:RELIANCE,NSE:M%26M,NSE:INFY");
    expect(out[0]).toEqual(QUOTE_HEAD);
    expect(out[1].slice(0, 4)).toEqual(["NSE:RELIANCE", 100, 1.5, 0.5]);
    expect(out[2][0]).toBe("NSE:M&M");
    expect(out).toHaveLength(4);
    ctx.BRIDGE_QUOTES([["NSE:RELIANCE"], ["NSE:M&M"], [""], ["NSE:INFY"]]);
    expect(fetches).toHaveLength(1); // the second call is answered from the script cache
  });

  it("the key travels only in the Authorization header, never in the address", () => {
    const { ctx, fetches } = load({ respond: (u) => ({ body: quotesFor(u) }) });
    ctx.BRIDGE_QUOTES([["NSE:A"]]);
    ctx.BRIDGE_QUOTE("NSE:B", "ltp");
    expect(fetches.length).toBeGreaterThan(1);
    for (const f of fetches) {
      expect(f.options.headers).toEqual({ Authorization: `Bearer ${KEY}` });
      expect(f.url).not.toContain(KEY);
      expect(f.url).not.toMatch(/[?&]key=/);
      expect(f.options.method).toBe("get");
    }
    expect(SOURCE).not.toMatch(/[?&]key=/);
  });

  it("a long list is split by count and by address length: every request fits", () => {
    const { ctx, fetches } = load({ respond: (u) => ({ body: quotesFor(u) }) });
    const symbols = Array.from({ length: 250 }, (_, i) => [`NFO:NIFTY-2026-11-24-${20000 + i * 50}-CE`]);
    const out = ctx.BRIDGE_QUOTES(symbols);
    expect(out).toHaveLength(251);
    expect(fetches.length).toBeGreaterThanOrEqual(3);
    for (const f of fetches) {
      expect(f.url.length).toBeLessThan(2000);
      expect(new URL(f.url).searchParams.get("symbols").split(",").length).toBeLessThanOrEqual(100);
    }
  });

  it("a 429 says how long to wait, a 401 says the key was not accepted, an unreachable Bridge says so", () => {
    const limited = csv([["status", "code", "message", "retry_after_s"], ["429", "RATE_LIMITED", "Too many refreshes: wait 3 seconds and try again.", "3"]]);
    const a = load({ respond: () => ({ status: 429, body: limited, headers: { "Retry-After": "3" } }) });
    expect(() => a.ctx.BRIDGE_QUOTES([["NSE:A"]])).toThrow("Too many refreshes: wait 3 seconds.");
    const denied = csv([["status", "code", "message", "retry_after_s"], ["401", "UNAUTHENTICATED", "The key was not accepted: it may be wrong, expired or revoked.", ""]]);
    const b = load({ respond: () => ({ status: 401, body: denied }) });
    expect(() => b.ctx.BRIDGE_QUOTES([["NSE:A"]])).toThrow(/key was not accepted/);
    const c = load({
      respond: () => {
        throw new Error("DNS error");
      },
    });
    expect(() => c.ctx.BRIDGE_QUOTES([["NSE:A"]])).toThrow(/Could not reach the Bridge.*tunnel/);
    const d = load({ respond: () => ({ body: "" }), props: {} });
    expect(() => d.ctx.BRIDGE_QUOTES([["NSE:A"]])).toThrow(/BRIDGE_URL and BRIDGE_KEY/);
  });

  it("Refresh now: one request for the watchlist however many rows, answers placed next to the symbol typed, a status line", () => {
    const watch = makeSheet("Watchlist", { "5,1": "NSE:RELIANCE", "6,1": "", "7,1": "NSE:NOPE", "8,1": "NSE:M&M" });
    const positions = makeSheet("Positions");
    const { ctx, fetches } = load({
      sheets: { Watchlist: watch, Positions: positions },
      respond(u) {
        if (u.includes("/xl/positions")) return { body: csv([["account", "mode", "symbol"], ["demo", "live", "NSE:INFY"]]) };
        const head = [...QUOTE_HEAD, "demo"];
        return { body: csv([head, ["NSE:RELIANCE", "2900", "5", "0.17", "1000", "2026-11-09 11:00:27", "0.1", "realtime", "stream", "false", "", "DEMO"], ["NSE:NOPE", "", "", "", "", "", "", "", "", "", "SYMBOL_NOT_FOUND: not found", "DEMO"], ["NSE:M&M", "3100", "1", "0.1", "20", "2026-11-09 11:00:27", "0.1", "realtime", "cache", "false", "", "DEMO"]]) };
      },
    });
    ctx.refreshBridge();
    expect(fetches).toHaveLength(2); // the watchlist is ONE request; Positions is another
    expect(fetches[0].url).toBe("https://tunnel.example.com/xl/quotes?format=csv&fields=ltp,chg,pct,volume&symbols=NSE:RELIANCE,NSE:NOPE,NSE:M%26M");
    expect(fetches[1].url).toBe("https://tunnel.example.com/xl/positions?format=csv");
    expect(watch.at(5, 2)).toBe(2900);
    expect(watch.at(6, 2)).toBe(""); // blank row stays blank
    expect(watch.at(7, 11)).toBe("SYMBOL_NOT_FOUND: not found");
    expect(watch.at(8, 2)).toBe(3100);
    expect(watch.at(8, 9)).toBe("cache");
    expect(watch.at(2, 1)).toBe("DEMO DATA, not real prices. CHECK: 1 of 3 symbols could not be priced (see Error). Refreshed 2026-11-09 11:00:27 IST.");
    expect(positions.at(5, 3)).toBe("NSE:INFY");
    expect(positions.at(2, 1)).toMatch(/^1 rows\. Refreshed/);
  });

  it("a refused refresh is written to the Status cell and the old values stay", () => {
    const watch = makeSheet("Watchlist", { "5,1": "NSE:RELIANCE", "5,2": 2899 });
    const limited = csv([["status", "code", "message", "retry_after_s"], ["429", "RATE_LIMITED", "Too many refreshes: wait 4 seconds and try again.", "4"]]);
    const { ctx } = load({ sheets: { Watchlist: watch }, respond: () => ({ status: 429, body: limited }) });
    ctx.refreshBridge();
    expect(watch.at(2, 1)).toBe("Too many refreshes: wait 4 seconds. (2026-11-09 11:00:27 IST)");
    expect(watch.at(5, 2)).toBe(2899);
  });

  it("the timer accepts only the intervals Google allows and replaces the old trigger", () => {
    const { ctx, triggers } = load({ respond: () => ({}) });
    ctx.startTimedRefresh(15);
    expect(triggers.map((t) => t.minutes)).toEqual([15]);
    ctx.startTimedRefresh(7); // not allowed: falls back to 5
    expect(triggers.map((t) => t.minutes)).toEqual([5]);
    ctx.stopTimedRefresh();
    expect(triggers).toEqual([]);
  });

  it("states the risks and the limits plainly, and links the exposure guide", () => {
    expect(SOURCE).toContain("docs/guides/expose-alerts.md");
    expect(SOURCE).toMatch(/cannot reach 127\.0\.0\.1/);
    expect(SOURCE).toMatch(/visible to every person who can edit this script/);
    expect(SOURCE).toMatch(/Do NOT use the key-in-the-address form/);
    expect(SOURCE).toMatch(/20,000/);
    expect(SOURCE).not.toMatch(/\/v1\/orders|placeOrder/);
  });
});
