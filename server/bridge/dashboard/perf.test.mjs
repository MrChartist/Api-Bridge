// The dashboard's fetch layer, live connection and budget indicator: pure parts.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DASHBOARD_FILES } from "../core/app.mjs";
import { NAV_WINDOW_MS, PAINT_FROM_CACHE_MS, SHARE_MS, STABLE_FRESH_MS, STABLE_PAINT_MS, cacheUse, cacheable, forgetsAnswers, pollTarget, positionSymbols, stableRead, whenIdle } from "./app.js";
import { budgetView, savedParts, shareTone, windowText } from "./budget.js";
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
    expect(forgetsAnswers("POST", "/v1/studies/compute")).toBe(false);
    expect(forgetsAnswers("GET", "/v1/orders")).toBe(false);
    // A dry run changes nothing (Cancel all's count on the Orders page ran one on every render and forgot every answer).
    expect(forgetsAnswers("POST", "/v1/orders/cancel-all", { dryRun: true })).toBe(false);
    expect(forgetsAnswers("POST", "/v1/orders/cancel-all", { dryRun: false })).toBe(true);
    expect(forgetsAnswers("POST", "/v1/orders/cancel-all", {})).toBe(true);
    expect(forgetsAnswers("DELETE", "/v1/orders/abc", { dryRun: true })).toBe(true);
  });
});

describe("slow-changing reads", () => {
  it("only the broker directory counts as slow-changing, and it is still a remembered read", () => {
    expect(stableRead("/v1/brokers")).toBe(true);
    expect(stableRead("/v1/brokers?x=1")).toBe(true);
    for (const p of ["/v1/brokers/dhan", "/v1/brokersX", "/v1/accounts", "/v1/quotes?symbols=NSE:NIFTY", "/v1/orders", null, undefined]) expect(stableRead(p), String(p)).toBe(false);
    expect(cacheable("/v1/brokers")).toBe(true);
  });

  it("answers from memory for a minute, paints from memory (and refreshes behind it) for half an hour, then asks again", () => {
    expect(cacheUse(0, false, true)).toBe("fresh");
    expect(cacheUse(STABLE_FRESH_MS, false, true)).toBe("fresh");
    expect(cacheUse(STABLE_FRESH_MS + 1, false, true)).toBe("paint");
    expect(cacheUse(STABLE_PAINT_MS, false, true)).toBe("paint");
    expect(cacheUse(STABLE_PAINT_MS + 1, false, true)).toBeNull();
    expect(cacheUse(Number.NaN, false, true)).toBeNull();
    expect(cacheUse(-1, false, true)).toBeNull();
  });

  it("other reads are unchanged: the short share window, and older answers only while a page switches in", () => {
    expect(cacheUse(STABLE_FRESH_MS, false)).toBeNull();
    expect(cacheUse(SHARE_MS + 1, false, false)).toBeNull();
    expect(cacheUse(SHARE_MS + 1, true, false)).toBe("paint");
  });
});

describe("whenIdle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("uses requestIdleCallback with a deadline when the browser has it, and never runs the work at once", () => {
    const calls = [];
    vi.stubGlobal("requestIdleCallback", (cb, opts) => calls.push({ cb, opts }));
    let ran = 0;
    whenIdle(() => ran++, 900);
    expect(ran).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toEqual({ timeout: 900 });
    calls[0].cb();
    expect(ran).toBe(1);
  });

  it("falls back to a short timer without it", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    let ran = 0;
    whenIdle(() => ran++);
    expect(ran).toBe(0);
    vi.advanceTimersByTime(500);
    expect(ran).toBe(1);
  });
});

