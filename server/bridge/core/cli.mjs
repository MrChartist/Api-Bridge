/**
 * CLI implementation behind bin/mc-bridge.mjs, kept here so it can be tested without spawning processes.
 * Commands delegate to the contract services (KeyStore, AccountManager, AuditLog); until a stream lands, its
 * command prints a clear "not built yet" message and exits with code 2.
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { createBrokerRegistry } from "../../brokers/registry.mjs";
import { SERVICE_CONTRACTS, isStub } from "./contracts.mjs";
import { BridgeError, NotImplementedError } from "./errors.mjs";
import { isLoopbackHost, loadConfig } from "./config.mjs";
import { createLogger } from "./logger.mjs";

export const USAGE = `Mr. Chartist API Bridge

Usage:
  mc-bridge start [--config <file>]
  mc-bridge keys create --label <name> --scope read[,paper,live,admin] [--accounts a,b|*] [--expires 30d] [--allow-query] [--client <kind>]
  mc-bridge keys list
  mc-bridge keys revoke <keyId>
  mc-bridge accounts list
  mc-bridge accounts connect <accountId> [--key <admin key>] [--url http://127.0.0.1:4300]
  mc-bridge doctor [--no-port-check]
  mc-bridge kill [--reason <text>] [--cancel-open] [--key <key>]
  mc-bridge kill release [--key <admin key>]
  mc-bridge mcp --key <key> [--url http://127.0.0.1:4300] [--config <file>]
  mc-bridge openai-tools [--scope read|paper] [--format responses|chat]

Config: --config, or MCB_CONFIG, or ./bridge.config.json, or the per-user folder (~/.mc-bridge, or
%APPDATA%\\MrChartist\\Bridge on Windows; MCB_HOME overrides). Safe defaults when absent: paper only, 127.0.0.1:4300.
mcp also honours MCB_BRIDGE_URL.`;

/** Parse "30d", "12h", "90m" or an ISO date into an ISO timestamp. */
export function parseExpiry(value, now = Date.now()) {
  if (value === undefined) return null;
  const m = /^(\d{1,4})([dhm])$/.exec(String(value));
  if (m) {
    const ms = Number(m[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2]];
    return new Date(now + ms).toISOString();
  }
  const t = Date.parse(String(value));
  if (!Number.isFinite(t) || t <= now) throw new BridgeError("VALIDATION_FAILED", `--expires must be like 30d, 12h or a future ISO date, got ${value}.`);
  return new Date(t).toISOString();
}

/**
 * Environment and config checks for `mc-bridge doctor`. Pure apart from file-system and port probes.
 * @returns {Promise<Array<{ level: "ok"|"warn"|"fail", check: string, message: string }>>}
 */
