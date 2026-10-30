/**
 * Python strategy runner (docs/STRATEGIES-PYTHON.md). Runs the user's own strategy files from the strategies folder
 * in their Bridge home as child processes of the system Python, each with an API key made for that run.
 *
 * What it will and will not run:
 *  - Only `<id>.py` files directly in the strategies folder (no sub-folders, no symbolic links, nothing whose name
 *    starts with "_" or "."). The web names a strategy by its id; the path is always rebuilt from the folder
 *    listing, so no request can name a file anywhere else.
 *  - On Linux and macOS the folder and the file must belong to the user running the Bridge and must not be writable
 *    by other users, so another account on the computer cannot slip code into it.
 *  - Reading a file's settings (describe) parses it with Python's ast module and never runs it.
 *
 * Each run:
 *  - an API key made for it: scope "paper" (or "live" after the live checks), limited to the one chosen account,
 *    held only in memory and revoked when the strategy stops. Orders go through POST /v1/orders like any script,
 *    so the kill switch, per-order and daily limits, the order-rate cap and the paper/live gates all apply.
 *  - a minimal environment (PATH, HOME, locale; never the Bridge's own secrets), cwd = the strategies folder.
 *  - stdout and stderr into a ring buffer (the Algo page's log); "@@mcb {json}" lines are SDK messages (hello,
 *    log, heartbeat, order, bye).
 *  - heartbeat: no heartbeat for heartbeatTimeoutMs (startTimeoutMs before the first one) means stuck: killed and
 *    treated as a crash. A crash restarts after a back-off (2 s, 4 s, 8 s ...) up to maxRestarts, then gives up.
 *    Exit 0 is "finished" (the strategy stopped itself), exit 3 "failed" (its file or settings), never restarted.
 *  - the kill switch stops every strategy at once and no strategy starts while it is on.
 */
