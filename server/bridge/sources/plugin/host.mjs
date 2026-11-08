/**
 * The plugin host: runs one plugin as a child process and talks to it in protocol bridge-source/1.
 *
 * What the host guarantees (the boundary is the process and the broker, not the permission flags):
 *  - the child gets an EMPTY environment, the plugin folder as its working directory, and no secret except the one key the
 *    owner stored for it (sent once, in `init`, over stdin; never in argv or the environment);
 *  - Node's permission flags are added as a seat belt (file reads limited to the entry file and the runner; no child
 *    processes, worker threads, native addons or WASI). Node 22 has no network permission flag, so the flags do not stop a
 *    plugin opening its own sockets. See docs/source-contract.md, "The sandbox and its limits";
 *  - ALL network access that goes through the host is brokered (netbroker.mjs): host allow-list, https only, size caps,
 *    redirect re-checks, timeouts and the plugin's own request limits;
 *  - every message from the child is size-capped, parsed once and strictly validated; a violation kills the child;
 *  - every call has a timeout (5 s by default, never above 15 s) and can be cancelled; a child that ignores two cancels
 *    or two heartbeats is killed;
 *  - a crashed child is restarted at most 3 times in 10 minutes, then the plugin is disabled with the reason shown.
 *
 * This module imports nothing from the order, safety, paper, accounts or broker code, and nothing outside the
 * sources area imports it except through loader.mjs.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BridgeError } from "../../core/errors.mjs";
import { API_VERSION, effectiveLimits } from "./manifest.mjs";
import { createFetchBroker } from "./netbroker.mjs";
import * as proto from "./protocol.mjs";
import { validateResult } from "./results.mjs";

export const RUNNER_PATH = fileURLToPath(new URL("./child.mjs", import.meta.url));
export const RESTART_WINDOW_MS = 10 * 60_000;
export const MAX_RESTARTS = 3;
export const READY_TIMEOUT_MS = 5000;
export const HEARTBEAT_MS = 10_000;
export const CANCEL_GRACE_MS = 1000;
export const STOP_GRACE_MS = 1000;
const DEFAULT_RETRY_AFTER_MS = 5000;
const MAX_QUEUED = 20;
const MAX_FETCHES_IN_FLIGHT = 4;
const MAX_MESSAGES_PER_SEC = 500;
const MAX_LOGS_PER_SEC = 20;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_STRAYS = 50;
const BACKOFF_MS = [1000, 2000, 4000, 8000];

/** The permission flag this Node understands, or null when it has none (Node older than 20). */
export function permissionFlagFor(version = process.versions.node) {
  const [major, minor] = String(version).split(".").map(Number);
  if (major > 23 || (major === 23 && minor >= 5) || (major === 22 && minor >= 13)) return "--permission";
  if (major >= 20) return "--experimental-permission";
  return null;
}

/**
 * The argument list for the child. Pure, so a test can check it: permission flags first, then limits, then the runner,
 * its entry file and the pinned hash.
 */
export function buildNodeArgs({ pluginDir, runnerPath = RUNNER_PATH, entryPath, entrySha, nodeVersion = process.versions.node, maxOldSpaceMb = 128 }) {
  const flag = permissionFlagFor(nodeVersion);
  return [
    // Read access to the entry file and the runner ONLY, never the folder: the pin covers two files, so a folder grant would
    // let a pinned plugin read whatever else sits in (or is linked from) the folder. The entry is imported from the bytes
    // the runner reads once, so it needs nothing else. `pluginDir` stays in the signature as the cwd the host passes.
    ...(flag ? [flag, `--allow-fs-read=${entryPath}`, `--allow-fs-read=${runnerPath}`] : []),
    `--max-old-space-size=${maxOldSpaceMb}`,
    "--disallow-code-generation-from-strings",
    "--no-experimental-fetch",
    "--no-experimental-websocket",
    runnerPath,
    entryPath,
    entrySha,
  ];
}

