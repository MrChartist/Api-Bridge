/**
 * integrations/google-sheets/bridge.gs, run in a sandbox with stand-ins for Google's services: one request per
 * refresh however many rows, the key only in a header, long lists split by address length, the 429 message shown,
 * timer intervals Google accepts. No network.
 */
import { describe, expect, it } from "vitest";
import { KEY, SOURCE, load, makeSheet } from "./__fixtures__/appsScriptHarness.mjs";

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

  const POS_HEAD = ["account", "mode", "symbol", "product", "qty", "avg_price", "ltp", "pnl", "realised_pnl", "unrealised_pnl", "as_of", "age_s", "class", "source", "stale", "error"];

  it("INT-03: a column the Bridge adds (demo) does not overflow the sheet; values go under the column of the same name", () => {
    const positions = makeSheet("Positions", { "5,1": "old", "6,1": "old" });
    const row = ["paper", "paper", "NSE:INFY", "CNC", "5", "100", "101", "5", "0", "5", "2026-11-09 11:00:27", "0.1", "realtime", "paper", "false", "", "DEMO"];
    const { ctx } = load({ sheets: { Positions: positions }, respond: () => ({ body: csv([[...POS_HEAD, "demo"], row]) }) });
    ctx.refreshBridge(); // before the fix: "The data has 17 but the range has 16" and the sheet stayed empty
    expect(positions.at(5, 3)).toBe("NSE:INFY");
    expect(positions.at(5, 16)).toBe(""); // error column, not the demo marker
    expect(positions.at(6, 1)).toBeUndefined(); // the old rows are cleared
    expect(positions.at(2, 1)).toMatch(/^DEMO DATA, not real\. 1 rows\. Refreshed/);
    // columns in another order still land under their names
    const shuffled = { ...Object.fromEntries(POS_HEAD.map((c, i) => [c, row[i]])) };
    const reversed = [...POS_HEAD].reverse();
    const sheet2 = makeSheet("Positions");
    load({ sheets: { Positions: sheet2 }, respond: () => ({ body: csv([reversed, reversed.map((c) => shuffled[c])]) }) }).ctx.refreshBridge();
    expect(sheet2.at(5, 1)).toBe("paper");
    expect(sheet2.at(5, 3)).toBe("NSE:INFY");
  });

  it("ids stay text: leading zeros and 18-digit order ids are not turned into numbers (audit F10)", () => {
    const ORD_HEAD = ["account", "mode", "order_id", "client_order_id", "symbol", "side", "product", "order_type", "qty", "filled_qty", "avg_price", "price", "trigger_price", "status", "status_message", "placed_at", "updated_at", "as_of", "age_s", "class", "source", "stale", "error"];
    const row = { account: "0007", mode: "live", order_id: "123456789012345678", client_order_id: "0001", symbol: "NSE:INFY", side: "BUY", product: "CNC", order_type: "LIMIT", qty: "10", filled_qty: "0", avg_price: "0", price: "1500.5", trigger_price: "", status: "open", status_message: "007", placed_at: "2026-11-09 10:00:00", updated_at: "", as_of: "2026-11-09 11:00:27", age_s: "0.1", class: "realtime", source: "broker", stale: "false", error: "" };
    const orders = makeSheet("Orders");
    load({ sheets: { Orders: orders }, respond: () => ({ body: csv([ORD_HEAD, ORD_HEAD.map((c) => row[c])]) }) }).ctx.refreshBridge();
    expect(orders.at(5, 1)).toBe("0007"); // account
    expect(orders.at(5, 3)).toBe("123456789012345678"); // order id: all 18 digits
    expect(orders.at(5, 4)).toBe("0001"); // client order id
    expect(orders.at(5, 9)).toBe(10); // qty is still a number
    expect(orders.at(5, 12)).toBe(1500.5); // price too
    // a value with a leading zero or over 15 digits is not converted even in a column the script does not know
    const { ctx } = load({ respond: () => ({ body: "" }) });
    expect(ctx.num_("007", "other")).toBe("007");
    expect(ctx.num_("1234567890123456", "other")).toBe("1234567890123456");
    expect(ctx.num_("-12.50", "other")).toBe(-12.5);
    expect(ctx.num_("0.5", "other")).toBe(0.5);
    expect(ctx.num_("0", "other")).toBe(0);
  });

  it("INT-03: one sheet that cannot be filled shows the reason in A2 and the others still refresh", () => {
    const positions = makeSheet("Positions");
    const funds = makeSheet("Funds");
    const { ctx } = load({
      sheets: { Positions: positions, Funds: funds },
      respond: (u) => (u.includes("/xl/positions") ? { body: csv([["account", "mode"], ["a", "b"]]) } : { body: csv([["account", "mode", "available_cash"], ["paper", "paper", "100"]]) }),
    });
    const getRange = positions.getRange;
    positions.getRange = (...a) => {
      const range = getRange(...a);
      if (a.length === 4) {
        range.clearContent = () => {
          throw new Error("Range is locked");
        };
      }
      return range;
    };
    ctx.refreshBridge();
    expect(positions.at(2, 1)).toMatch(/^ERROR: Range is locked/);
    expect(funds.at(5, 3)).toBe(100);
    expect(funds.at(2, 1)).toMatch(/^1 rows\. Refreshed/);
  });

  it("INT-03: missing script properties show the message on every sheet instead of throwing", () => {
    const watch = makeSheet("Watchlist", { "5,1": "NSE:INFY" });
    const funds = makeSheet("Funds");
    const { ctx } = load({ sheets: { Watchlist: watch, Funds: funds }, respond: () => ({}), props: {} });
    expect(() => ctx.refreshBridge()).not.toThrow();
    expect(watch.at(2, 1)).toMatch(/^ERROR: Set BRIDGE_URL and BRIDGE_KEY/);
    expect(funds.at(2, 1)).toMatch(/^ERROR: Set BRIDGE_URL and BRIDGE_KEY/);
  });

  it("INT-04: a 200 answer that is not a Bridge table (a tunnel notice) leaves the prices alone and says so", () => {
    const watch = makeSheet("Watchlist", { "5,1": "NSE:RELIANCE", "5,2": 2899, "5,3": 5 });
    const positions = makeSheet("Positions", { "5,1": "keep-me" });
    const page = "<html><body>Click here to visit the site</body></html>";
    const { ctx } = load({ sheets: { Watchlist: watch, Positions: positions }, respond: () => ({ status: 200, body: page }) });
    ctx.refreshBridge();
    expect(watch.at(5, 2)).toBe(2899);
    expect(watch.at(5, 3)).toBe(5);
    expect(watch.at(2, 1)).toMatch(/^NO ANSWER: The answer is not a Bridge table \(a login page or a tunnel notice\?\)\. It starts: <html><body>Click here/);
    expect(positions.at(5, 1)).toBe("keep-me");
    expect(positions.at(2, 1)).toMatch(/^NO ANSWER: The answer is not a Bridge table/);
    expect(() => ctx.BRIDGE_QUOTES([["NSE:A"]])).toThrow(/not a Bridge table/);
    expect(() => ctx.BRIDGE_HISTORY("NSE:A", "1d", 3)).toThrow(/not a Bridge table/);
  });

  it("INT-04: the Bridge's refusal table arriving with 200 is a refusal, not a data row", () => {
    const watch = makeSheet("Watchlist", { "5,1": "NSE:RELIANCE", "5,2": 2899 });
    const refusal = csv([["status", "code", "message", "retry_after_s"], ["429", "RATE_LIMITED", "Too many refreshes: wait 3 seconds and try again.", "3"]]);
    const { ctx } = load({ sheets: { Watchlist: watch }, respond: () => ({ status: 200, body: refusal }) });
    ctx.refreshBridge();
    expect(watch.at(5, 2)).toBe(2899);
    expect(watch.at(2, 1)).toBe("Too many refreshes: wait 3 seconds. (2026-11-09 11:00:27 IST)");
  });

  it("an empty Watchlist asks for symbols instead of throwing", () => {
    const watch = makeSheet("Watchlist");
    const { ctx, fetches } = load({ sheets: { Watchlist: watch }, respond: () => ({}) });
    ctx.refreshBridge();
    expect(fetches).toHaveLength(0);
    expect(watch.at(2, 1)).toMatch(/^Type some symbols in column A/);
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