export async function runDoctor({ config, warnings = [], source = null, env = process.env, portCheck = true, deps = null }) {
  const out = [];
  const add = (level, check, message) => out.push({ level, check, message });
  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 20 ? "ok" : "fail", "node", `Node.js ${process.versions.node}${major >= 20 ? "" : " (20 or newer is required)"}`);
  add("ok", "config", source ? `Loaded ${source}` : "No config file; using safe defaults");
  for (const w of warnings) add("warn", "config", w);
  const host = config.server.host;
  add(isLoopbackHost(host) ? "ok" : "warn", "bind", `Listening address ${host}:${config.server.port}${isLoopbackHost(host) ? " (this computer only)" : " (reachable from other machines)"}`);
  add("ok", "cors", config.cors.allowedOrigins.length ? `Allowed web origins: ${config.cors.allowedOrigins.join(", ")}` : "No web page origins allowed (scripts and tools are unaffected)");
  add(config.server.publicIngress.enabled ? "warn" : "ok", "public-ingress", config.server.publicIngress.enabled ? `Public ingress on ${config.server.publicIngress.host}:${config.server.publicIngress.port} (webhook routes only)` : "Public ingress off");

  const dataDir = config.dataDir;
  if (existsSync(dataDir)) {
    try {
      accessSync(dataDir, constants.W_OK);
      const mode = statSync(dataDir).mode & 0o777;
      if (process.platform !== "win32" && mode & 0o077) add("warn", "data-dir", `${dataDir} is readable by other users (mode ${mode.toString(8)}); run chmod 700`);
      else add("ok", "data-dir", `${dataDir} is writable`);
    } catch {
      add("fail", "data-dir", `${dataDir} is not writable`);
    }
  } else add("ok", "data-dir", `${dataDir} will be created when the Bridge first starts`);

  if (env.MCB_MASTER_KEY) {
    const len = Buffer.from(env.MCB_MASTER_KEY, "base64").length;
    add(len === 32 ? "ok" : "fail", "master-key", len === 32 ? "MCB_MASTER_KEY is set (32 bytes)" : `MCB_MASTER_KEY must be base64 of 32 bytes, got ${len}`);
  } else {
    const keyFile = env.MCB_MASTER_KEY_FILE ?? join(dataDir, "master.key");
    const sameFolder = resolve(dirname(keyFile)) === resolve(dataDir);
    if (existsSync(keyFile)) {
      const mode = statSync(keyFile).mode & 0o777;
      const tooOpen = process.platform !== "win32" && mode & 0o077;
      add(tooOpen ? "fail" : "ok", "master-key", tooOpen ? `${keyFile} is readable by other users (mode ${mode.toString(8)}); run chmod 600` : `Key file ${keyFile}`);
    } else add("warn", "master-key", `No master key yet; ${keyFile} will be created (mode 600) when you first connect a broker`);
    if (sameFolder) {
      add("warn", "master-key", `The master key sits in the data folder next to secrets.enc, so a backup, cloud sync or zip of ${dataDir} carries both and the encryption adds nothing. Move it outside (for example ${process.platform === "win32" ? "%APPDATA%\\MrChartist\\master.key" : "~/.config/mc-bridge/master.key"}) and set MCB_MASTER_KEY_FILE, or use MCB_MASTER_KEY.`);
    }
    if (process.platform === "win32") add("warn", "master-key", "File permissions are not checked on Windows. Restrict the key file to your user: icacls <file> /inheritance:r /grant:r %USERNAME%:F");
  }

  const s = config.safety;
  add("ok", "order-rate", `Order rate cap ${s.orderRatePerSecond}/s per account (ceiling 10/s for unregistered retail algos; needs verification)`);
  const liveAccounts = config.accounts.filter((a) => a.live.enabled).map((a) => a.id);
  if (!s.liveTrading) add("ok", "live-trading", "Live trading is off (paper only)");
  else add("warn", "live-trading", `Live trading is ON for: ${liveAccounts.join(", ") || "no account (enable per account)"}. Orders must leave from your broker-registered static IP.`);
  if (s.killSwitchOnStart) add("warn", "kill-switch", "The kill switch will be engaged at start");
  add(config.accounts.length ? "ok" : "warn", "accounts", config.accounts.length ? `${config.accounts.length} account(s): ${config.accounts.map((a) => `${a.id} (${a.broker})`).join(", ")}` : "No accounts configured yet");
  try {
    new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata" }).format(new Date());
    add("ok", "timezone", "Asia/Kolkata time zone data available");
  } catch {
    add("fail", "timezone", "This Node.js build has no Asia/Kolkata time zone data (install full-icu)");
  }
  if (deps) {
    const stubs = Object.keys(SERVICE_CONTRACTS).filter((k) => isStub(deps[k]));
    add(stubs.length ? "warn" : "ok", "services", stubs.length ? `Not built yet: ${stubs.map((k) => SERVICE_CONTRACTS[k].iface).join(", ")}` : "All services built");
  }
  // Paper trading still needs prices and an instrument list, and both come from a connected broker account.
  if (deps && !isStub(deps.accounts)) {
    try {
      const brokers = deps.accounts.list().filter((a) => a.broker !== "paper");
      const connected = brokers.filter((a) => a.session?.state === "connected");
      if (connected.length) add("ok", "market-data", `Market data from: ${connected.map((a) => a.id).join(", ")}`);
      else add("warn", "market-data", `No market-data source connected${brokers.length ? ` (log in ${brokers.map((a) => a.id).join(", ")})` : ""}. Quotes, history, option chains, symbol lookups and paper orders all need at least one connected broker account (mc-bridge accounts connect <id>).`);
    } catch {
      /* account manager not available */
    }
  }
  if (portCheck) {
    const free = await new Promise((r) => {
      const srv = net.createServer();
      srv.once("error", () => r(false));
      srv.listen(config.server.port, host, () => srv.close(() => r(true)));
    });
    add(free ? "ok" : "warn", "port", free ? `Port ${config.server.port} is free` : `Port ${config.server.port} is in use (is the Bridge already running?)`);
  }
  return out;
}

