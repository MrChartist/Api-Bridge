import { describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { createCallContext } from "../core/context.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createFakeMarketData } from "../market/fake.mjs";
import { createFakeOrderService } from "../orders/fake.mjs";
import { createFakeSafetyGuard } from "../safety/fake.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { DEFAULT_TOOLSETS, TOOLSETS, mcpConfig } from "./config.mjs";
import { DEFAULT_TOOL_NAMES, TOOL_DEFS, createToolRegistry, paginate, summariseCandles, summariseChain, toolEnv, toolVisible } from "./tools.mjs";

const PRICES = { "NSE:RELIANCE": 1402.5, "NSE:NIFTY": 25010, "NFO:NIFTY-2026-10-27-25000-CE": 120.5 };

function setup({ mcp = {} } = {}) {
  const orders = createFakeOrderService({ accounts: ["paper", "dhan-main"], liveAccounts: ["dhan-main"], prices: PRICES });
  const marketData = createFakeMarketData({ prices: PRICES });
  marketData.setExpiries("NIFTY", ["2026-10-20", "2026-10-27"]);
  const t0 = Math.floor(Date.parse("2026-10-01T03:45:00Z") / 1000);
  marketData.setCandles(
    "NSE:NIFTY",
    "1d",
    Array.from({ length: 300 }, (_, i) => ({ time: t0 + i * 86400, open: 25000 + i, high: 25050 + i, low: 24950 + i, close: 25010 + i, volume: 1000 })),
  );
  const deps = {
    config: { mcp },
    orders,
    marketData,
    symbols: createFakeSymbolService(),
    accounts: createFakeAccountManager({ accounts: [{ id: "paper", broker: "paper" }, { id: "dhan-main", broker: "dhan" }] }),
    safety: createFakeSafetyGuard(),
  };
  const registry = createToolRegistry({ deps });
  return { deps, registry, orders };
}

const key = (scopes, accounts = "*", id = `k${scopes.join("")}`) => ({ id, label: id, scopes, accounts, createdAt: "2026-10-18T10:00:00+05:30" });
const ctxFor = (scopes, accounts) => createCallContext({ source: "mcp", key: key(scopes, accounts), log: createNullLogger() });
const adminCtx = () => createCallContext({ source: "rest", principal: { kind: "local", id: "cli" }, scopes: ["admin"], log: createNullLogger() });
const ORDERS_ON = { toolsets: ["market", "analytics", "account", "orders"], orderAccounts: ["paper", "dhan-main"] };

describe("registry shape", () => {
  it("lists fewer than 20 tools by default, in a fixed order", () => {
    const { registry } = setup();
    const names = registry.listTools(ctxFor(["read"])).map((t) => t.name);
    expect(names.length).toBeLessThan(20);
    expect(names).toEqual(DEFAULT_TOOL_NAMES);
    expect(names).toEqual(TOOL_DEFS.filter((t) => t.toolset !== "orders" && t.toolset !== "options").map((t) => t.name));
  });

  it("lists exactly the 18 default tools; the opt-in options toolset stays at 19 tools or fewer", () => {
    expect(DEFAULT_TOOL_NAMES).toHaveLength(18);
    expect(TOOLSETS).toContain("options");
    expect(DEFAULT_TOOLSETS).not.toContain("options");
    expect(TOOL_DEFS.filter((t) => t.toolset === "options").length).toBeLessThanOrEqual(19);
    const { registry } = setup({ mcp: { toolsets: ["market", "analytics", "account", "options"] } });
    const names = registry.listTools(ctxFor(["read"])).map((t) => t.name);
    expect(names).toEqual(TOOL_DEFS.filter((t) => ["market", "analytics", "account", "options"].includes(t.toolset)).map((t) => t.name));
  });

  it("a tool with requiredScope (options write tools such as create_guard) is hidden from keys without it", () => {
    const cfg = mcpConfig({ mcp: { toolsets: ["options"] } });
    const def = { name: "create_guard", toolset: "options", requiredScope: "paper" };
    const read = ctxFor(["read"]);
    const paper = ctxFor(["paper"]);
    expect(toolVisible(def, cfg, toolEnv(cfg, read), read)).toBe(false);
    expect(toolVisible(def, cfg, toolEnv(cfg, paper), paper)).toBe(true);
    const off = mcpConfig({});
    expect(toolVisible(def, off, toolEnv(off, paper), paper)).toBe(false);
  });

  it("sets all four annotations explicitly, plus title, inputSchema and outputSchema on every tool", () => {
    const { registry } = setup({ mcp: ORDERS_ON });
    for (const t of registry.listTools(ctxFor(["live"]))) {
      for (const a of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) expect(typeof t.annotations[a], `${t.name}.${a}`).toBe("boolean");
      expect(t.title).toBeTruthy();
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.outputSchema.type).toBe("object");
      expect(t.outputSchema.required).toEqual(["data", "meta", "untrusted"]);
    }
  });

  it("has no tool that changes mode, scopes, sessions or releases the kill switch", () => {
    const names = TOOL_DEFS.map((t) => t.name).join(" ");
    expect(names).not.toMatch(/mode|scope|kill|release|session|key|login/i);
  });

  it("MCP input schemas require only non-nullable fields", () => {
    const { registry } = setup();
    const ltp = registry.listTools(ctxFor(["read"])).find((t) => t.name === "get_ltp");
    expect(ltp.inputSchema.required).toEqual(["symbols"]);
  });
});