/** The child's whole environment: empty. (Windows needs SystemRoot for Node to start.) */
export function cleanEnv(platform = process.platform, source = process.env) {
  return platform === "win32" && source.SystemRoot ? { SystemRoot: source.SystemRoot } : {};
}

/** `fields.kind` on every error, the same vocabulary as the built-in providers, so the router can tell a 429 or a missing symbol from a real fault. */
const KIND = Object.freeze({ RATE_LIMITED: "rate-limited", UNAVAILABLE: "unavailable", TIMEOUT: "timeout", BAD_RESPONSE: "upstream", NOT_FOUND: "not-found", UNSUPPORTED: "unsupported", AUTH: "auth", INTERNAL: "upstream", CANCELLED: "upstream" });

const unavailable = (detail, extra = {}) => new BridgeError("BROKER_UNAVAILABLE", detail, { retryable: false, ...extra, fields: { kind: "unavailable", ...(extra.fields ?? {}) } });

/**
 * @param {object} cfg
 * @param {import("./manifest.mjs").Manifest} cfg.manifest
 * @param {string} cfg.pluginDir  absolute folder
 * @param {string} cfg.entryPath  absolute path of the entry file
 * @param {string} cfg.entrySha   hex sha256 of the entry file, already verified by the loader
 * @param {Record<string, unknown>} [cfg.config]  owner settings, validated against the manifest's configSchema
 * @param {() => Promise<string|undefined>|string|undefined} [cfg.readSecret]  the plugin's API key, when it declares one
 * @param {{ debug?: Function, info?: Function, warn?: Function }} [cfg.logger]
 * @param {() => number} [cfg.clock]
 * @param {typeof spawn} [cfg.spawnImpl]    injected in tests
 * @param {ReturnType<typeof createFetchBroker>} [cfg.broker]  injected in tests
 * @param {(s: {state: string, reason?: string}) => void} [cfg.onStateChange]
 */
