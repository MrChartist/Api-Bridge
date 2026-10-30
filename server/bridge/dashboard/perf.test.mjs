// The dashboard's fetch layer, live connection and budget indicator: pure parts (docs/perf/README.md).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DASHBOARD_FILES } from "../core/app.mjs";
import { NAV_WINDOW_MS, PAINT_FROM_CACHE_MS, SHARE_MS, cacheUse, cacheable, forgetsAnswers, pollTarget } from "./app.js";
import { budgetView, busiestClass, perSecondLimit, savedParts, shareTone, windowText } from "./budget.js";
import { mergeTick, subscriptionDiff } from "./live.js";

describe("fetch layer memory", () => {
  it("shares answers for a moment, and paints older ones only while a page switches in", () => {
    expect(cacheUse(0, false)).toBe("fresh");
    expect(cacheUse(SHARE_MS, false)).toBe("fresh");
    expect(cacheUse(SHARE_MS + 1, false)).toBeNull();
    expect(cacheUse(SHARE_MS + 1, true)).toBe("paint");
    expect(cacheUse(PAINT_FROM_CACHE_MS, true)).toBe("paint");
    expect(cacheUse(PAINT_FROM_CACHE_MS + 1, true)).toBeNull();
    expect(cacheUse(Number.NaN, true)).toBeNull();
    expect(NAV_WINDOW_MS).toBeGreaterThan(1000);
  });

  it("never remembers one-time, audit or safety reads", () => {
    for (const p of ["/v1/stream/token", "/v1/safety", "/v1/tickets", "/v1/requests?limit=5", "/v1/audit", "/v1/orders/preview", "/v1/usage?series=1", "/v1/limits"]) expect(cacheable(p), p).toBe(false);
    for (const p of ["/v1/optionchain?underlying=NIFTY&expiry=2026-11-03", "/v1/quotes?symbols=NSE:NIFTY", "/v1/accounts", "/v1/orders?limit=100", "/v1/positions?account=x"]) expect(cacheable(p), p).toBe(true);
  });

  it("forgets every answer on a write, but not on a read-like POST", () => {
    expect(forgetsAnswers("POST", "/v1/orders")).toBe(true);
    expect(forgetsAnswers("DELETE", "/v1/orders/abc")).toBe(true);
    expect(forgetsAnswers("POST", "/v1/kill-switch")).toBe(true);
    expect(forgetsAnswers("POST", "/v1/stream/token")).toBe(false);
    expect(forgetsAnswers("POST", "/v1/orders/preview")).toBe(false);
    expect(forgetsAnswers("GET", "/v1/orders")).toBe(false);
  });
});

describe("polls become stream subscriptions", () => {
  it("reads the symbols and the mode of a polled quotes or LTP read", () => {
    expect(pollTarget("/v1/quotes?symbols=NSE%3ANIFTY%2CNFO%3ANIFTY-2026-11-03-26000-CE")).toEqual({ symbols: ["NSE:NIFTY", "NFO:NIFTY-2026-11-03-26000-CE"], mode: "quote" });
    expect(pollTarget("/v1/ltp?symbols=NSE:RELIANCE,NSE:INFY&maxAgeMs=500")).toEqual({ symbols: ["NSE:RELIANCE", "NSE:INFY"], mode: "ltp" });
    expect(pollTarget("/v1/optionchain?underlying=NIFTY")).toBeNull();
    expect(pollTarget("/v1/quotes?symbols=%E0%A4")).toBeNull();
  });
});

describe("live connection", () => {
  it("subscribes what is wanted once, raises modes, and unsubscribes what nobody wants", () => {
    const d = subscriptionDiff(
      new Map([
        ["NSE:NIFTY", "quote"],
        ["NFO:A", "quote"],
        ["NFO:B", "ltp"],
      ]),
      new Map([
        ["NSE:NIFTY", "ltp"],
        ["NFO:B", "quote"],
        ["NFO:OLD", "quote"],
      ]),
    );
    expect(Object.fromEntries(d.subscribe)).toEqual({ quote: ["NSE:NIFTY", "NFO:A"] });
    expect(d.unsubscribe).toEqual(["NFO:OLD"]);
  });

  it("merges a lighter tick over a fuller one without wiping known fields", () => {
    expect(mergeTick({ symbol: "X", ltp: 1, bid: 0.9, oi: 100 }, { symbol: "X", ltp: 2, bid: null })).toEqual({ symbol: "X", ltp: 2, bid: 0.9, oi: 100 });
    expect(mergeTick(null, { symbol: "X", ltp: 2 })).toEqual({ symbol: "X", ltp: 2 });
  });
});

describe("budget indicator", () => {
  const msg = {
    accounts: [
      { accountId: "a", second: { used: 3, limit: 10, cls: "quote" }, minute: { used: 380, limit: 400, cls: "quote" }, backoffMs: 0 },
      { accountId: "b", second: { used: 1, limit: 1, cls: "chain" }, minute: null, backoffMs: 0 },
    ],
    savedToday: 120,
    callsToday: 40,
    stream: { feeds: 1, up: 1 },
  };

  it("shows the fullest second and minute and the worst tone", () => {
    const v = budgetView(msg, "live");
    expect(v.second).toMatchObject({ used: 1, limit: 1, accountId: "b" });
    expect(v.minute).toMatchObject({ used: 380, limit: 400 });
    expect(v.tone).toBe("bad");
    expect(v.stream).toBe("live");
    expect(windowText(v.second)).toBe("1/1");
    expect(windowText(null)).toBe("–");
  });

  it("says when no broker feed is open or the dashboard's own connection is down", () => {
    expect(budgetView({ ...msg, stream: { feeds: 0, up: 0 } }, "live").stream).toBe("off");
    expect(budgetView(msg, "down").stream).toBe("down");
    expect(budgetView(null).hasBrokers).toBe(false);
  });

  it("tones by share, orders savings, picks the chart's class", () => {
    expect([shareTone(6, 10), shareTone(7, 10), shareTone(9, 10), shareTone(1, 0)]).toEqual(["ok", "warn", "bad", "ok"]);
    expect(savedParts({ servedFromStream: 5, servedFromCache: 9 })[0]).toEqual(["Cache", 9]);
    expect(busiestClass({ series: { classes: { quote: [1, 0, 2], chain: [0, 5] } } })).toBe("chain");
    expect(busiestClass({ classes: { quote: { callsToday: 0 }, chain: { callsToday: 0 } } })).toBe("quote");
    expect(perSecondLimit({ windows: [{ window: "1m", limit: 400 }, { window: "1s", limit: 10 }] })).toBe(10);
    expect(perSecondLimit({ windows: [] })).toBeNull();
  });
});

describe("served and lazy", () => {
  it("lists the new modules and loads page modules on first visit", () => {
    for (const f of ["live.js", "budget.js"]) expect(Object.hasOwn(DASHBOARD_FILES, f), f).toBe(true);
    const views = readFileSync(new URL("./views.js", import.meta.url), "utf8");
    // The heavy page modules are dynamic imports only (no static import from views.js).
    for (const m of ["desk.js", "screener.js", "calendar.js", "recorder.js", "events.js", "participants.js"]) {
      expect(views, m).not.toMatch(new RegExp(`^import [^;]+ from "\\./${m.replace(".", "\\.")}";`, "m"));
      expect(views, m).toContain(`import("./${m}")`);
    }
  });
});
