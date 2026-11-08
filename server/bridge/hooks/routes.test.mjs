import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sign } from "../auth/hmac.mjs";
import { startTestBridge } from "./__fixtures__/testBridge.mjs";
import { createAutomationRegistry } from "../readiness/automations.mjs";
import { hooksRuntimeFor } from "./module.mjs";

let b;
const json = { "content-type": "application/json" };

async function createHook(def) {
  const r = await b.request({ method: "POST", path: "/v1/hooks", headers: { ...b.auth(b.keys.admin), ...json }, body: { source: "gocharting", label: "GC", account: "paper", product: "CNC", maxLotsPerSignal: 10, ...def } });
  expect(r.status).toBe(201);
  return r.json.data;
}
const idle = () => hooksRuntimeFor(b.app.deps).worker.idle();
const alert = (o = {}) => ({ symbol: "NSE:RELIANCE", side: "buy", quantity: "1", price: "1400", id: "Long", time: "2026-10-19T04:00:00Z", ...o });

describe("hook management routes", () => {
  beforeEach(async () => {
    b = await startTestBridge();
  });
  afterEach(async () => b.close());

  it("creates a hook (URL shown once), lists it without the token and deletes it", async () => {
    const h = await createHook({});
    expect(h.url).toBe(`http://127.0.0.1:${b.port}${h.path}`);
    const token = h.path.split("/").at(-1);
    expect(h.templates[0].message).toContain("NSE:RELIANCE");
    const list = await b.request({ path: "/v1/hooks", headers: b.auth(b.keys.admin) });
    expect(list.status).toBe(200);
    expect(list.json.data).toHaveLength(1);
    expect(list.raw).not.toContain(token);
    expect(list.raw).not.toContain("tokenHash");
    const del = await b.request({ method: "DELETE", path: `/v1/hooks/${h.id}`, headers: b.auth(b.keys.admin) });
    expect(del.status).toBe(204);
    const after = await b.request({ method: "POST", path: h.path, headers: json, body: alert() });
    expect(after.status).toBe(404);
    expect(b.audit.ofType("hook.*").map((r) => r.type)).toEqual(["hook.created", "hook.deleted"]);
    expect(JSON.stringify(b.audit.records)).not.toContain(token);
  });

  it("needs an admin key and refuses unknown accounts or bad bodies", async () => {
    expect((await b.request({ path: "/v1/hooks", headers: b.auth(b.keys.read) })).status).toBe(403);
    expect((await b.request({ path: "/v1/hooks" })).status).toBe(401);
    const bad = await b.request({ method: "POST", path: "/v1/hooks", headers: { ...b.auth(b.keys.admin), ...json }, body: { source: "gocharting", label: "x", account: "nobody" } });
    expect(bad.json.code).toBe("ACCOUNT_NOT_FOUND");
    const invalid = await b.request({ method: "POST", path: "/v1/hooks", headers: { ...b.auth(b.keys.admin), ...json }, body: { source: "gocharting", label: "x", account: "paper", maxLotsPerSignal: -1 } });
    expect(invalid.status).toBe(400);
    expect((await b.request({ method: "DELETE", path: "/v1/hooks/hk_aaaaaaaaaaaa", headers: b.auth(b.keys.admin) })).status).toBe(404);
  });

  it("refuses a live hook the config does not allow, and warns about a ChartInk hook without a side", async () => {
    const r = await b.request({ method: "POST", path: "/v1/hooks", headers: { ...b.auth(b.keys.adminLive), ...json }, body: { source: "gocharting", label: "GC", account: "dhan-main", mode: "live", allowSourceIps: ["52.89.214.238"] } });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("PAPER_ONLY");
    const ci = await createHook({ source: "chartink" });
    expect(ci.warnings.join(" ")).toMatch(/set side/);
  });

  it("warns when an allowed dated contract has expired or expires soon", async () => {
    const h = await createHook({ allowedSymbols: ["NFO:NIFTY-2020-01-30-FUT"] });
    expect(h.warnings.join(" ")).toMatch(/already expired/);
  });
});

