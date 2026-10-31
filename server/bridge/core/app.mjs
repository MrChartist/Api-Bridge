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
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrokerRegistry } from "../../brokers/registry.mjs";
import { CONTRACT_VERSION } from "../../brokers/contract.mjs";
import { cliCommand } from "./cliName.mjs";
import { withAddableAccounts } from "./config.mjs";
import { SERVICE_CONTRACTS, isStub } from "./contracts.mjs";
import { createHttpContext, expandScopes, newRequestId } from "./context.mjs";
import { BridgeError, problemHeaders, toProblem } from "./errors.mjs";
import { createEventBus } from "./eventBus.mjs";
import { armStartup, openStartup, startupStatus } from "./startup.mjs";
import { isControlToken, removeControlToken, writeControlToken } from "./controlToken.mjs";
import { Reply, noContent, parseBody, readBody, send, sendProblem, text } from "./http.mjs";
import { createLogger } from "./logger.mjs";
import { applyModuleConfig, buildServices, validateModules } from "./modules.mjs";
import { createRouter } from "./router.mjs";
import { BASE_HEADERS, assertNotCrossSiteWrite, assertTransportAllowed, createCors, createHostCheck, isLocalRequest } from "./security.mjs";
import { registerDemoRoutes } from "../demo/routes.mjs";
import { httpConsumer, runAsConsumer } from "../ratelimit/consumer.mjs";
import { DEMO_ACCOUNT_HINT, DEMO_HEADER, DEMO_MARKET_ACCOUNT, DEMO_NOTICE, createDemoRegistry, labelDemoResult } from "../demo/demoMode.mjs";

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
 * Files the local dashboard serves (name -> Content-Type). A fixed allowlist: no request can name another path. Every
 * new dashboard page or shared module is added here (and to dashboard/format.test.mjs).
 */
