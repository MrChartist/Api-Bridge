/**
 * MCP over stdio. `mc-bridge mcp` calls runStdio().
 *
 * It is a RELAY, not a second Bridge: it forwards newline-delimited JSON-RPC between the AI client (Claude Desktop,
 * Claude Code, Cursor) on stdin/stdout and the running Bridge's Streamable HTTP endpoint (POST /mcp) with the given
 * API key. All tool calls therefore go through the one Bridge process and share its broker connections, rate limits,
 * safety checks and audit log. stdout belongs to the MCP protocol; diagnostics go to stderr (the logger).
 *
 * Behaviour:
 *  - Each stdin line is one JSON-RPC message (or batch). It is POSTed as is; responses are written to stdout one
 *    message per line. Notifications (202) produce no output.
 *  - Protocol-version negotiation is end to end: the relay remembers the version the Bridge returned for
 *    `initialize` and sends it as MCP-Protocol-Version on later requests, as the Streamable HTTP spec requires.
 *  - HTTP-level failures (Bridge not running, 401 bad key, 403, 429) become JSON-RPC errors for requests with an id,
 *    so the assistant shows a clear message instead of hanging. The API key is never written to stdout or logs.
 *  - The relay starts even when the Bridge is not running yet (Claude Desktop launches MCP servers at its own start).
 *    It then answers `initialize` itself, lists no tools, and answers each tool call with a clear tool error; every
 *    request retries the Bridge, and once it answers the relay sends notifications/tools/list_changed so the client
 *    fetches the real tool list. No restart of the AI client is needed.
 *  - Requests run concurrently (JSON-RPC ids keep them apart); each output line is written whole.
 */
import { createInterface } from "node:readline";

/** Largest stdin line accepted (bytes of UTF-16 code units, close enough). */
export const MAX_LINE = 4 * 1024 * 1024;
const RELAY_ERROR = -32000;
const PARSE_ERROR = -32700;

/** Messages in an SSE body (`data:` lines, events separated by blank lines). */
export function parseSseMessages(text) {
  const out = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data.trim()) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      /* ignore keep-alives and malformed events */
    }
  }
  return out;
}

const idsOf = (msg) => (Array.isArray(msg) ? msg : [msg]).filter((m) => m && typeof m === "object" && "method" in m && m.id !== undefined && m.id !== null).map((m) => m.id);

/** "detail" with any trailing full stops removed, so messages never end in "..". */
const trimDetail = (d) => (typeof d === "string" && d.trim() ? d.trim().replace(/[.\s]+$/, "") : null);

/** Protocol version the relay offers when it has to answer `initialize` itself. */
export const FALLBACK_PROTOCOL_VERSION = "2025-06-18";

/** Human message for an HTTP failure from the Bridge. */
export function httpFailureMessage(status, problem) {
  const detail = trimDetail(problem?.detail);
  if (status === 401) return `The Bridge refused the API key${detail ? `: ${detail}` : ""}. Check --key / MCB_API_KEY.`;
  if (status === 403) return `The Bridge refused this request${detail ? `: ${detail}` : ""}.`;
  if (status === 404) return "The Bridge's MCP endpoint is switched off (mcp.enabled) or not available.";
  if (status === 429) return `The Bridge is rate limiting this key${detail ? `: ${detail}` : ""}. Try again shortly.`;
  return `The Bridge answered HTTP ${status}${detail ? `: ${detail}` : ""}.`;
}

/**
 * @param {{ baseUrl: string, apiKey: string, stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream,
 *   logger: import("../core/logger.mjs").Logger, fetch?: typeof fetch, timeoutMs?: number }} opts
 *   fetch: injectable for tests (defaults to the global fetch). timeoutMs: per request (default 120 s).
 * @returns {Promise<void>} resolves when stdin closes and every in-flight request has been answered
 */
