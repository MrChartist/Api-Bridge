/**
 * Module registration. Each area ships ONE module file (server/bridge/<area>/module.mjs):
 *
 *   export default defineModule({
 *     name: "market", stream: "S5",
 *     configKey: "market", configSchema: z.object({...}).strict(),   // optional: owns config.market
 *     services: { marketData: (deps) => createMarketDataService(deps) },   // contract services only
 *     register(app, deps) { app.get("/v1/quotes", handler, { scope: "read" }); },   // routes, WS upgrades
 *     async start(deps) {}, async stop(deps) {},                        // optional lifecycle
 *   });
 *
 * `stream` is a short ownership tag ("S5", "core") that groups modules with the contract services they provide
 * (SERVICE_CONTRACTS[name].stream) and with their routes (`x-stream` in docs/openapi.yaml). defineModule() refuses a
 * module that provides a service owned by another tag.
 *
 * Service factories run in dependency order (SERVICE_CONTRACTS[name].requires) and receive a deps object that
 * contains ONLY the core deps plus the services they declared they need; touching anything else throws, so hidden
 * coupling between modules fails in tests, not in production. register() receives every service.
 */
import { CORE_DEPS, SERVICE_CONTRACTS, assertService, notImplementedService } from "./contracts.mjs";
import { CORE_SECTIONS, deepFreeze } from "./config.mjs";
import { BridgeError, NotImplementedError } from "./errors.mjs";

/**
 * @typedef {{ name: string, stream: string, configKey?: string, configSchema?: import("zod").ZodType,
 *   services?: Record<string, (deps: object) => object>, register?: (app: object, deps: object) => void | Promise<void>,
 *   start?: (deps: object) => void | Promise<void>, stop?: (deps: object) => void | Promise<void> }} BridgeModule
 */

/** @param {BridgeModule} mod @returns {Readonly<BridgeModule>} */
export function defineModule(mod) {
  if (!mod || typeof mod !== "object") throw new Error("defineModule needs an object");
  if (typeof mod.name !== "string" || !/^[a-z][a-z0-9-]{1,30}$/.test(mod.name)) throw new Error(`Bad module name ${mod?.name}`);
  if (typeof mod.stream !== "string" || !/^S\d{1,2}$|^core$/.test(mod.stream)) throw new Error(`Module ${mod.name}: stream must be like "S5" or "core"`);
  for (const key of Object.keys(mod.services ?? {})) {
    if (!SERVICE_CONTRACTS[key]) throw new Error(`Module ${mod.name}: "${key}" is not a contract service (core/contracts.mjs)`);
    if (SERVICE_CONTRACTS[key].stream !== mod.stream) throw new Error(`Module ${mod.name}: service ${key} belongs to stream ${SERVICE_CONTRACTS[key].stream}`);
    if (typeof mod.services[key] !== "function") throw new Error(`Module ${mod.name}: services.${key} must be a factory function`);
  }
  if (mod.configKey !== undefined) {
    if (CORE_SECTIONS.includes(mod.configKey)) throw new Error(`Module ${mod.name}: config section ${mod.configKey} belongs to core`);
    if (!mod.configSchema || typeof mod.configSchema.safeParse !== "function") throw new Error(`Module ${mod.name}: configKey needs a zod configSchema`);
  }
  for (const fn of ["register", "start", "stop"]) {
    if (mod[fn] !== undefined && typeof mod[fn] !== "function") throw new Error(`Module ${mod.name}: ${fn} must be a function`);
  }
  return Object.freeze({ ...mod });
}

/** Check module list consistency: unique names, one provider per service, unique config keys. */
export function validateModules(modules) {
  const names = new Set();
  const providers = new Map();
  const configKeys = new Map();
  for (const m of modules) {
    if (names.has(m.name)) throw new Error(`Duplicate module ${m.name}`);
    names.add(m.name);
    for (const s of Object.keys(m.services ?? {})) {
      if (providers.has(s)) throw new Error(`Service ${s} is provided by both ${providers.get(s)} and ${m.name}`);
      providers.set(s, m.name);
    }
    if (m.configKey) {
      if (configKeys.has(m.configKey)) throw new Error(`Config section ${m.configKey} is claimed by ${configKeys.get(m.configKey)} and ${m.name}`);
      configKeys.set(m.configKey, m.name);
    }
  }
  return { providers, configKeys };
}

