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
    expect(f.Price).toMatch(/1,400/);
    expect(f["Trigger price"]).toBe("—");
    expect(f["Estimated value"]).toMatch(/14,000/);
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
  const { checklistState, friendlyError, highlightJson } = await import("./app.js");
  const { KEY_PRESETS, genericAlert, snippets } = await import("./snippets.js");

  it("explains errors in plain words", () => {
    expect(friendlyError({ network: true }).title).toMatch(/Cannot reach the Bridge/);
    expect(friendlyError({ code: "UNAUTHENTICATED" }).detail).toMatch(/keys create/);
    expect(friendlyError({ code: "SESSION_EXPIRED", message: "dhan-main: expired" }).detail).toMatch(/accounts connect/);
    expect(friendlyError({ code: "BROKER_UNAVAILABLE", message: "x" }).detail).toMatch(/--demo/);
    expect(friendlyError({ status: 418, message: "teapot" })).toEqual({ title: "The Bridge answered 418", detail: "teapot" });
  });

  it("works out the welcome checklist", () => {
    const keys = [{ id: "a" }, { id: "b", revokedAt: "2026-01-01" }];
    expect(checklistState({ demo: true, keys }).map((s) => s.done)).toEqual([true, false, false, false]);
    const accounts = [{ broker: "dhan", session: { state: "connected" } }];
    expect(checklistState({ accounts, keys: [{ id: "a" }, { id: "b" }], copied: "1", tested: "1" }).every((s) => s.done)).toBe(true);
    expect(checklistState({ accounts: [{ broker: "paper", session: { state: "connected" } }] })[0].done).toBe(false);
    // A key made by a sign-in link is not a key for a tool.
    const signedIn = [{ id: "a", clientKind: "ui", label: "admin (created by init)" }, { id: "b", clientKind: "ui", label: "Dashboard sign-in" }];
    expect(checklistState({ keys: signedIn })[1].done).toBe(false);
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

  it("matches what the Bridge says and the label of the key it makes", async () => {
    const { SIGN_IN_KEY_LABEL } = await import("./app.js");
    const { SIGN_IN_FAILED: serverText, SIGN_IN_KEY_LABEL: serverLabel } = await import("../auth/module.mjs");
    expect(SIGN_IN_FAILED.detail).toBe(serverText);
    expect(SIGN_IN_KEY_LABEL).toBe(serverLabel);
  });
});