describe("account-limited admin keys manage only their own accounts' hooks", () => {
  beforeEach(async () => {
    b = await startTestBridge();
  });
  afterEach(async () => b.close());

  it("lists and deletes only hooks on its accounts; another account's hook answers 404 and keeps working", async () => {
    const { key: limited } = b.app.deps.keyStore.addKey({ label: "paper desk admin", scopes: ["admin"], accounts: ["paper"] });
    const own = await createHook({ label: "mine" });
    const other = await createHook({ label: "theirs", account: "dhan-main" });

    const list = await b.request({ path: "/v1/hooks", headers: b.auth(limited) });
    expect(list.json.data.map((h) => h.label)).toEqual(["mine"]);
    const del = await b.request({ method: "DELETE", path: `/v1/hooks/${other.id}`, headers: b.auth(limited) });
    expect(del.status).toBe(404);
    expect((await b.request({ method: "POST", path: other.path, headers: json, body: alert() })).status).toBe(202);
    expect((await b.request({ method: "DELETE", path: `/v1/hooks/${own.id}`, headers: b.auth(limited) })).status).toBe(204);
    expect((await b.request({ path: "/v1/hooks", headers: b.auth(b.keys.admin) })).json.data.map((h) => h.label)).toEqual(["theirs"]);
  });
});

describe("live hooks need live authority (regressions)", () => {
  const liveCfg = { safety: { liveTrading: true }, accounts: [{ id: "dhan-main", broker: "dhan", live: { enabled: true, allowedSources: ["webhook"] } }, { id: "paper", broker: "paper" }] };
  beforeEach(async () => {
    b = await startTestBridge({ config: liveCfg, liveAccounts: ["dhan-main"] });
  });
  afterEach(async () => b.close());
  const post = (key, def) => b.request({ method: "POST", path: "/v1/hooks", headers: { ...b.auth(key), ...json }, body: { source: "gocharting", label: "GC", account: "dhan-main", mode: "live", product: "CNC", ...def } });

  it("an admin key without the live scope cannot create a live hook", async () => {
    const r = await post(b.keys.admin, { allowSourceIps: ["52.89.214.238"] });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("SCOPE_REQUIRED");
  });

  it("an unsigned live hook needs allowSourceIps, requireConfirmation or an explicit acknowledgement", async () => {
    const bare = await post(b.keys.adminLive, {});
    expect(bare.status).toBe(400);
    expect(bare.json.detail).toMatch(/allowSourceIps/);
    expect((await post(b.keys.adminLive, { allowSourceIps: ["52.89.214.238"] })).status).toBe(201);
    expect((await post(b.keys.adminLive, { requireConfirmation: true })).status).toBe(201);
    const ack = await post(b.keys.adminLive, { acknowledgeUnsignedLive: true });
    expect(ack.status).toBe(201);
    expect(ack.json.data).toMatchObject({ acknowledgeUnsignedLive: true, createdByKeyId: expect.any(String) });
    expect(ack.json.data.warnings.join(" ")).toMatch(/protected only by its URL/);
  });

  it("a live hook stops accepting alerts once the key that created it is revoked", async () => {
    const r = await post(b.keys.adminLive, { acknowledgeUnsignedLive: true });
    expect(r.status).toBe(201);
    await b.app.deps.keyStore.revoke(r.json.data.createdByKeyId);
    const sent = await b.request({ method: "POST", path: r.json.data.path, headers: json, body: alert() });
    expect(sent.status).toBe(401);
  });
});

