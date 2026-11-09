/**
 * Session-error classification for everything the Bridge asks a broker adapter to do.
 *
 * The Bridge decides "the broker session is gone, log in again" from the error code an adapter call throws
 * (ratelimit/scheduler.mjs marks the account logged out, the dashboard shows "login needed", reads fail fast). Many
 * adapters only recognise their broker's own wording of an expired session inside `normaliseError`, so a plain read
 * or order call could fail with a generic code and leave the account looking connected. guardAdapterErrors() closes
 * that gap in one place: every error an adapter function throws is checked with the adapter's own `normaliseError`,
 * and an error that normalises to a session code is tagged with that code before it reaches the Bridge.
 *
 * It only ever ADDS a session code. It never changes a message, never touches `login` (a refused login is bad input,
 * not an expired session), and never makes a failed order look successful or rejected: order outcome handling stays
 * in OrderService.
 */

import { SESSION_ERROR_CODES } from "./contract.mjs";
import { ORDER_GATED } from "./orderGate.mjs";

const SESSION = new Set(SESSION_ERROR_CODES);
const UNGUARDED = new Set(["login", "normaliseError"]);

/** The session code this error carries or normalises to, or null when it is not a session error. */
export function sessionErrorCode(adapter, err) {
  if (!err || typeof err !== "object") return null;
  if (SESSION.has(err.code)) return err.code;
  let code = null;
  try {
    code = typeof adapter?.normaliseError === "function" ? adapter.normaliseError(err)?.code : null;
  } catch {
    code = null;
  }
  return SESSION.has(code) ? code : null;
}

function tag(adapter, err) {
  const code = sessionErrorCode(adapter, err);
  if (code && err.code !== code) {
    try {
      err.code = code;
    } catch {
      /* frozen error: the original is still thrown */
    }
  }
  return err;
}

const guards = new WeakMap();

/** @returns {object} a view of `adapter` whose functions tag session errors; every other property is passed through */
export function guardAdapterErrors(adapter) {
  if (!adapter || typeof adapter !== "object") return adapter;
  const cached = guards.get(adapter);
  if (cached) return cached;
  const fns = new Map();
  const wrap = (name, fn) => {
    const wrapped = function guarded(...args) {
      let out;
      try {
        out = fn.apply(adapter, args);
      } catch (err) {
        throw tag(adapter, err);
      }
      return out && typeof out.then === "function"
        ? out.then(undefined, (err) => {
            throw tag(adapter, err);
          })
        : out;
    };
    if (typeof fn[ORDER_GATED] === "string") Object.defineProperty(wrapped, ORDER_GATED, { value: fn[ORDER_GATED] });
    Object.defineProperty(wrapped, "name", { value: name });
    return wrapped;
  };
  const proxy = new Proxy(adapter, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function" || typeof prop !== "string" || UNGUARDED.has(prop) || /^[A-Z]/.test(prop)) return value;
      let w = fns.get(prop);
      if (!w || w.of !== value) {
        w = { of: value, fn: wrap(prop, value) };
        fns.set(prop, w);
      }
      return w.fn;
    },
  });
  guards.set(adapter, proxy);
  return proxy;
}
