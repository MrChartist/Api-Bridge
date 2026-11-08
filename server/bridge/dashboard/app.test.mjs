/**
 * The dashboard's pending-confirmation view: a person must see every field the confirmation covers before they
 * approve it, and the single-use code must be shown once after confirming. Pure helpers only (no DOM).
 */
import { describe, expect, it } from "vitest";
import { confirmCodeNotice, ticketFields } from "./app.js";

const ticket = {
  ticketId: "tkt_abc123",
  source: "mcp",
  client: "Claude",
  order: { account: "zerodha-main", symbol: "NSE:RELIANCE", side: "BUY", quantity: 10, product: "CNC", orderType: "LIMIT", price: 1400, triggerPrice: null, validity: "DAY", mode: "live", tag: "ai1" },
  checks: [{ code: "PRICE_FAR_FROM_LTP", message: "Price is 4% away from the last price.", severity: "warn" }],
  estimatedValue: 14000,
};
const accounts = new Map([["zerodha-main", { id: "zerodha-main", broker: "zerodha", label: "Main" }]]);

describe("dashboard ticket view", () => {
  it("shows every field of the order the confirmation covers", () => {
    const f = Object.fromEntries(ticketFields(ticket, accounts).map(([k, v]) => [k, v]));
    expect(f.Account).toBe("zerodha-main (zerodha · Main)");
    expect(f.Mode).toMatch(/LIVE/);
    expect(f).toMatchObject({ Side: "BUY", Quantity: "10", Symbol: "NSE:RELIANCE", "Order type": "LIMIT", Product: "CNC", Validity: "DAY", Tag: "ai1" });
    // Money follows the house rule: rupee sign, no grouping commas, two decimals; a missing value is "–" (DASH).
    expect(f.Price).toBe("₹1400.00");
    expect(f["Trigger price"]).toBe("–");
    expect(f["Estimated value"]).toBe("₹14000.00");
    expect(f.Warning).toMatch(/PRICE_FAR_FROM_LTP/);
  });

  it("flags live mode, MARKET orders and blocking checks", () => {
    const rows = ticketFields({ ...ticket, order: { ...ticket.order, orderType: "MARKET", price: null }, checks: [{ code: "KILL_SWITCH", severity: "block" }] }, accounts);
    const cls = Object.fromEntries(rows.map(([k, , c]) => [k, c]));
    expect(cls.Mode).toBe("bad");
    expect(cls["Order type"]).toBe("warn");
    expect(rows.find(([k]) => k === "Order type")[1]).toMatch(/MARKET \(no price limit\)/);
    expect(cls.Blocked).toBe("bad");
  });

  it("shows lots and an unknown account plainly", () => {
    const f = Object.fromEntries(ticketFields({ order: { account: "ghost", lots: 2, symbol: "NFO:NIFTY-2026-10-27-25000-CE", mode: "paper" } }).map(([k, v]) => [k, v]));
    expect(f).toMatchObject({ Account: "ghost", Quantity: "2 lot(s)", Mode: "paper", Validity: "DAY" });
  });

  it("keeps the confirmation code from the confirm response instead of throwing it away", () => {
    const n = confirmCodeNotice("tkt_abc123", { data: { confirmToken: "mct_0123456789abcdef", expiresAt: "2026-10-18T10:01:00+05:30" }, meta: {} });
    expect(n.token).toBe("mct_0123456789abcdef");
    expect(n.text).toMatch(/single-use/);
    expect(n.text).toMatch(/expires at/);
    expect(confirmCodeNotice("tkt_x", { data: {} })).toBeNull();
  });
});

