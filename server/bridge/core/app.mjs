/**
 * The Bridge application: builds core deps and contract services, lets every module register its routes, and
 * runs the request pipeline on node:http (one port for REST, SSE, WebSocket upgrades, spreadsheet routes, webhooks and MCP).
 *
 * Pipeline for every HTTP request (in this order; a failure at any step becomes problem+json):
 *   1. request id (X-Request-Id if sane, else new) and baseline security headers
 *   2. Host allowlist (DNS rebinding) and Origin allowlist (CORS); OPTIONS preflight answered here
 *   3. route match (404 / 405 + Allow); on the public-ingress listener only routes marked `public` exist
 *   4. loopbackOnly routes refuse non-loopback peers
 *   5. auth: "key" routes need a valid API key (Authorization: Bearer, X-API-Key, or ?key= where allowed and only
 *      for read-only keys created with allowQuery), then the route's scope; then the per-key client rate limit
 *   6. body: size-capped read, JSON (or text for webhooks), raw bytes kept for signature checks
 *   7. handler -> value (200 JSON) | Reply | nothing (204) | handler wrote the response itself (SSE)
 *   8. access log line (method, path WITHOUT query string, status, ms, key id) — never bodies, never keys
 */
import http from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrokerRegistry } from "../../brokers/registry.mjs";
import { CONTRACT_VERSION } from "../../brokers/contract.mjs";
import { SERVICE_CONTRACTS, isStub } from "./contracts.mjs";
import { createHttpContext, expandScopes, newRequestId } from "./context.mjs";
import { BridgeError, problemHeaders, toProblem } from "./errors.mjs";
import { createEventBus } from "./eventBus.mjs";
import { Reply, noContent, parseBody, readBody, send, sendProblem, text } from "./http.mjs";
import { createLogger } from "./logger.mjs";
import { applyModuleConfig, buildServices, validateModules } from "./modules.mjs";
import { createRouter } from "./router.mjs";
import { BASE_HEADERS, assertTransportAllowed, createCors, createHostCheck, isLocalRequest } from "./security.mjs";
import { DEMO_HEADER, DEMO_MARKET_ACCOUNT, DEMO_NOTICE, createDemoRegistry, labelDemoResult } from "../demo/demoMode.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const BRIDGE_VERSION = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).version;
export const API_VERSION = "v1";
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

/** Pull the raw API key from a request. Returns { key, viaQuery } or null. */
export function extractApiKey(req, url, { allowQuery = false } = {}) {
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (m) return { key: m[1], viaQuery: false };
  }
  const x = req.headers["x-api-key"];
  if (typeof x === "string" && x.trim()) return { key: x.trim(), viaQuery: false };
  if (allowQuery) {
    const q = url.searchParams.get("key");
    if (q) return { key: q, viaQuery: true };
  }
  return null;
}

/**
 * The path written to logs before (or without) a route match. Anything under /hooks/ is reduced to its pattern
 * because the last segment is a secret URL token; unmatched paths on the public listener are not logged at all.
 */
export function safeLogPath(pathname, isPublic = false) {
  const p = String(pathname ?? "");
  if (/^\/+hooks(\/|$)/i.test(p)) return "/hooks/:source/:token";
  if (isPublic) return "(unmatched)";
  return p.length > 200 ? `${p.slice(0, 200)}...` : p;
}

/**
 * @param {{ config: any, modules?: any[], overrides?: Record<string, object>, logger?: any, clock?: { now(): number },
 *   brokers?: any, warnings?: string[] }} opts
 */