describe("polls become stream subscriptions", () => {
  it("reads the symbols and the mode of a polled quotes or LTP read", () => {
    expect(pollTarget("/v1/quotes?symbols=NSE%3ANIFTY%2CNFO%3ANIFTY-2026-11-03-26000-CE")).toEqual({ symbols: ["NSE:NIFTY", "NFO:NIFTY-2026-11-03-26000-CE"], mode: "quote" });
    expect(pollTarget("/v1/ltp?symbols=NSE:RELIANCE,NSE:INFY&maxAgeMs=500")).toEqual({ symbols: ["NSE:RELIANCE", "NSE:INFY"], mode: "ltp" });
    expect(pollTarget("/v1/optionchain?underlying=NIFTY")).toBeNull();
    expect(pollTarget("/v1/quotes?symbols=%E0%A4")).toBeNull();
  });

  it("reads the open positions of a polled positions answer, once each", () => {
    const body = { data: [{ symbol: "NFO:NIFTY-2026-11-03-26000-CE", netQty: -65 }, { symbol: "NFO:NIFTY-2026-11-03-26000-CE", netQty: 65 }, { symbol: "NSE:INFY", netQty: 0 }, { symbol: null, netQty: 5 }] };
    expect(positionSymbols("/v1/positions?account=demo-paper", body)).toEqual(["NFO:NIFTY-2026-11-03-26000-CE"]);
    expect(positionSymbols("/v1/positions", { data: [] })).toEqual([]);
    expect(positionSymbols("/v1/positionsx", body)).toBeNull();
    expect(positionSymbols("/v1/quotes?symbols=NSE:INFY", body)).toBeNull();
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

  it("tones by share and orders savings", () => {
    // The same scale as the Sources page: heads up from 80 %, at the limit from 95 %.
    expect([shareTone(7, 10), shareTone(8, 10), shareTone(9, 10), shareTone(9.5, 10), shareTone(1, 0)]).toEqual(["ok", "warn", "warn", "bad", "ok"]);
    expect(savedParts({ servedFromStream: 5, servedFromCache: 9 })[0]).toEqual(["Cache", 9]);
  });
});

describe("served and lazy", () => {
  it("lists the live and budget modules in the served files", () => {
    for (const f of ["live.js", "budget.js"]) expect(Object.hasOwn(DASHBOARD_FILES, f), f).toBe(true);
  });
});

describe("live paths stay cheap", () => {
  const read = (f) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");

  it("styles no page container by :has(): a :has() on .content or .app-main restyled the whole page on every live update", () => {
    // Measured in Chromium: such a rule made every change inside #content a style recalculation of the 2000 nodes
    // under it (40-90 ms a tick). Page-specific layout keys off :root[data-page] instead.
    const css = read("app.css");
    expect(css).not.toMatch(/(\.content|\.app-main)(?:[.:#[\w-]|\([^)]*\))*:has\(/);
  });

  it("animates live indicators and tick flashes on the compositor (opacity and transform), never the page's paint", () => {
    // Measured in headless Chromium: Motion's breathing `scale` on the sidebar dot repainted the whole page layer every
    // frame, and a background-color flash repainted a whole table on every frame.
    const css = read("app.css");
    const frames = (name) => css.match(new RegExp(`^@keyframes ${name} \\{.*\\}$`, "m"))?.[0] ?? "";
    for (const k of ["dv-breathe"]) {
      expect(frames(k), k).not.toBe("");
      expect(frames(k), k).not.toMatch(/background|box-shadow|color/);
    }
    expect(css).toMatch(/:root\.tab-hidden \.dv-breathe[^{]*\{ animation-play-state: paused; \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^@]*\.dv-breathe \{ animation: none;/);
    const motion = read("motion.js");
    expect(motion.slice(motion.indexOf("export function pulse"), motion.indexOf("export function pulse") + 600)).not.toMatch(/animate\(/);
  });

  it("opens one WebSocket per tab: pages use live.js", () => {
    for (const f of Object.keys(DASHBOARD_FILES).filter((n) => n.endsWith(".js") && n !== "live.js" && !n.startsWith("motion"))) {
      expect(read(f), f).not.toMatch(/new WebSocket\(/);
    }
  });

});
