/**
 * Every MCP tool, called at least once through the real MCP endpoint of a demo Bridge (official SDK client over HTTP):
 * the answer is not an error and matches the tool's own declared output schema; each tool's read-only / trade labels match
 * what it really does (read tools change nothing, only the two order tools are not read-only); no tool can approve an
 * order; and a key limited to one account cannot read or prepare for another through any tool.
 * A tool added without a sample here fails the first test, so a new tool cannot ship untested.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { TOOL_DEFS } from "./tools.mjs";

const PAPER = "demo-paper";
const OTHER = "demo-paper-other";
/** Tools that only read: never change anything, whatever arguments. */
const READ_TOOLS = TOOL_DEFS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
const TRADE_TOOLS = ["prepare_order", "submit_confirmed_order"];

let app;
let port;
const clients = [];
const keys = {};

async function connect(key) {
  const client = new Client({ name: "tools-all-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } });
  await client.connect(transport);
  clients.push(client);
  return client;
}
/** A limit price a little below the demo price, on the tick, so a paper ticket opens (the price band would refuse a far price). */
async function nearPrice(client) {
  const ltp = (await client.callTool({ name: "get_ltp", arguments: { symbols: ["NSE:RELIANCE"] } })).structuredContent.data.items[0].ltp;
  return Number((Math.round((ltp * 0.99) / 0.1) * 0.1).toFixed(1));
}
const text = (r) => r.content?.map((c) => c.text).join("\n") ?? "";
const http = (method, path, key, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcb-mcp-all-"));
  const { config } = loadConfig({
    raw: { dataDir: dir, server: { port: 0 }, logging: { level: "silent" }, mcp: { toolsets: ["market", "analytics", "account", "orders"], orderAccounts: [PAPER, OTHER] } },
    env: {},
    demo: true,
  });
  app = await createApp({ config, logger: createNullLogger() });
  ({ port } = await app.listen());
  const make = async (label, scopes, accounts = "*", clientKind = "mcp") => (await app.deps.keyStore.create({ label, scopes, accounts, clientKind })).key;
  keys.read = await make("assistant-read", ["read"]);
  keys.paper = await make("assistant-paper", ["paper"]);
  keys.pinned = await make("assistant-pinned", ["paper"], [PAPER]);
  keys.admin = await make("owner", ["admin", "paper"], "*", "script");
});

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await app?.close();
});