export async function createApp({ config: baseConfig, modules, overrides = {}, logger, clock, brokers, warnings = [] }) {
  const mods = modules ?? (await import("./builtinModules.mjs")).BUILTIN_MODULES;
  validateModules(mods);
  const config = applyModuleConfig(baseConfig, mods);
  const log = logger ?? createLogger({ level: config.logging.level });
  const bus = createEventBus({ logger: log });
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const coreDeps = {
    config,
    logger: log,
    bus,
    clock: clock ?? { now: () => Date.now() },
    paths: Object.freeze({ root: ROOT, dataDir: config.dataDir }),
    // Demo mode loads ONLY the demo adapter, so no request can reach a real broker.
    brokers: brokers ?? (config.demo ? createDemoRegistry() : createBrokerRegistry()),
  };
  const deps = await buildServices(coreDeps, mods, overrides);
  if (config.demo && !isStub(deps.accounts)) {
    // The demo account needs no login: connect it now (memory-only secret store, no network).
    try {
      await deps.accounts.connect(DEMO_MARKET_ACCOUNT, { values: { demoToken: "demo" } });
    } catch (err) {
      log.warn("demo account could not be connected", { err });
    }
  }
  /** The last requests (method, path without query, status, ms, key id) for the dashboard's request log. Memory only. */
  const recentRequests = [];
  const RECENT_MAX = 200;
  const router = createRouter();
  /** @type {Map<string, { handler: Function, module: string, options: object }>} */
  const upgrades = new Map();
  const startedAt = Date.now();

  const facadeFor = (moduleName) => {
    const route = (method, pattern, handler, options) => router.add(method, pattern, handler, options, moduleName);
    return Object.freeze({
      route,
      get: (p, h, o) => route("GET", p, h, o),
      post: (p, h, o) => route("POST", p, h, o),
      put: (p, h, o) => route("PUT", p, h, o),
      patch: (p, h, o) => route("PATCH", p, h, o),
      delete: (p, h, o) => route("DELETE", p, h, o),
      /**
       * Register a WebSocket upgrade path. handler({ req, socket, head, url, requestId, log, viaPublicIngress })
       * must authenticate itself (stream token or Authorization header) and either complete the upgrade or call reject.
       */
      upgrade(path, handler, options = {}) {
        if (upgrades.has(path)) throw new Error(`Upgrade path already registered: ${path}`);
        upgrades.set(path, { handler, module: moduleName, options });
      },
      config,
      logger: log.child({ module: moduleName }),
      routes: () => router.list(),
    });
  };

  // ── Core routes ──
  const core = facadeFor("core");
  core.get(
    "/v1/health",
    (ctx) => {
      const basic = { status: "ok", version: BRIDGE_VERSION, apiVersion: API_VERSION, ...(config.demo ? { demo: true, dataNotice: DEMO_NOTICE } : {}) };
      if (!ctx.loopback) return basic;
      const services = {};
      for (const name of Object.keys(SERVICE_CONTRACTS)) services[name] = isStub(deps[name]) ? "not_built" : "ready";
      return { ...basic, startedAt: new Date(startedAt).toISOString(), uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), services };
    },
    { auth: "none", summary: "Liveness; detail only for loopback callers" },
  );
  core.get(
    "/v1/meta",
    (ctx) => ({
      bridgeVersion: BRIDGE_VERSION,
      // The install folder, for this computer only: the dashboard fills it into the MCP (stdio) snippets.
      ...(ctx.loopback ? { installDir: ROOT } : {}),
      apiVersion: API_VERSION,
      brokerContractVersion: CONTRACT_VERSION,
      brokers: coreDeps.brokers.list(),
      modules: mods.map((m) => ({ name: m.name, stream: m.stream })),
      routes: router.list().map((r) => ({ method: r.method, path: r.pattern, scope: r.options.scope ?? null, auth: r.options.auth ?? "key" })),
    }),
    { scope: "read", summary: "Versions, brokers, modules and routes" },
  );
  core.get(
    "/v1/requests",
    (ctx) => {
      const limit = Math.min(200, Math.max(1, Number.parseInt(ctx.query.get("limit") ?? "100", 10) || 100));
      return { data: recentRequests.slice(-limit).reverse(), meta: { requestId: ctx.requestId, kept: RECENT_MAX } };
    },
    { scope: "admin", loopbackOnly: true, summary: "Recent requests to this Bridge (memory only, newest first)" },
  );
  // ── Local dashboard (static files, this computer only; the page asks for an API key and keeps it in the tab) ──
  const DASHBOARD_FILES = Object.freeze({
    "index.html": "text/html; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
    "views.js": "text/javascript; charset=utf-8",
    "snippets.js": "text/javascript; charset=utf-8",
    "motion.js": "text/javascript; charset=utf-8",
    "palette.js": "text/javascript; charset=utf-8",
    "motion.min.js": "text/javascript; charset=utf-8",
    "palette.css": "text/css; charset=utf-8",
    "app.css": "text/css; charset=utf-8",
    "logo.svg": "image/svg+xml",
  });
  const DASHBOARD_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  const dashboardFile = (name) => {
    // Object.hasOwn: inherited names such as "constructor" or "__proto__" must not pass the allowlist.
    const type = Object.hasOwn(DASHBOARD_FILES, name) ? DASHBOARD_FILES[name] : undefined;
    if (!type) throw new BridgeError("NOT_FOUND", `No dashboard file ${name}.`);
    return new Reply(200, readFileSync(resolve(ROOT, "server/bridge/dashboard", name), "utf8"), { "Content-Type": type, "Content-Security-Policy": DASHBOARD_CSP });
  };
  // server.remoteDashboard (demo mode only, enforced by config.mjs) serves the pages to other computers as well.
  const dashboardLocalOnly = !(config.demo && config.server.remoteDashboard);
  core.get("/", () => new Reply(302, "", { Location: "/dashboard" }), { auth: "none", loopbackOnly: dashboardLocalOnly, summary: "Redirect to the local dashboard" });
  core.get("/dashboard", () => dashboardFile("index.html"), { auth: "none", loopbackOnly: dashboardLocalOnly, summary: "Local dashboard" });
  core.get("/dashboard/:file", (ctx) => dashboardFile(ctx.params.file), { auth: "none", loopbackOnly: dashboardLocalOnly, summary: "Dashboard assets" });
  core.get(
    "/openapi.yaml",
    () => text(readFileSync(resolve(ROOT, "docs/openapi.yaml"), "utf8"), { headers: { "Content-Type": "application/yaml; charset=utf-8" } }),
    { auth: "none", summary: "This API's OpenAPI 3.1 description" },
  );

  for (const m of mods) if (m.register) await m.register(facadeFor(m.name), deps);

  // ── Request pipeline ──
  const cors = createCors(config.cors);
  const handle = async (req, res, listener) => {
    const supplied = req.headers["x-request-id"];
    const requestId = typeof supplied === "string" && REQUEST_ID_RE.test(supplied) ? supplied : newRequestId();
    const headers = { ...BASE_HEADERS, "X-Request-Id": requestId };
    if (config.demo) {
      headers[DEMO_HEADER] = "demo";
      res.setHeader(DEMO_HEADER, "demo"); // also on responses a handler writes itself (SSE)
    }
    const t0 = Date.now();
    let ctx = null;
    let status = 500;
    let path = "";
    /** @type {any} */
    let matched = null;
    try {
      let url;
      try {
        url = new URL(req.url ?? "/", "http://bridge.local");
      } catch {
        throw new BridgeError("VALIDATION_FAILED", "Malformed request URL.");
      }
      // Until a route matches we log a redacted path: webhook URLs carry their token in the path, and a GET or a
      // miss on /hooks/... fails before the route's pattern is known.
      path = safeLogPath(url.pathname, listener.public);
      assertTransportAllowed(req, { hostCheck: listener.hostCheck, cors });
      const origin = req.headers.origin;
      if (origin !== undefined) Object.assign(headers, cors.headersFor(origin));
      if (req.method === "OPTIONS") {
        status = 204;
        send(res, noContent(), headers);
        return;
      }
      const m = router.match(req.method ?? "GET", url.pathname);
      if (!m.route || (listener.public && !m.route.options.public)) {
        if (m.route === null && m.allowed.length && !listener.public) {
          throw new BridgeError("METHOD_NOT_ALLOWED", undefined, { headers: { Allow: m.allowed.join(", ") } });
        }
        throw new BridgeError("NOT_FOUND", `No route for ${url.pathname}.`);
      }
      const { route, params } = m;
      matched = route;
      const opts = route.options;
      // Routes with their own auth may carry secrets in the path (webhook URL tokens): log the pattern instead.
      path = opts.auth === "custom" ? route.pattern : url.pathname;
      ctx = createHttpContext({ req, res, url, params, log, viaPublicIngress: listener.public, requestId });
      // "This computer" means: loopback peer, loopback Host name, no proxy headers, and not the public listener.
      // A local tunnel (cloudflared/ngrok) connects from 127.0.0.1, so the peer address alone proves nothing.
      ctx.loopback = !listener.public && isLocalRequest(req, { localPeers: config.server.localPeers });
      if (opts.loopbackOnly && !ctx.loopback) throw new BridgeError("LOOPBACK_ONLY");

      const authMode = opts.auth ?? "key";
      if (authMode === "key") {
        const found = extractApiKey(req, url, { allowQuery: opts.allowQueryKey === true });
        if (!found) throw new BridgeError("UNAUTHENTICATED", "Send your Bridge API key as 'Authorization: Bearer <key>'.");
        const record = await deps.keyStore.authenticate(found.key, { ip: ctx.clientIp });
        if (!record) throw new BridgeError("UNAUTHENTICATED", "This API key is not valid, has expired or was revoked.");
        if (found.viaQuery && (!record.allowQuery || record.scopes.some((s) => s !== "read"))) {
          throw new BridgeError("UNAUTHENTICATED", "Only read-only keys created for URL use may be sent as ?key=.");
        }
        ctx.key = record;
        ctx.scopes = expandScopes(record.scopes);
        ctx.principal = { kind: "key", id: record.id, label: record.label };
        ctx.log = ctx.log.child({ keyId: record.id });
        if (opts.scope) ctx.requireScope(opts.scope);
        if (!isStub(deps.scheduler)) {
          const verdict = deps.scheduler.checkClient(ctx);
          Object.assign(ctx.responseHeaders, verdict.headers ?? {});
          if (!verdict.ok) throw new BridgeError("RATE_LIMITED", undefined, { retryAfterMs: verdict.retryAfterMs });
        }
      } else if (opts.scope && authMode === "none") {
        throw new BridgeError("INTERNAL", "Route misconfigured: scope without auth.");
      }

      const method = String(req.method).toUpperCase();
      const bodyMode = opts.body ?? (method === "GET" || method === "HEAD" ? "none" : "json");
      if (method !== "GET" && method !== "HEAD") {
        const raw = await readBody(req, opts.bodyLimitBytes ?? config.server.bodyLimitBytes);
        if (bodyMode === "none" && raw.length > 0) throw new BridgeError("VALIDATION_FAILED", "This route takes no request body.");
        if (bodyMode === "raw" || bodyMode === "json-or-text") ctx.rawBody = raw;
        ctx.body = parseBody(raw, req.headers["content-type"], bodyMode);
      }

      const result = await route.handler(ctx);
      if (res.headersSent || res.writableEnded) {
        status = res.statusCode;
        return;
      }
      const reply = result === undefined ? noContent() : config.demo ? labelDemoResult(result) : result;
      status = reply instanceof Reply ? reply.status : 200;
      send(res, reply, { ...headers, ...ctx.responseHeaders }, { head: method === "HEAD" });
    } catch (err) {
      const problem = toProblem(err, { requestId });
      status = problem.status;
      if (!(err instanceof BridgeError)) log.error("unhandled error", { requestId, path, err });
      else if (status >= 500 && status !== 501) log.warn("request failed", { requestId, path, code: problem.code });
      if (res.headersSent) res.destroy();
      else if (typeof matched?.options?.formatError === "function") {
        // Clients that cannot read problem+json (Excel cells) get the error in their own format,
        // including failures raised before the handler ran (auth, scope, client rate limit).
        let reply = null;
        try {
          reply = matched.options.formatError(err, { requestId });
        } catch (fmtErr) {
          log.error("error formatter failed", { requestId, path, err: fmtErr });
        }
        if (reply instanceof Reply) send(res, reply, { ...headers, ...(ctx?.responseHeaders ?? {}), ...problemHeaders(err) });
        else sendProblem(res, problem, { ...headers, ...(ctx?.responseHeaders ?? {}), ...problemHeaders(err) });
      } else sendProblem(res, problem, { ...headers, ...(ctx?.responseHeaders ?? {}), ...problemHeaders(err) });
    } finally {
      const ms = Date.now() - t0;
      log.info("http", { requestId, method: req.method, path, status, ms, keyId: ctx?.key?.id, public: listener.public || undefined });
      if (!listener.public && path !== "/v1/requests" && !path.startsWith("/dashboard")) {
        const client = req.headers["x-mcb-client"] === "dashboard" ? "dashboard" : null;
        recentRequests.push({ at: new Date().toISOString(), method: req.method, path, status, ms, keyId: ctx?.key?.id ?? null, client, requestId });
        if (recentRequests.length > RECENT_MAX) recentRequests.splice(0, recentRequests.length - RECENT_MAX);
      }
    }
  };

  const handleUpgrade = async (req, socket, head, listener) => {
    const requestId = newRequestId();
    const reject = (statusLine) => {
      try {
        socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      } finally {
        socket.destroy();
      }
    };
    try {
      const url = new URL(req.url ?? "/", "http://bridge.local");
      try {
        assertTransportAllowed(req, { hostCheck: listener.hostCheck, cors });
      } catch {
        return reject("403 Forbidden");
      }
      const entry = upgrades.get(url.pathname);
      if (!entry || (listener.public && !entry.options.public)) return reject("404 Not Found");
      await entry.handler({ req, socket, head, url, requestId, log: log.child({ requestId, module: entry.module }), viaPublicIngress: listener.public, reject });
    } catch (err) {
      log.error("upgrade failed", { requestId, err });
      if (!socket.destroyed) reject("500 Internal Server Error");
    }
  };

  const makeServer = (listener) => {
    const server = http.createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, (req, res) => {
      handle(req, res, listener);
    });
    server.on("upgrade", (req, socket, head) => {
      handleUpgrade(req, socket, head, listener);
    });
    server.on("clientError", (_err, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
    return server;
  };

  const servers = [];
  let started = false;

  return {
    deps,
    config,
    router,
    warnings,
    /** Bind the listeners and start modules. Resolves with the bound ports. */
    async listen() {
      if (started) throw new Error("already listening");
      started = true;
      const bind = (host, port, listener) =>
        new Promise((resolveBind, rejectBind) => {
          const server = makeServer(listener);
          server.once("error", rejectBind);
          server.listen(port, host, () => {
            server.off("error", rejectBind);
            listener.boundPort = server.address().port;
            servers.push(server);
            resolveBind(server.address().port);
          });
        });
      const mainListener = { public: false, hostCheck: null };
      const s = config.server;
      // Host check needs the real port (port 0 = ephemeral in tests), so build it after binding.
      mainListener.hostCheck = (h) => createHostCheck({ port: mainListener.boundPort ?? s.port, allowedHosts: s.allowedHosts })(h);
      const port = await bind(s.host, s.port, mainListener);
      let publicPort = null;
      if (s.publicIngress.enabled) {
        const pub = { public: true, hostCheck: null };
        pub.hostCheck = (h) => createHostCheck({ port: pub.boundPort ?? s.publicIngress.port, allowedHosts: s.publicIngress.allowedHosts })(h);
        publicPort = await bind(s.publicIngress.host, s.publicIngress.port, pub);
      }
      for (const m of mods) if (m.start) await m.start(deps);
      for (const w of warnings) log.warn(w);
      log.info("bridge listening", { host: s.host, port, publicPort, version: BRIDGE_VERSION });
      return { port, publicPort };
    },
    /** Stop modules (reverse order) and close listeners. */
    async close() {
      for (const m of [...mods].reverse()) {
        if (!m.stop) continue;
        try {
          await m.stop(deps);
        } catch (err) {
          log.error("module stop failed", { module: m.name, err });
        }
      }
      await Promise.all(
        servers.splice(0).map(
          (srv) =>
            new Promise((r) => {
              srv.close(() => r());
              srv.closeAllConnections?.();
            }),
        ),
      );
    },
  };
}
