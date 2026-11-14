/**
 * The source registry: every data source the Bridge knows about, in registration order. A source is a provider
 * (contract.mjs SourceProvider): a descriptor plus read-only methods. Built-in providers, the demo sources and
 * plugins all register here; nothing else decides what exists.
 *
 * register() validates the descriptor and refuses a bad one with a message that lists every problem, so an author
 * sees them all at once. Ids are unique. The registry holds no state about a source (enabled, consent, keys): that
 * is the service's job (service.mjs).
 */
import { validateDescriptor } from "./contract.mjs";

/**
 * @param {{ logger?: { debug?: Function, info?: Function, warn?: Function } }} [opts]
 */
export function createSourceRegistry({ logger } = {}) {
  /** @type {Map<string, import("./contract.mjs").SourceProvider>} insertion order is registration order */
  const providers = new Map();

  return {
    /**
     * @param {import("./contract.mjs").SourceProvider} provider
     * @returns {import("./contract.mjs").SourceProvider} the same provider
     */
    register(provider) {
      if (!provider || typeof provider !== "object") throw new Error("A source provider must be an object with a descriptor.");
      const { ok, errors } = validateDescriptor(provider.descriptor);
      const id = typeof provider.descriptor?.id === "string" ? provider.descriptor.id : "(no id)";
      if (!ok) throw new Error(`Source ${id} is not valid: ${errors.join("; ")}`);
      if (providers.has(id)) throw new Error(`Source ${id} is already registered.`);
      for (const cap of provider.descriptor.capabilities) {
        if (typeof provider[cap] !== "function" && provider.descriptor.kind !== "broker") {
          throw new Error(`Source ${id} is not valid: it declares the capability ${cap} but has no ${cap}() method`);
        }
      }
      providers.set(id, provider);
      logger?.debug?.("source registered", { id, tier: provider.descriptor.tier, class: provider.descriptor.class });
      return provider;
    },
    /** @param {string} id @returns {boolean} whether it was registered */
    unregister(id) {
      return providers.delete(id);
    },
    /** @param {string} id */
    get(id) {
      return providers.get(id) ?? null;
    },
    /** @param {string} id */
    has(id) {
      return providers.has(id);
    },
    /** All providers in registration order. */
    list() {
      return [...providers.values()];
    },
  };
}
