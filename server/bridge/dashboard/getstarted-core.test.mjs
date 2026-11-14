/** The Get started checklist: which steps are done, the curl a person copies, where step 2 leads. Pure logic, no DOM. */
import { describe, expect, it } from "vitest";
import * as G from "./getstarted-core.js";

const NOW = Date.parse("2026-11-09T10:00:00Z");
const key = (over = {}) => ({ id: "k1", label: "Excel", clientKind: "excel", scopes: ["read"], expiresAt: null, revokedAt: null, ...over });
const call = (over = {}) => ({ method: "GET", path: "/v1/ltp", status: 200, keyId: "k1", client: null, ...over });
const derive = (over = {}) => G.deriveSteps({ demo: false, accounts: [], keys: [], requests: [], orders: [], sourcesSeen: false, ownKeyId: "own", now: NOW, ...over });
const done = (r) => r.steps.filter((s) => s.done).map((s) => s.id);

describe("step 1: the demo or a broker", () => {
  it("is done in demo mode, or when an account that is not the demo exists", () => {
    expect(done(derive())).toEqual([]);
    expect(done(derive({ demo: true }))).toEqual(["account"]);
    expect(done(derive({ accounts: [{ id: "demo", broker: "demo" }] }))).toEqual([]);
    expect(done(derive({ accounts: [{ id: "dhan-main", broker: "dhan" }] }))).toEqual(["account"]);
  });
  it("an account list that could not be read is not done", () => {
    expect(done(derive({ accounts: null }))).toEqual([]);
    expect(done(derive({ accounts: undefined }))).toEqual([]);
  });
  it("says a broker that is added but not logged in still needs its login", () => {
    const dhan = { id: "dhan-main", label: "Dhan (main)", broker: "dhan", session: { state: "none" } };
    expect(G.accountStepText({ demo: false, accounts: [] })).toMatch(/^Add your broker/);
    expect(G.accountStepText({ demo: false, accounts: [dhan] })).toMatch(/Dhan \(main\) is added but not logged in yet\. Open it below and press Log in/);
    expect(G.accountStepText({ demo: false, accounts: [{ ...dhan, session: { state: "connected" } }] })).toMatch(/logged in/);
    expect(G.accountStepText({ demo: true, accounts: [] })).toMatch(/demo mode/);
  });
});

describe("step 2: a key for a tool", () => {
  it("is done by an active key that is not this dashboard's own and not a sign-in key", () => {
    expect(done(derive({ keys: [key()] }))).toEqual(["key"]);
    expect(done(derive({ keys: [key({ id: "own" })] }))).toEqual([]);
    expect(done(derive({ keys: [key({ clientKind: "ui" })] }))).toEqual([]);
  });
  it("revoked and expired keys do not count; a key that could not be read does not either", () => {
    expect(done(derive({ keys: [key({ revokedAt: "2026-11-01T00:00:00Z" })] }))).toEqual([]);
    expect(done(derive({ keys: [key({ expiresAt: "2026-11-08T00:00:00Z" })] }))).toEqual([]);
    expect(done(derive({ keys: [key({ expiresAt: "2026-12-08T00:00:00Z" })] }))).toEqual(["key"]);
    expect(done(derive({ keys: null }))).toEqual([]);
  });
});

describe("step 3: the first call", () => {
  it("flips when a request from a key other than the dashboard was answered", () => {
    expect(G.firstCallSeen([call()])).toBe(true);
    expect(done(derive({ requests: [call()] }))).toEqual(["call"]);
  });
  it("ignores the dashboard's own requests, requests with no key, health checks, failures and an unreadable log", () => {
    expect(G.firstCallSeen([call({ client: "dashboard" })])).toBe(false);
    expect(G.firstCallSeen([call({ keyId: null })])).toBe(false);
    expect(G.firstCallSeen([call({ path: "/v1/health" })])).toBe(false);
    expect(G.firstCallSeen([call({ path: "/dashboard/app.js" })])).toBe(false);
    expect(G.firstCallSeen([call({ status: 401 }), call({ status: 429 })])).toBe(false);
    expect(G.firstCallSeen(null)).toBe(false);
    expect(G.firstCallSeen(undefined)).toBe(false);
    expect(G.firstCallSeen([])).toBe(false);
  });
});

