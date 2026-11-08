/**
 * Vitest setup: no test may use the real network through the global `fetch`.
 *
 * The built-in data-source providers default to `globalThis.fetch` when a test does not inject one, and a provider turns a
 * failed request into a plain "could not be reached" error, so a test that forgot to inject a fake would pass quietly while it
 * made a real request to a vendor (one did, with a canary key, during a security review). This replaces `fetch` with a
 * guard that
 *   - lets requests to this computer through (127.0.0.0/8, localhost, ::1: the tests that start a Bridge or a fake server
 *     on a loopback port) and `data:` and `blob:` URLs;
 *   - refuses every other request with a clear error, AND records it, and fails the test that made it when the test ends,
 *     even if the code under test caught the error and carried on.
 *
 * A test that stubs `globalThis.fetch` itself (vi.stubGlobal, an assignment) simply replaces the guard for its duration.
 */
import { afterEach } from "vitest";

const realFetch = globalThis.fetch;
const violations = [];

const isLocal = (host) => {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h) || h.endsWith(".localhost");
};

/** The host of a fetch input (string, URL or Request), or null when it has none (data:, blob:, a relative URL). */
function hostOf(input) {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : typeof input?.url === "string" ? input.url : String(input);
  if (/^(data|blob):/i.test(raw)) return null;
  try {
    return new URL(raw).hostname;
  } catch {
    return "";
  }
}

export function guardedFetch(input, init) {
  const host = hostOf(input);
  if (host === null || (host && isLocal(host))) return realFetch(input, init);
  const shown = host ? host : "an address that does not parse";
  violations.push(shown);
  return Promise.reject(new TypeError(`The test tried to use the real network (fetch to ${shown}). Inject a fake fetch instead.`));
}

if (typeof realFetch === "function" && !realFetch.__mcbGuard) {
  guardedFetch.__mcbGuard = true;
  globalThis.fetch = guardedFetch;
}

/** For the guard's own test. */
export const networkViolations = violations;

afterEach(() => {
  if (violations.length === 0) return;
  const hosts = [...new Set(violations.splice(0))];
  throw new Error(`The test used the real network through the global fetch (${hosts.join(", ")}). Inject a fake fetch; nothing may reach a real host.`);
});