describe("dashboard helpers", async () => {
  const { friendlyError, highlightJson } = await import("./app.js");
  const { KEY_PRESETS, genericAlert, snippets } = await import("./snippets.js");

  it("explains errors in plain words", () => {
    expect(friendlyError({ network: true }).title).toMatch(/Cannot reach the Bridge/);
    expect(friendlyError({ code: "UNAUTHENTICATED" }).detail).toMatch(/keys create/);
    expect(friendlyError({ code: "SESSION_EXPIRED", message: "dhan-main: expired" }).detail).toMatch(/Accounts page, Log in/);
    expect(friendlyError({ code: "BROKER_UNAVAILABLE", message: "x" }).detail).toMatch(/Accounts page.*demo mode/);
    expect(friendlyError({ code: "UPSTREAM_ERROR", message: "Dhan: invalid token" })).toEqual({ title: "The broker did not accept this", detail: "Dhan: invalid token" });
    expect(friendlyError({ status: 418, message: "teapot" })).toEqual({ title: "The Bridge answered 418", detail: "teapot" });
  });

  it("escapes data before highlighting JSON", () => {
    const html = highlightJson(JSON.stringify({ name: "<img src=x onerror=alert(1)>", n: 1, ok: true }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain('<span class="json-num">1</span>');
  });

  it("fills snippets with the Bridge address and never an admin key", () => {
    const s = snippets({ base: "http://127.0.0.1:4300/", account: "paper" });
    const all = JSON.stringify(s);
    expect(Object.keys(s)).toEqual(["webhooks", "python", "node", "excel", "amibroker", "claude", "chatgpt", "rest"]);
    expect(all).toContain("http://127.0.0.1:4300/hooks/generic/");
    expect(all).toContain("mcb_YOUR_READ_KEY");
    expect(JSON.parse(s.claude[0].code).mcpServers["mr-chartist-bridge"].env.MCB_BRIDGE_URL).toBe("http://127.0.0.1:4300");
    expect(snippets({ base: "http://h:1", key: "mcb_k_x" }).excel[1].code).toBe("mcb_k_x");
    expect(JSON.parse(genericAlert())).toMatchObject({ symbol: "NSE:RELIANCE", side: "BUY", price: 1402.5 });
    expect(JSON.parse(genericAlert({ orderType: "MARKET" })).price).toBeUndefined();
    expect(KEY_PRESETS.webhooks).toBeUndefined(); // the hook URL (and signing secret) is the credential
    for (const p of Object.values(KEY_PRESETS)) expect(p.scopes).not.toContain("admin");
  });
});

describe("dashboard sign-in links", async () => {
  const { SIGN_IN_FAILED, redeemSignIn, signInCodeFromHash } = await import("./app.js");
  const code = "Ab1_-".padEnd(43, "x");

  it("finds the code in the fragment only", () => {
    expect(signInCodeFromHash(`#signin=${code}`)).toBe(code);
    expect(signInCodeFromHash(`#/signin=${code}`)).toBe(code);
    expect(signInCodeFromHash("#signin=")).toBe("");
    for (const h of ["", "#", "#/home", "#/console?endpoint=order", `#/keys?signin=${code}`, undefined]) expect(signInCodeFromHash(h)).toBeNull();
  });

  it("exchanges the code for a key, and explains a refused link in plain words", async () => {
    const calls = [];
    const ok = async (path, init) => {
      calls.push({ path, init });
      return { ok: true, status: 201, json: async () => ({ data: { key: "mcb_abcdefghij_key", record: {} } }) };
    };
    expect(await redeemSignIn(code, ok)).toEqual({ key: "mcb_abcdefghij_key" });
    expect(calls[0].path).toBe("/v1/sign-in");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body)).toEqual({ code });
    expect(calls[0].init.headers.Authorization).toBeUndefined();

    const refused = async () => ({ ok: false, status: 401, json: async () => ({ code: "UNAUTHENTICATED", detail: SIGN_IN_FAILED.detail }) });
    const r = await redeemSignIn(code, refused);
    expect(r.error.title).toBe(SIGN_IN_FAILED.title);
    expect(r.error.detail).toMatch(/expired or was already used.*mc-bridge open/);
    const blank = await redeemSignIn(code, async () => ({ ok: false, status: 500, json: async () => { throw new Error("not json"); } }));
    expect(blank.error.detail).toBe(SIGN_IN_FAILED.detail);
    expect(await redeemSignIn(code, async () => { throw new TypeError("offline"); })).toEqual({ error: { network: true } });
  });

  it("matches what the Bridge says", async () => {
    const { SIGN_IN_FAILED: serverText } = await import("../auth/module.mjs");
    expect(SIGN_IN_FAILED.detail).toBe(serverText);
  });
});

