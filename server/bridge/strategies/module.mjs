/**
 * strategies module, stream S30: Python strategies (docs/STRATEGIES-PYTHON.md). Routes, all admin and this computer
 * only (they start processes on it):
 *
 *   GET  /v1/strategies                         the strategies folder: each file with its status, params, P&L today
 *   POST /v1/strategies/examples                copy the shipped examples into the folder (never overwrites)
 *   POST /v1/strategies/stop-all                stop every running strategy
 *   GET  /v1/strategies/{strategyId}            one strategy, with its orders and positions today
 *   GET  /v1/strategies/{strategyId}/logs       its log after ?after=<seq> (ring buffer)
 *   POST /v1/strategies/{strategyId}/start      { account, mode?, params?, confirmLive? }  paper unless mode "live"
 *   POST /v1/strategies/{strategyId}/stop       stop it (on_stop runs, then the process ends)
 *   PUT  /v1/strategies/{strategyId}/settings   { account?, params? } saved for the next start
 *
 * Config (file only): strategies { enabled, dir, python, maxRestarts, restartBackoffMs, heartbeatTimeoutMs,
 * startTimeoutMs, stopGraceMs, maxRunning, logLines }.
 */
import { z } from "zod";
import { BridgeError } from "../core/errors.mjs";
import { defineModule } from "../core/modules.mjs";
import { STRATEGY_ID_RE } from "./book.mjs";
import { createStrategyRunner } from "./runner.mjs";

export const configSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** The strategies folder. Default: "strategies" beside the data folder (the Bridge home). */
    dir: z.string().min(1).max(1000).optional(),
    /** The Python to run. Default python3 (python on Windows). */
    python: z.string().min(1).max(500).optional(),
    maxRestarts: z.number().int().min(0).max(10).default(3),
    restartBackoffMs: z.number().int().min(100).max(60_000).default(2000),
    heartbeatTimeoutMs: z.number().int().min(5000).max(600_000).default(30_000),
    startTimeoutMs: z.number().int().min(5000).max(600_000).default(60_000),
    stopGraceMs: z.number().int().min(500).max(60_000).default(8000),
    maxRunning: z.number().int().min(1).max(50).default(10),
    logLines: z.number().int().min(100).max(20_000).default(2000),
  })
  .strict();

const ADMIN = Object.freeze({ scope: "admin", loopbackOnly: true });
export const ROUTES = Object.freeze([
  ["GET", "/v1/strategies", ADMIN, "list"],
  ["POST", "/v1/strategies/examples", { ...ADMIN, body: "none" }, "examples"],
  ["POST", "/v1/strategies/stop-all", { ...ADMIN, body: "none" }, "stopAll"],
  ["GET", "/v1/strategies/:strategyId", ADMIN, "get"],
  ["GET", "/v1/strategies/:strategyId/logs", ADMIN, "logs"],
  ["POST", "/v1/strategies/:strategyId/start", ADMIN, "start"],
  ["POST", "/v1/strategies/:strategyId/stop", { ...ADMIN, body: "none" }, "stop"],
  ["PUT", "/v1/strategies/:strategyId/settings", ADMIN, "settings"],
]);

const runners = new WeakMap();

const idOf = (ctx) => {
  const id = String(ctx.params.strategyId ?? "");
  if (!STRATEGY_ID_RE.test(id)) throw new BridgeError("NOT_FOUND", "No strategy with this id.");
  return id;
};

/** Where a strategy reaches the Bridge: the port this request came in on, on loopback. */
function baseUrlFor(ctx, config) {
  const port = ctx.req?.socket?.localPort ?? config.server?.port;
  const host = config.server?.host === "::1" ? "[::1]" : "127.0.0.1";
  return `http://${host}:${port}`;
}

export default defineModule({
  name: "strategies",
  stream: "S30",
  configKey: "strategies",
  configSchema,
  register(app, deps) {
    const runner = createStrategyRunner(deps);
    runners.set(deps, runner);
    const meta = (ctx) => ({ requestId: ctx.requestId });
    const handlers = {
      list: async (ctx) => ({ data: await runner.list(), meta: meta(ctx) }),
      examples: async (ctx) => ({ data: runner.addExamples(), meta: meta(ctx) }),
      stopAll: async (ctx) => ({ data: { stopped: runner.stopAll("Stop all, from the dashboard") }, meta: meta(ctx) }),
      get: async (ctx) => ({ data: await runner.get(idOf(ctx)), meta: meta(ctx) }),
      logs: async (ctx) => {
        const after = Number(ctx.query.get("after") ?? 0);
        const limit = Number(ctx.query.get("limit") ?? 500);
        return { data: runner.logs(idOf(ctx), Number.isFinite(after) ? after : 0, Number.isFinite(limit) ? limit : 500), meta: meta(ctx) };
      },
      start: async (ctx) => {
        const id = idOf(ctx);
        await runner.start(id, ctx.body ?? {}, ctx, { baseUrl: baseUrlFor(ctx, deps.config) });
        return { data: await runner.get(id), meta: meta(ctx) };
      },
      stop: async (ctx) => {
        const id = idOf(ctx);
        runner.stop(id, "Stopped from the dashboard");
        return { data: await runner.get(id), meta: meta(ctx) };
      },
      settings: async (ctx) => ({ data: await runner.saveSettings(idOf(ctx), ctx.body ?? {}, ctx), meta: meta(ctx) }),
    };
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], options);
  },
  async start(deps) {
    await runners.get(deps)?.revokeOrphans();
  },
  async stop(deps) {
    await runners.get(deps)?.close();
  },
});

/** The runner for a deps object (tests). */
export const strategyRunnerOf = (deps) => runners.get(deps) ?? null;
