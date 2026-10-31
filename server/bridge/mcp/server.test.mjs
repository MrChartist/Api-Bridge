import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestBridge } from "../hooks/__fixtures__/testBridge.mjs";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "./server.mjs";

let b;
const H = (key, extra = {}) => ({ authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...extra });
const rpc = (method, params, id = 1) => ({ jsonrpc: "2.0", id, method, params });
const init = (protocolVersion) => rpc("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } });

async function sdkClient(key) {
  const client = new Client({ name: "s11-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${b.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } });
  await client.connect(transport);
  return client;
}

describe("POST /mcp (Streamable HTTP)", () => {
  beforeEach(async () => {
    b = await startTestBridge({ config: { mcp: { toolsets: ["market", "analytics", "account", "orders"], orderAccounts: ["paper"] } } });
  });
  afterEach(async () => b.close());

  it("negotiates the protocol version: echoes a supported one, offers the latest otherwise", async () => {
    const old = await b.request({ method: "POST", path: "/mcp", headers: H(b.keys.read), body: init("2025-03-26") });
    expect(old.status).toBe(200);
    expect(old.json.result.protocolVersion).toBe("2025-03-26");
    expect(old.json.result.serverInfo.name).toBe("mr-chartist-bridge");
    expect(old.json.result.capabilities.tools).toBeDefined();
    expect(old.json.result.instructions).toMatch(/untrusted-data/);
    const future = await b.request({ method: "POST", path: "/mcp", headers: H(b.keys.read), body: init("2099-01-01") });
    expect(future.json.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain("2025-06-18");
  });

  it("refuses an unsupported MCP-Protocol-Version header on later requests", async () => {
    const r = await b.request({ method: "POST", path: "/mcp", headers: H(b.keys.read, { "mcp-protocol-version": "1999-01-01" }), body: rpc("tools/list", {}) });
    expect(r.status).toBe(400);
  });

  it("needs a key; any scope that includes read may connect", async () => {
    expect((await b.request({ method: "POST", path: "/mcp", headers: { "content-type": "application/json" }, body: init(LATEST_PROTOCOL_VERSION) })).status).toBe(401);
    expect((await b.request({ method: "POST", path: "/mcp", headers: H("mcb_bogus000000_xxxxxxxxxxxxxxxx"), body: init(LATEST_PROTOCOL_VERSION) })).status).toBe(401);
  });

  it("works with the official SDK client end to end", async () => {
    const client = await sdkClient(b.keys.read);
    expect(client.getServerVersion().name).toBe("mr-chartist-bridge");
    const { tools } = await client.listTools();
    expect(tools.length).toBeLessThan(20);
    expect(tools.map((t) => t.name)).not.toContain("prepare_order");
    const r = await client.callTool({ name: "get_ltp", arguments: { symbols: ["NSE:RELIANCE"] } });
    expect(r.structuredContent.data.items[0]).toMatchObject({ symbol: "NSE:RELIANCE", ltp: 1402.5 });
    await client.close();
  });

  it("a read-key session lists no order tools; a paper key sees them; calling a hidden tool is an unknown tool", async () => {
    const read = await b.request({ method: "POST", path: "/mcp", headers: H(b.keys.read), body: rpc("tools/list", {}) });
    expect(read.json.result.tools.map((t) => t.name)).not.toContain("prepare_order");
    const paper = await b.request({ method: "POST", path: "/mcp", headers: H(b.keys.paper), body: rpc("tools/list", {}) });
    expect(paper.json.result.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["prepare_order", "submit_confirmed_order"]));
    const hidden = await b.request({
      method: "POST",
      path: "/mcp",
      headers: H(b.keys.read),
      body: rpc("tools/call", { name: "prepare_order", arguments: { account: "paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: 1400 } }),
    });
    expect(hidden.json.error.code).toBe(-32602);
    expect(b.orders.calls).toHaveLength(0);
  });

  it("an AI-prepared order reaches nothing until a person confirms the ticket through /v1/tickets", async () => {
    const client = await sdkClient(b.keys.paper);
    const prep = await client.callTool({ name: "prepare_order", arguments: { account: "paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: 1400 } });
    const { ticketId } = prep.structuredContent.data;
    expect(ticketId).toMatch(/^tkt_/);
    expect(b.orders.all()).toHaveLength(0);
    const refused = await client.callTool({ name: "submit_confirmed_order", arguments: { ticketId, confirmToken: "mct_guessed-token-value-0000" } });
    expect(refused.isError).toBe(true);
    expect(b.orders.all()).toHaveLength(0);
    // The person confirms (the S7 route does this with an admin key from loopback; here straight on the service).
    const { confirmToken } = await b.orders.confirmTicket({ principal: { kind: "local", id: "cli" }, scopes: new Set(["admin"]), source: "rest", loopback: true }, ticketId);
    const sent = await client.callTool({ name: "submit_confirmed_order", arguments: { ticketId, confirmToken } });
    expect(sent.isError).toBeFalsy();
    expect(sent.structuredContent.data.order).toMatchObject({ mode: "paper", source: "mcp" });
    expect(b.orders.all()).toHaveLength(1);
    await client.close();
  });

  it("notifications get 202 with no body; GET /mcp is not offered", async () => {
    const n = await b.request({ method: "POST", path: "/mcp", headers: H(b.keys.read), body: { jsonrpc: "2.0", method: "notifications/initialized" } });
    expect(n.status).toBe(202);
    const g = await b.request({ method: "GET", path: "/mcp", headers: H(b.keys.read) });
    expect(g.status).toBe(405);
  });

  it("is switched off by mcp.enabled false", async () => {
    await b.close();
    b = await startTestBridge({ config: { mcp: { enabled: false } } });
    expect((await b.request({ method: "POST", path: "/mcp", headers: H(b.keys.read), body: init(LATEST_PROTOCOL_VERSION) })).status).toBe(404);
  });

  it("rejects an unknown mcp config key at boot", async () => {
    await expect(startTestBridge({ config: { mcp: { toolsets: ["market"], placeOrders: true } } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("never logs the API key or tool arguments", async () => {
    await b.request({ method: "POST", path: "/mcp", headers: H(b.keys.read), body: rpc("tools/call", { name: "get_ltp", arguments: { symbols: ["NSE:RELIANCE"] } }) });
    const logs = b.logLines.join("\n");
    expect(logs).not.toContain(b.keys.read);
    expect(logs).toContain('"tool":"get_ltp"');
    expect(logs).not.toContain("NSE:RELIANCE");
  });
});