async function bootServices(flags, io, { server = false } = {}) {
  const { config, warnings, source } = loadConfig({ path: flags.config, env: io.env, cwd: io.cwd, knownBrokers: createBrokerRegistry().list() });
  const { createApp } = await import("./app.mjs");
  // The server logs at the configured level; one-shot commands only show warnings and errors.
  const logger = createLogger({ level: server || config.logging.level === "debug" ? config.logging.level : "warn" });
  const app = await createApp({ config, logger, warnings });
  return { app, config: app.config, warnings, source, logger };
}

/** Base URL of the running Bridge: --url, else MCB_BRIDGE_URL, else the config's host and port. */
export function bridgeUrl(flags, io, config) {
  const explicit = typeof flags.url === "string" ? flags.url : io.env.MCB_BRIDGE_URL;
  if (explicit) {
    let u;
    try {
      u = new URL(explicit);
    } catch {
      throw new BridgeError("VALIDATION_FAILED", `Not a valid Bridge URL: ${explicit}`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new BridgeError("VALIDATION_FAILED", "The Bridge URL must start with http:// or https://.");
    return u.origin;
  }
  const h = config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host === "::" ? "::1" : config.server.host;
  const host = h.includes(":") ? `[${h}]` : h;
  return `http://${host}:${config.server.port}`;
}

/** Lines printed after `start`: where the dashboard is and what to do next. Exported for tests. */
export async function startHints({ app, port }) {
  const lines = [];
  const host = app.config.server.host === "0.0.0.0" ? "127.0.0.1" : app.config.server.host;
  lines.push(`Dashboard (this computer only): http://${host.includes(":") ? `[${host}]` : host}:${port}/dashboard`);
  try {
    const keys = (await app.deps.keyStore.list()).filter((k) => !k.revokedAt && !(k.expiresAt && Date.parse(k.expiresAt) < Date.now()));
    if (keys.length === 0) lines.push("No API keys yet. In a second terminal, from this same folder: mc-bridge keys create --label me --scope read,paper");
    else lines.push(`${keys.length} active API key(s).`);
  } catch {
    /* key store not built */
  }
  try {
    const rows = app.deps.accounts.list().filter((a) => a.broker !== "paper");
    const live = rows.filter((a) => a.session?.state === "connected");
    if (rows.length === 0) lines.push('No market-data source connected: no broker account is configured. Quotes and even paper orders need one; add it under "accounts" in bridge.config.json (see docs/guides/accounts.md).');
    else if (live.length === 0) lines.push(`No market-data source connected (${rows.map((a) => a.id).join(", ")} not logged in). Quotes and even paper orders need one: mc-bridge accounts connect <id>.`);
    else lines.push(`Market data from: ${live.map((a) => a.id).join(", ")}.`);
  } catch {
    /* account manager not built */
  }
  return lines;
}

async function audit(deps, io, input) {
  try {
    await deps.audit.append({ actor: { kind: "local", id: "cli" }, source: "cli", ...input });
  } catch (err) {
    if (err instanceof NotImplementedError) io.err("Note: the audit log is not built yet; this action was not audited.");
    else throw err;
  }
}

/**
 * @param {string[]} positionals
 * @param {Record<string, string | boolean | undefined>} flags
 * @param {{ out(s: string): void, err(s: string): void, env: NodeJS.ProcessEnv, cwd: string }} io
 * @returns {Promise<number | null>} exit code, or null while `start` keeps running
 */
export async function runCli(positionals, flags, io) {
  const [cmd, sub, arg] = positionals;
  if (flags.version) {
    const { BRIDGE_VERSION } = await import("./app.mjs");
    io.out(BRIDGE_VERSION);
    return 0;
  }
  if (flags.help || !cmd) {
    io.out(USAGE);
    return cmd || flags.help ? 0 : 1;
  }
  try {
    switch (cmd) {
      case "start": {
        const { app } = await bootServices(flags, io, { server: true });
        const { port, publicPort } = await app.listen();
        io.err(`Mr. Chartist API Bridge listening on http://${app.config.server.host}:${port}${publicPort ? ` (public ingress on ${publicPort})` : ""}`);
        io.err(`Data folder: ${app.config.dataDir}`);
        for (const line of await startHints({ app, port })) io.err(line);
        const stop = async () => {
          await app.close();
          process.exit(0);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        return null;
      }
      case "doctor": {
        // Doctor must not create anything: only boot the services (which create the data folder) when it exists.
        const loaded = loadConfig({ path: flags.config, env: io.env, cwd: io.cwd, knownBrokers: createBrokerRegistry().list() });
        let deps = null;
        let { config, warnings, source } = loaded;
        if (existsSync(loaded.config.dataDir)) ({ app: { deps }, config, warnings, source } = await bootServices(flags, io));
        const checks = await runDoctor({ config, warnings, source, env: io.env, portCheck: !flags["no-port-check"], deps });
        if (flags.json) io.out(JSON.stringify(checks, null, 2));
        else for (const c of checks) io.out(`${c.level === "ok" ? "OK  " : c.level === "warn" ? "WARN" : "FAIL"}  ${c.check.padEnd(14)} ${c.message}`);
        return checks.some((c) => c.level === "fail") ? 1 : 0;
      }
      case "keys": {
        const { app, source } = await bootServices(flags, io);
        if (!source) io.err(`Note: no bridge.config.json was found, so keys live in ${app.config.dataDir}. A Bridge started with a config file elsewhere will not know them; run this from the Bridge's folder or pass --config.`);
        const { keyStore } = app.deps;
        if (sub === "create") {
          if (!flags.label || !flags.scope) throw new BridgeError("VALIDATION_FAILED", "keys create needs --label and --scope.");
          const scopes = String(flags.scope).split(",").map((s) => s.trim()).filter(Boolean);
          const accounts = flags.accounts === undefined || flags.accounts === "*" ? "*" : String(flags.accounts).split(",").map((s) => s.trim());
          const { key, record } = await keyStore.create({
            label: String(flags.label),
            scopes,
            accounts,
            expiresAt: parseExpiry(flags.expires),
            allowQuery: flags["allow-query"] === true,
            clientKind: flags.client ? String(flags.client) : "other",
          });
          await audit(app.deps, io, { type: "key.created", data: { keyId: record.id, scopes: record.scopes, label: record.label } });
          io.out(`Created key ${record.id} (${record.scopes.join(", ")}). Copy it now; it will not be shown again:\n\n  ${key}\n`);
          return 0;
        }
        if (sub === "list") {
          const rows = await keyStore.list();
          if (flags.json) io.out(JSON.stringify(rows, null, 2));
          else if (rows.length === 0) io.out("No keys yet. Create one with: mc-bridge keys create --label <name> --scope read");
          else for (const r of rows) io.out(`${r.id}  ${r.scopes.join(",").padEnd(16)} ${r.revokedAt ? "revoked " : r.expiresAt && Date.parse(r.expiresAt) < Date.now() ? "expired " : "active  "} ${r.label}`);
          return 0;
        }
        if (sub === "revoke") {
          if (!arg) throw new BridgeError("VALIDATION_FAILED", "keys revoke needs a key id.");
          const record = await keyStore.revoke(arg);
          await audit(app.deps, io, { type: "key.revoked", data: { keyId: record.id } });
          io.out(`Revoked key ${record.id}.`);
          return 0;
        }
        io.err(USAGE);
        return 1;
      }
      case "accounts": {
        if (sub === "connect") return await connectCommand(arg, flags, io);
        if (sub !== "list") {
          io.err(USAGE);
          return 1;
        }
        const { app } = await bootServices(flags, io);
        const rows = app.deps.accounts.list();
        if (flags.json) io.out(JSON.stringify(rows, null, 2));
        else if (rows.length === 0) io.out("No accounts configured. Add them under \"accounts\" in bridge.config.json.");
        else for (const a of rows) io.out(`${a.id.padEnd(20)} ${a.broker.padEnd(14)} ${a.session.state.padEnd(10)} ${a.liveAllowedByConfig ? "live-enabled" : "paper"}  ${a.label}`);
        return 0;
      }
      case "mcp": {
        // A relay to the RUNNING Bridge (POST /mcp), so AI tools share its connections, limits, safety and audit.
        const raw = typeof flags.key === "string" ? flags.key : io.env.MCB_API_KEY;
        if (!raw) throw new BridgeError("UNAUTHENTICATED", "mcp needs --key or MCB_API_KEY (use a key created for this AI client).");
        // AI apps start this process in their own folder, so --url / MCB_BRIDGE_URL come first; the config lookup
        // (--config, MCB_CONFIG, ./bridge.config.json, then the per-user folder) is the fallback.
        const explicitUrl = typeof flags.url === "string" || Boolean(io.env.MCB_BRIDGE_URL);
        const config = explicitUrl ? null : loadConfig({ path: flags.config, env: io.env, cwd: io.cwd }).config;
        const baseUrl = bridgeUrl(flags, io, config);
        const alive = await fetch(`${baseUrl}/v1/health`).then((r) => r.ok, () => false);
        // Keep running anyway: the relay answers initialize itself and retries the Bridge on every request, so the AI
        // client does not mark this server as failed when it starts before the Bridge (stderr only; stdout is MCP).
        if (!alive) io.err(`The Bridge is not running at ${baseUrl} yet. Start it with 'npm start' in the api-bridge folder; the MCP relay will connect when it is up.`);
        const { runStdio } = await import("../mcp/stdio.mjs");
        await runStdio({ baseUrl, apiKey: raw, stdin: process.stdin, stdout: process.stdout, logger: createLogger({ level: "warn" }) });
        return 0;
      }
      case "openai-tools": {
        // The MCP tool registry as strict OpenAI function schemas, for your own scripts (no key, no server needed).
        const { config } = loadConfig({ path: flags.config, env: io.env, cwd: io.cwd });
        const scope = flags.scope === undefined ? "read" : String(flags.scope);
        if (!["read", "paper"].includes(scope)) throw new BridgeError("VALIDATION_FAILED", "--scope must be read or paper.");
        const format = flags.format === undefined ? "responses" : String(flags.format);
        if (!["responses", "chat"].includes(format)) throw new BridgeError("VALIDATION_FAILED", "--format must be responses or chat.");
        const { toOpenAITools } = await import("../mcp/openaiSchemas.mjs");
        io.out(JSON.stringify(toOpenAITools({ config, scopes: [scope], format }), null, 2));
        return 0;
      }
      case "kill":
        return await killCommand(sub, flags, io);
      default:
        io.err(`Unknown command "${cmd}".\n\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    if (err instanceof NotImplementedError) {
      io.err(`${err.detail} This command needs a part of the Bridge that is still being built.`);
      return 2;
    }
    if (err instanceof BridgeError) {
      io.err(`Error: ${err.detail}`);
      return 1;
    }
    throw err;
  }
}

/**
 * `mc-bridge kill` / `mc-bridge kill release`. When the Bridge is running, the command goes through its API (the
 * running process holds the kill-switch state; engaging needs any key, releasing an admin key, both from this
 * computer). When it is not running, the CLI engages or releases the persisted kill switch directly, as the local
 * principal, with the same audit record, so trading stays stopped when the Bridge next starts.
 */
async function killCommand(sub, flags, io) {
  const release = sub === "release";
  if (sub !== undefined && !release) {
    io.err(USAGE);
    return 1;
  }
  // In a panic nobody should have to think of a reason: default to "manual".
  const reason = typeof flags.reason === "string" && flags.reason.trim() ? flags.reason.trim() : "manual";
  if (reason.length > 200) throw new BridgeError("VALIDATION_FAILED", "--reason must be at most 200 characters.");
  const { config } = loadConfig({ path: flags.config, env: io.env, cwd: io.cwd });
  const baseUrl = bridgeUrl(flags, io, config);
  const alive = await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  if (alive) {
    const key = typeof flags.key === "string" ? flags.key : io.env.MCB_API_KEY;
    if (!key) throw new BridgeError("UNAUTHENTICATED", `The Bridge is running at ${baseUrl}; pass --key (or MCB_API_KEY)${release ? " with an admin key" : ""}, or use the dashboard.`);
    const res = await fetch(`${baseUrl}/v1/safety/kill-switch`, {
      method: release ? "DELETE" : "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(release ? { confirm: "RELEASE" } : { reason, cancelOpenOrders: flags["cancel-open"] === true }),
    });
    if (!res.ok) {
      const problem = await res.json().catch(() => ({}));
      io.err(`Error: ${problem.detail ?? `the Bridge answered HTTP ${res.status}`}`);
      return 1;
    }
    io.out(release ? "Kill switch released. Orders can be sent again." : `Kill switch engaged: ${reason}. No orders will be sent; cancels still work.`);
    const answer = await res.json().catch(() => ({}));
    for (const w of answer?.data?.warnings ?? []) io.err(`Note: ${w}`);
    return 0;
  }
  const { app } = await bootServices(flags, io);
  const ctx = { principal: { kind: "local", id: "cli" }, source: "cli", loopback: true, scopes: new Set(["admin"]), requestId: "cli" };
  if (release) {
    await app.deps.safety.releaseKillSwitch(ctx, { confirm: "RELEASE" });
    io.out("Kill switch released (the Bridge was not running). Orders can be sent once it starts.");
  } else {
    await app.deps.safety.engageKillSwitch(ctx, { reason, cancelOpenOrders: false });
    io.out(`Kill switch engaged (the Bridge was not running): ${reason}. It stays on when the Bridge starts.`);
    if (flags["cancel-open"] === true) io.err("Note: open orders can only be cancelled while the Bridge is running. Start it and run this again with --cancel-open, or cancel them at your broker.");
  }
  return 0;
}

/**
 * Read one line from the terminal without echoing it (for tokens, PINs and TOTP codes), on stderr so stdout stays
 * clean. Used by `accounts connect`; tests inject io.prompt instead.
 * @param {string} label @param {{ hidden?: boolean }} [opts]
 * @returns {Promise<string>}
 */
export async function terminalPrompt(label, { hidden = true } = {}) {
  const { createInterface } = await import("node:readline");
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: Boolean(process.stdin.isTTY) });
    let asked = false;
    if (hidden) {
      // Print the question once, then swallow the echo of what is typed.
      rl._writeToOutput = (s) => {
        if (!asked) process.stderr.write(s);
      };
    }
    rl.question(`${label}: `, (answer) => {
      if (hidden) process.stderr.write("\n");
      rl.close();
      resolve(answer);
    });
    asked = true;
  });
}

/**
 * `mc-bridge accounts connect <id>`: ask for each field the account's broker needs (GET /v1/brokers metadata) with
 * hidden input and send it to the RUNNING Bridge over loopback with an admin key. Nothing is passed on the command
 * line, so tokens, PINs and TOTP codes stay out of shell history and `ps`.
 */
async function connectCommand(accountId, flags, io) {
  if (!accountId) throw new BridgeError("VALIDATION_FAILED", "accounts connect needs an account id, for example: mc-bridge accounts connect dhan-main");
  const { config } = loadConfig({ path: flags.config, env: io.env, cwd: io.cwd });
  const baseUrl = bridgeUrl(flags, io, config);
  const alive = await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  if (!alive) throw new BridgeError("UPSTREAM_ERROR", `The Bridge is not running at ${baseUrl}. Start it first (mc-bridge start), then run this again.`);
  const key = typeof flags.key === "string" ? flags.key : io.env.MCB_ADMIN_KEY ?? io.env.MCB_API_KEY;
  if (!key) throw new BridgeError("UNAUTHENTICATED", "accounts connect needs an admin key: --key, or MCB_ADMIN_KEY in the environment.");
  const ask = typeof io.prompt === "function" ? io.prompt : terminalPrompt;
  const call = async (method, path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new BridgeError(json.code && json.code in { UNAUTHENTICATED: 1, SCOPE_REQUIRED: 1, ACCOUNT_NOT_FOUND: 1, VALIDATION_FAILED: 1 } ? json.code : "UPSTREAM_ERROR", json.detail ?? `the Bridge answered HTTP ${res.status}`);
    return json.data;
  };
  const account = await call("GET", `/v1/accounts/${encodeURIComponent(accountId)}`);
  const broker = (await call("GET", "/v1/brokers")).find((b) => b.id === account.broker);
  if (!broker) throw new BridgeError("VALIDATION_FAILED", `The Bridge does not know the broker ${account.broker}.`);
  io.err(`Connecting ${accountId} (${broker.name}). What you type is not shown and is sent only to the Bridge on this computer.`);
  const values = {};
  for (const field of broker.credentialFields ?? []) {
    const v = String(await ask(field, { hidden: true })).trim();
    if (v) values[field] = v;
  }
  const secrets = {};
  for (const f of broker.loginFields ?? []) {
    const v = String(await ask(`${f.label} (used once to log in, never stored)`, { hidden: true })).trim();
    if (v) secrets[f.key] = v;
  }
  const result = await call("POST", `/v1/accounts/${encodeURIComponent(accountId)}/session`, Object.keys(secrets).length ? { values, secrets } : { values });
  io.out(`Connected ${accountId}: session ${result?.session?.state ?? "saved"}.`);
  return 0;
}
