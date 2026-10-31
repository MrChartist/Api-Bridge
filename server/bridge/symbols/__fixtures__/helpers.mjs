/**
 * Test helpers for stream S4: fixture masters, a recording Scheduler stub, a fake AccountManager wired to stub
 * adapters, a settable clock and a capturing logger. No network, no real broker.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeAccountManager } from "../../accounts/fake.mjs";
import { notImplementedService } from "../../core/contracts.mjs";
import { createLogger } from "../../core/logger.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The five brokers whose normalised masters are snapshotted in __fixtures__/masters/. */
export const FIXTURE_BROKERS = Object.freeze(["dhan", "zerodha", "upstox", "angelone", "fyers"]);

/** Contract Instrument rows for a fixture broker (a fresh copy each call). */
export function loadMaster(broker) {
  return JSON.parse(readFileSync(join(HERE, "masters", `${broker}.json`), "utf8")).rows;
}

/** Epoch ms for an IST wall-clock time, e.g. istMs("2026-10-18T09:00"). */
export const istMs = (local) => Date.parse(`${local}:00+05:30`);

/** A clock tests can move. */
export function createClock(local = "2026-10-18T10:00") {
  let t = istMs(local);
  return {
    now: () => t,
    set(localTime) {
      t = istMs(localTime);
    },
    advance(ms) {
      t += ms;
    },
  };
}

/**
 * Scheduler stub that records every schedule() call and runs fn (optionally after `gate`), coalescing by key like
 * the real one. pickAccount returns the first candidate.
 */
export function createRecordingScheduler({ gate } = {}) {
  const calls = [];
  const inflight = new Map();
  return {
    ...notImplementedService("scheduler"),
    calls,
    async schedule(opts, fn) {
      calls.push({ ...opts });
      if (opts.coalesceKey && inflight.has(opts.coalesceKey)) return inflight.get(opts.coalesceKey);
      const run = (async () => {
        if (gate) await gate;
        return fn();
      })();
      if (opts.coalesceKey) {
        inflight.set(opts.coalesceKey, run);
        run.finally(() => inflight.delete(opts.coalesceKey)).catch(() => {});
      }
      return run;
    },
    pickAccount: ({ candidates }) => candidates[0] ?? null,
    // The request pipeline calls this for every keyed request once the scheduler is not a stub.
    checkClient: () => ({ ok: true, retryAfterMs: 0, headers: {} }),
  };
}

/** Adapter stub whose fetchInstruments returns `rows` (or throws `error`) and counts calls and the creds it saw. */
export function stubAdapter(id, rows, { error, shape = "envelope" } = {}) {
  const adapter = {
    id,
    calls: 0,
    seenCreds: [],
    async fetchInstruments(creds) {
      adapter.calls++;
      adapter.seenCreds.push(creds);
      if (error) throw error;
      return shape === "array" ? rows : { status: "success", data: rows };
    },
  };
  return adapter;
}

/**
 * Fake AccountManager with one connected account per adapter (account id "<broker>-1").
 * @param {Record<string, object>} adapters broker -> adapter
 * @param {{ extra?: object[], bus?: object }} [opts]
 */
export function accountsFor(adapters, { extra = [], bus } = {}) {
  const accounts = Object.entries(adapters).map(([broker, adapter]) => ({
    id: `${broker}-1`,
    broker,
    adapter,
    capabilities: ["instruments", "ltp", "quotes"],
    creds: { clientId: `${broker}-client`, accessToken: `secret-token-${broker}-abcdef` },
  }));
  return createFakeAccountManager({ accounts: [...accounts, ...extra], bus });
}

/** Broker registry view that knows the fixture brokers plus anything given. */
export function brokerIds(...more) {
  const known = new Set([...FIXTURE_BROKERS, ...more]);
  return { has: (id) => known.has(id), list: () => [...known], get: () => ({}) };
}

/** Logger that captures every line as text. */
export function createCapturingLogger() {
  const lines = [];
  const logger = createLogger({ level: "debug", write: (l) => lines.push(l) });
  return { logger, lines, text: () => lines.join("\n") };
}