describe("POST /hooks/{source}/{token}", () => {
  beforeEach(async () => {
    b = await startTestBridge({ config: { hooks: { maxSignalsPerMinute: 600, queueSize: 1000 } } });
  });
  afterEach(async () => b.close());

  it("acknowledges under load without waiting for the orders (a burst of 100, then 20 while the worker is held), at under 50 ms of work each", async () => {
    const h = await createHook({});
    // Hold every order placement until the acknowledgements are in, so "the 202 does not wait for the work" is a
    // fact the test can count, not a race against the clock. (Wall-clock latency under the full parallel suite on a
    // busy 4-core machine measured 84 ms for work that takes a few ms, so it cannot tell a slow ack path from a slow
    // machine.)
    let release;
    const gate = new Promise((r) => (release = r));
    const place = b.orders.place;
    b.orders.place = async (...args) => {
      await gate;
      return place.apply(b.orders, args);
    };
    const worker = hooksRuntimeFor(b.app.deps).worker;
    const cpu0 = process.cpuUsage();
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => b.request({ method: "POST", path: h.path, headers: json, body: alert({ id: `L${i}` }) })));
    expect(results.every((r) => r.status === 202 && r.json.accepted === true)).toBe(true);
    // Round trips while the worker still has a backlog to process.
    for (let i = 0; i < 20; i += 1) {
      const r = await b.request({ method: "POST", path: h.path, headers: json, body: alert({ id: `S${i}` }) });
      expect(r.status).toBe(202);
    }
    const cpu = process.cpuUsage(cpu0);
    // Every alert was acknowledged while no order had been placed: the reply never waits on processing.
    expect(b.orders.all()).toHaveLength(0);
    const st = worker.stats();
    expect(st.queued + st.active).toBe(120);
    // The ack path's own work (this process: client and server, CPU time, so other processes do not count) stays
    // under 50 ms a request with the queue full behind it.
    expect((cpu.user + cpu.system) / 1000 / 120).toBeLessThan(50);
    release();
    await idle();
    expect(b.orders.all()).toHaveLength(120);
  });

  it("a double-fire (same id + time) creates one order", async () => {
    const h = await createHook({});
    const [r1, r2] = await Promise.all([
      b.request({ method: "POST", path: h.path, headers: json, body: alert() }),
      b.request({ method: "POST", path: h.path, headers: json, body: alert() }),
    ]);
    expect([r1.status, r2.status]).toEqual([202, 202]);
    expect(r1.json.signalId).toBe(r2.json.signalId);
    expect([r1.json.duplicate, r2.json.duplicate].filter(Boolean)).toHaveLength(1);
    await idle();
    expect(b.orders.all()).toHaveLength(1);
    expect(b.orders.all()[0]).toMatchObject({ source: "webhook", mode: "paper", symbol: "NSE:RELIANCE" });
  });

  it("a redelivery after the dedupe window still makes no second order (same id + time)", async () => {
    await b.close();
    b = await startTestBridge({ config: { hooks: { dedupeWindowMs: 1000 } } });
    const h = await createHook({});
    await b.request({ method: "POST", path: h.path, headers: json, body: alert() });
    await idle();
    await new Promise((r) => setTimeout(r, 1100));
    const rt = hooksRuntimeFor(b.app.deps);
    const again = await b.request({ method: "POST", path: h.path, headers: json, body: alert({ price: "1400" }) });
    expect(again.status).toBe(202);
    await idle();
    expect(b.orders.all()).toHaveLength(1);
    expect(rt.worker.recent().at(-1).status).toBe("duplicate");
  });

  it("accepts text alerts with text/plain", async () => {
    const h = await createHook({});
    const r = await b.request({ method: "POST", path: h.path, headers: { "content-type": "text/plain" }, raw: "BUY NSE:RELIANCE 2 @ 1401" });
    expect(r.status).toBe(202);
    await idle();
    expect(b.orders.all()[0]).toMatchObject({ quantity: 2, price: 1401 });
  });

  it("answers 400 for a malformed alert, 404 for unknown or mismatched tokens", async () => {
    const h = await createHook({});
    expect((await b.request({ method: "POST", path: h.path, headers: json, body: alert({ side: "{{side}}" }) })).status).toBe(400);
    expect((await b.request({ method: "POST", path: h.path, headers: { "content-type": "text/plain" }, raw: "please buy something" })).status).toBe(400);
    expect((await b.request({ method: "POST", path: `/hooks/gocharting/${"x".repeat(43)}`, headers: json, body: alert() })).status).toBe(404);
    expect((await b.request({ method: "POST", path: h.path.replace("gocharting", "chartink"), headers: json, body: alert() })).status).toBe(404);
    expect((await b.request({ method: "POST", path: h.path.replace("gocharting", "slack"), headers: json, body: alert() })).status).toBe(404);
  });

  it("never logs the hook token", async () => {
    const h = await createHook({});
    const token = h.path.split("/").at(-1);
    await b.request({ method: "POST", path: h.path, headers: json, body: alert() });
    await idle();
    expect(b.logLines.join("\n")).not.toContain(token);
  });

  it("enforces the source-IP allowlist", async () => {
    const remote = await createHook({ allowSourceIps: ["52.89.214.238"] });
    const r = await b.request({ method: "POST", path: remote.path, headers: json, body: alert() });
    expect(r.status).toBe(401);
    const local = await createHook({ allowSourceIps: ["127.0.0.1"] });
    expect((await b.request({ method: "POST", path: local.path, headers: json, body: alert() })).status).toBe(202);
  });

  it("ChartInk scans become one order per stock on the hook's side", async () => {
    const h = await createHook({ source: "chartink", side: "BUY", maxLotsPerSignal: 1 });
    const r = await b.request({ method: "POST", path: h.path, headers: json, body: { stocks: "RELIANCE,INFY", trigger_prices: "1400,1500", triggered_at: "2:34 pm", scan_name: "Breakouts", scan_url: "breakouts" } });
    expect(r.status).toBe(202);
    await idle();
    expect(b.orders.all().map((o) => [o.symbol, o.side, o.price])).toEqual([
      ["NSE:RELIANCE", "BUY", 1400],
      ["NSE:INFY", "BUY", 1500],
    ]);
  });

  it("confirmation-required hooks place nothing until a person confirms", async () => {
    const h = await createHook({ requireConfirmation: true });
    await b.request({ method: "POST", path: h.path, headers: json, body: alert() });
    await idle();
    expect(b.orders.all()).toHaveLength(0);
    const tickets = await b.orders.tickets({ principal: { kind: "local", id: "cli" }, scopes: new Set(["admin"]) });
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ source: "webhook", order: { account: "paper", symbol: "NSE:RELIANCE" } });
  });

  it("rate-limits a noisy hook", async () => {
    await b.close();
    b = await startTestBridge({ config: { hooks: { maxSignalsPerMinute: 2 } } });
    const h = await createHook({});
    const codes = [];
    for (let i = 0; i < 3; i += 1) codes.push((await b.request({ method: "POST", path: h.path, headers: json, body: alert({ id: `x${i}` }) })).status);
    expect(codes).toEqual([202, 202, 429]);
  });
});