export function createPluginHost({
  manifest,
  pluginDir,
  entryPath,
  entrySha,
  config = {},
  readSecret,
  logger,
  clock = () => Date.now(),
  spawnImpl = spawn,
  broker,
  onStateChange,
  nodePath = process.execPath,
  nodeVersion = process.versions.node,
  platform = process.platform,
  hostVersion = "2",
  readyTimeoutMs = READY_TIMEOUT_MS,
  heartbeatMs = HEARTBEAT_MS,
  cancelGraceMs = CANCEL_GRACE_MS,
  stopGraceMs = STOP_GRACE_MS,
}) {
  const limits = effectiveLimits(manifest);
  const net =
    broker ??
    createFetchBroker({ id: manifest.id, version: manifest.version, allowHosts: manifest.network.allowHosts, allowPost: manifest.network.allowPost === true, limits, clock });
  const id = manifest.id;
  const log = (level, msg, fields) => logger?.[level]?.(`plugin ${id}: ${msg}`, fields);

  let child = null; // the live process record, see spawnChild
  let disabledReason = null;
  let stopped = false;
  let lastError = null;
  let nextTryAt = 0;
  let callSeq = 0;
  let secretValues = [];
  const crashes = [];
  const pending = new Map(); // call id -> pending call
  const cancelled = new Map(); // call id -> timer awaiting the child's acknowledgement
  const waiters = [];
  let inFlight = 0;
  let unacked = 0;
  let spawning = null;
  let rateBlockedUntil = 0;
  const callAborts = new Map(); // call id -> AbortController for that call's brokered requests

  const redact = (text) => {
    let out = String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
    for (const s of secretValues) if (s.length >= 4) out = out.split(s).join("[redacted]");
    return out;
  };

  function setDisabled(reason) {
    if (disabledReason) return;
    disabledReason = redact(reason);
    lastError = disabledReason;
    log("warn", `disabled: ${disabledReason}`);
    onStateChange?.({ state: "disabled", reason: disabledReason });
  }

  function failAll(err) {
    for (const p of [...pending.values()]) p.reject(err);
    for (const w of waiters.splice(0)) w.reject(err);
  }

  /** Kill the child now. The exit handler records the crash. */
  function kill(reason) {
    const c = child;
    if (!c || c.killing) return;
    c.killing = true;
    c.reason = reason;
    lastError = redact(reason);
    log("warn", `killing the plugin process: ${lastError}`);
    try {
      c.proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    // A fake or stuck process may never emit "exit"; do not wait for it.
    queueMicrotask(() => onExit(c, null, "SIGKILL"));
  }

  function onExit(c, code, signal) {
    if (c.exited) return;
    c.exited = true;
    clearTimeout(c.readyTimer);
    clearInterval(c.heartbeat);
    for (const t of cancelled.values()) clearTimeout(t);
    cancelled.clear();
    unacked = 0;
    if (child === c) child = null;
    c.fetchAbort.abort();
    c.rejectReady(unavailable(`Plugin ${id} exited before it was ready`));
    const wasIntentional = c.stopping === true;
    const reason = c.reason ?? (code === 0 ? "the plugin process exited" : `the plugin process exited (code ${code ?? signal})`);
    failAll(unavailable(`Plugin ${id}: ${redact(reason)}`));
    if (wasIntentional || stopped) return;
    // Exit codes 3 and 4 mean the runner could not load the entry (hash mismatch, import error) or the versions disagree:
    // restarting would only repeat it.
    if (code === 3 || code === 4) return setDisabled(c.lastLog ? `could not start: ${c.lastLog}` : "could not start the plugin (the entry file did not load)");
    const t = clock();
    crashes.push(t);
    while (crashes.length && crashes[0] <= t - RESTART_WINDOW_MS) crashes.shift();
    lastError = redact(reason);
    if (crashes.length > MAX_RESTARTS) return setDisabled(`crashed ${crashes.length} times in 10 minutes (last: ${reason})`);
    nextTryAt = t + BACKOFF_MS[Math.min(crashes.length - 1, BACKOFF_MS.length - 1)];
    onStateChange?.({ state: "restarting", reason: lastError });
  }

  function handleMessage(c, msg) {
    switch (msg.type) {
      case "ready": {
        if (c.ready) return kill("sent ready twice");
        if (msg.apiVersion !== API_VERSION) return setDisabledAndKill(`speaks apiVersion ${msg.apiVersion}, the host needs ${API_VERSION}`);
        const have = new Set(msg.capabilities);
        const missing = manifest.capabilities.filter((cap) => !have.has(cap));
        if (missing.length) return setDisabledAndKill(`does not implement the capabilities its manifest declares: ${missing.join(", ")}`);
        c.ready = true;
        clearTimeout(c.readyTimer);
        send(c, proto.init(config, c.secrets));
        c.resolveReady();
        return;
      }
      case "result":
      case "error":
        return settle(c, msg);
      case "log":
        c.logsThisSecond = (c.logsThisSecond ?? 0) + 1;
        if (c.logsThisSecond <= MAX_LOGS_PER_SEC) {
          c.lastLog = redact(msg.msg);
          log(msg.level === "error" ? "warn" : msg.level, redact(msg.msg));
        }
        return;
      case "pong":
        c.pingOutstanding = false;
        c.missed = 0;
        return;
      case "fetch":
        return void brokerFetch(c, msg);
      default:
    }
  }

  function setDisabledAndKill(reason) {
    setDisabled(reason);
    kill(reason);
  }

  function settle(c, msg) {
    if (cancelled.has(msg.id)) {
      clearTimeout(cancelled.get(msg.id));
      cancelled.delete(msg.id);
      unacked = 0;
      return;
    }
    const p = pending.get(msg.id);
    if (!p) {
      c.strays = (c.strays ?? 0) + 1;
      if (c.strays > MAX_STRAYS) kill("sent too many answers to calls that were never made or already ended");
      return;
    }
    unacked = 0;
    callAborts.delete(msg.id);
    if (msg.type === "error") {
      const known = Boolean(proto.PLUGIN_ERROR_CODES[msg.code]);
      const code = known ? msg.code : "BAD_RESPONSE";
      const mapped = proto.PLUGIN_ERROR_CODES[code];
      lastError = redact(`${code}: ${msg.message ?? ""}`);
      if (code === "CANCELLED") return p.reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
      if (code === "RATE_LIMITED") rateBlockedUntil = clock() + (msg.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS);
      return p.reject(new BridgeError(mapped, `Plugin ${id}: ${redact(msg.message || code)}`, { ...(msg.retryAfterMs !== undefined ? { retryAfterMs: msg.retryAfterMs } : code === "RATE_LIMITED" ? { retryAfterMs: DEFAULT_RETRY_AFTER_MS } : {}), broker: { id, code }, fields: { kind: KIND[code], source: id } }));
    }
    const v = validateResult(p.method, msg.data, clock());
    if (!v.ok) {
      lastError = redact(v.error);
      return p.reject(new BridgeError("UPSTREAM_ERROR", `Plugin ${id} returned an answer that does not fit the contract (${redact(v.error)}).`, { broker: { id, code: "BAD_RESPONSE" }, fields: { kind: "upstream", source: id } }));
    }
    p.resolve(v.value);
  }

  async function brokerFetch(c, msg) {
    if (c.fetching >= MAX_FETCHES_IN_FLIGHT) return send(c, proto.fetchFail(msg.id, "RATE_LIMITED", "too many requests in flight", 250));
    c.fetching += 1;
    try {
      let signal = c.fetchAbort.signal;
      if (msg.call !== undefined && pending.has(msg.call)) {
        if (!callAborts.has(msg.call)) callAborts.set(msg.call, new AbortController());
        signal = AbortSignal.any([signal, callAborts.get(msg.call).signal]);
      }
      const r = await net.fetch(msg.url, msg.init, { signal, timeoutMs: Math.min(limits.callTimeoutMs, 10_000) });
      send(c, proto.fetchOk(msg.id, r.status, r.headers, r.body));
    } catch (err) {
      const code = typeof err?.code === "string" ? err.code : "NETWORK";
      if (code === "HOST_NOT_ALLOWED") log("warn", `refused a request: ${redact(err.message)}`);
      send(c, proto.fetchFail(msg.id, code, redact(err?.message ?? "request failed"), err?.retryAfterMs));
    } finally {
      c.fetching -= 1;
    }
  }

  function send(c, line) {
    if (c.exited || c.killing || !c.proc.stdin || c.proc.stdin.destroyed) return false;
    try {
      c.proc.stdin.write(line);
      return true;
    } catch {
      return false;
    }
  }

  async function spawnChild() {
    secretValues = [];
    let secrets = {};
    if (manifest.secrets?.includes("apiKey")) {
      const key = await readSecret?.();
      if (!key) throw unavailable(`Plugin ${id} needs an API key. Set it with: mc-bridge sources set-key ${id}`, { retryable: false });
      secrets = { apiKey: key };
      secretValues = [key];
    }
    const args = buildNodeArgs({ pluginDir, entryPath, entrySha, nodeVersion });
    const proc = spawnImpl(nodePath, args, { cwd: pluginDir, env: cleanEnv(platform), stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    const c = { proc, secrets, ready: false, exited: false, killing: false, stopping: false, fetching: 0, fetchAbort: new AbortController(), decoder: new proto.LineDecoder(), windowStart: 0, windowCount: 0, missed: 0, pingId: 0, pingOutstanding: false };
    c.readyPromise = new Promise((resolve, reject) => {
      c.resolveReady = resolve;
      c.rejectReady = reject;
    });
    c.readyPromise.catch(() => {});
    child = c;

    proc.on("error", (err) => {
      c.reason = `could not start the process: ${err?.code ?? err?.message}`;
      onExit(c, null, null);
    });
    proc.on("exit", (code, signal) => onExit(c, code, signal));
    proc.stdin?.on?.("error", () => {});
    proc.stdout?.on?.("data", (chunk) => {
      if (c.exited || c.killing) return;
      const t = clock();
      if (t - c.windowStart >= 1000) {
        c.windowStart = t;
        c.windowCount = 0;
        c.logsThisSecond = 0;
      }
      for (const ev of c.decoder.push(chunk)) {
        if (c.killing) return;
        if (ev.error) return kill(`protocol violation: ${ev.error}`);
        if (++c.windowCount > MAX_MESSAGES_PER_SEC) return kill("protocol violation: message flood");
        const parsed = proto.parseChildMessage(ev.line);
        if (!parsed.ok) return kill(`protocol violation: ${parsed.error}`);
        handleMessage(c, parsed.msg);
      }
    });
    let errBytes = 0;
    proc.stderr?.on?.("data", (chunk) => {
      errBytes += chunk.length;
      if (errBytes <= MAX_STDERR_BYTES) log("warn", `stderr: ${redact(chunk.toString("utf8"))}`);
      else if (errBytes - chunk.length <= MAX_STDERR_BYTES) log("warn", "stderr: further output dropped");
    });

    c.readyTimer = setTimeout(() => kill("did not become ready in time"), readyTimeoutMs);
    c.readyTimer.unref?.();
    send(c, proto.hello(hostVersion));
    c.heartbeat = setInterval(() => {
      if (!c.ready || c.exited) return;
      if (c.pingOutstanding) {
        c.missed += 1;
        if (c.missed >= 2) return kill("did not answer two heartbeats");
      }
      c.pingId += 1;
      c.pingOutstanding = true;
      send(c, proto.ping(c.pingId));
    }, heartbeatMs);
    c.heartbeat.unref?.();
    return c;
  }

  async function ensureRunning() {
    if (disabledReason) throw unavailable(`Plugin ${id} is disabled: ${disabledReason}`);
    if (stopped) throw unavailable(`Plugin ${id} is stopped`);
    if (!child) {
      const t = clock();
      if (t < nextTryAt) throw unavailable(`Plugin ${id} is restarting after a crash (${lastError ?? "unknown"}); next try in ${Math.ceil((nextTryAt - t) / 1000)} s`, { retryAfterMs: nextTryAt - t });
      spawning ??= spawnChild().finally(() => {
        spawning = null;
      });
      await spawning;
    }
    const c = child;
    if (!c) throw unavailable(disabledReason ? `Plugin ${id} is disabled: ${disabledReason}` : `Plugin ${id} is not running`);
    await c.readyPromise;
    return c;
  }

  function acquire(signal) {
    if (inFlight < limits.maxInFlight) {
      inFlight += 1;
      return Promise.resolve();
    }
    if (waiters.length >= MAX_QUEUED) return Promise.reject(unavailable(`Plugin ${id} is busy`, { retryAfterMs: 500 }));
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      waiters.push(w);
      const timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        reject(new BridgeError("UPSTREAM_TIMEOUT", `Plugin ${id} did not take the call in time.`, { fields: { kind: "timeout", source: id } }));
      }, limits.callTimeoutMs);
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        done();
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      };
      w.resolve = () => {
        done();
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  function release() {
    inFlight -= 1;
    const next = waiters.shift();
    if (next) {
      inFlight += 1;
      next.resolve();
    }
  }

  function noteCancel(c, callId) {
    callAborts.get(callId)?.abort();
    callAborts.delete(callId);
    send(c, proto.cancel(callId));
    const timer = setTimeout(() => {
      cancelled.delete(callId);
      unacked += 1;
      if (unacked >= 2) kill("ignored two cancellations");
    }, cancelGraceMs);
    timer.unref?.();
    cancelled.set(callId, timer);
  }

  /**
   * Ask the plugin. Resolves with the validated answer; rejects with a BridgeError (UPSTREAM_TIMEOUT, BROKER_UNAVAILABLE,
   * UPSTREAM_ERROR, UPSTREAM_RATE_LIMITED, SYMBOL_NOT_FOUND, CAPABILITY_UNSUPPORTED) or an AbortError.
   * @param {"quotes"|"history"|"expiries"|"optionChain"|"test"} method
   */
  async function call(method, params, { signal } = {}) {
    if (!proto.METHODS.includes(method)) throw new BridgeError("CAPABILITY_UNSUPPORTED", `Plugin ${id} does not support ${method}.`, { fields: { kind: "unsupported", source: id } });
    if (method !== "test" && !manifest.capabilities.includes(method)) throw new BridgeError("CAPABILITY_UNSUPPORTED", `Plugin ${id} does not declare ${method}.`, { fields: { kind: "unsupported", source: id } });
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const blocked = rateBlockedUntil - clock();
    if (blocked > 0) throw new BridgeError("UPSTREAM_RATE_LIMITED", `Plugin ${id}'s source asked us to slow down; try again in about ${Math.ceil(blocked / 1000)} s.`, { retryAfterMs: blocked, broker: { id, code: "RATE_LIMITED" }, fields: { kind: "rate-limited", source: id } });
    await acquire(signal);
    try {
      const c = await ensureRunning();
      const callId = ++callSeq;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          noteCancel(c, callId);
          cleanup();
          lastError = `no answer within ${limits.callTimeoutMs} ms`;
          reject(new BridgeError("UPSTREAM_TIMEOUT", `Plugin ${id} did not answer within ${limits.callTimeoutMs} ms.`, { broker: { id, code: "TIMEOUT" }, fields: { kind: "timeout", source: id } }));
        }, limits.callTimeoutMs);
        const onAbort = () => {
          noteCancel(c, callId);
          cleanup();
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        };
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          pending.delete(callId);
          callAborts.delete(callId);
        };
        pending.set(callId, {
          method,
          resolve: (v) => (cleanup(), resolve(v)),
          reject: (e) => (cleanup(), reject(e)),
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        const sent = send(c, proto.call(callId, method, params, limits.callTimeoutMs, clock()));
        if (!sent) pending.get(callId)?.reject(unavailable(`Plugin ${id} is not running`));
      });
    } finally {
      release();
    }
  }

  async function stop() {
    stopped = true;
    failAll(unavailable(`Plugin ${id} is stopping`));
    const c = child;
    if (!c) return;
    c.stopping = true;
    send(c, proto.shutdown());
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          c.proc.kill("SIGKILL");
        } catch {
          /* gone */
        }
        onExit(c, null, "SIGKILL");
        resolve();
      }, stopGraceMs);
      t.unref?.();
      c.proc.once?.("exit", () => {
        clearTimeout(t);
        resolve();
      });
      if (c.exited) {
        clearTimeout(t);
        resolve();
      }
    });
  }

  /** @returns {{ state: "idle"|"ready"|"restarting"|"disabled"|"stopped", running: boolean, restarts: number, lastError: string|null, nextTryAt: number|null, reason: string|null }} */
  function status() {
    const t = clock();
    const recent = crashes.filter((x) => x > t - RESTART_WINDOW_MS).length;
    const state = disabledReason ? "disabled" : stopped ? "stopped" : !child && t < nextTryAt ? "restarting" : child?.ready ? "ready" : "idle";
    return { state, running: Boolean(child && !child.exited), restarts: recent, lastError, nextTryAt: state === "restarting" ? nextTryAt : null, reason: disabledReason, network: net.stats() };
  }

  return { call, stop, status, id, kill: (reason = "killed") => kill(reason) };
}
