// The Get started checklist: the pure logic (no DOM, no network, no clock unless passed in), so it can be tested in Node.
//
// Five steps from nothing to a working call. Each one is done or not from what the Bridge reports (accounts, keys,
// recent requests, orders), plus one thing the dashboard itself knows (the person has opened Sources). Any input may be
// null: "could not be read", which never counts as done.

import { PLACEHOLDER } from "./snippets.js";

export const TOTAL_STEPS = 5;
/** localStorage slots (read and written inside try/catch by getstarted.js). */
export const DISMISS_SLOT = "mcb.dashboard.getStarted.dismissed";
export const SOURCES_SEEN_SLOT = "mcb.dashboard.getStarted.sourcesSeen";
/** The key a copied command carries: a placeholder, never a real key. */
export const KEY_PLACEHOLDER = PLACEHOLDER.read;

/** One word in single quotes for a POSIX shell (a quote inside it is closed, escaped and reopened). Pure. */
export const shellQuote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

/** Keep a symbol list readable (NSE:NIFTY,NSE:RELIANCE) and percent-encode anything that is not plain. Pure. */
export const querySymbols = (symbols) => String(symbols).replace(/[^A-Za-z0-9:_.,-]/g, (c) => (c === "'" ? "%27" : encodeURIComponent(c)));

/**
 * The first call to make: last prices from this Bridge, with the Bridge's real address and a placeholder for the key.
 * Both the header and the URL are single-quoted, so the line pastes into bash and zsh as it is.
 * @param {{ base: string, symbols?: string, key?: string }} o  base is the address the dashboard was opened at
 */
export function curlLtp({ base, symbols = "NSE:NIFTY,NSE:RELIANCE", key = KEY_PLACEHOLDER }) {
  const host = String(base ?? "").replace(/\/+$/, "");
  return `curl -H ${shellQuote(`Authorization: Bearer ${key}`)} ${shellQuote(`${host}/v1/ltp?symbols=${querySymbols(symbols)}`)}`;
}

/** Is this key still usable? Revoked and expired keys are not. */
const active = (k, now) => !k.revokedAt && !(k.expiresAt && Date.parse(k.expiresAt) < now);

/**
 * Has a tool other than the dashboard called the Bridge with a key and been answered? The log marks the dashboard's own
 * requests with client "dashboard"; health checks need no key and do not count.
 * @param {Array<{ client?: string | null, keyId?: string | null, status?: number, path?: string }> | null} requests
 */
export function firstCallSeen(requests) {
  if (!Array.isArray(requests)) return false;
  return requests.some((r) => r && r.client !== "dashboard" && Boolean(r.keyId) && Number(r.status) < 400 && /^\/v1\//.test(String(r.path ?? "")) && !String(r.path).startsWith("/v1/health"));
}

/**
 * Where the person is, step by step.
 * @param {{ demo?: boolean, accounts: object[] | null, keys: object[] | null, requests: object[] | null, orders: object[] | null,
 *   sourcesSeen?: boolean, ownKeyId?: string | null, now?: number }} input
 * @returns {{ steps: Array<{ id: string, done: boolean }>, doneCount: number, total: number, complete: boolean, current: string | null, progress: string }}
 */
export function deriveSteps({ demo = false, accounts, keys, requests, orders, sourcesSeen = false, ownKeyId = null, now = Date.now() }) {
  const done = {
    account: Boolean(demo) || (Array.isArray(accounts) && accounts.some((a) => a?.broker !== "demo")),
    // A key for a tool: one that is not the key this dashboard is signed in with, and not a dashboard sign-in key.
    key: Array.isArray(keys) && keys.some((k) => k && k.id !== ownKeyId && k.clientKind !== "ui" && active(k, now)),
    call: firstCallSeen(requests),
    order: Array.isArray(orders) && orders.length > 0,
    sources: sourcesSeen === true,
  };
  const steps = ["account", "key", "call", "order", "sources"].map((id) => ({ id, done: done[id] }));
  const doneCount = steps.filter((s) => s.done).length;
  return { steps, doneCount, total: TOTAL_STEPS, complete: doneCount === TOTAL_STEPS, current: steps.find((s) => !s.done)?.id ?? null, progress: progressText(doneCount) };
}

/**
 * What step 1 says. A broker that is added but not logged in is not "ready": say so, and what to do.
 * @param {{ demo: boolean, accounts: object[] | null | undefined }} o
 */
export function accountStepText({ demo, accounts }) {
  if (demo) return "You are in demo mode: prices are samples made on this computer, not real market data, and orders are paper only. Add your broker when you are ready.";
  const real = (Array.isArray(accounts) ? accounts : []).filter((a) => a?.broker !== "paper" && a?.broker !== "demo");
  if (!real.length) return "Add your broker to see real prices. New accounts are paper only until you allow live orders.";
  const waiting = real.filter((a) => a.session?.state !== "connected");
  return waiting.length ? `${waiting.map((a) => a.label || a.id).join(" and ")} ${waiting.length === 1 ? "is" : "are"} added but not logged in yet. Open ${waiting.length === 1 ? "it" : "them"} below and press Log in to see real prices.` : "Your broker is logged in. Real prices are available.";
}

export const CONNECT_HASH = "#/connect";
export const KEYS_HASH = "#/api/keys";

/**
 * Where "Create an API key" leads: the Connect a tool wizard when this build has that page, else the Keys tab. The router
 * sends an unknown page to the first page, so the resolved page id is what says whether the page exists, not the hash.
 * @param {(hash: string) => { page?: { id?: string } } | null | undefined} resolve  views.js resolveRoute
 */
export function keyStepLink(resolve) {
  try {
    return resolve?.(CONNECT_HASH)?.page?.id === "connect" ? CONNECT_HASH : KEYS_HASH;
  } catch {
    return KEYS_HASH;
  }
}

/** "2 of 5". */
export const progressText = (n, total = TOTAL_STEPS) => `${n} of ${total}`;

/** Is the checklist on the page? Only while something is left to do, and never after it was hidden. */
export const shouldShow = ({ dismissed, complete }) => !dismissed && !complete;

/** What a screen reader hears when a step flips to done. */
export const STEP_DONE_TEXT = Object.freeze({
  account: "Step 1 done: you have an account to work with.",
  key: "Step 2 done: you have an API key for a tool.",
  call: "Step 3 done: a tool made its first call to the Bridge.",
  order: "Step 4 done: you placed a paper order.",
  sources: "Step 5 done: you have seen where data comes from.",
});

/** The steps that became done between two derivations, in order (pure; the checklist announces them). */
export const newlyDone = (before, after) => (before ? after.steps.filter((s, i) => s.done && !before.steps[i]?.done).map((s) => s.id) : []);
