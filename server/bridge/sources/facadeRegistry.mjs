/**
 * A registry view over a BackupDataService facade, for the router when no registry is injected. It lets the market
 * service route to whatever `deps.backupData` offers without knowing how the sources service stores its sources:
 *
 *  - a facade with the management API (`list()` rows with id, class, delaySec, official, capabilities, enabled ...)
 *    shows each row as a source, on when it is enabled (and set up, when it needs a key);
 *  - a bare facade (only quotes/history/expiries/optionChain, as in simple tests and the original seam) shows one
 *    pseudo-source named "backup": delayed 15 minutes, not official, on while the facade exists.
 *
 * The rows are cached for a second so select() does not rebuild them on every read.
 */

const CAPS = Object.freeze(["quotes", "history", "expiries", "optionChain"]);
const TTL_MS = 1000;

/** The id of the single pseudo-source a bare facade shows. */
export const LEGACY_SOURCE_ID = "backup";

const LEGACY_DESCRIPTOR = Object.freeze({
  id: LEGACY_SOURCE_ID,
  name: "Backup data",
  kind: "free",
  tier: "opt-in",
  class: "delayed",
  delaySec: 900,
  official: false,
  capabilities: CAPS,
  limits: Object.freeze({ perMinute: 30 }),
});

/**
 * @param {{ backup: any, clock?: { now(): number }, usable?: (svc: any) => boolean }} p
 * @returns {{ list(): Array<{ descriptor: object, enabled: boolean }>, get(id: string): any, isEnabled(id: string): boolean }}
 */
export function createFacadeRegistry({ backup, clock, usable = Boolean }) {
  const now = () => (clock && typeof clock.now === "function" ? clock.now() : Date.now());
  let cached = null;
  let cachedAt = -Infinity;

  function rows() {
    const t = now();
    if (cached && t - cachedAt < TTL_MS) return cached;
    let out = [];
    if (usable(backup)) {
      if (typeof backup.list === "function") {
        // A management list() is the source of truth. If it cannot say (it throws or does not answer with an array),
        // nothing is on: never fall back to the bare-facade pseudo-source, which would ignore what the owner switched off.
        let managed = null;
        try {
          managed = backup.list();
        } catch {
          managed = null;
        }
        if (Array.isArray(managed)) {
          out = managed
            .filter((r) => r && typeof r.id === "string")
            .map((r) => ({
              descriptor: {
                id: r.id,
                name: r.name ?? r.id,
                kind: r.kind ?? "free",
                tier: r.tier ?? "opt-in",
                class: r.class ?? "delayed",
                delaySec: r.delaySec ?? null,
                official: r.official === true,
                capabilities: Array.isArray(r.capabilities) ? r.capabilities : [],
                limits: r.limits ?? {},
                ...(r.terms ? { terms: r.terms } : {}),
              },
              enabled: r.enabled === true && (r.needsKey !== true || r.configured !== false),
            }));
        }
      } else out = [{ descriptor: LEGACY_DESCRIPTOR, enabled: true }];
    }
    cached = out;
    cachedAt = t;
    return out;
  }

  return {
    list: rows,
    get: (id) => rows().find((r) => r.descriptor.id === id) ?? null,
    isEnabled: (id) => rows().find((r) => r.descriptor.id === id)?.enabled === true,
  };
}