describe("every tool is called once, against the demo Bridge", () => {
  it("each tool answers, matches its declared output schema, and read tools change nothing", async () => {
    const client = await connect(keys.paper);
    const call = (name, args) => client.callTool({ name, arguments: args });
    const listed = (await client.listTools()).tools.map((t) => t.name);

    const ltp = (await call("get_ltp", { symbols: ["NSE:RELIANCE"] })).structuredContent.data.items[0].ltp;
    expect(ltp).toBeGreaterThan(0);
    const expiries = (await call("get_expiries", { underlying: "NIFTY" })).structuredContent.data.expiries;
    expect(expiries.length).toBeGreaterThan(0);
    const price = Math.round((ltp * 0.99) / 0.1) * 0.1;

    /** One valid call per tool (the ones that need something an earlier call makes take it from `ctx`). */
    const samples = {
      get_ltp: () => ({ symbols: ["NSE:RELIANCE", "NSE:INFY"] }),
      get_quotes: () => ({ symbols: ["NSE:RELIANCE"] }),
      get_depth: () => ({ symbol: "NSE:RELIANCE" }),
      get_history: () => ({ symbol: "NSE:RELIANCE", interval: "1d", countback: 5 }),
      get_expiries: () => ({ underlying: "NIFTY" }),
      get_option_chain: () => ({ underlying: "NIFTY", expiry: expiries[0], strikes: 2 }),
      search_instruments: () => ({ query: "RELIANCE", limit: 5 }),
      convert_symbol: () => ({ input: "NSE:RELIANCE" }),
      option_chain_summary: () => ({ underlying: "NIFTY", expiry: expiries[0] }),
      history_summary: () => ({ symbol: "NSE:RELIANCE", interval: "1d", countback: 5 }),
      list_accounts: () => ({}),
      get_positions: () => ({ account: PAPER }),
      get_holdings: () => ({ account: PAPER }),
      get_funds: () => ({ account: PAPER }),
      list_orders: () => ({ account: PAPER }),
      get_order: (c) => ({ orderId: c.orderId }),
      get_safety_status: () => ({}),
      prepare_order: () => ({ account: PAPER, symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: Number(price.toFixed(1)) }),
      check_order_ticket: (c) => ({ ticketId: c.ticketId }),
      submit_confirmed_order: (c) => ({ ticketId: c.ticketId, confirmToken: "mct_guessed-token-value-0000" }),
    };
    // A tool added to the registry without a sample here is a tool nothing tests.
    expect(TOOL_DEFS.map((t) => t.name).sort()).toEqual(Object.keys(samples).sort());
    expect(listed.sort()).toEqual(TOOL_DEFS.map((t) => t.name).sort());

    const orderCount = async () => (await call("list_orders", {})).structuredContent.data.length;
    const ctx = {};
    // An order for get_order to look at: placed by the owner on the paper account, not through any assistant tool.
    const placed = await http("POST", "/v1/orders", keys.admin, { account: PAPER, symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: Number(price.toFixed(1)), clientOrderId: "mcp-all-1" });
    expect([200, 201]).toContain(placed.status);
    ctx.orderId = (await placed.json()).data.orderId;
    const before = await orderCount();
    expect(before).toBeGreaterThan(0);

    const called = [];
    for (const def of TOOL_DEFS) {
      if (!def.annotations.readOnlyHint) continue; // the trade tools are exercised below
      if (def.name === "check_order_ticket") continue;
      const r = await call(def.name, samples[def.name](ctx));
      expect(r.isError, `${def.name}: ${text(r).slice(0, 300)}`).toBeFalsy();
      const parsed = def.output.safeParse(r.structuredContent);
      expect(parsed.success, `${def.name} output: ${parsed.error?.message}`).toBe(true);
      expect(r.structuredContent.untrusted, def.name).toBe(true);
      expect(text(r), def.name).toMatch(/DEMO DATA/);
      called.push(def.name);
    }
    expect(await orderCount()).toBe(before); // nothing a read tool did created or changed an order

    // The trade tools: prepare opens a ticket (nothing sent), check reads it, submit without the person's code sends nothing.
    const prep = await call("prepare_order", samples.prepare_order());
    expect(prep.isError, text(prep)).toBeFalsy();
    expect(TOOL_DEFS.find((t) => t.name === "prepare_order").output.safeParse(prep.structuredContent).success).toBe(true);
    ctx.ticketId = prep.structuredContent.data.ticketId;
    expect(ctx.ticketId).toMatch(/^tkt_/);
    expect(prep.structuredContent.data.requiresHumanConfirmation).toBe(true);
    const checked = await call("check_order_ticket", samples.check_order_ticket(ctx));
    expect(checked.isError).toBeFalsy();
    expect(TOOL_DEFS.find((t) => t.name === "check_order_ticket").output.safeParse(checked.structuredContent).success).toBe(true);
    expect(checked.structuredContent.data.status).toBe("open");
    const submitted = await call("submit_confirmed_order", samples.submit_confirmed_order(ctx));
    expect(submitted.isError).toBe(true);
    expect(await orderCount()).toBe(before);
    called.push("prepare_order", "check_order_ticket", "submit_confirmed_order");

    expect(called.sort()).toEqual(TOOL_DEFS.map((t) => t.name).sort());
  });
});

describe("capability labels (read-only vs trade)", () => {
  it("the labels are explicit and consistent: read tools are read-only and not destructive, the two trade tools are not read-only", async () => {
    const client = await connect(keys.paper);
    const tools = (await client.listTools()).tools;
    for (const t of tools) {
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) expect(typeof t.annotations[hint], `${t.name}.${hint}`).toBe("boolean");
      if (TRADE_TOOLS.includes(t.name)) {
        expect(t.annotations.readOnlyHint, t.name).toBe(false);
      } else {
        expect(t.annotations, t.name).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        expect(t.description, t.name).not.toMatch(/\b(places?|sends?|cancels?|modif(?:y|ies)) an? (live )?order\b/i);
      }
    }
    expect(tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name).sort()).toEqual([...TRADE_TOOLS].sort());
    expect(tools.find((t) => t.name === "submit_confirmed_order").annotations.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "prepare_order").annotations.destructiveHint).toBe(false);
    // check_order_ticket is an order tool too, but it only reads (the state of a ticket).
    expect(READ_TOOLS).toContain("check_order_ticket");
    expect(READ_TOOLS.length + TRADE_TOOLS.length).toBe(TOOL_DEFS.length);
  });

  it("a read-only key sees read-only tools only, whatever the config allows", async () => {
    const client = await connect(keys.read);
    const tools = (await client.listTools()).tools;
    expect(tools.length).toBeGreaterThan(10);
    expect(tools.every((t) => t.annotations.readOnlyHint === true)).toBe(true);
    for (const name of [...TRADE_TOOLS, "check_order_ticket"]) {
      expect(tools.map((t) => t.name)).not.toContain(name);
      const r = await client.callTool({ name, arguments: { ticketId: "tkt_x", confirmToken: "mct_guessed-token-value-0000" } }).catch((e) => e);
      expect(r instanceof Error || r.isError === true, name).toBe(true);
    }
  });
});