import { execFile, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { liveAllowedByConfig } from "../core/config.mjs";
import { createCallContext } from "../core/context.mjs";
import { BridgeError } from "../core/errors.mjs";
import { istDay } from "../orders/time.mjs";
import { readJsonState, writeJsonState } from "../safety/stateFile.mjs";
import { RingLog, backoffMs, checkParams, childEnv, orderPrefix, parseLine, strategyBook, strategyIdOf } from "./book.mjs";

export const EXIT_CONFIG = 3;
/** Params for a log line: "lots 1 · stop_loss_pct 30 · exit_on_stop yes". */
export const paramsText = (values) =>
  Object.entries(values)
    .map(([k, v]) => `${k} ${v === true ? "yes" : v === false ? "no" : String(v)}`)
    .join(" · ");
/** The SDK's exit code when the Bridge refused the strategy for good (kill switch, daily limit, scope): not restarted. */
export const EXIT_REFUSED = 4;
export const STATUSES = Object.freeze(["stopped", "starting", "running", "stopping", "restarting", "finished", "failed"]);
const ACTIVE = new Set(["starting", "running", "stopping", "restarting"]);
const MAX_FILE_BYTES = 512 * 1024;
const POSIX = process.platform !== "win32";
const LINES_PER_SECOND = 200;

export const DEFAULTS = Object.freeze({
  enabled: true,
  maxRestarts: 3,
  restartBackoffMs: 2000,
  heartbeatTimeoutMs: 30_000,
  startTimeoutMs: 60_000,
  stopGraceMs: 8000,
  maxRunning: 10,
  logLines: 2000,
  restartResetMs: 600_000,
});

/** Why a file or folder must not be run (POSIX ownership and write bits), or null. */
export function unsafeReason(st, what) {
  if (!POSIX) return null;
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return `${what} belongs to another user`;
  if (st.mode & 0o022) return `other users can change ${what} (run: chmod go-w on it)`;
  return null;
}

/**
 * @param {object} deps  register()'s deps: config, logger, bus, paths, keyStore, audit, accounts, orders, safety, readiness
 * @param {{ spawnImpl?: typeof spawn, execFileImpl?: typeof execFile, now?: () => number, dir?: string, python?: string, sdkDir?: string }} [opts]
 */
export function createStrategyRunner(deps, opts = {}) {
  const { config, bus } = deps;
  const log = deps.logger?.child ? deps.logger.child({ module: "strategies" }) : deps.logger;
  const cfg = { ...DEFAULTS, ...(config.strategies ?? {}) };
  const now = opts.now ?? (() => Date.now());
  const spawnImpl = opts.spawnImpl ?? spawn;
  const execFileImpl = opts.execFileImpl ?? execFile;
  const dataDir = deps.paths?.dataDir ?? config.dataDir;
  const root = deps.paths?.root ?? resolve(import.meta.dirname, "../../..");
  const dir = opts.dir ?? (cfg.dir ? (isAbsolute(cfg.dir) ? cfg.dir : resolve(dirname(dataDir), cfg.dir)) : join(dirname(dataDir), "strategies"));
  const python = opts.python ?? cfg.python ?? (POSIX ? "python3" : "python");
  const sdkDir = opts.sdkDir ?? resolve(root, "sdk/python");
  const examplesDir = resolve(sdkDir, "examples/strategies");
  const statePath = join(dataDir, "strategies", "state.json");

  /** Saved per strategy: the last account and params used, the last run day. Never a key, never live mode. */
  let saved = { settings: {}, keys: [] };
  const loaded = readJsonState(statePath);
  if (loaded.status === "ok") saved = { settings: loaded.value.settings && typeof loaded.value.settings === "object" ? loaded.value.settings : {}, keys: Array.isArray(loaded.value.keys) ? loaded.value.keys.filter((k) => typeof k === "string") : [] };
  else if (loaded.status === "corrupt") log?.warn?.("strategies state file unreadable; starting empty", { path: statePath });
  const persist = () => {
    try {
      writeJsonState(statePath, { version: 1, settings: saved.settings, keys: saved.keys });
    } catch (err) {
      log?.warn?.("could not save strategies state", { err: String(err?.message ?? err) });
    }
  };

  /** @type {Map<string, any>} runtime per strategy id */
  const runtimes = new Map();
  const describeCache = new Map();
  const pnlCache = new Map();
  let closed = false;
  const starting = new Set();
  const revoking = new Set();

  const rtOf = (id) => {
    let rt = runtimes.get(id);
    if (!rt) {
      rt = { id, status: "stopped", account: null, mode: "paper", params: {}, child: null, key: null, keyId: null, runId: null, startedAt: null, runStartedAt: null, lastBeat: null, restarts: 0, crashes: 0, lastExit: null, lastError: null, stopReason: null, stopRequested: false, counts: {}, log: new RingLog(cfg.logLines), restartTimer: null, killTimer: null, hello: null, lastErrorLine: null, rate: { sec: 0, n: 0, dropped: 0 } };
      runtimes.set(id, rt);
    }
    return rt;
  };
  const note = (rt, level, text) => rt.log.push({ at: now(), level, text, run: rt.runId });

  // ── the folder ──

  /** The strategy files in the folder, the ones skipped (and why), or the folder's own problem. Never follows links. */
  function scan() {
    const out = { dir, exists: false, problem: null, files: [], skipped: [] };
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      return out;
    }
    out.exists = true;
    if (!st.isDirectory()) {
      out.problem = "The strategies path is not a folder";
      return out;
    }
    out.problem = unsafeReason(st, "the strategies folder");
    if (out.problem) return out;
    const seen = new Set();
    let names = [];
    try {
      names = readdirSync(dir).sort();
    } catch (err) {
      out.problem = `The strategies folder cannot be read (${err.code ?? "error"})`;
      return out;
    }
    for (const file of names) {
      if (!file.endsWith(".py")) continue;
      const id = strategyIdOf(file);
      if (!id) {
        if (!file.startsWith("_") && !file.startsWith(".")) out.skipped.push({ file, reason: "Use letters, digits, _ or - in the name (at most 32)" });
        continue;
      }
      let fst;
      try {
        fst = lstatSync(join(dir, file));
      } catch {
        continue;
      }
      if (fst.isSymbolicLink()) out.skipped.push({ file, reason: "Symbolic links are not run; copy the file into the folder" });
      else if (!fst.isFile()) continue;
      else if (fst.size > MAX_FILE_BYTES) out.skipped.push({ file, reason: "Larger than 512 KB" });
      else if (seen.has(id)) out.skipped.push({ file, reason: `Another file already has the id ${id}` });
      else {
        const bad = unsafeReason(fst, "this file");
        if (bad) out.skipped.push({ file, reason: bad[0].toUpperCase() + bad.slice(1) });
        else {
          seen.add(id);
          out.files.push({ id, file, path: join(dir, file), size: fst.size, mtimeMs: fst.mtimeMs });
        }
      }
    }
    return out;
  }

  const pyEnv = (extra = {}) => childEnv(process.env, { PYTHONPATH: [sdkDir, process.env.PYTHONPATH].filter(Boolean).join(delimiter), ...extra });
  const pythonMissing = (err) => err?.code === "ENOENT";
  const PY_MISSING = `Python 3 was not found (${python}). Install Python 3.9 or newer, or set strategies.python in the config file.`;

  /** A file's declared name, params and so on, read without running it (cached by size and time). */
  function describe(f) {
    const key = `${f.path}:${f.size}:${f.mtimeMs}`;
    const hit = describeCache.get(f.id);
    if (hit && hit.key === key) return hit.promise;
    const promise = new Promise((done) => {
      // cwd is the SDK folder, not the strategies folder, so no module there can shadow the standard library here.
      execFileImpl(python, ["-m", "mrchartist_bridge", "strategy", "describe", f.path], { cwd: sdkDir, env: pyEnv(), timeout: 15_000, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout) => {
        if (err && pythonMissing(err)) return done({ ok: false, error: PY_MISSING });
        try {
          const r = JSON.parse(String(stdout ?? "").trim().split("\n").pop());
          if (r && r.ok && r.strategy) return done({ ok: true, strategy: r.strategy });
          return done({ ok: false, error: String(r?.error ?? "The file could not be read"), line: Number.isInteger(r?.line) ? r.line : null });
        } catch {
          return done({ ok: false, error: err ? `Could not read the file (${err.killed ? "timed out" : `exit ${err.code}`})` : "Could not read the file" });
        }
      });
    });
    describeCache.set(f.id, { key, promise });
    return promise;
  }

  // ── reads for the page ──

  const readCtx = (account) => createCallContext({ source: "system", principal: { kind: "guard", id: "strategies", label: "Python strategies" }, scopes: ["read"], hookAccounts: [account], log: deps.logger });

  /** The strategy's orders today and its P&L from them (cached briefly; paper reads are local). */
  async function bookOf(id, account, mode, { force = false } = {}) {
    if (!account) return null;
    const ttl = runtimes.get(id) && ACTIVE.has(runtimes.get(id).status) ? 3000 : 15_000;
    const c = pnlCache.get(id);
    if (!force && c && c.account === account && c.mode === mode && now() - c.at < ttl) return c.value;
    const ctx = readCtx(account);
    const prefix = orderPrefix(id);
    const today = istDay(now());
    let orders = [];
    try {
      const page = await deps.orders.list(ctx, { accountId: account, mode, limit: 500 });
      orders = (page.items ?? []).filter((o) => String(o.clientOrderId ?? "").startsWith(prefix) && String(o.placedAt ?? "").slice(0, 10) === today);
    } catch (err) {
      return { error: err?.message ?? "Orders unavailable", orders: [], book: null };
    }
    const held = new Set(strategyBook(orders).positions.filter((p) => p.qty).map((p) => p.symbol));
    const ltps = new Map();
    if (held.size) {
      try {
        const pos = await deps.orders.positions(ctx, account, { mode });
        for (const p of pos.items ?? []) if (held.has(p.symbol) && Number.isFinite(p.ltp)) ltps.set(p.symbol, p.ltp);
      } catch {
        /* P&L without prices: realised only */
      }
    }
    const value = { orders, book: strategyBook(orders, ltps), error: null };
    pnlCache.set(id, { at: now(), account, mode, value });
    return value;
  }

  function publicState(rt, f, d, b) {
    const set = saved.settings[rt.id] ?? {};
    const account = rt.account ?? set.account ?? null;
    const t = now();
    return {
      id: rt.id,
      file: f?.file ?? null,
      name: d?.ok ? d.strategy.name : rt.id,
      description: d?.ok ? d.strategy.description : "",
      problem: d && !d.ok ? d.error : null,
      problemLine: d && !d.ok ? (d.line ?? null) : null,
      params: d?.ok ? d.strategy.params : [],
      symbols: d?.ok ? d.strategy.symbols : [],
      timeframes: d?.ok ? d.strategy.timeframes : [],
      status: rt.status,
      account,
      mode: ACTIVE.has(rt.status) ? rt.mode : "paper",
      lastMode: rt.mode,
      values: { ...(set.params ?? {}), ...(ACTIVE.has(rt.status) ? rt.params : {}) },
      pid: rt.child?.pid ?? null,
      runId: rt.runId,
      startedAt: rt.startedAt ? new Date(rt.startedAt).toISOString() : null,
      uptimeMs: ACTIVE.has(rt.status) && rt.startedAt ? t - rt.startedAt : null,
      lastHeartbeatAt: rt.lastBeat ? new Date(rt.lastBeat).toISOString() : null,
      heartbeatAgeMs: rt.lastBeat && ACTIVE.has(rt.status) ? t - rt.lastBeat : null,
      restarts: rt.restarts,
      maxRestarts: cfg.maxRestarts,
      lastExit: rt.lastExit,
      lastError: rt.lastError,
      stopReason: rt.stopReason,
      counts: rt.counts,
      logSeq: rt.log.seq,
      pnl: b?.book ? { realised: b.book.realised, unrealised: b.book.unrealised, total: b.book.total, open: b.book.open } : null,
      orderCount: b ? b.orders.length : 0,
      // Orders since Start was pressed (restarts included); orderCount is every run today.
      runOrderCount: b && rt.startedAt ? b.orders.filter((o) => Date.parse(o.placedAt) >= rt.startedAt - 1000).length : 0,
      lastRunDay: set.lastRunDay ?? null,
      // Open legs from an earlier run today that this run took over (its open P&L includes them).
      resumedLegs: ACTIVE.has(rt.status) ? rt.resumedLegs ?? 0 : 0,
    };
  }

  /** Every strategy in the folder with its state (and any still running whose file has gone). */
  async function list() {
    const s = scan();
    const ids = new Set(s.files.map((f) => f.id));
    const descs = await Promise.all(s.files.map((f) => describe(f)));
    const today = istDay(now());
    const items = await Promise.all(
      s.files.map(async (f, i) => {
        const rt = rtOf(f.id);
        const set = saved.settings[f.id] ?? {};
        const account = rt.account ?? set.account;
        const ran = ACTIVE.has(rt.status) || rt.runId || set.lastRunDay === today;
        const b = ran && account ? await bookOf(f.id, account, rt.account ? rt.mode : set.lastMode ?? "paper") : null;
        return publicState(rt, f, descs[i], b);
      }),
    );
    for (const rt of runtimes.values()) if (!ids.has(rt.id) && ACTIVE.has(rt.status)) items.push(publicState(rt, null, null, null));
    return { dir: s.dir, exists: s.exists, problem: s.problem, skipped: s.skipped, python, items, killSwitch: killEngaged(), running: [...runtimes.values()].filter((r) => ACTIVE.has(r.status)).length, maxRunning: cfg.maxRunning, examples: exampleFiles().length };
  }

  async function get(id) {
    const s = scan();
    const f = s.files.find((x) => x.id === id);
    const rt = runtimes.get(id);
    if (!f && !(rt && ACTIVE.has(rt.status))) throw new BridgeError("NOT_FOUND", `No strategy ${id} in ${dir}.`);
    const r = rtOf(id);
    const d = f ? await describe(f) : null;
    const set = saved.settings[id] ?? {};
    const account = r.account ?? set.account;
    const b = account ? await bookOf(id, account, r.account ? r.mode : set.lastMode ?? "paper") : null;
    return { ...publicState(r, f, d, b), orders: (b?.orders ?? []).slice(0, 100), positions: b?.book?.positions ?? [], ordersError: b?.error ?? null };
  }

  function logs(id, after, limit) {
    const rt = runtimes.get(id);
    if (!rt) {
      if (!scan().files.some((f) => f.id === id)) throw new BridgeError("NOT_FOUND", `No strategy ${id}.`);
      return { items: [], last: 0, truncated: false };
    }
    return rt.log.since(after, limit);
  }

  // ── start ──

  const killEngaged = () => {
    try {
      return Boolean(deps.safety?.killSwitchStatus?.()?.engaged);
    } catch {
      return false;
    }
  };

  async function audit(ctx, type, accountId, data) {
    try {
      await deps.audit?.append?.({ type, actor: ctx?.key ? { kind: "key", id: ctx.key.id } : { kind: "system", id: "bridge" }, source: ctx?.source ?? "system", accountId: accountId ?? null, requestId: ctx?.requestId ?? null, data });
    } catch (err) {
      log?.warn?.("audit append failed", { type, code: err?.code });
    }
  }

  /**
   * Start a strategy. body: { account, mode?: "paper"|"live", params?, confirmLive? }. Live needs every live gate the
   * Bridge has, a key with the live scope on this request, and confirmLive equal to the strategy id (the second,
   * typed confirmation); a live start that misses any is refused, never downgraded to paper.
   * @param {string} id @param {object} body @param {object} ctx  the HTTP request's context
   */
  async function start(id, body, ctx, { baseUrl }) {
    if (starting.has(id)) throw new BridgeError("STATE_CONFLICT", `${id} is already starting.`);
    starting.add(id);
    try {
      return await startOnce(id, body, ctx, baseUrl);
    } finally {
      starting.delete(id);
    }
  }

  async function startOnce(id, body, ctx, baseUrl) {
    if (closed) throw new BridgeError("STATE_CONFLICT", "The Bridge is shutting down.");
    if (cfg.enabled === false) throw new BridgeError("CAPABILITY_UNSUPPORTED", "Python strategies are turned off (strategies.enabled in the config file).");
    const s = scan();
    if (s.problem) throw new BridgeError("VALIDATION_FAILED", `${s.problem}: ${dir}`);
    const f = s.files.find((x) => x.id === id);
    if (!f) throw new BridgeError("NOT_FOUND", `No strategy ${id} in ${dir}.`);
    const rt = rtOf(id);
    if (ACTIVE.has(rt.status)) throw new BridgeError("STATE_CONFLICT", `${id} is already ${rt.status}.`);
    if (killEngaged()) throw new BridgeError("KILL_SWITCH_ACTIVE", "The kill switch is on, so no strategy can start. Release it on the Safety page first.");
    const running = [...runtimes.values()].filter((r) => ACTIVE.has(r.status)).length;
    if (running >= cfg.maxRunning) throw new BridgeError("CAPACITY_EXCEEDED", `${running} strategies are running already (strategies.maxRunning ${cfg.maxRunning}).`);
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const account = typeof b.account === "string" ? b.account : saved.settings[id]?.account;
    if (!account) throw new BridgeError("VALIDATION_FAILED", "Choose the account the strategy trades on.", { errors: [{ path: "account", message: "required" }] });
    ctx.requireAccountAccess(account);
    const summary = deps.accounts.get(account);
    if (summary.enabled === false) throw new BridgeError("VALIDATION_FAILED", `${account} is turned off.`, { errors: [{ path: "account", message: "account is disabled" }] });
    const mode = b.mode === undefined ? "paper" : b.mode;
    if (mode !== "paper" && mode !== "live") throw new BridgeError("VALIDATION_FAILED", 'mode is "paper" or "live".', { errors: [{ path: "mode", message: "paper or live" }] });
    const d = await describe(f);
    if (!d.ok) throw new BridgeError("VALIDATION_FAILED", `${f.file}${d.line ? `, line ${d.line}` : ""}: ${d.error}`);
    const merged = { ...(saved.settings[id]?.params ?? {}), ...(b.params && typeof b.params === "object" ? b.params : {}) };
    // Saved values for params the file no longer declares are dropped quietly; values sent now are checked strictly.
    const declared = new Set(d.strategy.params.map((p) => p.name));
    for (const k of Object.keys(merged)) if (!declared.has(k) && !(b.params && k in b.params)) delete merged[k];
    const { values, errors } = checkParams(d.strategy.params, merged);
    if (errors.length) throw new BridgeError("VALIDATION_FAILED", `Some params are not valid: ${errors.map((e) => `${e.path.slice(7)} ${e.message}`).join("; ")}`, { errors });
    if (mode === "live") await liveChecks(id, account, summary, b, ctx);

    const label = `Algo ${id}`.slice(0, 60);
    const { key, record } = await deps.keyStore.create({ label, scopes: [mode === "live" ? "live" : "paper"], accounts: [account], clientKind: "script" }, { loopback: true });
    saved.keys = [...new Set([...saved.keys, record.id])];
    saved.settings[id] = { account, params: values, lastRunDay: istDay(now()), lastMode: mode };
    persist();
    Object.assign(rt, { status: "starting", account, mode, params: values, key, keyId: record.id, runId: newRunId(), startedAt: now(), restarts: 0, crashes: 0, lastExit: null, lastError: null, stopReason: null, stopRequested: false, counts: {}, hello: null, lastErrorLine: null, resumedLegs: 0, baseUrl });
    pnlCache.delete(id);
    note(rt, "info", `Start requested: ${mode} on ${account}${Object.keys(values).length ? `, ${paramsText(values)}` : ""}`);
    await audit(ctx, "strategy.started", account, { strategy: id, file: f.file, mode, runId: rt.runId, keyId: record.id, params: values });
    spawnRun(rt, f);
    return rt;
  }

  async function liveChecks(id, account, summary, b, ctx) {
    const refuse = (code, message) => {
      throw new BridgeError(code, message);
    };
    if (b.confirmLive !== id) refuse("CONFIRMATION_REQUIRED", `Live trading needs a second confirmation: send confirmLive "${id}".`);
    if (!ctx.scopes.has("live")) refuse("SCOPE_REQUIRED", 'Starting a live strategy needs a key that has the "live" scope itself.');
    if (summary.broker === "paper") refuse("PAPER_ONLY", `${account} is a paper account; it cannot trade live.`);
    if (!config.safety?.liveTrading) refuse("PAPER_ONLY", "Live trading is off for the Bridge (safety.liveTrading in the config file).");
    const accountCfg = (config.accounts ?? []).find((a) => a.id === account);
    if (!accountCfg || !liveAllowedByConfig(config, accountCfg)) refuse("PAPER_ONLY", `Live trading is not enabled for ${account} (accounts[].live.enabled in the config file).`);
    if (!(accountCfg.live?.allowedSources ?? []).includes("rest")) refuse("PAPER_ONLY", `Strategies send orders through the REST API, and ${account} does not allow live orders from REST (accounts[].live.allowedSources).`);
    try {
      const r = await deps.readiness?.ensureFresh?.(account, { maxAgeMs: 60_000 });
      if (r && r.ok === false) refuse("CANNOT_TRADE", `${account} cannot trade right now: ${(r.reasons ?? []).map((x) => x.message ?? x).join("; ") || r.state}.`);
    } catch (err) {
      if (err instanceof BridgeError) throw err;
    }
    await audit(ctx, "strategy.live_confirmed", account, { strategy: id });
  }

  const newRunId = () => Math.random().toString(36).slice(2, 8).padEnd(6, "0");

  function spawnRun(rt, f) {
    const env = pyEnv({
      MCB_BRIDGE_URL: rt.baseUrl,
      MCB_API_KEY: rt.key,
      MCB_STRATEGY_RUNNER: "1",
      MCB_STRATEGY_ID: rt.id,
      MCB_STRATEGY_RUN: rt.runId,
      MCB_STRATEGY_ACCOUNT: rt.account,
      MCB_STRATEGY_MODE: rt.mode,
      MCB_STRATEGY_PARAMS: JSON.stringify(rt.params),
    });
    let child;
    try {
      child = spawnImpl(python, ["-u", "-m", "mrchartist_bridge", "strategy", "run", f.path], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      finish(rt, "failed", pythonMissing(err) ? PY_MISSING : `Could not start Python: ${err.message}`);
      return;
    }
    rt.child = child;
    rt.runStartedAt = now();
    rt.lastBeat = null;
    rt.hung = false;
    const lines = (stream, name) => {
      if (!stream) return;
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on("line", (line) => onLine(rt, child, line, name));
      stream.on("error", () => {});
    };
    lines(child.stdout, "out");
    lines(child.stderr, "err");
    child.stdin?.on?.("error", () => {});
    child.on("error", (err) => {
      if (rt.child !== child) return;
      rt.child = null;
      finish(rt, "failed", pythonMissing(err) ? PY_MISSING : `Python could not run: ${err.message}`);
    });
    child.on("exit", (code, signal) => onExit(rt, child, code, signal));
    note(rt, "info", `Python started (pid ${child.pid ?? "?"}, run ${rt.runId})`);
  }

  function onLine(rt, child, line, stream) {
    if (rt.child !== child && rt.child !== null) return;
    const p = parseLine(line, stream);
    if (p.kind === "msg") {
      const m = p.msg;
      if (m.t === "heartbeat") {
        rt.lastBeat = now();
        rt.counts = { ticks: m.ticks ?? 0, bars: m.bars ?? 0, orders: m.orders ?? 0, refused: m.refused ?? 0, errors: m.errors ?? 0 };
        if (rt.status === "starting") rt.status = "running";
        return;
      }
      if (m.t === "hello") {
        rt.hello = m;
        rt.lastBeat = now();
        if (rt.status === "starting") rt.status = "running";
        return;
      }
      if (m.t === "resumed") {
        rt.resumedLegs = Number.isInteger(m.legs) ? m.legs : 0;
        return;
      }
      if (m.t === "order") {
        pnlCache.delete(rt.id);
        return;
      }
      if (m.t === "bye") {
        rt.counts = { ticks: m.ticks ?? 0, bars: m.bars ?? 0, orders: m.orders ?? 0, refused: m.refused ?? 0, errors: m.errors ?? 0 };
        return;
      }
      if (m.t === "log") return push(rt, m.level, String(m.msg ?? ""));
      return;
    }
    if (p.text.trim() === "") return;
    push(rt, p.level, p.text);
  }

  /** A log line, with a cap per second so a print loop cannot flood the buffer. */
  function push(rt, level, text) {
    const sec = Math.floor(now() / 1000);
    if (rt.rate.sec !== sec) {
      if (rt.rate.dropped) note(rt, "warn", `${rt.rate.dropped} log lines dropped (more than ${LINES_PER_SECOND} a second)`);
      rt.rate = { sec, n: 0, dropped: 0 };
    }
    if (++rt.rate.n > LINES_PER_SECOND) {
      rt.rate.dropped += 1;
      return;
    }
    if (level === "error") rt.lastErrorLine = text.slice(0, 300);
    note(rt, level, text);
  }

  function onExit(rt, child, code, signal) {
    if (rt.child !== child) return;
    rt.child = null;
    if (rt.killTimer) clearTimeout(rt.killTimer);
    rt.killTimer = null;
    rt.lastExit = { code, signal: signal ?? null, at: new Date(now()).toISOString() };
    pnlCache.delete(rt.id);
    const ran = now() - (rt.runStartedAt ?? now());
    const how = signal ? `signal ${signal}` : `exit code ${code}`;
    if (rt.stopRequested) return finish(rt, "stopped", rt.stopReason ?? "Stopped");
    if (code === 0) return finish(rt, "finished", rt.hello ? "The strategy stopped itself" : "Python exited before the strategy started");
    if (code === EXIT_CONFIG) return finish(rt, "failed", rt.lastErrorLine ?? "The file or its params have a problem");
    if (code === EXIT_REFUSED) return finish(rt, "failed", rt.lastErrorLine ?? "The Bridge refused it; not restarted");
    if (ran >= cfg.restartResetMs) rt.restarts = 0;
    rt.crashes += 1;
    const why = rt.hung ? `stuck (no heartbeat for ${Math.round(cfg.heartbeatTimeoutMs / 1000)} s)` : `crashed (${how})`;
    if (rt.restarts < cfg.maxRestarts && !closed && !killEngaged()) {
      const wait = backoffMs(rt.restarts, cfg.restartBackoffMs);
      rt.restarts += 1;
      rt.status = "restarting";
      rt.lastError = `${why[0].toUpperCase()}${why.slice(1)}${rt.lastErrorLine ? `: ${rt.lastErrorLine}` : ""}`;
      note(rt, "warn", `The strategy ${why}. Restarting in ${Math.round(wait / 1000)} s (restart ${rt.restarts} of ${cfg.maxRestarts}).`);
      rt.restartTimer = setTimeout(() => {
        rt.restartTimer = null;
        if (rt.status !== "restarting" || closed) return;
        const f = scan().files.find((x) => x.id === rt.id);
        if (!f) return finish(rt, "failed", "The file is no longer in the strategies folder");
        if (killEngaged()) return finish(rt, "stopped", "Kill switch");
        rt.status = "starting";
        rt.runId = newRunId();
        spawnRun(rt, f);
      }, wait);
      rt.restartTimer.unref?.();
      return;
    }
    const msg = killEngaged() ? `The strategy ${why}; not restarted while the kill switch is on` : `The strategy ${why} ${rt.restarts ? `after ${rt.restarts} restart${rt.restarts === 1 ? "" : "s"}` : ""}; gave up`.replace(/\s+;/, ";");
    finish(rt, "failed", `${msg}${rt.lastErrorLine ? `. Last error: ${rt.lastErrorLine}` : ""}`);
  }

  function finish(rt, status, reason) {
    if (rt.restartTimer) clearTimeout(rt.restartTimer);
    rt.restartTimer = null;
    rt.status = status;
    rt.stopReason = reason;
    if (status === "failed") rt.lastError = reason;
    const lc = String(reason).replace(/^[A-Z](?=[a-z ])/, (c) => c.toLowerCase());
    note(rt, status === "failed" ? "error" : "info", status === "stopped" ? String(reason) : `${status === "failed" ? "Failed" : "Finished"}: ${lc}`);
    const keyId = rt.keyId;
    rt.key = null;
    rt.keyId = null;
    if (keyId) {
      const p = revokeKey(keyId);
      revoking.add(p);
      p.finally(() => revoking.delete(p));
    }
    audit(null, status === "failed" ? "strategy.failed" : "strategy.stopped", rt.account, { strategy: rt.id, runId: rt.runId, status, reason: String(reason).slice(0, 300), exit: rt.lastExit });
  }

  async function revokeKey(keyId) {
    try {
      await deps.keyStore.revoke(keyId);
      saved.keys = saved.keys.filter((k) => k !== keyId);
      persist();
    } catch (err) {
      log?.warn?.("could not revoke a strategy key", { keyId, code: err?.code });
    }
  }

  // ── stop ──

  /** Stop one strategy: SIGTERM (the SDK runs on_stop), then SIGKILL after stopGraceMs. */
  function stop(id, reason = "Stopped from the dashboard", { graceMs = cfg.stopGraceMs } = {}) {
    const rt = runtimes.get(id);
    if (!rt || !ACTIVE.has(rt.status)) {
      if (!rt && !scan().files.some((f) => f.id === id)) throw new BridgeError("NOT_FOUND", `No strategy ${id}.`);
      return rtOf(id);
    }
    rt.stopRequested = true;
    rt.stopReason = reason;
    if (rt.status === "restarting" || !rt.child) {
      finish(rt, "stopped", reason);
      return rt;
    }
    rt.status = "stopping";
    note(rt, "info", `Stop requested: ${reason}`);
    const child = rt.child;
    // POSIX: SIGTERM (the SDK runs on_stop). Windows has no gentle signal, so closing stdin asks the SDK to stop.
    try {
      if (POSIX) child.kill("SIGTERM");
      else child.stdin?.end?.();
    } catch {
      /* already gone */
    }
    if (rt.killTimer) clearTimeout(rt.killTimer);
    rt.killTimer = setTimeout(() => {
      if (rt.child === child) {
        note(rt, "warn", `Did not stop within ${Math.round(graceMs / 1000)} s; ended it`);
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }
    }, graceMs);
    rt.killTimer.unref?.();
    return rt;
  }

  function stopAll(reason, opts) {
    const ids = [...runtimes.values()].filter((r) => ACTIVE.has(r.status)).map((r) => r.id);
    for (const id of ids) stop(id, reason, opts);
    return ids;
  }

  /** Change the saved account and params (used by the next start). */
  async function saveSettings(id, body, ctx) {
    const f = scan().files.find((x) => x.id === id);
    if (!f) throw new BridgeError("NOT_FOUND", `No strategy ${id} in ${dir}.`);
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const cur = saved.settings[id] ?? {};
    let account = cur.account;
    if (b.account !== undefined) {
      if (typeof b.account !== "string") throw new BridgeError("VALIDATION_FAILED", "account is an account id.", { errors: [{ path: "account", message: "string" }] });
      ctx.requireAccountAccess(b.account);
      deps.accounts.get(b.account);
      account = b.account;
    }
    let params = cur.params ?? {};
    if (b.params !== undefined) {
      const d = await describe(f);
      if (!d.ok) throw new BridgeError("VALIDATION_FAILED", `${f.file}: ${d.error}`);
      const r = checkParams(d.strategy.params, b.params);
      if (r.errors.length) throw new BridgeError("VALIDATION_FAILED", `Some params are not valid: ${r.errors.map((e) => `${e.path.slice(7)} ${e.message}`).join("; ")}`, { errors: r.errors });
      params = r.values;
    }
    saved.settings[id] = { ...cur, account, params };
    persist();
    return get(id);
  }

  // ── examples ──

  function exampleFiles() {
    try {
      return readdirSync(examplesDir).filter((x) => strategyIdOf(x));
    } catch {
      return [];
    }
  }

  /** Copy the shipped examples into the folder (creating it, owner-only); never overwrites a file. */
  function addExamples() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const added = [];
    const kept = [];
    for (const file of exampleFiles()) {
      const to = join(dir, file);
      if (existsSync(to)) {
        kept.push(file);
        continue;
      }
      copyFileSync(join(examplesDir, file), to);
      try {
        chmodSync(to, 0o644);
      } catch {
        /* Windows */
      }
      added.push(file);
    }
    return { dir, added, kept };
  }

  // ── health and the kill switch ──

  const health = setInterval(() => {
    const t = now();
    for (const rt of runtimes.values()) {
      if (!rt.child || rt.stopRequested || !(rt.status === "running" || rt.status === "starting")) continue;
      const since = rt.lastBeat ?? rt.runStartedAt;
      const limit = rt.lastBeat ? cfg.heartbeatTimeoutMs : cfg.startTimeoutMs;
      if (t - since > limit) {
        rt.hung = true;
        note(rt, "error", `No heartbeat for ${Math.round((t - since) / 1000)} s: the strategy looks stuck, so it was ended`);
        try {
          rt.child.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
  }, 2000);
  health.unref?.();

  const offKill = bus?.on?.("safety.kill_switch", (p) => {
    if (!p?.engaged) return;
    const ids = stopAll(`Kill switch: ${p.reason ?? "engaged"}`, { graceMs: Math.min(cfg.stopGraceMs, 3000) });
    if (ids.length) log?.warn?.("kill switch stopped strategies", { strategies: ids });
  });

  /** Revoke keys of runs that did not end cleanly (the Bridge stopped without stopping them). */
  async function revokeOrphans() {
    const live = new Set([...runtimes.values()].map((r) => r.keyId).filter(Boolean));
    for (const k of saved.keys) if (!live.has(k)) await revokeKey(k);
  }

  /** Stop everything and wait for the processes (at most stopGraceMs + 1 s). */
  async function close() {
    closed = true;
    clearInterval(health);
    if (typeof offKill === "function") offKill();
    const waiting = [...runtimes.values()].filter((r) => r.child).map((r) => new Promise((done) => r.child.once("exit", () => done())));
    stopAll("The Bridge is shutting down");
    for (const rt of runtimes.values()) if (rt.restartTimer) finish(rt, "stopped", "The Bridge is shutting down");
    await Promise.race([Promise.all(waiting), new Promise((r) => setTimeout(r, cfg.stopGraceMs + 1000).unref?.())]);
    await Promise.all([...revoking]);
  }

  return { dir, python, scan, list, get, logs, start, stop, stopAll, saveSettings, addExamples, revokeOrphans, close, runtimes, describe };
}
