/**
 * Registers the plugins the owner granted (config `sources.plugins`) on the source registry. Called by the sources
 * module at start-up (see ../builtin.mjs). A plugin that does not load (not granted, bad pin, changed files, bad config)
 * is reported in the log and skipped; it never stops the Bridge. Every loaded plugin is a provider with `stop()`, which
 * the sources module calls when the Bridge stops.
 *
 * Loading a plugin only makes it known: like every other source it is off until the owner switches it on.
 */
import { dirname } from "node:path";
import { loadPlugins } from "./loader.mjs";

/** Where the key of source `id` is stored (the same name service.mjs secretNameFor gives; not imported, so the plugin folder stays free of service code). */
const secretNameFor = (id) => `source:${id}`;

/**
 * @param {{ register(p: object): unknown, list(): Array<{ descriptor: { id: string } }> }} registry
 * @param {{ config?: { sources?: { plugins?: object[] } }, logger?: object, paths?: { configFile?: string | null }, secrets?: { get(name: string): Promise<{ apiKey?: string } | null> } }} [deps]
 * @returns {Promise<{ loaded: string[], problems: Array<{ path: string, id?: string, reason: string }> }>}
 */
export async function registerPlugins(registry, deps = {}) {
  const entries = deps.config?.sources?.plugins ?? [];
  if (!entries.length) return { loaded: [], problems: [] };
  const optional = (name) => {
    try {
      return deps[name];
    } catch {
      return undefined;
    }
  };
  const paths = optional("paths");
  const secrets = optional("secrets");
  // Relative plugin folders are read relative to the config file, else to where the Bridge was started.
  const baseDir = paths?.configFile ? dirname(paths.configFile) : process.cwd();
  const readSecret = async (id) => {
    try {
      const v = secrets ? await secrets.get(secretNameFor(id)) : null;
      return typeof v?.apiKey === "string" && v.apiKey ? v.apiKey : undefined;
    } catch {
      return undefined;
    }
  };
  const { providers, problems } = loadPlugins({ entries, baseDir, readSecret, logger: deps.logger, runAs: deps.config?.sources?.pluginUser ?? null, takenIds: registry.list().map((p) => p.descriptor.id) });
  const loaded = [];
  for (const provider of providers) {
    try {
      registry.register(provider);
      loaded.push(provider.descriptor.id);
    } catch (err) {
      problems.push({ path: provider.plugin?.folder ?? "", id: provider.descriptor?.id, reason: String(err?.message ?? err) });
      deps.logger?.warn?.("a plugin could not be registered", { id: provider.descriptor?.id, err: String(err?.message ?? err) });
      await provider.stop?.();
    }
  }
  return { loaded, problems };
}