describe("steps 4 and 5", () => {
  it("a paper order exists; Sources has been opened", () => {
    expect(done(derive({ orders: [{ orderId: "o1" }] }))).toEqual(["order"]);
    expect(done(derive({ orders: null }))).toEqual([]);
    expect(done(derive({ sourcesSeen: true }))).toEqual(["sources"]);
  });
});

describe("progress", () => {
  it("counts the steps, names the first one left, and is complete only at five", () => {
    const none = derive();
    expect(none).toMatchObject({ doneCount: 0, total: 5, progress: "0 of 5", complete: false, current: "account" });
    const two = derive({ demo: true, keys: [key()] });
    expect(two).toMatchObject({ doneCount: 2, progress: "2 of 5", current: "call" });
    const all = derive({ demo: true, keys: [key()], requests: [call()], orders: [{}], sourcesSeen: true });
    expect(all).toMatchObject({ doneCount: 5, progress: "5 of 5", complete: true, current: null });
    expect(none.steps.map((s) => s.id)).toEqual(["account", "key", "call", "order", "sources"]);
  });
  it("the checklist shows only while something is left and it was not hidden", () => {
    expect(G.shouldShow({ dismissed: false, complete: false })).toBe(true);
    expect(G.shouldShow({ dismissed: true, complete: false })).toBe(false);
    expect(G.shouldShow({ dismissed: false, complete: true })).toBe(false);
  });
  it("names the steps that became done between two readings, so a screen reader can hear them", () => {
    const before = derive({ demo: true });
    const after = derive({ demo: true, keys: [key()], requests: [call()] });
    expect(G.newlyDone(before, after)).toEqual(["key", "call"]);
    expect(G.newlyDone(null, after)).toEqual([]);
    expect(G.newlyDone(after, after)).toEqual([]);
    for (const id of G.newlyDone(before, after)) expect(G.STEP_DONE_TEXT[id]).toMatch(/done/);
  });
});