describe("generic signed hooks", () => {
  let h;
  let secret;
  beforeEach(async () => {
    b = await startTestBridge();
    h = await createHook({ source: "generic" });
    secret = h.signingSecret;
  });
  afterEach(async () => b.close());

  const send = (body, { t = Math.floor(Date.now() / 1000), sig } = {}) => {
    const raw = JSON.stringify(body);
    return b.request({ method: "POST", path: h.path, headers: { ...json, "x-mcb-signature": sig ?? sign(secret, t, raw) }, raw });
  };
  const body = { symbol: "NSE:INFY", side: "BUY", quantity: 1, price: 1500, id: "s-1" };

  it("returns the signing secret once and accepts a correctly signed request", async () => {
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const list = await b.request({ path: "/v1/hooks", headers: b.auth(b.keys.admin) });
    expect(list.raw).not.toContain(secret);
    expect((await send(body)).status).toBe(202);
    await idle();
    expect(b.orders.all()).toHaveLength(1);
  });

  it("refuses a missing, wrong or stale signature", async () => {
    const raw = JSON.stringify(body);
    expect((await b.request({ method: "POST", path: h.path, headers: json, raw })).status).toBe(401);
    expect((await send(body, { sig: sign("x".repeat(32), Math.floor(Date.now() / 1000), raw) })).status).toBe(401);
    expect((await send(body, { t: Math.floor(Date.now() / 1000) - 301 })).status).toBe(401);
    expect((await send(body, { t: Math.floor(Date.now() / 1000) + 301 })).status).toBe(401);
    await idle();
    expect(b.orders.all()).toHaveLength(0);
  });

  it("refuses a replayed signed request", async () => {
    const raw = JSON.stringify(body);
    const sig = sign(secret, Math.floor(Date.now() / 1000), raw);
    expect((await send(body, { sig })).status).toBe(202);
    const replay = await send(body, { sig });
    expect(replay.status).toBe(401);
    expect(replay.json.code).toBe("UNAUTHENTICATED");
    await idle();
    expect(b.orders.all()).toHaveLength(1);
  });

  it("a re-signed request with the same id still makes one order", async () => {
    expect((await send(body)).status).toBe(202);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await send(body)).status).toBe(202);
    await idle();
    expect(b.orders.all()).toHaveLength(1);
  });
});