export const DASHBOARD_FILES = Object.freeze({
  "index.html": "text/html; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "views.js": "text/javascript; charset=utf-8",
  "chart-lite.js": "text/javascript; charset=utf-8",
  "pulse.js": "text/javascript; charset=utf-8",
  "pulse-core.js": "text/javascript; charset=utf-8",
  "chart-lite-core.js": "text/javascript; charset=utf-8",
  "chart-specs.js": "text/javascript; charset=utf-8",
  "trigger-core.js": "text/javascript; charset=utf-8",
  "triggers.js": "text/javascript; charset=utf-8",
  "orders-core.js": "text/javascript; charset=utf-8",
  "reasons-core.js": "text/javascript; charset=utf-8",
  "statement-core.js": "text/javascript; charset=utf-8",
  "statement.js": "text/javascript; charset=utf-8",
  "orders-book.js": "text/javascript; charset=utf-8",
  "snippets.js": "text/javascript; charset=utf-8",
  "flows.js": "text/javascript; charset=utf-8",
  "motion.js": "text/javascript; charset=utf-8",
  "palette.js": "text/javascript; charset=utf-8",
  "format.js": "text/javascript; charset=utf-8",
  "options.js": "text/javascript; charset=utf-8",
  "chain-metrics.js": "text/javascript; charset=utf-8",
  "chain-facts.js": "text/javascript; charset=utf-8",
  "events.js": "text/javascript; charset=utf-8",
  "scanner.js": "text/javascript; charset=utf-8",
  "scan-builder.js": "text/javascript; charset=utf-8",
  "scan-library.js": "text/javascript; charset=utf-8",
  "pricing.js": "text/javascript; charset=utf-8",
  "expiry-costs.js": "text/javascript; charset=utf-8",
  "span-margin.js": "text/javascript; charset=utf-8",
  "alert-core.js": "text/javascript; charset=utf-8",
  "alerts.js": "text/javascript; charset=utf-8",
  "cockpit.js": "text/javascript; charset=utf-8",
  "workbook.js": "text/javascript; charset=utf-8",
  "workbook-core.js": "text/javascript; charset=utf-8",
  "xlsx-core.js": "text/javascript; charset=utf-8",
  "today-core.js": "text/javascript; charset=utf-8",
  "trade-intent.js": "text/javascript; charset=utf-8",
  "explain.js": "text/javascript; charset=utf-8",
  "explain-core.js": "text/javascript; charset=utf-8",
  "watchlists.js": "text/javascript; charset=utf-8",
  "watchlist-core.js": "text/javascript; charset=utf-8",
  "expiry-core.js": "text/javascript; charset=utf-8",
  "journal.js": "text/javascript; charset=utf-8",
  "journal-core.js": "text/javascript; charset=utf-8",
  "roll-core.js": "text/javascript; charset=utf-8",
  "basket-core.js": "text/javascript; charset=utf-8",
  "whatif.js": "text/javascript; charset=utf-8",
  "whatif-core.js": "text/javascript; charset=utf-8",
  "reference.js": "text/javascript; charset=utf-8",
  "vol-context.js": "text/javascript; charset=utf-8",
  "calendar.js": "text/javascript; charset=utf-8",
  "readiness.js": "text/javascript; charset=utf-8",
  "recorder.js": "text/javascript; charset=utf-8",
  "algo.js": "text/javascript; charset=utf-8",
  "algo-core.js": "text/javascript; charset=utf-8",
  "desk.js": "text/javascript; charset=utf-8",
  "symbol-search.js": "text/javascript; charset=utf-8",
  "arbitrage.js": "text/javascript; charset=utf-8",
  "screener.js": "text/javascript; charset=utf-8",
  "screens.js": "text/javascript; charset=utf-8",
  "participants.js": "text/javascript; charset=utf-8",
  "chain-sheet.js": "text/javascript; charset=utf-8",
  "oi.js": "text/javascript; charset=utf-8",
  "positions.js": "text/javascript; charset=utf-8",
  "book-core.js": "text/javascript; charset=utf-8",
  "book-view.js": "text/javascript; charset=utf-8",
  "vol.js": "text/javascript; charset=utf-8",
  "vol-curves.js": "text/javascript; charset=utf-8",
  "oi-store.js": "text/javascript; charset=utf-8",
  "oi-series.js": "text/javascript; charset=utf-8",
  "strategy.js": "text/javascript; charset=utf-8",
  "strategy-place.js": "text/javascript; charset=utf-8",
  "payoff.js": "text/javascript; charset=utf-8",
  "viz.js": "text/javascript; charset=utf-8",
  "layout-prefs.js": "text/javascript; charset=utf-8",
  "live.js": "text/javascript; charset=utf-8",
  "analytics.js": "text/javascript; charset=utf-8",
  "analyticsViews.js": "text/javascript; charset=utf-8",
  "analyticsMore.js": "text/javascript; charset=utf-8",
  "analyticsFlow.js": "text/javascript; charset=utf-8",
  "analyticsRisk.js": "text/javascript; charset=utf-8",
  "analyticsTime.js": "text/javascript; charset=utf-8",
  "analyticsDepth.js": "text/javascript; charset=utf-8",
  "workspace.js": "text/javascript; charset=utf-8",
  "chrome.js": "text/javascript; charset=utf-8",
  "terminal.js": "text/javascript; charset=utf-8",
  "export.js": "text/javascript; charset=utf-8",
  "help.js": "text/javascript; charset=utf-8",
  "budget.js": "text/javascript; charset=utf-8",
  "motion.min.js": "text/javascript; charset=utf-8",
  "palette.css": "text/css; charset=utf-8",
  "app.css": "text/css; charset=utf-8",
  "logo.svg": "image/svg+xml",
});

/**
 * @param {{ config: any, modules?: any[], overrides?: Record<string, object>, logger?: any, clock?: { now(): number },
 *   brokers?: any, warnings?: string[], configFile?: string | null, demoRoutes?: readonly import("../demo/routes.mjs").DemoRoute[] }} opts
 *   configFile: where accounts added from the dashboard are saved (config.mjs configFileForWrites). Without it the
 *   Bridge cannot add or remove accounts at run time.
 *   demoRoutes: replaces demo/routes.mjs DEMO_ROUTES (tests only); registered only when config.demo is true.
 */
