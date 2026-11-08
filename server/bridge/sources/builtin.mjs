/**
 * Which sources a Bridge starts with. One place, so every part that adds sources (the demo sources, the built-in
 * providers, plugins) hooks in the same way and a missing part never stops the others.
 *
 *  - Demo mode: the demo sources (demo.mjs). Never any network source.
 *  - Otherwise: the built-in providers, if `./providers/index.mjs` exists. It exports `registerProviders(registry, deps)`
 *    (or a default function with the same arguments, or `providers`: an array of providers).
 *  - Plugins that the config grants, if `./plugin/index.mjs` exists. It exports `registerPlugins(registry, deps)`.
 *
 * A part that is absent is skipped silently. A part that is present but throws is logged and skipped: a broken source
 * must not stop the Bridge from starting.
 */
import { registerDemoSources } from "./demo.mjs";

/** Import a sibling file when it exists. Returns null only when that file itself is missing. */
async function importOptional(relative, logger) {
  const url = new URL(relative, import.meta.url);
  try {
    return await import(url.href);
  } catch (err) {
    const missing = err?.code === "ERR_MODULE_NOT_FOUND" && String(err.message).includes(url.pathname.split("/").slice(-2).join("/"));
    if (!missing) logger?.warn?.("a source part could not be loaded", { part: relative, err: err?.message });
    return null;
  }
}

/**
 * @param {{ register(p: object): unknown, has(id: string): boolean }} registry
 * @param {{ config?: { demo?: boolean, sources?: object }, logger?: object, clock?: object, paths?: object }} [deps]
 */
export async function registerBuiltinSources(registry, deps = {}) {
  const { logger } = deps;
  if (deps.config?.demo) {
    registerDemoSources(registry);
    return registry;
  }
  const guarded = async (part, run) => {
    try {
      await run();
    } catch (err) {
      logger?.warn?.("a source part failed to register", { part, err: err?.message });
    }
  };
  const providers = await importOptional("./providers/index.mjs", logger);
  if (providers) {
    await guarded("providers", async () => {
      const fn = typeof providers.registerProviders === "function" ? providers.registerProviders : typeof providers.default === "function" ? providers.default : null;
      if (fn) await fn(registry, deps);
      else for (const p of Array.isArray(providers.providers) ? providers.providers : []) registry.register(p);
    });
  }
  const plugins = await importOptional("./plugin/index.mjs", logger);
  if (plugins && typeof plugins.registerPlugins === "function") await guarded("plugins", () => plugins.registerPlugins(registry, deps));
  return registry;
}
