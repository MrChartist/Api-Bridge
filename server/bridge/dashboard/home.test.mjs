import { describe, expect, it } from "vitest";
import { HOOK_SOURCES as SERVER_SOURCES } from "../hooks/hookStore.mjs";
import { CLIENT_KINDS } from "../auth/keyStore.mjs";

// app.js (imported by home.js) reads sessionStorage at load time.
globalThis.sessionStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const { HOOK_SOURCES, KEY_SOURCES, activityMark, alertRows, welcomePages, bridgeStatus, brokerRows, externalRequests, keyIdOf, linkPath, setupSteps, sourceRows, uptimeText } = await import("./home.js");

const NOW = Date.parse("2026-11-11T05:00:00Z");
const key = (o) => ({ id: "k1", label: "k", scopes: ["read"], clientKind: "script", revokedAt: null, expiresAt: null, lastUsedAt: null, ...o });
const acct = (o) => ({ id: "dhan-main", broker: "dhan", label: "Dhan", session: { state: "connected" }, ...o });

describe("the map's sources", () => {
  it("lists every webhook source the Bridge accepts and every client kind a tool key can have", () => {
    expect(HOOK_SOURCES.map((s) => s.id).sort()).toEqual([...SERVER_SOURCES].sort());
    expect(HOOK_SOURCES[0].id).toBe("tradingview");
    expect(KEY_SOURCES.map((s) => s.id).sort()).toEqual(CLIENT_KINDS.filter((k) => k !== "ui").sort());
  });
  it("counts hooks and tool keys, puts the connected ones first and links each row to where it is set up", () => {
    const rows = sourceRows({
      now: NOW,
      hooks: [{ source: "tradingview", lastSignalAt: "2026-11-11T04:00:00Z" }, { source: "tradingview", lastSignalAt: "2026-11-11T04:30:00Z" }],
      keys: [key({ clientKind: "excel", lastUsedAt: "2026-11-11T03:00:00Z" }), key({ scopes: ["admin", "paper"] }), key({ revokedAt: "2026-11-10T00:00:00Z" }), key({ clientKind: "mcp", expiresAt: "2026-11-01T00:00:00Z" }), key({ clientKind: "ui" })],
    });
    expect(rows.slice(0, 2).map((r) => [r.id, r.count, r.status, r.lastAt])).toEqual([
      ["tradingview", 2, "2 hooks", "2026-11-11T04:30:00Z"],
      ["excel", 1, "1 key", "2026-11-11T03:00:00Z"],
    ]);
    expect(rows.filter((r) => r.active)).toHaveLength(2);
    expect(rows).toHaveLength(HOOK_SOURCES.length + KEY_SOURCES.length);
    expect(rows.find((r) => r.id === "chartink")).toMatchObject({ active: false, to: "#/api/integrations?tool=webhooks&source=chartink" });
    expect(rows.find((r) => r.id === "script")).toMatchObject({ active: false, to: "#/api/integrations?tool=python" });
    expect(rows.find((r) => r.id === "excel").to).toBe("#/api/keys");
  });
});

describe("the map's brokers", () => {
  it("one row per broker account with its session, and the paper accounts as one row", () => {
    const rows = brokerRows([acct({}), acct({ id: "z", broker: "zerodha", label: "", session: { state: "expired" } }), { id: "p1", broker: "paper", label: "Paper" }, { id: "p2", broker: "paper" }], new Map([["dhan", "Dhan"]]));
    expect(rows.map((r) => [r.id, r.name, r.sub, r.active, r.tone])).toEqual([
      ["dhan-main", "Dhan", "Dhan", true, "ok"],
      ["z", "z", "zerodha", false, "bad"],
      ["paper", "Paper accounts", "2 practice accounts", true, "ok"],
    ]);
    expect(brokerRows([{ id: "p1", broker: "paper", label: "Practice" }])[0]).toMatchObject({ name: "Practice", sub: "Practice money, no broker" });
    expect(brokerRows([])).toEqual([]);
  });
});

describe("the status line", () => {
  const ok = { status: "ok" };
  it("says the worst thing first", () => {
    expect(bridgeStatus({ health: ok, safety: { killSwitch: { engaged: true, reason: "testing" } }, accounts: [acct({})] })).toMatchObject({ tone: "bad", title: "All orders are stopped", action: ["Open Safety", "#/safety"] });
    expect(bridgeStatus({ health: { status: "degraded" }, accounts: [acct({})] }).tone).toBe("warn");
    expect(bridgeStatus({ health: ok, accounts: [{ id: "p", broker: "paper" }] })).toMatchObject({ tone: "warn", title: "Connect your first broker", action: ["Add a broker", "#/accounts?add=1"] });
    expect(bridgeStatus({ health: ok, accounts: [acct({ session: { state: "expired" } })] })).toMatchObject({ tone: "warn", title: "No broker is logged in" });
  });
  it("running: counts the logged-in accounts and says paper or live", () => {
    const two = [acct({}), acct({ id: "z", session: { state: "expired" } })];
    expect(bridgeStatus({ health: ok, safety: { liveTrading: false }, accounts: two })).toMatchObject({ tone: "ok", detail: "1 broker account logged in of 2. Orders are paper only." });
    expect(bridgeStatus({ health: ok, safety: { liveTrading: true }, accounts: [acct({})] }).detail).toMatch(/Live trading is on/);
    expect(bridgeStatus({ health: ok, accounts: [], demo: true })).toMatchObject({ tone: "ok", action: null });
  });
});

