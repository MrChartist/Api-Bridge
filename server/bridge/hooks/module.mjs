/**
 * hooks module — stream S11: inbound webhooks (signed generic, ChartInk, GoCharting).
 * Owned files and tasks: docs/STREAMS.md §S11. The routes below are the contract in docs/openapi.yaml.
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
  const handlers = createHookRoutes({ deps, cfg, store, worker, logger: log, now: clock });
  return { cfg, store, worker, handlers };
}

/** The runtime register() built for these deps (tests, diagnostics). */
export function hooksRuntimeFor(deps) {
  return runtimes.get(deps) ?? null;
}

export default defineModule({
  name: "hooks",
  stream: "S11",
  configKey: "hooks",
  configSchema: HOOKS_CONFIG_SCHEMA,
  register(app, deps) {
    const rt = createHooksRuntime(deps, { logger: app.logger });
    runtimes.set(deps, rt);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, rt.handlers[name], options);
  },
  async stop(deps) {
    const rt = runtimes.get(deps);
    if (!rt) return;
    await rt.worker.stop();
    rt.store.close();
  },
});
