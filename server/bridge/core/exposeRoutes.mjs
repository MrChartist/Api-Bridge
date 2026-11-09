/**
 * The Sheets listener's admission rule and request cap, and the two this-computer-only routes behind the dashboard's
 * Expose card (the logic is in expose.mjs).
 *
 *   GET  /v1/expose        what is reachable from outside, in plain words, with the doctor's exposure checks
 *   POST /v1/expose/check  the local self-check; a call to a public URL happens only when the body says so
 */
import { readHooksQuietly, runSelfCheck, exposureState, defaultTransport } from "./expose.mjs";
import { BridgeError } from "./errors.mjs";
import { isStub } from "./contracts.mjs";

/**
 * Whether the Sheets listener serves this route: only GET (or HEAD) /xl/* that needs a key with the read scope and is
 * not this-computer-only. Everything else is a 404 there, so a tunnel to that port reaches nothing else.
 * @param {string | undefined} method
 * @param {{ method: string, pattern: string, options: any } | null} route
 */
export function sheetsAdmits(method, route) {
  const m = String(method ?? "GET").toUpperCase();
  if (!route || (m !== "GET" && m !== "HEAD") || route.method !== "GET") return false;
  const o = route.options ?? {};
  return route.pattern.startsWith("/xl/") && (o.auth ?? "key") === "key" && o.scope === "read" && o.loopbackOnly !== true;
}

/**
 * A fixed-window counter per caller address (one minute). Memory is bounded: at most `maxKeys` addresses are tracked;
 * when full, the oldest window is dropped.
 * @param {{ perMinute: number, now?: () => number, maxKeys?: number }} opts
 */
export function createSheetsLimiter({ perMinute, now = () => Date.now(), maxKeys = 2000 }) {
  /** @type {Map<string, { start: number, count: number }>} */
  const windows = new Map();
  return {
    /** @returns {{ ok: true } | { ok: false, retryAfterMs: number }} */
    hit(address) {
      const key = String(address ?? "?");
      const t = now();
      let w = windows.get(key);
      if (!w || t - w.start >= 60_000) {
        if (!w && windows.size >= maxKeys) windows.delete(windows.keys().next().value);
        w = { start: t, count: 0 };
        windows.set(key, w);
      }
      w.count += 1;
      return w.count > perMinute ? { ok: false, retryAfterMs: Math.max(1, w.start + 60_000 - t) } : { ok: true };
    },
  };
}

const GUIDE = "https://github.com/MrChartist/api-bridge-v2/blob/main/docs/guides/expose-alerts.md";

/**
 * @param {{ get: Function, post: Function }} core  the core route facade
 * @param {{ config: any, configFile: string | null, deps: any }} ctx
 */
export function registerExposeRoutes(core, { config, deps }) {
  const gather = async () => {
    const hooks = readHooksQuietly(config.dataDir);
    let keys = null;
    try {
      if (deps.keyStore && !isStub(deps.keyStore)) keys = await deps.keyStore.list();
    } catch {
      keys = null;
    }
    return { hooks, keys };
  };
  core.get(
    "/v1/expose",
    async (ctx) => {
      const { hooks, keys } = await gather();
      return { data: { ...exposureState(config, { hooks, keys }), guide: GUIDE }, meta: { requestId: ctx.requestId } };
    },
    { scope: "admin", loopbackOnly: true, summary: "What is reachable from outside this computer, in plain words" },
  );
  core.post(
    "/v1/expose/check",
    async (ctx) => {
      const body = ctx.body && typeof ctx.body === "object" ? ctx.body : {};
      const publicUrl = typeof body.publicUrl === "string" && body.publicUrl ? body.publicUrl : null;
      const allowOutbound = body.allowOutbound === true;
      if (publicUrl && !allowOutbound) throw new BridgeError("VALIDATION_FAILED", "To test a public address the Bridge must call it from this computer: send allowOutbound: true to say so.", { errors: [{ path: "allowOutbound", message: "required with publicUrl" }] });
      const kinds = Array.isArray(body.kinds) ? body.kinds.filter((k) => k === "alerts" || k === "sheets") : undefined;
      const result = await runSelfCheck({ config, request: defaultTransport, kinds, publicUrl, allowOutbound });
      return { data: result, meta: { requestId: ctx.requestId } };
    },
    { scope: "admin", loopbackOnly: true, summary: "Check that only the intended routes answer on the public listeners" },
  );
}
