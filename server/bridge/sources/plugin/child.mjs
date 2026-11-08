/**
 * The process the host starts for each plugin: `node [permission flags] child.mjs <entry> <sha256>`.
 *
 * It reads the entry file ONCE, checks its sha256 against the pin the host verified, and imports exactly those bytes
 * (from a data: URL, so the file cannot change between the check and the import and the entry cannot import siblings).
 * Then it speaks protocol bridge-source/1 on stdin and stdout and gives the plugin a small API:
 *
 *   export default { quotes(symbols, ctx), history(req, ctx), expiries(underlying, ctx),
 *                    optionChain(underlying, expiry, ctx), test(ctx) }
 *
 *   ctx.fetch(url, init)   host-brokered HTTPS GET: { ok, status, headers, text(), json() }
 *   ctx.signal             aborted when the host cancels the call
 *   ctx.now                epoch ms from the Bridge clock
 *   ctx.config             the owner's settings, validated against configSchema
 *   ctx.secrets            { apiKey } when the manifest declares it
 *   ctx.log(level, msg)    logged by the host (rate-limited, secrets redacted)
 *   ctx.fail(code, msg, retryAfterMs)  throw a plugin error (RATE_LIMITED, UNAVAILABLE, NOT_FOUND, ...)
 *
 * This file imports only Node built-ins and nothing from the Bridge.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { format } from "node:util";

const API_VERSION = 1;
const METHODS = ["quotes", "history", "expiries", "optionChain"];
const PLUGIN_CODES = new Set(["RATE_LIMITED", "UNAVAILABLE", "TIMEOUT", "BAD_RESPONSE", "NOT_FOUND", "UNSUPPORTED", "AUTH", "CANCELLED", "INTERNAL"]);
const FETCH_CODE_MAP = { RATE_LIMITED: "RATE_LIMITED", TIMEOUT: "TIMEOUT", TOO_LARGE: "BAD_RESPONSE", NETWORK: "UNAVAILABLE", CANCELLED: "CANCELLED" };

const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

// stdout carries the protocol: keep console output out of it.
for (const [name, level] of [["log", "info"], ["info", "info"], ["debug", "debug"], ["warn", "warn"], ["error", "error"]]) {
  console[name] = (...args) => write({ type: "log", level, msg: format(...args).slice(0, 1000) });
}
const die = (msg, code = 1) => {
  write({ type: "log", level: "error", msg: String(msg).slice(0, 500) });
  process.exitCode = code;
  setTimeout(() => process.exit(code), 20);
};
process.on("uncaughtException", (err) => die(`uncaught: ${err?.message ?? err}`));
process.on("unhandledRejection", (err) => die(`unhandled rejection: ${err?.message ?? err}`));

const [entryPath, expectedSha] = process.argv.slice(2);
let plugin;
try {
  const bytes = readFileSync(entryPath);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha) throw new Error("the entry file does not match its pinned sha256");
  const mod = await import(`data:text/javascript;base64,${bytes.toString("base64")}`);
  plugin = mod.default && typeof mod.default === "object" ? mod.default : mod;
} catch (err) {
  die(`could not load the plugin: ${err?.message ?? err}`, 3);
}

if (plugin) {
  const implemented = METHODS.filter((m) => typeof plugin[m] === "function");
  let settings = { config: {}, secrets: {} };
  let inited = false;
  let nextFetchId = 1;
  const pendingFetches = new Map();
  const calls = new Map();

  const makeError = (code, message, retryAfterMs) => {
    const e = new Error(message ?? code);
    e.code = PLUGIN_CODES.has(code) ? code : "INTERNAL";
    if (retryAfterMs !== undefined) e.retryAfterMs = retryAfterMs;
    return e;
  };

  const hostFetch = (url, init, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(makeError("CANCELLED", "cancelled"));
      const id = nextFetchId++;
      const onAbort = () => {
        pendingFetches.delete(id);
        reject(makeError("CANCELLED", "cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      pendingFetches.set(id, {
        resolve: (v) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
        reject: (e) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
      });
      write({ type: "fetch", id, url: String(url), ...(init ? { init } : {}) });
    });

  const contextFor = (signal, now) => ({
    signal,
    now,
    config: settings.config,
    secrets: settings.secrets,
    log: (level, msg) => write({ type: "log", level: ["debug", "info", "warn", "error"].includes(level) ? level : "info", msg: String(msg).slice(0, 1000) }),
    fail: (code, message, retryAfterMs) => {
      throw makeError(code, message, retryAfterMs);
    },
    async fetch(url, init) {
      const r = await hostFetch(url, init, signal);
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        headers: r.headers,
        text: async () => r.body,
        json: async () => {
          try {
            return JSON.parse(r.body);
          } catch {
            throw makeError("BAD_RESPONSE", "the response was not JSON");
          }
        },
      };
    },
  });

  const run = async (msg) => {
    const ac = new AbortController();
    calls.set(msg.id, ac);
    try {
      if (!inited) throw makeError("INTERNAL", "call before init");
      const ctx = contextFor(ac.signal, msg.now ?? Date.now());
      const p = msg.params ?? {};
      let data;
      if (msg.method === "test") data = typeof plugin.test === "function" ? await plugin.test(ctx) : { ok: true };
      else if (!implemented.includes(msg.method)) throw makeError("UNSUPPORTED", `${msg.method} is not implemented`);
      else if (msg.method === "quotes") data = await plugin.quotes(p.symbols, ctx);
      else if (msg.method === "history") data = await plugin.history(p, ctx);
      else if (msg.method === "expiries") data = await plugin.expiries(p.underlying, ctx);
      else data = await plugin.optionChain(p.underlying, p.expiry, ctx);
      if (ac.signal.aborted) write({ type: "error", id: msg.id, code: "CANCELLED", message: "cancelled" });
      else write({ type: "result", id: msg.id, data });
    } catch (err) {
      if (ac.signal.aborted) return write({ type: "error", id: msg.id, code: "CANCELLED", message: "cancelled" });
      const code = PLUGIN_CODES.has(err?.code) ? err.code : "INTERNAL";
      write({ type: "error", id: msg.id, code, message: String(err?.message ?? err).slice(0, 400), ...(Number.isInteger(err?.retryAfterMs) && err.retryAfterMs >= 0 ? { retryAfterMs: Math.min(err.retryAfterMs, 3_600_000) } : {}) });
    } finally {
      calls.delete(msg.id);
    }
  };

  const onMessage = (msg) => {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "hello":
        if (msg.apiVersion !== API_VERSION) die(`host speaks apiVersion ${msg.apiVersion}, this plugin runtime speaks ${API_VERSION}`, 4);
        break;
      case "init":
        settings = { config: msg.config && typeof msg.config === "object" ? msg.config : {}, secrets: msg.secrets && typeof msg.secrets === "object" ? msg.secrets : {} };
        inited = true;
        break;
      case "call":
        void run(msg);
        break;
      case "cancel":
        calls.get(msg.id)?.abort();
        break;
      case "ping":
        write({ type: "pong", id: msg.id });
        break;
      case "fetchResult": {
        const p = pendingFetches.get(msg.id);
        if (!p) break;
        pendingFetches.delete(msg.id);
        if (msg.ok) p.resolve({ status: msg.status, headers: msg.headers ?? {}, body: String(msg.body ?? "") });
        else p.reject(makeError(FETCH_CODE_MAP[msg.code] ?? "INTERNAL", msg.message ?? msg.code, msg.retryAfterMs));
        break;
      }
      case "shutdown":
        process.exit(0);
        break;
      default:
        break;
    }
  };

  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        /* the host is trusted; ignore a garbled line */
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));

  write({ type: "ready", apiVersion: API_VERSION, capabilities: implemented });
}
