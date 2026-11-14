// Talk to the Bridge as an MCP client: list its tools, then call one. No dependencies, so you can read every byte.
//   node mcp.mjs                                              list the tools this key may use
//   node mcp.mjs get_ltp '{"symbols":["NSE:RELIANCE"]}'       call a tool with JSON arguments
//
// MCP is JSON-RPC. The Bridge speaks it over plain HTTP at POST /mcp (one request, one answer). The key goes in the
// Authorization header. A read key sees the read-only tools; a tool that could place an order is not offered to it.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.mjs";

const env = loadEnv();
const base = (env.BRIDGE_URL ?? "http://127.0.0.1:4300").replace(/\/+$/, "");
let id = 0;

/** One JSON-RPC call. Throws with the Bridge's own explanation when it refuses. */
export async function rpc(method, params, { key = env.BRIDGE_KEY, url = `${base}/mcp` } = {}) {
  if (!key) throw new Error("No API key. Put BRIDGE_KEY=mcb_... in .env (make one with: mc-bridge keys create --label assistant --scope read --client mcp).");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const body = await res.json().catch(() => ({}));
  // Two kinds of refusal: the HTTP layer (a problem answer: bad key, wrong scope) and MCP itself (an `error` member).
  if (!res.ok) throw new Error(`${body.code ?? res.status}: ${body.detail ?? "the Bridge refused the request"}${body.requestId ? ` (request id ${body.requestId})` : ""}`);
  if (body.error) throw new Error(`MCP error ${body.error.code}: ${body.error.message}`);
  return body.result;
}

async function main() {
  const [tool, args] = process.argv.slice(2);
  const hello = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "bridge-mcp-starter", version: "1.0.0" } });
  if (!tool) {
    console.log(`Connected to ${hello.serverInfo.title ?? hello.serverInfo.name} ${hello.serverInfo.version}`);
    const { tools } = await rpc("tools/list", {});
    console.log(`\nThis key may use ${tools.length} tools:`);
    for (const t of tools) console.log(`  ${t.name.padEnd(24)} ${t.title ?? ""}`);
    console.log('\nCall one:  node mcp.mjs get_ltp \'{"symbols":["NSE:RELIANCE"]}\'');
    return;
  }
  const result = await rpc("tools/call", { name: tool, arguments: args ? JSON.parse(args) : {} });
  // Results are wrapped in "untrusted data" markers: instrument names and broker messages come from third parties,
  // and an AI assistant must treat them as data, never as instructions. structuredContent is the same answer without the wrapper.
  console.log(JSON.stringify(result.structuredContent ?? result.content, null, 2));
  if (result.isError) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exitCode = 1;
  });
}
