/**
 * hooks module: inbound webhooks (signed generic, ChartInk, GoCharting).
 * The routes below are the contract in docs/openapi.yaml.
 *
 * Config section `hooks` (optional; see config.mjs): queue size, concurrency, dedupe window, signature tolerance,
 * per-hook rate, global source-IP allowlist, trusted tunnel header.
 *
 * The module owns no contract service; it keeps a small runtime (hook store, dedupe, signal worker) per app,
 * created in register() and stopped in stop().
 */
import { isStub } from "../core/contracts.mjs";
import { defineModule } from "../core/modules.mjs";
import { HOOKS_CONFIG_SCHEMA, hooksConfig } from "./config.mjs";
import { createHookStore } from "./hookStore.mjs";
import { createHookRoutes } from "./routes.mjs";
import { createSignalWorker } from "./worker.mjs";

/** [method, path, route options, handler name in createHookRoutes()] */
export const ROUTES = Object.freeze([
  ["POST", "/hooks/:source/:token", { auth: "custom", public: true, body: "json-or-text", bodyLimitBytes: 16384 }, "receiveHook"],
  ["GET", "/v1/hooks", { scope: "admin", loopbackOnly: true }, "listHooks"],
  ["POST", "/v1/hooks", { scope: "admin", loopbackOnly: true }, "createHook"],
  ["DELETE", "/v1/hooks/:hookId", { scope: "admin", loopbackOnly: true }, "deleteHook"],
]);

/** deps -> runtime, so stop() finds what register() built. */
const runtimes = new WeakMap();

/**
 * Build the hooks runtime for one app. Exported for tests and for callers that embed the receiver.
 * @param {any} deps
 * @param {{ logger?: any, now?: () => number }} [opts]
 */
export function createHooksRuntime(deps, { logger, now } = {}) {
  const cfg = hooksConfig(deps.config);
  const log = logger ?? deps.logger.child({ module: "hooks" });
  const clock = now ?? (() => deps.clock.now());
  const store = createHookStore({
    dataDir: deps.paths.dataDir,
    secrets: deps.secrets && !isStub(deps.secrets) ? deps.secrets : undefined,
    now: clock,
    maxHooks: cfg.maxHooks,
    logger: log,
  });
  const worker = createSignalWorker({ deps, store, logger: log, queueSize: cfg.queueSize, concurrency: cfg.concurrency, now: clock });
  const automations = createHookAutomations(deps, log);
  const handlers = createHookRoutes({ deps, cfg, store, worker, logger: log, now: clock, automations });
  return { cfg, store, worker, handlers, automations };
}

/**
 * Live hooks as readiness automations: each `mode: "live"` hook registers with
 * deps.readiness so it can show "cannot trade" and the reason; its orders are gated in OrderService. Paper hooks are
 * not registered (paper never needs the broker session). Without a readiness service this does nothing.
 * @returns {{ sync(hook: any): void, remove(hookId: string): void, syncAll(hooks: any[]): void, state(hook: any): string | null, clear(): void }}
 */
export function createHookAutomations(deps, log) {
  const handles = new Map();
  const readiness = (() => {
    try {
      const r = deps.readiness;
      return r && !isStub(r) && typeof r.registerAutomation === "function" ? r : null;
    } catch {
      return null;
    }
  })();
  const api = {
    sync(hook) {
      if (!readiness || !hook) return;
      const existing = handles.get(hook.id);
      if (hook.mode !== "live") {
        if (existing) api.remove(hook.id);
        return;
      }
      if (existing) {
        existing.update({ accountId: hook.account, label: hook.label, mode: "live" });
        return;
      }
      try {
        handles.set(hook.id, readiness.registerAutomation({ id: hook.id, kind: "webhook", accountId: hook.account, mode: "live", label: hook.label }));
      } catch (err) {
        log?.warn?.("live hook not registered with readiness", { hookId: hook.id, code: err?.code });
      }
    },
    remove(hookId) {
      handles.get(hookId)?.remove();
      handles.delete(hookId);
    },
    syncAll(hooks) {
      for (const h of hooks ?? []) api.sync(h);
    },
    /** The readiness state shown on a hook: its account's state for live hooks, null for paper hooks. */
    state(hook) {
      if (!readiness || hook?.mode !== "live") return null;
      try {
        return readiness.canTrade(hook.account, { mode: "live" }).state ?? null;
      } catch {
        return null;
      }
    },
    clear() {
      for (const id of [...handles.keys()]) api.remove(id);
    },
    has: (hookId) => handles.has(hookId),
  };
  return api;
}

/** The runtime register() built for these deps (tests, diagnostics). */
export function hooksRuntimeFor(deps) {
  return runtimes.get(deps) ?? null;
}

export default defineModule({
  name: "hooks",
  configKey: "hooks",
  configSchema: HOOKS_CONFIG_SCHEMA,
  register(app, deps) {
    const rt = createHooksRuntime(deps, { logger: app.logger });
    runtimes.set(deps, rt);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, rt.handlers[name], options);
  },
  async start(deps) {
    // Live hooks re-register with readiness at every boot (its registry is memory only).
    const rt = runtimes.get(deps);
    rt?.automations.syncAll(rt.store.list());
  },
  async stop(deps) {
    const rt = runtimes.get(deps);
    if (!rt) return;
    rt.automations.clear();
    await rt.worker.stop();
    rt.store.close();
  },
});