describe("generic hooks: junk without the secret cannot use up the hook's budget (regression)", () => {
  beforeEach(async () => {
    b = await startTestBridge({ config: { hooks: { maxSignalsPerMinute: 3 } } });
  });
  afterEach(async () => b.close());

  it("unsigned requests are refused 401 without being charged; a signed one still gets 202", async () => {
    const h = await createHook({ source: "generic" });
    for (let i = 0; i < 6; i += 1) {
      const junk = await b.request({ method: "POST", path: h.path, headers: json, raw: JSON.stringify({ i }) });
      expect(junk.status).toBe(401);
    }
    const raw = JSON.stringify({ symbol: "NSE:INFY", side: "BUY", quantity: 1, price: 1500, id: "ok-1" });
    const good = await b.request({ method: "POST", path: h.path, headers: { ...json, "x-mcb-signature": sign(h.signingSecret, Math.floor(Date.now() / 1000), raw) }, raw });
    expect(good.status).toBe(202);
  });

  it("an address sending many bad signatures is slowed down (429)", async () => {
    const h = await createHook({ source: "generic" });
    let last;
    for (let i = 0; i < 31; i += 1) last = await b.request({ method: "POST", path: h.path, headers: json, raw: JSON.stringify({ i }) });
    expect(last.status).toBe(429);
  });
});

describe("live hooks are readiness automations", () => {
  const liveCfg = { safety: { liveTrading: true }, accounts: [{ id: "dhan-main", broker: "dhan", live: { enabled: true, allowedSources: ["webhook"] } }, { id: "paper", broker: "paper" }] };
  let registry;
  let state;
  const fakeReadiness = () => {
    registry = createAutomationRegistry();
    state = "cannot_trade";
    return {
      status: () => ({}),
      canTrade: (id, { mode } = {}) => ({ ok: state !== "cannot_trade", state: mode === "paper" ? "ready" : state, reasons: [], checkedAt: null, stale: false }),
      ensureFresh: async () => ({}),
      check: async () => ({}),
      registerAutomation: (a) => registry.register(a),
    };
  };
  beforeEach(async () => {
    b = await startTestBridge({ config: liveCfg, liveAccounts: ["dhan-main"], readiness: fakeReadiness() });
  });
  afterEach(async () => b.close());
  const post = (def) => b.request({ method: "POST", path: "/v1/hooks", headers: { ...b.auth(b.keys.adminLive), ...json }, body: { source: "gocharting", label: "GC live", account: "dhan-main", mode: "live", product: "CNC", allowSourceIps: ["52.89.214.238"], ...def } });

  it("registers live hooks on create (not paper ones), shows their readiness, removes them on delete", async () => {
    const live = (await post({})).json.data;
    expect(live.readiness).toBe("cannot_trade");
    const paper = await createHook({ label: "paper hook" });
    expect(paper.readiness).toBeNull();
    expect(registry.list().map((a) => [a.id, a.kind, a.accountId, a.mode, a.label])).toEqual([[live.id, "webhook", "dhan-main", "live", "GC live"]]);
    const list = (await b.request({ path: "/v1/hooks", headers: b.auth(b.keys.admin) })).json.data;
    expect(Object.fromEntries(list.map((h) => [h.label, h.readiness]))).toEqual({ "GC live": "cannot_trade", "paper hook": null });
    state = "ready";
    expect((await b.request({ path: "/v1/hooks", headers: b.auth(b.keys.admin) })).json.data.find((h) => h.id === live.id).readiness).toBe("ready");
    expect((await b.request({ method: "DELETE", path: `/v1/hooks/${live.id}`, headers: b.auth(b.keys.admin) })).status).toBe(204);
    expect(registry.list()).toEqual([]);
  });

  it("re-registers live hooks at start (the registry is memory only)", async () => {
    const live = (await post({})).json.data;
    const rt = hooksRuntimeFor(b.app.deps);
    rt.automations.clear();
    expect(registry.count()).toBe(0);
    const { default: hooksModule } = await import("./module.mjs");
    await hooksModule.start(b.app.deps);
    expect(registry.list().map((a) => a.id)).toEqual([live.id]);
  });
});