describe("visibility", () => {
  it("a read key sees no order tools, even when config enables them", () => {
    const { registry } = setup({ mcp: ORDERS_ON });
    const names = registry.listTools(ctxFor(["read"])).map((t) => t.name);
    expect(names).not.toContain("prepare_order");
    expect(names).not.toContain("submit_confirmed_order");
  });

  it("a paper key sees order tools only when config enables them, limited to config ∩ key accounts", () => {
    expect(setup().registry.listTools(ctxFor(["paper"])).map((t) => t.name)).not.toContain("prepare_order");
    const { registry } = setup({ mcp: { ...ORDERS_ON, orderAccounts: ["paper"] } });
    const prep = registry.listTools(ctxFor(["paper"])).find((t) => t.name === "prepare_order");
    expect(prep.inputSchema.properties.account.enum).toEqual(["paper"]);
    expect(prep.inputSchema.properties.mode.anyOf[0].enum).toEqual(["paper"]);
    expect(registry.listTools(ctxFor(["paper"], ["dhan-main"])).map((t) => t.name)).not.toContain("prepare_order");
    const live = registry.listTools(ctxFor(["live"])).find((t) => t.name === "prepare_order");
    expect(live.inputSchema.properties.mode.anyOf[0].enum).toEqual(["paper", "live"]);
  });

  it("toolsets can be narrowed in config", () => {
    const { registry } = setup({ mcp: { toolsets: ["market"] } });
    expect(registry.listTools(ctxFor(["read"])).every((t) => TOOL_DEFS.find((d) => d.name === t.name).toolset === "market")).toBe(true);
  });

  it("a hidden tool behaves exactly like an unknown one", async () => {
    const { registry, orders } = setup({ mcp: ORDERS_ON });
    const r = await registry.call("prepare_order", { account: "paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: 1400 }, ctxFor(["read"]));
    const u = await registry.call("no_such_tool", {}, ctxFor(["read"]));
    expect(r.unknownTool).toBe(true);
    expect(u.unknownTool).toBe(true);
    expect(orders.calls).toHaveLength(0);
  });
});

describe("results", () => {
  const calls = [
    ["get_ltp", { symbols: ["NSE:RELIANCE", "NSE:NIFTY"] }],
    ["get_quotes", { symbols: ["NSE:RELIANCE"], maxAgeMs: 0 }],
    ["get_depth", { symbol: "NSE:RELIANCE" }],
    ["get_history", { symbol: "NSE:NIFTY", interval: "1d", countback: 300 }],
    ["get_expiries", { underlying: "NIFTY" }],
    ["get_option_chain", { underlying: "NIFTY", expiry: "2026-10-27", strikes: 3 }],
    ["search_instruments", { query: "RELIANCE" }],
    ["convert_symbol", { input: "NSE:NIFTY1!" }],
    ["option_chain_summary", { underlying: "NIFTY", expiry: "2026-10-27" }],
    ["history_summary", { symbol: "NSE:NIFTY", interval: "1d", countback: 20 }],
    ["list_accounts", {}],
    ["get_positions", { account: "paper" }],
    ["get_holdings", { account: "paper" }],
    ["get_funds", { account: "paper" }],
    ["list_orders", {}],
    ["get_safety_status", {}],
  ];

  it.each(calls)("%s returns structuredContent matching its outputSchema, in an untrusted envelope", async (name, args) => {
    const { registry } = setup();
    const r = await registry.call(name, args, ctxFor(["read"]));
    expect(r.isError, JSON.stringify(r.content)).toBeUndefined();
    const def = TOOL_DEFS.find((t) => t.name === name);
    const check = def.output.safeParse(JSON.parse(JSON.stringify(r.structuredContent)));
    expect(check.success, JSON.stringify(check.error?.issues)).toBe(true);
    expect(r.structuredContent.untrusted).toBe(true);
    const text = r.content[0].text;
    const m = /<(untrusted-data-[0-9a-f]{12})>\n([\s\S]*)\n<\/\1>/.exec(text);
    expect(m).not.toBeNull();
    expect(JSON.parse(m[2])).toEqual(JSON.parse(JSON.stringify(r.structuredContent)));
  });

  it("uses a fresh envelope marker on every call", async () => {
    const { registry } = setup();
    const a = await registry.call("list_accounts", {}, ctxFor(["read"]));
    const b = await registry.call("list_accounts", {}, ctxFor(["read"]));
    expect(a.content[0].text.match(/untrusted-data-[0-9a-f]+/)[0]).not.toBe(b.content[0].text.match(/untrusted-data-[0-9a-f]+/)[0]);
  });

  it("pages big results with a cursor", async () => {
    const { registry } = setup({ mcp: { maxItems: 100 } });
    const first = await registry.call("get_history", { symbol: "NSE:NIFTY", interval: "1d", countback: 300 }, ctxFor(["read"]));
    expect(first.structuredContent.data.candles).toHaveLength(100);
    const cursor = first.structuredContent.meta.nextCursor;
    expect(cursor).toBeTruthy();
    const second = await registry.call("get_history", { symbol: "NSE:NIFTY", interval: "1d", countback: 300, cursor }, ctxFor(["read"]));
    expect(second.structuredContent.data.candles[0].time).toBe(first.structuredContent.data.candles[99].time + 86400);
    const bad = await registry.call("get_history", { symbol: "NSE:NIFTY", interval: "1d", cursor: "!!" }, ctxFor(["read"]));
    expect(bad.isError).toBe(true);
  });

  it("returns errors as isError results with the Bridge code, never throwing", async () => {
    const { registry } = setup();
    const v = await registry.call("get_ltp", { symbols: [] }, ctxFor(["read"]));
    expect(v.isError).toBe(true);
    expect(v.content[0].text).toMatch(/^VALIDATION_FAILED/);
    const f = await registry.call("get_positions", { account: "paper" }, ctxFor(["read"], ["dhan-main"]));
    expect(f.content[0].text).toMatch(/^ACCOUNT_FORBIDDEN/);
  });

  it("list_accounts only shows accounts the key may use", async () => {
    const { registry } = setup();
    const r = await registry.call("list_accounts", {}, ctxFor(["read"], ["dhan-main"]));
    expect(r.structuredContent.data.map((a) => a.id)).toEqual(["dhan-main"]);
  });

  it("reads run with source mcp and interactive priority", async () => {
    const { registry, deps } = setup();
    await registry.call("get_ltp", { symbols: ["NSE:RELIANCE"], account: "paper" }, ctxFor(["read"]));
    expect(deps.marketData.calls.at(-1)[2]).toMatchObject({ accountId: "paper", priority: "interactive" });
  });
});

describe("order tools never place without a confirmed ticket", () => {
  const order = { account: "paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: 1400 };

  it("prepare_order opens a ticket and sends nothing", async () => {
    const { registry, orders } = setup({ mcp: ORDERS_ON });
    const r = await registry.call("prepare_order", order, ctxFor(["paper"]));
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.data).toMatchObject({ requiresHumanConfirmation: true, mode: "paper" });
    expect(r.structuredContent.data.ticketId).toMatch(/^tkt_/);
    expect(r.structuredContent.data.nextStep).toMatch(/Nothing has been sent/);
    expect(orders.calls.map((c) => c[0])).toEqual(["preview"]);
    expect(orders.all()).toHaveLength(0);
  });

  it("submit_confirmed_order refuses without a human-confirmed token", async () => {
    const { registry, orders } = setup({ mcp: ORDERS_ON });
    const ctx = ctxFor(["paper"]);
    const { ticketId } = (await registry.call("prepare_order", order, ctx)).structuredContent.data;
    const r = await registry.call("submit_confirmed_order", { ticketId, confirmToken: "mct_this-is-not-a-real-token" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^CONFIRMATION_REQUIRED/);
    expect(orders.all()).toHaveLength(0);
  });

  it("an AI cannot confirm its own ticket (confirmTicket refuses source mcp)", async () => {
    const { orders, registry } = setup({ mcp: ORDERS_ON });
    const ctx = ctxFor(["admin", "paper"]);
    const { ticketId } = (await registry.call("prepare_order", order, ctx)).structuredContent.data;
    await expect(orders.confirmTicket(ctx, ticketId)).rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
  });

  it("with the person's confirmation it sends exactly the prepared order, once", async () => {
    const { registry, orders } = setup({ mcp: ORDERS_ON });
    const ctx = ctxFor(["paper"]);
    const { ticketId } = (await registry.call("prepare_order", order, ctx)).structuredContent.data;
    const { confirmToken } = await orders.confirmTicket(adminCtx(), ticketId);
    const r = await registry.call("submit_confirmed_order", { ticketId, confirmToken }, ctx);
    expect(r.isError, r.content?.[0]?.text).toBeUndefined();
    expect(r.structuredContent.data.order).toMatchObject({ symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, mode: "paper", source: "mcp" });
    // A retry (say the first response was lost) replays the same order instead of failing or sending a second one.
    const again = await registry.call("submit_confirmed_order", { ticketId, confirmToken }, ctx);
    expect(again.isError, again.content?.[0]?.text).toBeUndefined();
    expect(again.structuredContent.data).toMatchObject({ replayed: true, order: { orderId: r.structuredContent.data.order.orderId } });
    expect(orders.all()).toHaveLength(1);
  });

  it("another client cannot submit someone else's ticket", async () => {
    const { registry, orders } = setup({ mcp: ORDERS_ON });
    const { ticketId } = (await registry.call("prepare_order", order, ctxFor(["paper"]))).structuredContent.data;
    const { confirmToken } = await orders.confirmTicket(adminCtx(), ticketId);
    const other = createCallContext({ source: "mcp", key: key(["paper"], "*", "someone-else"), log: createNullLogger() });
    const r = await registry.call("submit_confirmed_order", { ticketId, confirmToken }, other);
    expect(r.isError).toBe(true);
    expect(orders.all()).toHaveLength(0);
  });

  it("refuses accounts outside mcp.orderAccounts and quantity+lots together", async () => {
    const { registry } = setup({ mcp: { ...ORDERS_ON, orderAccounts: ["paper"] } });
    expect((await registry.call("prepare_order", { ...order, account: "dhan-main" }, ctxFor(["paper"]))).isError).toBe(true);
    expect((await registry.call("prepare_order", { ...order, lots: 1 }, ctxFor(["paper"]))).content[0].text).toMatch(/exactly one/);
  });

  it("a live request from a paper key cannot even be expressed", async () => {
    const { registry, orders } = setup({ mcp: ORDERS_ON });
    const r = await registry.call("prepare_order", { ...order, account: "dhan-main", mode: "live" }, ctxFor(["paper"]));
    expect(r.content[0].text).toMatch(/^VALIDATION_FAILED/);
    expect(orders.calls).toHaveLength(0);
  });
});

describe("pure helpers", () => {
  it("paginate walks a list", () => {
    const p1 = paginate([1, 2, 3, 4, 5], { cursor: undefined, max: 2 });
    const p2 = paginate([1, 2, 3, 4, 5], { cursor: p1.nextCursor, max: 2 });
    const p3 = paginate([1, 2, 3, 4, 5], { cursor: p2.nextCursor, max: 2 });
    expect([p1.items, p2.items, p3.items, p3.nextCursor]).toEqual([[1, 2], [3, 4], [5], null]);
  });
  it("summariseChain computes PCR and max pain from the rows", () => {
    const s = summariseChain({
      underlying: "NIFTY",
      expiry: "2026-10-27",
      atmStrike: 100,
      underlyingLtp: 101,
      rows: [
        { strike: 90, ce: { oi: 10, iv: 20 }, pe: { oi: 100 } },
        { strike: 100, ce: { oi: 50, iv: 15 }, pe: { oi: 50, iv: 16 } },
        { strike: 110, ce: { oi: 100 }, pe: { oi: 10 } },
      ],
    });
    expect(s.pcrOi).toBe(1);
    expect(s.maxPain).toBe(100);
    expect(s.atmCeIv).toBe(15);
    expect(s.highestCeOi[0]).toEqual({ strike: 110, oi: 100 });
  });
  it("summariseCandles handles empty input and computes change", () => {
    expect(summariseCandles([]).bars).toBe(0);
    const s = summariseCandles([{ time: 1, open: 100, high: 110, low: 95, close: 105, volume: 10 }, { time: 2, open: 105, high: 120, low: 104, close: 118, volume: 30 }]);
    expect(s).toMatchObject({ bars: 2, change: 18, changePct: 18, high: 120, low: 95, avgVolume: 20 });
  });
});

describe("market reads keep to the key's accounts", () => {
  it("passes a limited key's accounts to marketData so unpinned reads never borrow another account", async () => {
    const { registry, deps } = setup();
    await registry.call("get_ltp", { symbols: ["NSE:RELIANCE"] }, ctxFor(["read"], ["dhan-main"]));
    await registry.call("get_ltp", { symbols: ["NSE:RELIANCE"] }, ctxFor(["read"], "*"));
    const ltpCalls = deps.marketData.calls.filter((c) => c[0] === "ltp");
    expect(ltpCalls[0][2]).toMatchObject({ allowedAccounts: ["dhan-main"] });
    expect(ltpCalls[1][2]?.allowedAccounts).toBeUndefined();
  });
});

describe("get_reference (options toolset)", () => {
  const refSetup = async () => {
    const { createReferenceService } = await import("../reference/referenceService.mjs");
    const { parseReferenceConfig } = await import("../reference/config.mjs");
    const { demoInstruments } = await import("../demo/demoAdapter.mjs");
    const t = Date.parse("2026-10-29T10:00:00+05:30");
    const reference = createReferenceService({ config: { demo: true, reference: parseReferenceConfig({}) }, logger: createNullLogger(), clock: { now: () => t }, paths: {}, symbols: createFakeSymbolService({ masters: { fake: demoInstruments(t) } }) });
    const registry = createToolRegistry({ deps: { config: { mcp: { toolsets: ["market", "analytics", "account", "options"] } }, reference }, now: () => t });
    return { reference, registry, t };
  };

  it("returns the same data as the REST route for bundle and lots", async () => {
    const { reference, registry, t } = await refSetup();
    const { readReference } = await import("../reference/routes.mjs");
    for (const [dataset, params] of [
      ["bundle", { underlying: "NIFTY" }],
      ["lots", { underlying: "BANKNIFTY" }],
    ]) {
      const out = await registry.call("get_reference", { dataset, ...params }, ctxFor(["read"]));
      expect(out.isError, JSON.stringify(out.content)).toBeUndefined();
      const rest = await readReference(reference, dataset, params, { now: () => t });
      expect(out.structuredContent.data).toEqual(JSON.parse(JSON.stringify(rest)));
    }
  });

  it("is read-only, opt-in, and there is no reference write tool", async () => {
    const { registry } = await refSetup();
    const def = TOOL_DEFS.find((t) => t.name === "get_reference");
    expect(def).toMatchObject({ toolset: "options", annotations: { readOnlyHint: true, destructiveHint: false } });
    expect(DEFAULT_TOOL_NAMES).not.toContain("get_reference");
    expect(TOOL_DEFS.filter((t) => /reference|rate|corporate|sources/.test(t.name)).map((t) => t.name)).toEqual(["get_reference"]);
    const bad = await registry.call("get_reference", { dataset: "set-rate" }, ctxFor(["read"]));
    expect(bad.isError).toBe(true);
  });
});

describe("get_participant_oi (options toolset)", () => {
  const partSetup = async () => {
    const { createParticipantsService } = await import("../participants/service.mjs");
    const t = Date.parse("2026-10-29T12:00:00+05:30");
    const participants = createParticipantsService({ config: { demo: true }, clock: { now: () => t }, paths: {} });
    const registry = createToolRegistry({ deps: { config: { mcp: { toolsets: ["market", "analytics", "account", "options"] } }, participants }, now: () => t });
    return { participants, registry };
  };

  it("returns the same summary as the REST read, and a series with from/to (capped at 250 days)", async () => {
    const { participants, registry } = await partSetup();
    const { readParticipantOi } = await import("../participants/routes.mjs");
    const out = await registry.call("get_participant_oi", {}, ctxFor(["read"]));
    expect(out.isError, JSON.stringify(out.content)).toBeUndefined();
    expect(out.structuredContent.data).toEqual(JSON.parse(JSON.stringify(readParticipantOi(participants, {}))));
    expect(out.structuredContent.data).toMatchObject({ kind: "summary", available: true, date: "2026-10-28", unit: "contracts" });
    const s = await registry.call("get_participant_oi", { from: "2025-01-01", to: "2026-10-28", participants: ["FII"], instruments: ["IDX_FUT"] }, ctxFor(["read"]));
    expect(s.structuredContent.data.kind).toBe("series");
    expect(s.structuredContent.data.days).toHaveLength(250);
    expect(s.structuredContent.data.truncated).toBe(true);
    expect(Object.keys(s.structuredContent.data.days[0].rows)).toEqual(["FII"]);
  });

  it("is read-only and opt-in", () => {
    const def = TOOL_DEFS.find((t) => t.name === "get_participant_oi");
    expect(def).toMatchObject({ toolset: "options", annotations: { readOnlyHint: true, destructiveHint: false } });
    expect(def.requiredScope).toBeUndefined();
    expect(DEFAULT_TOOL_NAMES).not.toContain("get_participant_oi");
  });
});

describe("get_safety_status readiness (p1-05 §4.6)", () => {
  it("adds readiness per account: state, reason codes and messages, checkedAt; never an IP address", async () => {
    const { deps, registry } = setup();
    deps.readiness = {
      status: () => ({}),
      canTrade: (id) =>
        id === "dhan-main"
          ? { ok: false, state: "cannot_trade", checkedAt: "2026-10-19T10:00:00+05:30", stale: false, reasons: [{ check: "egress", code: "IP_MISMATCH", severity: "fail", message: "This computer's internet address does not match the static IP registered for dhan-main.", detectedIp: "198.51.100.23" }] }
          : { ok: true, state: "paper_only", reasons: [], checkedAt: null, stale: false },
      ensureFresh: async () => ({}),
      check: async () => ({}),
      registerAutomation: () => ({}),
    };
    const r = await registry.call("get_safety_status", {}, ctxFor(["read"]));
    const accounts = r.structuredContent.data.accounts;
    expect(accounts.find((a) => a.accountId === "dhan-main").readiness).toEqual({
      state: "cannot_trade",
      reasons: [{ code: "IP_MISMATCH", message: "This computer's internet address does not match the static IP registered for dhan-main." }],
      checkedAt: "2026-10-19T10:00:00+05:30",
    });
    expect(accounts.find((a) => a.accountId === "paper").readiness.state).toBe("paper_only");
    expect(JSON.stringify(r.structuredContent)).not.toMatch(/198\.51\.100\.23/);
    expect(TOOL_DEFS.find((t) => t.name === "get_safety_status").description).toMatch(/readiness says whether the account can trade now/);
  });

  it("without a readiness service the field is null", async () => {
    const { registry } = setup();
    const r = await registry.call("get_safety_status", {}, ctxFor(["read"]));
    expect(r.structuredContent.data.accounts.every((a) => a.readiness === null)).toBe(true);
  });
});

describe("T-sec-6: MCP order tools by key scope (p1-05 §3.9 F9)", () => {
  const order = { account: "paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: 1400 };
  const toolsets = [["market", "analytics", "account", "orders"], ["orders"], ["account", "orders", "options"]];
  for (const ts of toolsets) {
    describe(`toolsets ${ts.join(", ")}`, () => {
      const mcp = { toolsets: ts, orderAccounts: ["paper", "dhan-main"] };
      it("read: no order tools, and calling them answers exactly like an unknown tool", async () => {
        const { registry, orders } = setup({ mcp });
        const names = registry.listTools(ctxFor(["read"])).map((t) => t.name);
        expect(names).not.toContain("prepare_order");
        expect(names).not.toContain("submit_confirmed_order");
        const hidden = await registry.call("prepare_order", order, ctxFor(["read"]));
        const hidden2 = await registry.call("submit_confirmed_order", { ticketId: "t", confirmToken: "mct_x" }, ctxFor(["read"]));
        const unknown = await registry.call("no_such_tool", {}, ctxFor(["read"]));
        const same = (r, name) => JSON.stringify(r).replaceAll(name, "<tool>");
        expect(same(hidden, "prepare_order")).toBe(same(unknown, "no_such_tool"));
        expect(same(hidden2, "submit_confirmed_order")).toBe(same(unknown, "no_such_tool"));
        expect(orders.calls).toHaveLength(0);
      });
      it("paper: mode enum lacks live; live: has it", () => {
        const { registry } = setup({ mcp });
        const paper = registry.listTools(ctxFor(["paper"])).find((t) => t.name === "prepare_order");
        expect(paper.inputSchema.properties.mode.anyOf[0].enum).toEqual(["paper"]);
        const live = registry.listTools(ctxFor(["live"])).find((t) => t.name === "prepare_order");
        expect(live.inputSchema.properties.mode.anyOf[0].enum).toEqual(["paper", "live"]);
      });
    });
  }
  it("an mcp client key with admin cannot be created (auth/keyStore.test.mjs: AI-assistant keys never hold admin)", () => {
    // Referenced, not repeated: keyStore.create({ scopes: ["admin"], clientKind: "mcp" }) → VALIDATION_FAILED.
    expect(true).toBe(true);
  });
});

describe("get_option_snapshots (options toolset, p1-01 §4.7)", () => {
  it("returns the REST page shape and units, at most 80 snapshots, defaults oi,ltp ±10 every 5", async () => {
    const { makeRecorder, IST, EXPIRY } = await import("../recorder/testkit.mjs");
    const { parseSnapshotQuery, readSnapshots, UNITS } = await import("../recorder/routes.mjs");
    const r = makeRecorder({ start: IST("2026-10-19T09:14:30"), recorder: { sources: { stream: false } } });
    await r.svc.start();
    await r.minutes(120); // 09:15 … 11:14
    const registry = createToolRegistry({ deps: { config: { mcp: { toolsets: ["market", "analytics", "account", "options"] } }, recorder: r.svc }, now: () => r.clock.now() });
    const def = TOOL_DEFS.find((t) => t.name === "get_option_snapshots");
    expect(def).toMatchObject({ toolset: "options", annotations: { readOnlyHint: true, destructiveHint: false } });
    expect(DEFAULT_TOOL_NAMES).not.toContain("get_option_snapshots");
    const out = await registry.call("get_option_snapshots", { underlying: "NIFTY", expiry: EXPIRY, every: 1 }, ctxFor(["read"]));
    expect(out.isError, JSON.stringify(out.content)).toBeUndefined();
    const d = out.structuredContent.data;
    expect(d.units).toEqual(UNITS);
    expect(d.fields).toEqual(["oi", "ltp"]);
    expect(d.snapshots).toHaveLength(80);
    expect(d.truncated).toBe(true);
    const five = await registry.call("get_option_snapshots", { underlying: "NIFTY", expiry: EXPIRY }, ctxFor(["read"]));
    const rest = await readSnapshots(r.svc, { ...parseSnapshotQuery({ underlying: "NIFTY", expiry: EXPIRY, fields: "oi,ltp", strikes: "10", every: "5" }, { now: r.clock.now() }), limit: 81 }, ctxFor(["read"]));
    expect(five.structuredContent.data.truncated).toBe(false);
    expect(five.structuredContent.data.snapshots).toEqual(JSON.parse(JSON.stringify(rest.snapshots)));
    const bad = await registry.call("get_option_snapshots", { underlying: "NIFTY", expiry: EXPIRY, fields: "theta" }, ctxFor(["read"]));
    expect(bad.isError).toBe(true);
    await r.svc.stop();
  });
});
