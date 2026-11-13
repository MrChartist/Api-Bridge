/**
 * Keyless access on this computer: a tool that sends no API key is treated as "This computer" when the request
 * genuinely comes from the computer the Bridge runs on. For now nothing on this computer needs a key; keys are for
 * limiting a tool (fewer scopes, fewer accounts) and, later, for subscriptions.
 *
 * What stands in for the key is the same test the this-computer-only routes use (core/security.mjs isLocalRequest):
 * a loopback peer, a loopback Host name and no proxy headers, never the public listener. A browser page from another
 * site is refused as well: the core pipeline rejects an Origin that is not on the allowlist, and a request a browser
 * marks as cross-site (Sec-Fetch-Site) gets no keyless access here.
 *
 * What it gives: the read, paper and admin scopes on every account. It does NOT give the live scope: a real order
 * still needs a key that was created for live trading, on top of the opt-ins in bridge.config.json. A request that
 * does send a key is judged by that key alone, so a tool can still be held to less.
 *
 * "This computer" is a real key record (label LOCAL_ACCESS_LABEL, made on first use, its secret thrown away), so the
 * rate limits, stream tokens, audit log and the Keys page all treat it like any other key. Switched off with
 * server.keylessApi: false (or MCB_KEYLESS=0 in the environment), and off by default when server.localPeers is set or
 * the dashboard is served to other computers (config.mjs keylessApiAllowed).
 */
import { keylessApiAllowed } from "../core/config.mjs";
import { isStub } from "../core/contracts.mjs";
import { isLocalRequest } from "../core/security.mjs";

export const LOCAL_ACCESS_LABEL = "This computer (no key)";
export const LOCAL_ACCESS_SCOPES = Object.freeze(["read", "paper", "admin"]);

const usable = (k, now) => k && !k.revokedAt && !(k.expiresAt && Date.parse(k.expiresAt) < now);
const instances = new WeakMap();

/** True when a request with no key may act as this computer (pure apart from reading the request). */
export function mayActAsThisComputer(req, config, { publicListener = false } = {}) {
  if (publicListener || !keylessApiAllowed(config)) return false;
  if (!isLocalRequest(req, { localPeers: config?.server?.localPeers ?? [] })) return false;
  const site = req?.headers?.["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

/**
 * The shared keyless access of one Bridge (one per deps object).
 * @param {{ config: object, keyStore: object, clock?: { now(): number } }} deps
 * @returns {{ recordFor(req: object, opts?: { publicListener?: boolean }): Promise<object | null> }}
 */
export function localAccessFor(deps) {
  let inst = instances.get(deps);
  if (inst) return inst;
  let record = null;
  let making = null;
  const now = () => deps.clock?.now?.() ?? Date.now();
  async function ensure() {
    const store = deps.keyStore;
    if (!store || isStub(store) || typeof store.create !== "function" || typeof store.list !== "function") return null;
    // Still valid (not revoked from the Keys page since it was last used)?
    if (record) {
      const current = typeof store.get === "function" ? await store.get(record.id) : record;
      if (usable(current, now())) return (record = current);
      record = null;
    }
    const existing = (await store.list()).find((k) => k.label === LOCAL_ACCESS_LABEL && k.clientKind === "other" && usable(k, now()) && LOCAL_ACCESS_SCOPES.every((s) => (k.scopes ?? []).includes(s)) && !(k.scopes ?? []).includes("live"));
    if (existing) return (record = existing);
    const made = await store.create({ label: LOCAL_ACCESS_LABEL, scopes: [...LOCAL_ACCESS_SCOPES], accounts: "*", clientKind: "other" }, { loopback: true });
    return (record = made.record);
  }
  inst = {
    async recordFor(req, opts = {}) {
      if (!mayActAsThisComputer(req, deps.config, opts)) return null;
      making ??= ensure().finally(() => (making = null));
      return making;
    },
  };
  instances.set(deps, inst);
  return inst;
}
