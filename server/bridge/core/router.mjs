/**
 * A tiny router on node:http. No dependency: the Bridge needs exact paths, `:param` segments, a trailing `*`
 * wildcard, 404 vs 405 with an Allow header, and per-route options the request pipeline reads (auth, scope,
 * public ingress, body handling). That is ~100 lines; a framework would add surface without adding safety.
 *
 * Patterns: "/v1/orders", "/v1/orders/:orderId", "/udf/*". Params are URI-decoded; a param never contains "/".
 * Static segments win over params at the same depth, regardless of registration order.
 */

export const METHODS = Object.freeze(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * @typedef {{
 *   auth?: "key" | "none" | "custom",      // "custom": the handler authenticates (hook tokens, stream tokens)
 *   scope?: "read" | "paper" | "live" | "admin",
 *   allowQueryKey?: boolean,               // accept ?key= (read scope only; Excel WEBSERVICE / Sheets)
 *   public?: boolean,                      // also served on the opt-in public ingress listener
 *   loopbackOnly?: boolean,                // refuse unless the TCP peer is loopback (credential and admin actions)
 *   body?: "json" | "json-or-text" | "raw" | "none",
 *   bodyLimitBytes?: number,
 *   summary?: string,
 *   formatError?: (err: unknown, info: { requestId: string }) => import("./http.mjs").Reply,
 *                                          // error body for clients that cannot read problem+json (UDF, Excel);
 *                                          // used for every failure on the route, including auth and rate limit
 * }} RouteOptions
 * @typedef {(ctx: import("./context.mjs").RequestContext) => unknown | Promise<unknown>} Handler
 * @typedef {{ method: string, pattern: string, handler: Handler, options: RouteOptions, module?: string }} Route
 */

const segmentsOf = (path) => path.split("/").filter(Boolean);

function compile(pattern) {
  if (typeof pattern !== "string" || !pattern.startsWith("/")) throw new Error(`Route pattern must start with "/": ${pattern}`);
  const segs = segmentsOf(pattern);
  const wildcard = segs.at(-1) === "*";
  if (segs.slice(0, -1).includes("*")) throw new Error(`"*" is only allowed as the last segment: ${pattern}`);
  const parts = (wildcard ? segs.slice(0, -1) : segs).map((s) => (s.startsWith(":") ? { param: s.slice(1) } : { literal: s }));
  for (const p of parts) if (p.param !== undefined && !/^[A-Za-z][A-Za-z0-9_]*$/.test(p.param)) throw new Error(`Bad param name in ${pattern}`);
  // Score for specificity: literals beat params beat wildcards.
  const score = parts.reduce((s, p) => s * 3 + (p.literal !== undefined ? 2 : 1), 1) * (wildcard ? 1 : 3) + parts.length * 1e6;
  return { parts, wildcard, score };
}

function matchCompiled(c, segs) {
  if (c.wildcard ? segs.length < c.parts.length : segs.length !== c.parts.length) return null;
  const params = {};
  for (let i = 0; i < c.parts.length; i += 1) {
    const p = c.parts[i];
    if (p.literal !== undefined) {
      if (p.literal !== segs[i]) return null;
    } else {
      let v;
      try {
        v = decodeURIComponent(segs[i]);
      } catch {
        return null;
      }
      if (v.includes("/")) return null;
      params[p.param] = v;
    }
  }
  if (c.wildcard) params["*"] = segs.slice(c.parts.length).join("/");
  return params;
}

export function createRouter() {
  /** @type {Array<Route & { compiled: ReturnType<typeof compile> }>} */
  const routes = [];
  const add = (method, pattern, handler, options = {}, module) => {
    const m = String(method).toUpperCase();
    if (!METHODS.includes(m)) throw new Error(`Unsupported method ${method}`);
    if (typeof handler !== "function") throw new TypeError(`Handler for ${m} ${pattern} must be a function`);
    if (routes.some((r) => r.method === m && r.pattern === pattern)) throw new Error(`Route already registered: ${m} ${pattern}`);
    routes.push({ method: m, pattern, handler, options: Object.freeze({ ...options }), module, compiled: compile(pattern) });
    routes.sort((a, b) => b.compiled.score - a.compiled.score);
  };
  return {
    add,
    /**
     * @param {string} method
     * @param {string} pathname  Already stripped of the query string.
     * @returns {{ route: Route, params: Record<string, string> } | { route: null, allowed: string[] }}
     */
    match(method, pathname) {
      const m = String(method).toUpperCase() === "HEAD" ? "GET" : String(method).toUpperCase();
      const segs = segmentsOf(pathname);
      const allowed = new Set();
      for (const r of routes) {
        const params = matchCompiled(r.compiled, segs);
        if (!params) continue;
        if (r.method === m) return { route: r, params };
        allowed.add(r.method);
      }
      return { route: null, allowed: [...allowed].sort() };
    },
    /** Registered routes, for /v1/meta, docs checks and tests. */
    list() {
      return routes.map(({ method, pattern, options, module }) => ({ method, pattern, options, module }));
    },
  };
}