describe("setup steps", () => {
  it("a broker (or demo), a tool key, an alert source, an order", () => {
    const none = setupSteps({ now: NOW, keys: [key({ scopes: ["admin"] })], orders: [{ tag: "DEMOSEED" }] });
    expect(none.map((s) => [s.id, s.done])).toEqual([["broker", false], ["key", false], ["source", false], ["order", false]]);
    expect(none[1].to).toBe("#/api/integrations?tool=python");
    const all = setupSteps({ now: NOW, accounts: [acct({})], keys: [key({})], hooks: [{ source: "tradingview" }], orders: [{ tag: null }] });
    expect(all.every((s) => s.done)).toBe(true);
    expect(setupSteps({ demo: true })[0].done).toBe(true);
    for (const s of none) expect(s.to.startsWith("#/"), s.id).toBe(true);
  });
});

describe("what became of each alert", () => {
  it("names the hook, says placed or refused, and gives the Bridge's reason for a refusal", () => {
    const audit = [
      { type: "hook.signal", at: "t2", data: { hookId: "hk_a", status: "rejected", side: "BUY", symbol: "NSE:RELIANCE", reason: "The price 1402.5 is 4.18% away from the last traded price." } },
      { type: "order.refused", at: "t2", data: {} },
      { type: "hook.signal", at: "t1", data: { hookId: "hk_gone", status: "placed", side: "SELL", symbol: "NSE:INFY", reason: null } },
      { type: "hook.signal", at: "t0", data: { hookId: "hk_a", status: "something_new" } },
    ];
    expect(alertRows(audit, [{ id: "hk_a", label: "TV breakout" }])).toEqual([
      { at: "t2", status: "Refused", tone: "bad", side: "BUY", symbol: "NSE:RELIANCE", title: "BUY NSE:RELIANCE", hook: "TV breakout", note: "The price 1402.5 is 4.18% away from the last traded price." },
      { at: "t1", status: "Placed", tone: "ok", side: "SELL", symbol: "NSE:INFY", title: "SELL NSE:INFY", hook: "hk_gone", note: "Order placed" },
      { at: "t0", status: "something_new", tone: "", side: null, symbol: null, title: "Alert", hook: "TV breakout", note: "" },
    ]);
    expect(alertRows(audit, [], 1)).toHaveLength(1);
    expect(alertRows()).toEqual([]);
  });
});

describe("staying current", () => {
  it("the mark changes when an alert arrives, a hook is added or used, a tool calls, or the kill switch flips; not otherwise", () => {
    const base = { audit: [{ seq: 6 }], hooks: [{ id: "hk_a", lastSignalAt: "t1" }], requests: [{ requestId: "req_1" }], safety: { killSwitch: { engaged: false } } };
    const m = activityMark(base);
    expect(activityMark(structuredClone(base))).toBe(m);
    expect(activityMark({ ...base, audit: [{ seq: 7 }] })).not.toBe(m);
    expect(activityMark({ ...base, hooks: [...base.hooks, { id: "hk_b" }] })).not.toBe(m);
    expect(activityMark({ ...base, hooks: [{ id: "hk_a", lastSignalAt: "t2" }] })).not.toBe(m);
    expect(activityMark({ ...base, requests: [{ requestId: "req_2" }] })).not.toBe(m);
    expect(activityMark({ ...base, safety: { killSwitch: { engaged: true } } })).not.toBe(m);
    expect(activityMark()).toBe("|||0");
  });
});

describe("the welcome guide", () => {
  it("four short pages: hello, a broker, alerts, ready; the two middle ones open the page that does the job", () => {
    const pages = welcomePages();
    expect(pages.map((p) => p.id)).toEqual(["hello", "broker", "source", "ready"]);
    expect(pages[1].primary).toEqual(["Add my broker", "#/accounts?add=1"]);
    expect(pages[2].primary).toEqual(["Connect TradingView", "#/api/integrations?tool=webhooks&source=tradingview"]);
    expect([pages[1].later, pages[2].later]).toEqual(["Later", "Later"]);
    expect([pages[0].primary[1], pages[3].primary[1]]).toEqual([null, null]);
    for (const p of pages) expect(p.text.length, p.id).toBeLessThan(200);
  });
  it("does not ask for what is already there, and never mentions a key to type or a command", () => {
    const done = welcomePages({ brokerConnected: true, hasSource: true });
    expect([done[1].primary, done[2].primary]).toEqual([["Next", null], ["Next", null]]);
    expect(welcomePages({ demo: true })[1]).toMatchObject({ primary: ["Next", null], later: null });
    for (const p of [...welcomePages(), ...done, ...welcomePages({ demo: true })]) expect(`${p.title} ${p.text}`).not.toMatch(/npm|mc-bridge|terminal|mcb_/i);
  });
});

describe("small helpers", () => {
  it("uptime in plain words", () => {
    expect([uptimeText(5), uptimeText(125), uptimeText(3 * 3600 + 12 * 60), uptimeText(3 * 86400)]).toEqual(["under a minute", "2 min", "3 h 12 min", "3 days"]);
    expect(uptimeText(-1)).toBe(uptimeText("soon"));
  });
  it("shows other tools' requests only, and never a query string", () => {
    const list = [
      { keyId: "mine", path: "/v1/accounts", client: null },
      { keyId: "tool", path: "/v1/quotes?symbols=NSE:NIFTY&key=mcb_secret", client: "excel" },
      { keyId: null, path: "/v1/health", client: null },
      { keyId: null, path: "/dashboard/app.js", client: "dashboard" },
      { keyId: null, path: "/hooks/tradingview/abc", client: null },
    ];
    const out = externalRequests(list, "mine");
    expect(out.map((r) => linkPath(r.path))).toEqual(["/v1/quotes", "/hooks/tradingview/abc"]);
    expect(externalRequests(list, "mine", 1)).toHaveLength(1);
    expect(keyIdOf("mcb_y2pgl2nflf_secret-part")).toBe("y2pgl2nflf");
    expect(keyIdOf("nope")).toBeNull();
  });
});