describe("no tool can approve an order", () => {
  it("there is no approve, confirm, release, mode or key tool, and no tool argument names a confirmation action", async () => {
    const client = await connect(keys.paper);
    const tools = (await client.listTools()).tools;
    for (const t of tools) {
      expect(t.name, t.name).not.toMatch(/approve|confirm_ticket|reject|decline|release|kill|scope|login|set_mode|api_key/i);
      if (t.name !== "submit_confirmed_order") expect(t.name, t.name).not.toMatch(/confirm/i);
    }
    const submit = tools.find((t) => t.name === "submit_confirmed_order");
    // The only way in is a code the person gets by confirming on this computer; the tool asks for it and cannot make one.
    expect(Object.keys(submit.inputSchema.properties).sort()).toEqual(["confirmToken", "ticketId"]);
    expect(submit.description).toMatch(/single-use confirmation code the person got/);
    // And a key made for an assistant cannot hold the admin scope that confirms tickets.
    await expect(app.deps.keyStore.create({ label: "bad", scopes: ["admin"], accounts: "*", clientKind: "mcp" })).rejects.toThrow(/must never confirm its own/);
  });

  it("a ticket an assistant prepares cannot be confirmed with the assistant's own key, over HTTP or by guessing a code", async () => {
    const client = await connect(keys.paper);
    const prep = await client.callTool({ name: "prepare_order", arguments: { account: PAPER, symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: await nearPrice(client) } });
    expect(prep.isError, text(prep)).toBeFalsy();
    const { ticketId } = prep.structuredContent.data;
    expect(ticketId).toMatch(/^tkt_/);
    // The routes that approve or decline need an admin key from this computer; an assistant's key (any scope but admin) is refused.
    for (const key of [keys.paper, keys.read, keys.pinned]) {
      const confirm = await http("POST", `/v1/tickets/${ticketId}/confirm`, key);
      expect([401, 403], `confirm with a non-admin key: ${confirm.status}`).toContain(confirm.status);
      const reject = await http("POST", `/v1/tickets/${ticketId}/reject`, key, { reason: "x" });
      expect([401, 403]).toContain(reject.status);
    }
    const guessed = await client.callTool({ name: "submit_confirmed_order", arguments: { ticketId, confirmToken: "mct_0123456789abcdef0123456789abcdef" } });
    expect(guessed.isError).toBe(true);
    const status = await client.callTool({ name: "check_order_ticket", arguments: { ticketId } });
    expect(status.isError, text(status)).toBeFalsy();
    expect(status.structuredContent.data.status).toBe("open"); // still waiting for the person
    const list = await client.callTool({ name: "list_orders", arguments: { account: PAPER } });
    expect(list.structuredContent.data.filter((o) => o.source === "mcp")).toHaveLength(0); // nothing an assistant prepared was sent
  });
});

describe("a key limited to one account cannot reach another through any tool", () => {
  it("lists only its account, and every account-taking tool refuses the other account instead of answering empty", async () => {
    const client = await connect(keys.pinned);
    const call = (name, args) => client.callTool({ name, arguments: args });
    const accounts = (await call("list_accounts", {})).structuredContent.data.map((a) => a.id);
    expect(accounts).toEqual([PAPER]);
    const refused = {
      get_positions: { account: OTHER },
      get_holdings: { account: OTHER },
      get_funds: { account: OTHER },
      list_orders: { account: OTHER },
      get_safety_status: { account: OTHER },
      get_ltp: { symbols: ["NSE:RELIANCE"], account: OTHER },
      get_quotes: { symbols: ["NSE:RELIANCE"], account: OTHER },
      get_depth: { symbol: "NSE:RELIANCE", account: OTHER },
      get_history: { symbol: "NSE:RELIANCE", interval: "1d", countback: 3, account: OTHER },
      get_expiries: { underlying: "NIFTY", account: OTHER },
      history_summary: { symbol: "NSE:RELIANCE", interval: "1d", countback: 3, account: OTHER },
    };
    for (const [name, args] of Object.entries(refused)) {
      const r = await call(name, args);
      expect(r.isError, `${name} for another account`).toBe(true);
      expect(text(r), name).toMatch(/FORBIDDEN|not allowed|may not use/i);
    }
    // Without naming an account, the safety view and the order list cover only the accounts this key may use.
    const safety = (await call("get_safety_status", {})).structuredContent.data;
    expect(safety.accounts.map((a) => a.accountId)).toEqual([PAPER]);
    // The order tools cannot even name the other account: it is not among the accounts this key may prepare for.
    const prepSchema = (await client.listTools()).tools.find((t) => t.name === "prepare_order").inputSchema;
    expect(prepSchema.properties.account.enum).toEqual([PAPER]);
    const prep = await call("prepare_order", { account: OTHER, symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: 1000 });
    expect(prep.isError).toBe(true);
    // (A key limited to the paper account has no price source of its own, so the price comes from a key that sees them all.)
    const own = await call("prepare_order", { account: PAPER, symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: await nearPrice(await connect(keys.paper)) });
    expect(own.isError, text(own)).toBeFalsy();
    expect(own.structuredContent.data.ticketId).toMatch(/^tkt_/);
  });
});