describe("the curl a person copies", () => {
  it("uses the Bridge's real address and a placeholder for the key, both single-quoted", () => {
    expect(G.curlLtp({ base: "http://127.0.0.1:4442" })).toBe("curl -H 'Authorization: Bearer mcb_YOUR_READ_KEY' 'http://127.0.0.1:4442/v1/ltp?symbols=NSE:NIFTY,NSE:RELIANCE'");
  });
  it("drops a trailing slash and works with another host and port", () => {
    expect(G.curlLtp({ base: "https://bridge.example.test:8443/" })).toContain("'https://bridge.example.test:8443/v1/ltp?symbols=");
    expect(G.curlLtp({ base: "http://localhost:4300//" })).toContain("'http://localhost:4300/v1/ltp");
  });
  it("never puts a real key in: the default is the placeholder", () => {
    expect(G.curlLtp({ base: "http://127.0.0.1:4300" })).toContain(G.KEY_PLACEHOLDER);
    expect(G.KEY_PLACEHOLDER).toMatch(/^mcb_YOUR_/);
  });
  it("quotes safely: a quote in any part cannot end the word, and odd symbols are percent-encoded", () => {
    expect(G.shellQuote("it's")).toBe(`'it'\\''s'`);
    const line = G.curlLtp({ base: "http://h:1", symbols: "NSE:A B,NSE:C'D&x=1", key: "k'ey" });
    expect(line).toContain(`'Authorization: Bearer k'\\''ey'`);
    expect(line).toContain("symbols=NSE:A%20B,NSE:C%27D%26x%3D1'");
    // Taking out each closed-escaped-reopened quote leaves the plain quoting: two words, four quotes.
    expect(line.replaceAll(`'\\''`, "").match(/'/g)).toHaveLength(4);
    expect(line).not.toContain('"');
    expect(line).not.toContain("$");
  });
});

describe("where step 2 leads", () => {
  const pages = (ids) => (hash) => ({ page: { id: ids.includes(hash.replace(/^#\//, "")) ? hash.replace(/^#\//, "") : ids[0] } });
  it("to the Connect a tool wizard when this build has that page", () => {
    expect(G.keyStepLink(pages(["accounts", "connect"]))).toBe("#/connect");
  });
  it("to the Keys tab when it does not (the router sends an unknown page to the first page)", () => {
    expect(G.keyStepLink(pages(["accounts", "sources"]))).toBe("#/api/keys");
  });
  it("falls back to the Keys tab when the resolver is missing or fails", () => {
    expect(G.keyStepLink(undefined)).toBe("#/api/keys");
    expect(G.keyStepLink(() => { throw new Error("x"); })).toBe("#/api/keys");
    expect(G.keyStepLink(() => null)).toBe("#/api/keys");
  });
  it("the checklist state does not depend on the link", () => {
    expect(derive({ keys: [key()] })).toEqual(derive({ keys: [key()] }));
  });
});

describe("goals: three steps for what the person wants", () => {
  const goalDone = (goal, over = {}) => G.deriveGoal(goal, { demo: false, accounts: [], keys: [], requests: [], orders: [], downloads: [], rules: [], recordings: [], subs: [], ownKeyId: "own", now: NOW, ...over });
  const ids = (r) => r.steps.map((s) => s.id);
  const doneIds = (r) => r.steps.filter((s) => s.done).map((s) => s.id);

  it("offers five goals, each with its own steps; the API goal is the original five", () => {
    expect(G.GOALS.map((g) => g.id)).toEqual(["excel", "history", "record", "api", "events"]);
    expect(ids(goalDone("api"))).toEqual(["account", "key", "call", "order", "sources"]);
    expect(ids(goalDone("excel"))).toEqual(["account", "excelKey", "excel"]);
    expect(ids(goalDone("history"))).toEqual(["account", "download", "files"]);
    expect(ids(goalDone("record"))).toEqual(["account", "rule", "recorded"]);
    expect(ids(goalDone("events"))).toEqual(["key", "receiver", "delivered"]);
    expect(goalDone("history").total).toBe(3);
    expect(goalDone("history").progress).toBe("0 of 3");
    expect(ids(goalDone("nonsense"))).toEqual(ids(goalDone("api")));
  });
  it("excel: an Excel key, then a spreadsheet call to /xl/ with a key", () => {
    expect(doneIds(goalDone("excel", { demo: true, keys: [key({ clientKind: "excel" })] }))).toEqual(["account", "excelKey"]);
    expect(doneIds(goalDone("excel", { keys: [key({ clientKind: "script" })] }))).toEqual([]);
    expect(G.sheetCallSeen([call({ path: "/xl/ltp" })])).toBe(true);
    expect(G.sheetCallSeen([call({ path: "/xl/ltp", client: "dashboard" }), call({ path: "/xl/ltp", status: 401 }), call({ path: "/v1/ltp" })])).toBe(false);
    expect(goalDone("excel", { requests: [call({ path: "/xl/quotes" })] }).steps[2].done).toBe(true);
  });
  it("history: a download exists, then one is finished", () => {
    expect(doneIds(goalDone("history", { downloads: [{ id: "a", status: "running" }] }))).toEqual(["download"]);
    expect(goalDone("history", { demo: true, downloads: [{ id: "a", status: "done" }] }).complete).toBe(true);
    expect(doneIds(goalDone("history", { downloads: null }))).toEqual([]);
  });
  it("record: a rule that is on, then a file written", () => {
    expect(doneIds(goalDone("record", { rules: [{ id: "r", enabled: false }] }))).toEqual([]);
    expect(doneIds(goalDone("record", { rules: [{ id: "r", enabled: true }] }))).toEqual(["rule"]);
    expect(doneIds(goalDone("record", { rules: [{ id: "r" }], recordings: [{ id: "x", rows: 0 }] }))).toEqual(["rule"]);
    expect(doneIds(goalDone("record", { rules: [{ id: "r" }], recordings: [{ id: "x", rows: 12 }] }))).toEqual(["rule", "recorded"]);
  });
  it("events: a key, a receiver, then a delivery or a working test", () => {
    expect(doneIds(goalDone("events", { keys: [key()], subs: [{ id: "s", health: { state: "unverified" } }] }))).toEqual(["key", "receiver"]);
    expect(goalDone("events", { keys: [key()], subs: [{ id: "s", health: { state: "ok", delivered: 0 } }] }).complete).toBe(true);
    expect(doneIds(goalDone("events", { subs: null }))).toEqual([]);
  });
  it("keeps one dismiss slot per goal, the old slot for the API goal", () => {
    expect(G.dismissSlot("api")).toBe(G.DISMISS_SLOT);
    expect(G.dismissSlot("excel")).toBe(`${G.DISMISS_SLOT}.excel`);
    expect(G.stepDoneText("key", 1)).toMatch(/^Step 1 done: you have an API key/);
    expect(G.stepDoneText("rule", 2)).toBe("Step 2 done.");
  });
});
