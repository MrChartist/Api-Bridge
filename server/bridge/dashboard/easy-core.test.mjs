/**
 * The rules that make the dashboard easy: the Simple and Advanced view, the Connect a tool wizard's key and setup
 * choices, what a failed request offers as its fix, the help topics, and the practice-order form. Pure (no DOM).
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  CONNECT_TOOLS,
  HELP_TOPICS,
  MODE_SLOT,
  connectCapabilities,
  connectKey,
  connectSetup,
  connectTool,
  failure,
  fixFor,
  getMode,
  normaliseSymbol,
  ordersChoice,
  pageShown,
  parseMode,
  practiceOrder,
  resetModeForTests,
  setMode,
  sourcesSentence,
  tabsShown,
  testOutcome,
  testRequest,
} from "./easy-core.js";

const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
};

describe("Simple and Advanced view", () => {
  beforeEach(() => {
    resetModeForTests();
    globalThis.localStorage = memory();
  });

  it("is Simple in a new browser and for anything unknown", () => {
    expect(getMode()).toBe("simple");
    expect(parseMode(undefined)).toBe("simple");
    expect(parseMode("expert")).toBe("simple");
    expect(parseMode("advanced")).toBe("advanced");
  });

  it("remembers the choice, tells listeners, and survives a reload", async () => {
    const { onMode } = await import("./easy-core.js");
    const seen = [];
    onMode((m) => seen.push(m));
    expect(setMode("advanced")).toBe("advanced");
    expect(globalThis.localStorage.getItem(MODE_SLOT)).toBe("advanced");
    setMode("advanced");
    expect(seen).toEqual(["advanced"]);
    resetModeForTests();
    expect(getMode()).toBe("advanced");
  });

  it("still works when storage is blocked", () => {
    resetModeForTests();
    globalThis.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(getMode()).toBe("simple");
    expect(setMode("advanced")).toBe("advanced");
    expect(getMode()).toBe("advanced");
  });

  it("hides advanced pages and tabs in Simple but never the one you are on", () => {
    const api = { id: "api", advanced: true };
    const accounts = { id: "accounts" };
    expect(pageShown(accounts, "simple")).toBe(true);
    expect(pageShown(api, "simple")).toBe(false);
    expect(pageShown(api, "simple", "api")).toBe(true);
    expect(pageShown(api, "advanced")).toBe(true);
    const page = { tabs: [{ id: "overview", advanced: true }, { id: "providers" }, { id: "quotas", advanced: true }] };
    expect(tabsShown(page, "simple", "providers").map((t) => t.id)).toEqual(["providers"]);
    expect(tabsShown(page, "simple", "quotas").map((t) => t.id)).toEqual(["providers", "quotas"]);
    expect(tabsShown(page, "advanced").map((t) => t.id)).toEqual(["overview", "providers", "quotas"]);
  });

  it("keeps every page and tab reachable by address in both views", async () => {
    const { PAGES, resolveRoute } = await import("./views.js");
    for (const mode of ["simple", "advanced"]) {
      for (const p of PAGES) {
        expect(resolveRoute(`#/${p.id}`, { mode }).page.id).toBe(p.id);
        for (const t of p.tabs ?? []) {
          const r = resolveRoute(`#/${p.id}/${t.id}`, { mode });
          expect([r.page.id, r.tab.id, r.redirect]).toEqual([p.id, t.id, null]);
        }
      }
    }
  });

  it("opens Sources on Providers in Simple and on Overview in Advanced", async () => {
    const { resolveRoute } = await import("./views.js");
    expect(resolveRoute("#/sources", { mode: "simple" }).tab.id).toBe("providers");
    expect(resolveRoute("#/sources", { mode: "advanced" }).tab.id).toBe("overview");
    // A page with no plain tab keeps its default; a remembered tab only counts in Advanced.
    expect(resolveRoute("#/api", { mode: "simple" }).tab.id).toBe("keys");
    expect(resolveRoute("#/sources", { mode: "advanced", lastTab: () => "quotas" }).tab.id).toBe("quotas");
  });

  it("keeps the advanced pages in the menu model: API is flagged, Accounts and Orders are not", async () => {
    const { PAGES } = await import("./views.js");
    expect(PAGES.filter((p) => p.advanced).map((p) => p.id)).toEqual(["api"]);
    expect(PAGES.find((p) => p.id === "connect")).toMatchObject({ group: "Bridge", label: "Connect a tool" });
  });
});

describe("Connect a tool: the key each tool gets", () => {
  const now = new Date("2026-11-09T10:00:00Z");

  it("offers the six tools, each with a unique id and a setup", () => {
    expect(CONNECT_TOOLS.map((t) => t.id)).toEqual(["excel", "ai", "python", "node", "app", "amibroker"]);
    expect(new Set(CONNECT_TOOLS.map((t) => t.id)).size).toBe(CONNECT_TOOLS.length);
    for (const t of CONNECT_TOOLS) expect(connectSetup(t.id, { base: "http://127.0.0.1:4000", key: "mcb_k_secret" }).length, t.id).toBeGreaterThan(0);
  });

  it("makes read-only keys unless the person chose orders, and never live or admin", () => {
    for (const t of CONNECT_TOOLS) {
      for (const orders of [false, true]) {
        const k = connectKey(t.id, { orders, now });
        expect(k.scopes, `${t.id} orders=${orders}`).toEqual(t.orders === "optional" && orders ? ["paper"] : ["read"]);
        expect(k.scopes).not.toContain("live");
        expect(k.scopes).not.toContain("admin");
        expect(k.accounts).toBe("*");
      }
    }
  });

  it("gives spreadsheet tools the URL rule and an expiry, and nobody else", () => {
    const excel = connectKey("excel", { now });
    expect(excel).toMatchObject({ scopes: ["read"], allowQuery: true, clientKind: "excel" });
    expect(Date.parse(excel.expiresAt) - now.getTime()).toBe(90 * 86_400_000);
    expect(connectKey("amibroker", { now }).allowQuery).toBe(true);
    for (const id of ["ai", "python", "node", "app"]) expect(connectKey(id, { now }).allowQuery, id).toBeUndefined();
    // The URL rule is for read-only keys: a tool that cannot place orders ignores the switch.
    expect(connectKey("excel", { orders: true, now }).scopes).toEqual(["read"]);
  });

  it("names the key like the Keys page and keeps names apart", () => {
    expect(connectKey("python", { now }).label).toBe("Python key · 9 Nov");
    expect(connectKey("python", { now, taken: ["Python key · 9 Nov"] }).label).toBe("Python key · 9 Nov 2");
  });

  it("asks about orders only where orders make sense, with the safe answer first", () => {
    expect(ordersChoice("excel")).toBeNull();
    expect(ordersChoice("amibroker")).toBeNull();
    for (const id of ["ai", "python", "node", "app"]) expect(ordersChoice(id).options[0][0], id).toBe("no");
    expect(ordersChoice("ai").options[1][1]).toMatch(/approve/);
  });

  it("says what a tool can and cannot do", () => {
    expect(connectCapabilities("python").cannot).toMatch(/cannot place any order/);
    expect(connectCapabilities("python", { orders: true }).can).toMatch(/practice \(paper\) orders/);
    expect(connectCapabilities("python", { orders: true }).cannot).toMatch(/real-money/);
    expect(connectCapabilities("ai", { orders: true }).can).toMatch(/approve/);
    expect(connectCapabilities("ai", { orders: true }).cannot).toMatch(/on its own/);
    // The switch means nothing for a tool that cannot place orders.
    expect(connectCapabilities("excel", { orders: true }).cannot).toMatch(/cannot place any order/);
  });

  it("fills the real address and the new key into every setup, with no placeholder left", () => {
    for (const t of CONNECT_TOOLS) {
      const text = connectSetup(t.id, { base: "http://127.0.0.1:4446", key: "mcb_abc_SECRET123", account: "demo-paper" })
        .flatMap((g) => g.blocks.map((b) => b.code))
        .join("\n");
      expect(text, t.id).toContain("mcb_abc_SECRET123");
      expect(text, t.id).not.toMatch(/YOUR_/);
      if (t.id !== "chatgpt") expect(text, t.id).toMatch(/127\.0\.0\.1:4446|MCB_API_KEY|mcb_abc/);
    }
    expect(connectSetup("excel", { base: "http://127.0.0.1:4446", key: "k" })[0].blocks[0].code).toContain("http://127.0.0.1:4446/xl/ltp");
  });

  it("tests the way the tool really asks", () => {
    expect(testRequest("excel", "mcb_a b")).toEqual({ url: "/xl/ltp?symbol=NSE%3ARELIANCE&key=mcb_a%20b", headers: {}, kind: "sheet" });
    expect(testRequest("python", "mcb_x")).toMatchObject({ url: "/v1/ltp?symbols=NSE%3ARELIANCE", headers: { authorization: "Bearer mcb_x" }, kind: "api" });
  });
});

describe("Test it: pass and fail in plain words", () => {
  it("passes with the price, and says when the data is sample or late", () => {
    const ok = testOutcome({ status: 200, json: { data: [{ symbol: "NSE:RELIANCE", ltp: 1464.1, freshness: { class: "realtime" } }], meta: { demo: true } } });
    expect(ok).toMatchObject({ ok: true, title: "It works" });
    expect(ok.detail).toMatch(/RELIANCE is 1464.1/);
    expect(ok.detail).toMatch(/sample prices/);
    const late = testOutcome({ status: 200, json: { data: [{ ltp: 100, freshness: { class: "delayed", delaySec: 900 } }] } });
    expect(late.title).toMatch(/late/);
    expect(late.detail).toMatch(/15 minutes late/);
    expect(late.fix).toMatchObject({ id: "delayed", route: "sources/providers" });
    expect(testOutcome({ status: 200, text: "1467.1" }).detail).toMatch(/RELIANCE is 1467.1/);
  });

  it("fails with the cause and one fix", () => {
    expect(testOutcome({ status: 401, json: { code: "UNAUTHENTICATED" } })).toMatchObject({ ok: false, title: "The key was not accepted", fix: { id: "login" } });
    expect(testOutcome({ status: 403, json: { code: "SCOPE_REQUIRED" } }).fix).toMatchObject({ id: "keys", route: "api/keys" });
    expect(testOutcome({ status: 429, json: {} }).fix).toMatchObject({ id: "limits" });
    expect(testOutcome({ network: true })).toMatchObject({ ok: false, fix: { id: "retry" } });
    expect(testOutcome({ status: 401, text: "UNAUTH" }).ok).toBe(false);
  });
});

describe("When something fails: the fix", () => {
  it("maps each cause to one button", () => {
    const f = (code, status) => fixFor({ code, status });
    expect(f("UNAUTHENTICATED")).toMatchObject({ id: "login", label: "Log in again" });
    expect(f("SCOPE_REQUIRED")).toMatchObject({ id: "keys", route: "api/keys" });
    expect(f("ACCOUNT_FORBIDDEN")).toMatchObject({ id: "keys" });
    expect(f("RATE_LIMITED")).toMatchObject({ id: "limits", route: "sources/overview" });
    expect(f("UPSTREAM_RATE_LIMITED")).toMatchObject({ id: "limits" });
    expect(f("SESSION_EXPIRED")).toMatchObject({ id: "broker", route: "accounts" });
    expect(f("BROKER_UNAVAILABLE")).toMatchObject({ id: "broker" });
    expect(f("KILL_SWITCH_ENGAGED")).toMatchObject({ id: "safety", route: "safety" });
    expect(f("UPSTREAM_TIMEOUT")).toMatchObject({ id: "retry" });
    expect(fixFor({ network: true })).toMatchObject({ id: "retry" });
  });

  it("falls back to the HTTP status, and offers nothing it cannot back up", () => {
    expect(fixFor({ status: 401 }).id).toBe("login");
    expect(fixFor({ status: 403 }).id).toBe("keys");
    expect(fixFor({ status: 429 }).id).toBe("limits");
    expect(fixFor({ status: 500 })).toBeNull();
    expect(fixFor({ code: "VALIDATION_FAILED", status: 400 })).toBeNull();
    expect(fixFor(null)).toBeNull();
    expect(fixFor(undefined)).toBeNull();
  });

  it("every dashboard route a fix points to exists", async () => {
    const { PAGES, resolveRoute } = await import("./views.js");
    for (const code of ["SCOPE_REQUIRED", "RATE_LIMITED", "SESSION_EXPIRED", "KILL_SWITCH_ENGAGED"]) {
      const r = resolveRoute(`#/${fixFor({ code }).route}`);
      expect(PAGES.map((p) => p.id), code).toContain(r.page.id);
      expect(r.redirect, code).toBeNull();
    }
  });

  it("explains in plain words and never repeats a code", () => {
    for (const code of ["UNAUTHENTICATED", "SCOPE_REQUIRED", "RATE_LIMITED", "SESSION_EXPIRED", "KILL_SWITCH_ENGAGED"]) {
      const f = failure({ code });
      expect(f.title).not.toMatch(/[A-Z]_[A-Z]/);
      expect(f.detail.length).toBeGreaterThan(10);
    }
  });
});

describe("Something wrong?", () => {
  it("answers the common problems, each with a place that exists", async () => {
    const { resolveRoute } = await import("./views.js");
    expect(HELP_TOPICS.map((t) => t.id)).toEqual(["rate", "old", "stop", "login", "key", "connect"]);
    for (const t of HELP_TOPICS) {
      expect(t.title.length).toBeGreaterThan(5);
      if (t.to === "stop") continue;
      const r = resolveRoute(`#/${t.to}`, { mode: "advanced" });
      expect(r.redirect, t.id).toBeNull();
    }
    expect(HELP_TOPICS.find((t) => t.id === "stop").danger).toBe(true);
  });
});

describe("Sources in one sentence", () => {
  const ok = { state: "ok" };
  it("names the sources and whether they work", () => {
    expect(sourcesSentence([{ name: "Zerodha", enabled: true, health: ok }])).toBe("Your prices come from Zerodha, and it is working.");
    expect(sourcesSentence([{ name: "Zerodha", enabled: true, health: ok }, { name: "Dhan", enabled: true, health: ok }])).toBe("Your prices come from Zerodha and Dhan, and all are working.");
    expect(sourcesSentence([{ name: "A", enabled: true, health: ok }, { name: "B", enabled: true, health: ok }, { name: "C", enabled: true, health: ok }])).toMatch(/A, B and C/);
  });
  it("says so when something is wrong or nothing is on", () => {
    expect(sourcesSentence([{ name: "A", enabled: true, health: ok }, { name: "B", enabled: true, health: { state: "open" } }])).toMatch(/B has a problem/);
    expect(sourcesSentence([{ name: "A", enabled: false }])).toMatch(/No source is turned on/);
    expect(sourcesSentence([])).toMatch(/Accounts/);
  });
});

describe("Practice order", () => {
  it("understands a stock typed the way people type it", () => {
    expect(normaliseSymbol("reliance")).toBe("NSE:RELIANCE");
    expect(normaliseSymbol("  tcs ")).toBe("NSE:TCS");
    expect(normaliseSymbol("BSE:SENSEX")).toBe("BSE:SENSEX");
    expect(normaliseSymbol("")).toBe("");
  });
  it("builds a paper market order from three answers", () => {
    expect(practiceOrder({ account: "demo-paper", symbol: "reliance", side: "BUY", quantity: "10" })).toEqual({
      body: { account: "demo-paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 10, product: "CNC", orderType: "MARKET", mode: "paper" },
    });
    expect(practiceOrder({ account: "a", symbol: "x", side: "anything else", quantity: 1 }).body.side).toBe("BUY");
    expect(practiceOrder({ account: "a", symbol: "x", side: "SELL", quantity: 1 }).body.side).toBe("SELL");
  });
  it("points at the field to fix", () => {
    expect(practiceOrder({ account: "a", symbol: "", quantity: 1 }).error.field).toBe("symbol");
    for (const q of ["0", "-3", "2.5", "ten", ""]) expect(practiceOrder({ account: "a", symbol: "x", quantity: q }).error.field, q).toBe("quantity");
    expect(practiceOrder({ account: "", symbol: "x", quantity: 1 }).error.field).toBe("account");
  });
});

it("never names a tool the dashboard cannot set up", () => {
  expect(connectTool("nope")).toBeNull();
  expect(() => connectKey("nope")).toThrow(/Unknown tool/);
});