/**
 * Validate module-owned config sections and return a new frozen config with parsed (defaulted) sections.
 * Unknown top-level sections are errors.
 */
export function applyModuleConfig(config, modules) {
  const out = structuredClone(config);
  const claimed = new Set();
  for (const m of modules) {
    if (!m.configKey) continue;
    claimed.add(m.configKey);
    const parsed = m.configSchema.safeParse(config[m.configKey] ?? {});
    if (!parsed.success) {
      const errors = parsed.error.issues.map((i) => ({ path: [m.configKey, ...i.path].join("."), message: i.message }));
      throw new BridgeError("VALIDATION_FAILED", `Config is not valid: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`, { errors });
    }
    out[m.configKey] = parsed.data;
  }
  for (const k of Object.keys(config)) {
    if (!CORE_SECTIONS.includes(k) && !claimed.has(k)) throw new BridgeError("VALIDATION_FAILED", `Unknown config section "${k}".`);
  }
  return deepFreeze(out);
}

/** deps view that only exposes `allowed` keys; anything else throws (catches undeclared coupling). */
export function scopedDeps(all, allowed, who) {
  const allow = new Set([...CORE_DEPS, ...allowed]);
  return new Proxy(all, {
    get(target, prop) {
      if (typeof prop === "symbol" || prop === "then" || prop === "toJSON") return prop === "then" ? undefined : target[prop];
      if (!allow.has(prop)) throw new Error(`${who} used deps.${String(prop)} without declaring it in SERVICE_CONTRACTS requires`);
      return target[prop];
    },
    set() {
      throw new Error("deps is read-only");
    },
  });
}

function topoOrder() {
  const order = [];
  const state = new Map();
  const visit = (name, path) => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") throw new Error(`Service dependency cycle: ${[...path, name].join(" -> ")}`);
    state.set(name, "visiting");
    for (const r of SERVICE_CONTRACTS[name].requires) visit(r, [...path, name]);
    state.set(name, "done");
    order.push(name);
  };
  for (const name of Object.keys(SERVICE_CONTRACTS)) visit(name, []);
  return order;
}

/** Contract services in construction order. */
export const SERVICE_ORDER = Object.freeze(topoOrder());

/**
 * Build every contract service. A service no module provides becomes a stub; `overrides` replace any service
 * (tests, CLI). Each result is checked with assertService.
 * @param {object} coreDeps  { config, logger, bus, clock, paths, brokers }
 * @param {Readonly<BridgeModule>[]} modules
 * @param {Record<string, object>} [overrides]
 * @returns {Promise<object>} deps
 */
export async function buildServices(coreDeps, modules, overrides = {}) {
  const { providers } = validateModules(modules);
  const deps = { ...coreDeps };
  for (const name of SERVICE_ORDER) {
    const spec = SERVICE_CONTRACTS[name];
    let impl;
    if (overrides[name]) impl = overrides[name];
    else if (providers.has(name)) {
      const mod = modules.find((m) => m.name === providers.get(name));
      impl = await mod.services[name](scopedDeps(deps, spec.requires, `${spec.iface} factory`));
    } else impl = notImplementedService(name);
    assertService(name, impl);
    deps[name] = impl;
  }
  return Object.freeze(deps);
}

/**
 * Placeholder handler for a route whose module has not landed yet: answers 501 NOT_IMPLEMENTED. Modules replace
 * these with real handlers; the route itself (method, path, auth, scope) is part of the contract (docs/openapi.yaml).
 * @param {string} what  e.g. "GET /v1/quotes (stream S5)"
 */
export function notBuilt(what) {
  return () => {
    throw new NotImplementedError(what);
  };
}