describe("dashboard broker login form", async () => {
  const { brokerMatches, fieldLabel, fillLoginUrl, loginBody, loginFormSpec, loginHelp } = await import("./app.js");
  const { createBrokerRegistry } = await import("../../brokers/registry.mjs");
  const { BROKER_NAMES } = await import("../accounts/brokerInfo.mjs");
  const { loginUrlTemplate } = await import("../accounts/routes.mjs");
  const { isForbiddenSecretKey } = await import("../../brokers/contract.mjs");
  const reg = createBrokerRegistry();
  /** The broker entry the dashboard gets from GET /v1/brokers, built the same way. */
  const info = (id) => {
    const a = reg.get(id);
    const loginUrl = loginUrlTemplate(a);
    return {
      id,
      name: BROKER_NAMES[id],
      authKind: a.capabilities.auth.kind,
      verified: id === "dhan",
      credentialFields: [...a.credentialFields],
      loginFields: (a.capabilities.auth.loginFields ?? []).map((f) => ({ key: f.key, label: f.label ?? f.key, kind: f.kind ?? "secret" })),
      tokenExpiry: a.capabilities.auth.tokenExpiry ?? null,
      ...(loginUrl ? { loginUrl } : {}),
    };
  };

  it("Dhan: client id shown as typed, access token masked, no one-time fields", () => {
    const spec = loginFormSpec(info("dhan"));
    expect(spec.kind).toBe("apiKeyToken");
    expect(spec.fields.map((f) => [f.key, f.label, f.type, f.group])).toEqual([
      ["clientId", "Client ID", "text", "values"],
      ["accessToken", "Access token", "password", "values"],
    ]);
    expect(spec.help.join(" ")).toMatch(/Dhan's API or developer page/);
  });

  it("Zerodha: API key and secret once, the access token daily, and a fillable login page", () => {
    const z = info("zerodha");
    const spec = loginFormSpec(z);
    expect(spec.fields.map((f) => f.key)).toEqual(["apiKey", "apiSecret", "accessToken"]);
    expect(spec.fields.every((f) => f.type === "password")).toBe(true);
    expect(spec.fields.find((f) => f.key === "accessToken").hint).toMatch(/every trading day/);
    expect(spec.help.join(" ")).toMatch(/06:00 IST next day/);
    expect(fillLoginUrl(z.loginUrl, {})).toBeNull();
    const url = fillLoginUrl(z.loginUrl, { apiKey: "abc 123" });
    expect(url).toMatch(/^https:\/\/kite\.zerodha\.com\/connect\/login\?v=3&api_key=abc%20123$/);
    expect(fillLoginUrl("http://x.example/?k={apiKey}", { apiKey: "a" })).toBeNull();
  });

  it("session brokers: PIN masked, TOTP numeric with 6 digits, both required and never in values", () => {
    const spec = loginFormSpec(info("angelone"), { saved: true });
    const totp = spec.fields.find((f) => f.key === "totpCode");
    expect(totp).toMatchObject({ group: "secrets", type: "text", inputmode: "numeric", pattern: "[0-9]{6}", maxlength: 6, required: true });
    expect(spec.fields.find((f) => f.key === "password")).toMatchObject({ group: "secrets", type: "password", required: true });
    expect(spec.keepHint).toBe(true);
    expect(loginHelp(info("angelone")).join(" ")).toMatch(/never saved/);
  });

  it("every broker gets a usable form: labelled fields, no password or TOTP saved as a value", () => {
    for (const id of reg.list()) {
      const spec = loginFormSpec(info(id));
      expect(spec.fields.length).toBeGreaterThan(0);
      for (const f of spec.fields) {
        expect(f.label).toMatch(/^[A-Za-z0-9]/);
        if (f.group === "values") expect(isForbiddenSecretKey(f.key)).toBe(false);
      }
      if (spec.kind === "sessionLogin") expect(spec.fields.some((f) => f.group === "secrets")).toBe(true);
      expect(spec.help.length).toBeGreaterThan(0);
    }
  });

  it("the request body leaves out empty fields (saved values are kept) and splits secrets", () => {
    const spec = loginFormSpec(info("angelone"));
    const typed = { apiKey: " k1 ", clientId: "", password: "1234", totpCode: "123456" };
    expect(loginBody(spec, (f) => typed[f.key])).toEqual({ values: { apiKey: "k1" }, secrets: { password: "1234", totpCode: "123456" } });
    expect(loginBody(loginFormSpec(info("dhan")), () => "")).toEqual({ values: {} });
  });

  it("labels and search", () => {
    expect(fieldLabel("interactiveApiSecret")).toBe("Interactive (orders) API secret");
    expect(fieldLabel("someNewApiId")).toBe("Some new API ID");
    const b = { id: "angelone", name: "Angel One (SmartAPI)" };
    expect(brokerMatches(b, "")).toBe(true);
    expect(brokerMatches(b, "angel one")).toBe(true);
    expect(brokerMatches(b, "SMART")).toBe(true);
    expect(brokerMatches(b, "zerodha")).toBe(false);
  });

  it("no beginner text sends people to the terminal or the config file for accounts", async () => {
    const { readFileSync } = await import("node:fs");
    const views = readFileSync(new URL("./views.js", import.meta.url), "utf8");
    const appJs = readFileSync(new URL("./app.js", import.meta.url), "utf8");
    for (const src of [views, appJs]) {
      expect(src).not.toMatch(/bridge -- init/);
      expect(src).not.toMatch(/npm start -- --demo/);
      expect(src).not.toMatch(/restart without --demo/);
      expect(src).not.toMatch(/under "accounts" in bridge\.config\.json/);
    }
  });
});

describe("the menu and the tabbed pages (API Bridge v2: Accounts, API, Orders, Safety)", async () => {
  const { PAGES, LEGACY, resolveRoute } = await import("./views.js");
  const { fuzzyScore, pageCommands, rank } = await import("./palette.js");
  const route = (hash, lastTab = () => null) => resolveRoute(hash, { lastTab });

  it("has 4 pages in two groups, in the order of the sidebar", () => {
    expect(PAGES.map((p) => p.id)).toEqual(["accounts", "api", "orders", "safety"]);
    expect([...new Set(PAGES.map((p) => p.group))]).toEqual(["Bridge", "Trade"]);
    expect(PAGES.filter((p) => p.tab).map((p) => p.id)).toEqual(["accounts", "api", "orders", "safety"]);
    expect(PAGES.find((p) => p.id === "orders").title).toBe("Orders");
  });

  it("curates the shortcuts", () => {
    const keys = Object.fromEntries(PAGES.filter((p) => p.key).map((p) => [p.key, p.id]));
    expect(keys).toEqual({ 1: "accounts", 2: "api", 3: "orders", 4: "safety" });
    expect(shortcutList().filter((s) => s.keys.length === 2 && /^[1-9]$/.test(s.keys[1])).map((s) => s.what)).toEqual(["Go to Accounts", "Go to API", "Go to Orders", "Go to Safety"]);
  });

  it("every tab names a legacy page id and every legacy id resolves to a tab of the page it names", () => {
    const tabbed = PAGES.filter((p) => p.tabs);
    expect(tabbed.map((p) => p.id)).toEqual(["api", "orders"]);
    for (const p of tabbed) {
      expect(p.tabs.some((t) => t.id === p.defaultTab), p.id).toBe(true);
      for (const t of p.tabs) {
        expect(typeof t.page, `${p.id}/${t.id}`).toBe("string");
        expect(typeof t.render, `${p.id}/${t.id}`).toBe("function");
      }
    }
    for (const [old, to] of Object.entries(LEGACY)) {
      const [pageId, tabId] = to.split("/");
      const tab = PAGES.find((p) => p.id === pageId)?.tabs?.find((t) => t.id === tabId);
      expect(tab?.page, `${old} → ${to}`).toBe(old);
    }
  });

  it("old hashes open the right tab and keep their query", () => {
    const cases = [
      ["#/console?endpoint=order", "api", "console", "console", "#/api/console?endpoint=order"],
      ["#/keys", "api", "keys", "keys", "#/api/keys"],
      ["#/limits", "api", "limits", "limits", "#/api/limits"],
      ["#/integrations?tab=python", "api", "integrations", "integrations", "#/api/integrations?tool=python"],
      ["#/activity", "api", "activity", "activity", "#/api/activity"],
    ];
    for (const [hash, page, tab, view, redirect] of cases) {
      const r = route(hash);
      expect([r.page.id, r.tab?.id, r.view, r.redirect], hash).toEqual([page, tab, view, redirect]);
    }
  });

  it("each tab sets its own data-page; plain pages are untouched", () => {
    expect(route("#/api/console?endpoint=order")).toMatchObject({ view: "console", query: "endpoint=order", redirect: null });
    expect(route("#/orders/trades")).toMatchObject({ view: "trades", redirect: null });
    expect(route("#/accounts")).toMatchObject({ view: "accounts", query: "", redirect: null });
  });

  it("an unknown page is Accounts (the first page); an unknown or missing tab is the last tab used, then the default", () => {
    expect(route("#/nowhere").page.id).toBe("accounts");
    expect(route("").page.id).toBe("accounts");
    expect(route("#signin=abc").page.id).toBe("accounts");
    expect(route("#/api").tab.id).toBe("keys");
    expect(route("#/api/nope").tab.id).toBe("keys");
    expect(route("#/api/nope").redirect).toBe("#/api/keys");
    expect(route("#/api/keys").redirect).toBe(null);
    expect(route("#/api", (id) => (id === "api" ? "limits" : null)).tab.id).toBe("limits");
    expect(route("#/api/nope", () => "gone").tab.id).toBe("keys");
  });

  it("the palette has one command per tab, the tools as search-only destinations, and ranks prefixes first", () => {
    const cmds = pageCommands(PAGES, "Ctrl");
    const byLabel = Object.fromEntries(cmds.map((c) => [c.label, c]));
    for (const l of ["API keys", "Integrations", "Test console", "Rate limits", "Activity", "Trade book", "Python snippet", "Webhooks", "Audit log"]) expect(byLabel[l], l).toBeTruthy();
    expect(byLabel["API keys"]).toMatchObject({ route: "api/keys", sub: "API › Keys", hint: ["Ctrl", "2"] });
    expect(byLabel["Python snippet"]).toMatchObject({ route: "api/integrations?tool=python", searchOnly: true });
    expect(byLabel["Audit log"].route).toBe("api/activity?view=audit");
    expect([...new Set(cmds.map((c) => c.group))]).toEqual(["Bridge", "Trade"]);
    expect(rank(cmds, "rate")[0].label).toBe("Rate limits");
    expect(rank(cmds, "console")[0].label).toBe("Test console");
    // A scattered in-order match is not enough: three points per query character.
    expect(fuzzyScore("rate", "Safety")).toBeLessThan(fuzzyScore("rate", "Rate limits"));
    expect(fuzzyScore("xqz", "Rate limits")).toBe(-1);
    expect(fuzzyScore("rl", "Rate limits")).toBeGreaterThanOrEqual(6);
  });
});