export async function runStdio({ baseUrl, apiKey, stdin, stdout, logger, fetch: fetchImpl = globalThis.fetch, timeoutMs = 120_000 }) {
  if (typeof apiKey !== "string" || !apiKey) throw new TypeError("runStdio needs an apiKey");
  logger?.addSecret?.(apiKey);
  const endpoint = new URL("/mcp", baseUrl).toString();
  let protocolVersion = null;
  /** The client's initialize message, kept when the relay had to answer it itself (Bridge down at start). */
  let pendingInit = null;
  /** True once the client was told "no tools" because the Bridge was down; cleared by list_changed. */
  let listedWhileDown = false;
  const inflight = new Set();
  const origin = new URL(baseUrl).origin;
  const downMessage = `The Mr. Chartist Bridge is not running at ${origin}. Start it from its shortcut (or run: mc-bridge start), then try again.`;

  const write = (msg) => {
    stdout.write(`${JSON.stringify(msg)}\n`);
  };
  const errorFor = (id, message, code = RELAY_ERROR) => write({ jsonrpc: "2.0", id, error: { code, message } });
  const headersFor = (isInit) => {
    const h = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${apiKey}` };
    if (protocolVersion && !isInit) h["mcp-protocol-version"] = protocolVersion;
    return h;
  };

  /** Answer one message locally while the Bridge is unreachable. */
  const answerWhileDown = (m) => {
    if (!m || typeof m !== "object" || m.id === undefined || m.id === null || typeof m.method !== "string") return;
    if (m.method === "initialize") {
      pendingInit = m;
      const requested = typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : FALLBACK_PROTOCOL_VERSION;
      write({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          protocolVersion: requested,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "mr-chartist-bridge-relay", version: "0.1.0" },
          instructions: `${downMessage} Tools appear once the Bridge is running.`,
        },
      });
    } else if (m.method === "ping") write({ jsonrpc: "2.0", id: m.id, result: {} });
    else if (m.method === "tools/list") {
      listedWhileDown = true;
      write({ jsonrpc: "2.0", id: m.id, result: { tools: [] } });
    } else if (m.method === "tools/call") write({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: downMessage }], isError: true } });
    else errorFor(m.id, downMessage);
  };

  /** After the relay answered initialize itself, initialise upstream once so the real protocol version is known. */
  const catchUpInit = async () => {
    if (!pendingInit) return;
    const init = pendingInit;
    try {
      const res = await fetchImpl(endpoint, { method: "POST", headers: headersFor(true), body: JSON.stringify(init) });
      const text = await res.text();
      const ct = res.headers.get("content-type") ?? "";
      const msgs = ct.includes("text/event-stream") ? parseSseMessages(text) : [JSON.parse(text)].flat();
      const v = msgs.find((x) => x?.id === init.id)?.result?.protocolVersion;
      if (typeof v === "string") protocolVersion = v;
      pendingInit = null;
    } catch {
      /* still down or unreadable: try again on the next request */
    }
  };

  const forward = async (msg) => {
    const ids = idsOf(msg);
    const list = Array.isArray(msg) ? msg : [msg];
    const isInit = list.some((m) => m?.method === "initialize");
    if (!isInit) await catchUpInit();
    const headers = headersFor(isInit);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(endpoint, { method: "POST", headers, body: JSON.stringify(msg), signal: ac.signal });
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === "AbortError") {
        logger?.warn("mcp relay: request failed", { reason: "timeout" });
        for (const id of ids) errorFor(id, "The Bridge did not answer in time.");
        return;
      }
      logger?.warn("mcp relay: request failed", { reason: "unreachable" });
      for (const m of list) answerWhileDown(m);
      return;
    }
    if (listedWhileDown && !isInit) {
      listedWhileDown = false;
      write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
    try {
      const text = res.status === 202 || res.status === 204 ? "" : await res.text();
      const ct = res.headers.get("content-type") ?? "";
      if (!res.ok && !ct.includes("application/json") && !ct.includes("text/event-stream")) {
        let problem = null;
        try {
          problem = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        logger?.warn("mcp relay: bridge refused", { status: res.status, code: problem?.code });
        for (const id of ids) errorFor(id, httpFailureMessage(res.status, problem));
        return;
      }
      if (!text) return;
      let messages;
      if (ct.includes("text/event-stream")) messages = parseSseMessages(text);
      else {
        try {
          const parsed = JSON.parse(text);
          messages = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          for (const id of ids) errorFor(id, "The Bridge sent a reply the relay could not read.");
          return;
        }
      }
      for (const m of messages) {
        if (isInit && m?.result?.protocolVersion && typeof m.result.protocolVersion === "string") protocolVersion = m.result.protocolVersion;
        write(m);
      }
    } finally {
      clearTimeout(timer);
    }
  };

  const rl = createInterface({ input: stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (line.length > MAX_LINE) {
      errorFor(null, "Message too large.", PARSE_ERROR);
      continue;
    }
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      errorFor(null, "Parse error: each line must be one JSON-RPC message.", PARSE_ERROR);
      continue;
    }
    // initialize must finish before anything else so the negotiated version is known.
    const p = forward(msg).catch((err) => logger?.error("mcp relay crashed", { err }));
    if ((Array.isArray(msg) ? msg : [msg]).some((m) => m?.method === "initialize")) await p;
    else {
      inflight.add(p);
      p.finally(() => inflight.delete(p));
    }
  }
  await Promise.all([...inflight]);
}
