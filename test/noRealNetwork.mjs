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
 * Code that does not use fetch (node's own http and https clients, ws, a raw socket) goes through `net.Socket#connect`, so the
 * same rule is applied there: a connection to anything but this computer is refused and recorded. (Child processes the tests
 * start are not covered; they get their own setup.)
 *
 * A test that stubs `globalThis.fetch` itself (vi.stubGlobal, an assignment) simply replaces the guard for its duration.
 */
import net from "node:net";
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

/** The host a `socket.connect(...)` call is for: null for a local socket path, "localhost" when none is given. */
function connectHost(args) {
  // net.connect() hands the already normalised form on: an array [options, callback].
  const a = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (a && typeof a === "object") return typeof a.path === "string" && a.host === undefined ? null : a.host ?? "localhost";
  if (typeof a === "number" || (typeof a === "string" && /^\d+$/.test(a))) return typeof args[1] === "string" ? args[1] : "localhost";
  return null; // a path (unix socket, named pipe)
}

/** Where in the repository a refused connection came from (the first stack frame outside node and node_modules), for the message. */
const sites = new Map();
function noteSite(host) {
  if (sites.has(host)) return;
  if (process.env.MCB_NET_DEBUG) Error.stackTraceLimit = 60;
  const frame = String(new Error().stack).split("\n").slice(1).find((l) => !/node:|node_modules|test\/noRealNetwork/.test(l));
  sites.set(host, process.env.MCB_NET_DEBUG ? String(new Error().stack) : frame ? frame.trim().replace(/^at /, "") : "unknown");
}

const realConnect = net.Socket.prototype.connect;
if (!realConnect.__mcbGuard) {
  const guardedConnect = function connect(...args) {
    const host = connectHost(args);
    if (host === null || isLocal(host) || host === "0.0.0.0" || host === "::") return realConnect.apply(this, args);
    // A caller that pins the address with its own `lookup` (the webhook sender connects to the address it already vetted, under
    // the receiver's name) is judged by where that lookup sends it, not by the name.
    const normalised = Array.isArray(args[0]);
    const opts = normalised ? args[0][0] : args[0];
    if (opts && typeof opts === "object" && typeof opts.lookup === "function") {
      const lookup = opts.lookup;
      const vetted = (hostname, options, cb) =>
        lookup(hostname, options, (err, address, family) => {
          const addresses = (Array.isArray(address) ? address.map((a) => a?.address) : [address]).filter(Boolean);
          const outside = addresses.find((a) => !isLocal(String(a).replace(/^::ffff:/i, "")));
          if (err || !outside) return cb(err, address, family);
          violations.push(`${host} (resolved to ${outside})`);
          return cb(Object.assign(new Error(`The test tried to use the real network (${host} resolved to ${outside}). Use a fake server on 127.0.0.1 instead.`), { code: "ECONNREFUSED" }));
        });
      const copy = { ...opts, lookup: vetted };
      if (normalised) {
        const arr = Object.assign([...args[0]], args[0]); // keeps net's marker on the normalised form
        arr[0] = copy;
        return realConnect.apply(this, [arr, ...args.slice(1)]);
      }
      return realConnect.apply(this, [copy, ...args.slice(1)]);
    }
    violations.push(host);
    noteSite(host);
    const err = Object.assign(new Error(`The test tried to use the real network (a connection to ${host}). Use a fake server on 127.0.0.1 instead.`), { code: "ECONNREFUSED" });
    process.nextTick(() => this.destroy(err));
    return this;
  };
  guardedConnect.__mcbGuard = true;
  net.Socket.prototype.connect = guardedConnect;
}

/** For the guard's own test. */
export const networkViolations = violations;

afterEach(() => {
  if (violations.length === 0) return;
  const hosts = [...new Set(violations.splice(0))].map((h) => (sites.has(h) ? `${h} from ${sites.get(h)}` : h));
  throw new Error(`The test used the real network (${hosts.join("; ")}). Inject a fake fetch or use a fake server on 127.0.0.1; nothing may reach a real host.`);
});