export async function createApp({ config: baseConfig, modules, overrides = {}, logger, clock, brokers, warnings = [], configFile = null, demoRoutes }) {
  const mods = modules ?? (await import("./builtinModules.mjs")).BUILTIN_MODULES;
  validateModules(mods);
  const config = withAddableAccounts(applyModuleConfig(baseConfig, mods));
  const log = logger ?? createLogger({ level: config.logging.level });
  const bus = createEventBus({ logger: log });
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const coreDeps = {
    config,
    logger: log,
    bus,
    clock: clock ?? { now: () => Date.now() },
    paths: Object.freeze({ root: ROOT, dataDir: config.dataDir, configFile: typeof configFile === "string" && configFile ? configFile : null }),
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
      // While the Bridge starts, the reads it holds (positions, funds, orders, trades, the book) and how far the jobs
      // they wait for have got: a page shows that progress instead of a silent wait (core/startup.mjs).
      const starting = startupStatus(deps);
      const basic = { status: "ok", version: BRIDGE_VERSION, apiVersion: API_VERSION, ...(config.demo ? { demo: true, dataNotice: DEMO_NOTICE } : {}), ...(starting ? { startup: starting } : {}) };
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
      // For this computer only: the install folder (the dashboard fills it into the MCP (stdio) snippets) and how to run
      // a Bridge command here (the dashboard's "Prefer the terminal?" hints).
      ...(ctx.loopback ? { installDir: ROOT, cliCommand: cliCommand() } : {}),
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
  // DASHBOARD_FILES (module scope, above) lists what may be served.
  const DASHBOARD_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  // Broker logos (dashboard/brokers/<id>.png, see its README), served as /dashboard/broker-<id>.png. Only ids with a
  // file present when the Bridge starts can be asked for, so no request can name another path.
  const BROKER_LOGOS = new Set(
    (() => {
      try {
        return readdirSync(resolve(ROOT, "server/bridge/dashboard/brokers")).filter((f) => /^[a-z0-9]{2,32}\.png$/.test(f)).map((f) => f.slice(0, -4));
      } catch {
        return [];
      }
    })(),
  );
  // The dashboard's self-hosted Chartist typefaces (dashboard/fonts/, SIL Open Font Licence files beside them), served as
  // /dashboard/font-<file>.woff2. A fixed list, so no request can name another path.
  const DASHBOARD_FONTS = Object.freeze({
    "font-chartist-sans-flex.woff2": "chartist-sans-flex.woff2",
    "font-chartist-sans-flex-symbols.woff2": "chartist-sans-flex-symbols.woff2",
    "font-chartist-sans.woff2": "chartist-sans.woff2",
    "font-chartist-serif-italic.woff2": "chartist-serif-italic.woff2",
  });
  const dashboardFile = (name) => {
    if (Object.hasOwn(DASHBOARD_FONTS, name)) {
      return new Reply(200, readFileSync(resolve(ROOT, "server/bridge/dashboard/fonts", DASHBOARD_FONTS[name])), { "Content-Type": "font/woff2", "Cache-Control": "public, max-age=604800", "Content-Security-Policy": DASHBOARD_CSP });
    }
    const logo = /^broker-([a-z0-9]{2,32})\.png$/.exec(name);
    if (logo && BROKER_LOGOS.has(logo[1])) {
      return new Reply(200, readFileSync(resolve(ROOT, "server/bridge/dashboard/brokers", `${logo[1]}.png`)), { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400", "Content-Security-Policy": DASHBOARD_CSP });
    }
    // Object.hasOwn: inherited names such as "constructor" or "__proto__" must not pass the allowlist.
    const type = Object.hasOwn(DASHBOARD_FILES, name) ? DASHBOARD_FILES[name] : undefined;
    if (!type) throw new BridgeError("NOT_FOUND", `No dashboard file ${name}.`);
    const file = dashboardSource(name);
    // ETag + no-cache: the browser keeps every file and asks "still this one?" (a 304 with no body) instead of
    // downloading the whole dashboard on each load. A file edited on disk gets a new ETag at once.
    const cacheHeaders = { "Content-Type": type, "Content-Security-Policy": DASHBOARD_CSP, "Cache-Control": "no-cache", ETag: file.etag };
    if (ifNoneMatch(ifNoneMatchHeader, file.etag)) return new Reply(304, "", cacheHeaders);
    return new Reply(200, file.body, cacheHeaders);
  };
  /** name -> { mtimeMs, size, body, etag }: each dashboard file read once and re-read when it changes on disk. */
  const dashboardMemo = new Map();
  function dashboardSource(name) {
    const path = resolve(ROOT, "server/bridge/dashboard", name);
    const st = statSync(path);
    const hit = dashboardMemo.get(name);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
    const body = readFileSync(path, "utf8");
    const entry = { mtimeMs: st.mtimeMs, size: st.size, body, etag: `"${createHash("sha1").update(body).digest("base64url").slice(0, 22)}"` };
    dashboardMemo.set(name, entry);
    return entry;
  }
  /** The If-None-Match of the request being answered (set per dashboard request below). */
  let ifNoneMatchHeader = null;
  const ifNoneMatch = (header, etag) => typeof header === "string" && header.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
  const dashboardReply = (ctx, name) => {
    ifNoneMatchHeader = ctx.req?.headers?.["if-none-match"] ?? null;
    try {
      return dashboardFile(name);
    } finally {
      ifNoneMatchHeader = null;
    }
  };
  // server.remoteDashboard (demo mode only, enforced by config.mjs) serves the pages to other computers as well.
  const dashboardLocalOnly = !(config.demo && config.server.remoteDashboard);
  core.get("/", () => new Reply(302, "", { Location: "/dashboard" }), { auth: "none", loopbackOnly: dashboardLocalOnly, summary: "Redirect to the local dashboard" });
  core.get("/dashboard", (ctx) => dashboardReply(ctx, "index.html"), { auth: "none", loopbackOnly: dashboardLocalOnly, summary: "Local dashboard" });
  core.get("/dashboard/:file", (ctx) => dashboardReply(ctx, ctx.params.file), { auth: "none", loopbackOnly: dashboardLocalOnly, summary: "Dashboard assets" });
  core.get(
    "/openapi.yaml",
    () => text(readFileSync(resolve(ROOT, "docs/openapi.yaml"), "utf8"), { headers: { "Content-Type": "application/yaml; charset=utf-8" } }),
    { auth: "none", summary: "This API's OpenAPI 3.1 description" },
  );

  for (const m of mods) if (m.register) await m.register(facadeFor(m.name), deps);
  // Demo-only controls (demo/routes.mjs): registered only in demo mode, each under its owning module.
  registerDemoRoutes({ config, facadeFor, deps, modules: mods, ...(demoRoutes ? { routes: demoRoutes } : {}) });

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
      assertNotCrossSiteWrite(req, cors);
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
        // `mc-bridge kill` on this computer: the control token in the data folder acts as the local CLI (controlToken.mjs).
        const control = opts.localControl === true && ctx.loopback && !found.viaQuery && isControlToken(controlToken, found.key);
        if (control) {
          ctx.scopes = expandScopes(["admin"]);
          ctx.principal = { kind: "local", id: "cli" };
          ctx.log = ctx.log.child({ principal: "cli" });
        } else {
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

      // Every broker call this request causes is credited to its consumer (API › Rate limits, Top consumers).
      const consumer = httpConsumer({ headers: req.headers, path: url.pathname, principal: ctx.principal });
      const result = await runAsConsumer(consumer, () => route.handler(ctx));
      if (res.headersSent || res.writableEnded) {
        status = res.statusCode;
        return;
      }
      const reply = result === undefined ? noContent() : config.demo ? labelDemoResult(result) : result;
      status = reply instanceof Reply ? reply.status : 200;
      send(res, reply, { ...headers, ...ctx.responseHeaders }, { head: method === "HEAD" });
    } catch (err) {
      const problem = toProblem(err, { requestId });
      if (config.demo && problem.code === "ACCOUNT_NOT_FOUND") problem.detail = `${problem.detail ?? ""} ${DEMO_ACCOUNT_HINT}`.trim();
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
  /** Written while listening; see controlToken.mjs. */
  let controlToken = null;

  return {
    deps,
    config,
    router,
    warnings,
    /** Registered WebSocket upgrade paths (security tests check every one). */
    upgradePaths: () => [...upgrades.keys()],
    /** Bind the listeners and start modules. Resolves with the bound ports. */
    async listen() {
      if (started) throw new Error("already listening");
      started = true;
      // Reads gated on startup jobs (the demo book seed) wait from the first request until the jobs are done.
      armStartup(deps);
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
      // Not awaited: the Bridge answers at once; only the gated reads wait for the startup jobs.
      openStartup(deps).catch(() => {});
      try {
        controlToken = writeControlToken(config.dataDir);
      } catch (err) {
        log.warn("could not write the local control token; mc-bridge kill will need --key", { err });
      }
      for (const w of warnings) log.warn(w);
      log.info("bridge listening", { host: s.host, port, publicPort, version: BRIDGE_VERSION });
      return { port, publicPort };
    },
    /** Stop modules (reverse order) and close listeners. */
    async close() {
      if (controlToken) removeControlToken(config.dataDir, controlToken);
      controlToken = null;
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
