import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../core/logger.mjs";
import { startTestBridge } from "../hooks/__fixtures__/testBridge.mjs";
import { httpFailureMessage, parseSseMessages, runStdio } from "./stdio.mjs";

let b;

/** Run the relay over in-memory pipes; returns stdout lines once stdin is closed and all replies are in. */
async function relay(lines, { apiKey, baseUrl, fetchImpl } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const out = [];
  stdout.on("data", (c) => out.push(...c.toString("utf8").split("\n").filter(Boolean)));
  const logs = [];
  const done = runStdio({ baseUrl: baseUrl ?? `http://127.0.0.1:${b.port}`, apiKey: apiKey ?? b.keys.read, stdin, stdout, logger: createLogger({ level: "debug", write: (l) => logs.push(l) }), fetch: fetchImpl });
  for (const l of lines) stdin.write(`${typeof l === "string" ? l : JSON.stringify(l)}\n`);
  stdin.end();
  await done;
  return { out: out.map((l) => JSON.parse(l)), logs };
}

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-desktop", version: "1" } } };

describe("mc-bridge mcp stdio relay", () => {
  beforeEach(async () => {
    b = await startTestBridge();
  });
  afterEach(async () => b.close());

  it("relays initialize, notifications and tool calls to the running Bridge", async () => {
    const { out } = await relay([
      init,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_ltp", arguments: { symbols: ["NSE:RELIANCE"] } } },
    ]);
    const byId = Object.fromEntries(out.map((m) => [m.id, m]));
    expect(out).toHaveLength(3);
    expect(byId[1].result.protocolVersion).toBe("2025-06-18");
    expect(byId[2].result.tools.length).toBeGreaterThan(5);
    expect(byId[3].result.structuredContent.data.items[0].ltp).toBe(1402.5);
  });

  it("sends the negotiated MCP-Protocol-Version on later requests, never on initialize", async () => {
    const seen = [];
    const spy = (url, opts) => {
      seen.push(opts.headers["mcp-protocol-version"] ?? null);
      return fetch(url, opts);
    };
    await relay([init, { jsonrpc: "2.0", id: 2, method: "tools/list" }], { fetchImpl: spy });
    expect(seen).toEqual([null, "2025-06-18"]);
  });

  it("turns a refused key into a JSON-RPC error and never prints the key", async () => {
    const bad = "mcb_bogus000000_xxxxxxxxxxxxxxxxxxxx";
    const { out, logs } = await relay([init], { apiKey: bad });
    expect(out[0]).toMatchObject({ id: 1, error: { code: -32000 } });
    expect(out[0].error.message).toMatch(/refused the API key/);
    expect(JSON.stringify(out) + logs.join("")).not.toContain(bad);
  });

  it("starts without a running Bridge: answers initialize itself and gives a clear tool error", async () => {
    const { out } = await relay(
      [
        init,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_ltp", arguments: { symbols: ["NSE:RELIANCE"] } } },
      ],
      { baseUrl: "http://127.0.0.1:9" },
    );
    const byId = Object.fromEntries(out.map((m) => [m.id, m]));
    expect(byId[1].result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } } });
    expect(byId[2].result.tools).toEqual([]);
    expect(byId[3].result.isError).toBe(true);
    expect(byId[3].result.content[0].text).toMatch(/not running at http:\/\/127\.0\.0\.1:9/);
  });

  it("connects once the Bridge comes up, without restarting the AI client", async () => {
    let up = false;
    const flaky = (url, opts) => (up ? fetch(url, opts) : Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })));
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out = [];
    stdout.on("data", (c) => out.push(...c.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    const done = runStdio({ baseUrl: `http://127.0.0.1:${b.port}`, apiKey: b.keys.read, stdin, stdout, logger: createLogger({ level: "silent" }), fetch: flaky });
    const send = (m) => stdin.write(`${JSON.stringify(m)}\n`);
    const waitFor = async (pred) => {
      for (let i = 0; i < 200 && !out.some(pred); i++) await new Promise((r) => setTimeout(r, 5));
      return out.find(pred);
    };
    send(init);
    await waitFor((m) => m.id === 1);
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await waitFor((m) => m.id === 2)).result.tools).toEqual([]);
    up = true;
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_ltp", arguments: { symbols: ["NSE:RELIANCE"] } } });
    const r3 = await waitFor((m) => m.id === 3);
    expect(r3.result.structuredContent.data.items[0].ltp).toBe(1402.5);
    expect(out.some((m) => m.method === "notifications/tools/list_changed")).toBe(true);
    stdin.end();
    await done;
  });

  it("never ends a relayed refusal with a doubled full stop", () => {
    expect(httpFailureMessage(401, { detail: "This API key was revoked." })).toBe("The Bridge refused the API key: This API key was revoked. Check --key / MCB_API_KEY.");
    expect(httpFailureMessage(403, { detail: "Not allowed..." })).not.toMatch(/\.\./);
  });

  it("answers malformed lines with a parse error and carries on", async () => {
    const { out } = await relay(["{not json", { jsonrpc: "2.0", id: 7, method: "tools/list" }]);
    expect(out[0]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(out[1].id).toBe(7);
  });
});

describe("parseSseMessages", () => {
  it("reads data lines and skips keep-alives", () => {
    expect(parseSseMessages(': keepalive\n\nevent: message\ndata: {"a":1}\n\ndata: {"b":\ndata: 2}\n\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
