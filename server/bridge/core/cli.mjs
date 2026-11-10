/**
 * CLI implementation behind bin/mc-bridge.mjs, kept here so it can be tested without spawning processes.
 * Commands delegate to the contract services (KeyStore, AccountManager, AuditLog); until a module lands, its
 * command prints a clear "not built yet" message and exits with code 2.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { createBrokerRegistry } from "../../brokers/registry.mjs";
import { SERVICE_CONTRACTS, SERVICES_NOT_IN_V2, isStub } from "./contracts.mjs";
import { cliCommand } from "./cliName.mjs";
import { readControlToken } from "./controlToken.mjs";
import { SIGN_IN_TTL_MS, createSignInCode } from "../auth/signIn.mjs";
import { BridgeError, NotImplementedError } from "./errors.mjs";
import { configFileForWrites, isLoopbackHost, loadConfig } from "./config.mjs";
import { createLogger } from "./logger.mjs";
import { exposureChecks, readHooksQuietly } from "./expose.mjs";
import { poolingDoctorChecks } from "../sources/pooling.mjs";
import { PLUGIN_TRUST_NOTICE } from "../sources/plugin/notice.mjs";

export const USAGE = `Mr. Chartist API Bridge

Usage:
  mc-bridge init [--yes] [--demo] [--broker <id> [--account <id>] [--label <text>]] [--no-paper] [--force]
                                   first-run setup (alias: setup); asks questions unless --yes
  mc-bridge start [--config <file>] [--demo] [--open]
                                   --demo: sample data, no broker, live trading off; --open: open the dashboard,
                                   already signed in (if the Bridge is already running, just opens the dashboard)
  mc-bridge open [--config <file>] open the dashboard of the running Bridge, already signed in (no key to copy)
  mc-bridge keys create --label <name> --scope read[,paper,live,admin] [--accounts a,b|*] [--expires 30d] [--allow-query] [--client <kind>]
  mc-bridge keys list
  mc-bridge keys revoke <keyId>
  mc-bridge accounts list
  mc-bridge accounts connect <accountId> [--key <admin key>] [--url http://127.0.0.1:4300]
  mc-bridge doctor [--no-port-check] [--strict] [--json]
                                   --strict: exit 1 also for a blocking exposure problem (for a scheduler or monitor)
  mc-bridge expose [alerts|sheets] [--provider cloudflare|cloudflare-quick|ngrok|caddy|port-forward] [--host <public host>]
                   [--port <n>] [--allow-ips tradingview|none|<a,b,c>] [--yes] [--check] [--json]
                                   let TradingView alerts (or a Google Sheet) reach this Bridge through a tunnel or proxy,
                                   without exposing the dashboard; asks questions unless --yes (restart the Bridge after)
  mc-bridge expose check [--public-url <url> --allow-outbound] [--json]
                                   test that only the intended routes answer; --allow-outbound lets it call the public url
  mc-bridge expose status | off [alerts|sheets]
  mc-bridge backup [--out FILE] [--include-secrets]   one archive of your data folder (never the master key; never overwrites)
  mc-bridge backup list | verify FILE                 the copies kept in the data folder; check an archive
  mc-bridge restore FILE [--dry-run] [--yes]          put a backup back (the Bridge must be stopped; makes a safety copy first)
  mc-bridge kill [--reason <text>] [--cancel-open] [--key <key>]
  mc-bridge kill release [--key <admin key>]
  mc-bridge mcp --key <key> [--url http://127.0.0.1:4300] [--config <file>]
  mc-bridge openai-tools [--scope read|paper] [--format responses|chat]
  mc-bridge sources list [--json]
  mc-bridge sources enable <id> [--acknowledge <notice version>]
  mc-bridge sources disable <id>
  mc-bridge sources set-key <id>   the key is read from stdin or a hidden prompt, never from the command line
  mc-bridge sources test <id>
  mc-bridge sources trace --capability quotes --symbols NSE:RELIANCE [--purpose display] [--max-age <ms>]
  mc-bridge sources plugins pin <folder>     print the sha256 to put in the config. First read mc-source.json and the entry file
  mc-bridge sources plugins check <folder>   run the conformance checks offline. This RUNS the plugin's code: pin it first
  mc-bridge notify telegram setup   connect a Telegram bot: the token is read from a hidden prompt, never from the command line
  mc-bridge notify telegram remove <id>
  mc-bridge notify status | test [<id>]
  mc-bridge collections list|show|create|universe|resolve|tag|rename|duplicate|delete|export|import|usage|estimate ...
                                   named lists of instruments and option universes (ATM, rolling expiry) for downloads, recordings and sheets;
                                   needs --key (or MCB_API_KEY), a paper-scope key to change things. See docs/guides/collections.md
  mc-bridge subscriptions list | topics | status | show <id> | test <id> | pause <id> | resume <id> | remove <id>
  mc-bridge subscriptions add <https url> --topics order.*,download.* [--label name] [--accounts a,b] [--secret-stdin]
                                   send Bridge events to your own program, signed. The signing secret is made here and printed once
  mc-bridge subscriptions rotate-secret <id> | deliveries <id> [--outcome dead] | dead-letters <id> [--retry <deliveryId> | --retry-all | --clear]
  mc-bridge subscriptions tail [--topics order.*] [--since <cursor>]   print events as they happen
  mc-bridge download <symbols...> --interval 5m --from 2024-01-01 [--to <date>] [--format csv|jsonl|amibroker] [--dataset <name>]
                   [--layout combined] [--collection <name>] [--dry-run] [--watch]
                                   save history to files on this computer (a background job; never slows live reads)
  mc-bridge download list | show <id> | pause <id> | resume <id> | cancel <id> | files <id> [--out <folder>]
  mc-bridge download datasets | update <dataset>   datasets grow from their last stored bar
  mc-bridge record quotes <symbols...> --every <s> [--all-day]   save real-time prices to files (one file per symbol per day)
  mc-bridge record chain <UNDERLYING> --every <s> [--expiry <date>] [--strikes <n>] [--all-day]   save option-chain snapshots (at least 15 s)
  mc-bridge record list | status | show <id> | files <id> | pause <id> | resume <id> | stop <id> | delete <id>
  mc-bridge record auto on|off|status   record by itself every trading day (off until you turn it on)
  mc-bridge record rules | rule add quotes|chain <...> --every <s> | rule on|off|remove <id> | preset index-option-chains|my-watchlist

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
  const add = (level, check, message, extra = {}) => out.push({ level, check, message, ...extra });
  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 22 ? "ok" : "fail", "node", `Node.js ${process.versions.node}${major >= 22 ? "" : " (22 or newer is required)"}`);
  add(source ? "ok" : "warn", "config", source ? `Loaded ${source}` : `No bridge.config.json yet; using safe defaults. Run: ${cliCommand(env)} init`);
  if (config.demo) add("warn", "demo", "Demo mode is ON: sample prices, no real broker, paper orders only. Remove \"demo\" from the config (or start without --demo) for real accounts.");
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
    const keyFile = env.MCB_MASTER_KEY_FILE ?? config.masterKeyFile ?? join(dataDir, "master.key");
    const sameFolder = resolve(dirname(keyFile)) === resolve(dataDir);
    if (existsSync(keyFile)) {
      const mode = statSync(keyFile).mode & 0o777;
      const tooOpen = process.platform !== "win32" && mode & 0o077;
      add(tooOpen ? "fail" : "ok", "master-key", tooOpen ? `${keyFile} is readable by other users (mode ${mode.toString(8)}); run chmod 600` : `Key file ${keyFile}`);
    } else add("warn", "master-key", `No master key yet; ${keyFile} will be created (mode 600) when you first connect a broker. '${cliCommand(env)} init' creates one outside the data folder now.`);
    if (sameFolder) {
      add("warn", "master-key", `The master key sits in the data folder next to secrets.enc, so a backup, cloud sync or zip of ${dataDir} carries both and the encryption adds nothing. Move it outside (for example ${process.platform === "win32" ? "%APPDATA%\\MrChartist\\master.key" : "~/.config/mc-bridge/master.key"}) and set "masterKeyFile" in bridge.config.json (or MCB_MASTER_KEY_FILE), or use MCB_MASTER_KEY.`);
    }
    if (process.platform === "win32") add("warn", "master-key", "File permissions are not checked on Windows. Restrict the key file to your user: icacls <file> /inheritance:r /grant:r %USERNAME%:F");
  }

  const s = config.safety;
  add("ok", "order-rate", `Order rate cap ${s.orderRatePerSecond}/s per account (ceiling 10/s for unregistered retail algos; needs verification)`);
  const liveAccounts = config.accounts.filter((a) => a.live.enabled).map((a) => a.id);
  if (!s.liveTrading) add("ok", "live-trading", "Live trading is off (paper only)");
  else add("warn", "live-trading", `Live trading is ON for: ${liveAccounts.join(", ") || "no account (enable per account)"}. Orders must leave from your broker-registered static IP.`);
  if (s.killSwitchOnStart) add("warn", "kill-switch", "The kill switch will be engaged at start");
  for (const c of readinessDoctorChecks(config)) add(c.level, c.check, c.message);
  {
    let keys = null;
    try {
      if (deps && !isStub(deps.keyStore)) keys = await deps.keyStore.list();
    } catch {
      keys = null;
    }
    for (const c of exposureChecks(config, { hooks: readHooksQuietly(config.dataDir), keys })) add(c.level, c.check, c.message, { ...(c.fix ? { fix: c.fix } : {}), ...(c.blocking ? { blocking: true } : {}) });
  }
  add(config.accounts.length ? "ok" : "warn", "accounts", config.accounts.length ? `${config.accounts.length} account(s): ${config.accounts.map((a) => `${a.id} (${a.broker})`).join(", ")}` : "No accounts configured yet");
  for (const c of poolingDoctorChecks({ config })) add(c.level, c.check, c.message);
  for (const c of (await import("../backup/doctor.mjs")).backupDoctorChecks({ config, env })) add(c.level, c.check, c.message);
  try {
    new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata" }).format(new Date());
    add("ok", "timezone", "Asia/Kolkata time zone data available");
  } catch {
    add("fail", "timezone", "This Node.js build has no Asia/Kolkata time zone data (install full-icu)");
  }
  if (deps) {
    const stubs = Object.keys(SERVICE_CONTRACTS).filter((k) => !SERVICES_NOT_IN_V2.includes(k) && isStub(deps[k]));
    add(stubs.length ? "warn" : "ok", "services", stubs.length ? `Not built yet: ${stubs.map((k) => SERVICE_CONTRACTS[k].iface).join(", ")}` : "All services built");
  }
  // Paper trading still needs prices and an instrument list, and both come from a connected broker account.
  if (deps && !isStub(deps.keyStore)) {
    try {
      const keys = (await deps.keyStore.list()).filter((k) => !k.revokedAt && !(k.expiresAt && Date.parse(k.expiresAt) < Date.now()));
      const admin = keys.some((k) => k.scopes.includes("admin"));
      add(keys.length ? (admin ? "ok" : "warn") : "warn", "api-keys", keys.length ? `${keys.length} active key(s)${admin ? "" : "; none is an admin key (the dashboard and accounts connect need one)"}` : `No API keys yet. Create one: ${cliCommand(env)} keys create --label me --scope admin,paper`);
    } catch {
      /* key store not available */
    }
  }
  if (deps && !isStub(deps.accounts)) {
    try {
      const brokers = deps.accounts.list().filter((a) => a.broker !== "paper");
      const connected = brokers.filter((a) => a.session?.state === "connected");
      if (connected.length) add("ok", "market-data", `Market data from: ${connected.map((a) => a.id).join(", ")}`);
      else add("warn", "market-data", `No market-data source connected${brokers.length ? ` (log in ${brokers.map((a) => a.id).join(", ")})` : ""}. Quotes, history, option chains, symbol lookups and paper orders all need at least one connected broker account (mc-bridge accounts connect <id>). To try everything without a broker, start with --demo for sample data (${cliCommand(env)} start --demo --open); if the Bridge is already running with --demo, this check is about your real accounts and you can ignore it.`);
    } catch {
      /* account manager not available */
    }
  }
  if (deps && !isStub(deps.backupData)) {
    try {
      const st = deps.backupData.status();
      const on = st.providers.filter((p) => p.enabled);
      if (config.demo) add("ok", "data-sources", `Demo mode: ${on.length} of ${st.providers.length} sample sources switched on. They show how delayed and end-of-day data is labelled; no network is used`);
      else if (on.length) add("ok", "data-sources", `Extra data sources on: ${on.map((p) => `${p.id} (${p.class})`).join(", ")}${st.autoFallback ? "; reads no broker can answer fall back to them, labelled with their data class" : "; used only when a request asks for them"}`);
      else add("ok", "data-sources", "No extra data sources are switched on. Your broker accounts answer every read. Add free delayed or end-of-day sources on the Sources page");
    } catch {
      /* sources service not available */
    }
  }
  if (deps && !isStub(deps.notify)) {
    const { notifyDoctorChecks } = await import("../notify/doctor.mjs");
    for (const c of await notifyDoctorChecks(deps, { env })) add(c.level, c.check, c.message);
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

/**
 * The trading-readiness check: a live-enabled account without live.registeredIp, so the readiness monitor cannot
 * compare the static IP. Pure.
 * @returns {Array<{ level: "ok"|"warn", check: string, message: string }>}
 */
export function readinessDoctorChecks(config) {
  const out = [];
  const live = (config.accounts ?? []).filter((a) => a.live?.enabled && a.broker !== "paper");
  const missing = live.filter((a) => !String(a.live?.registeredIp ?? "").trim());
  if (live.length) {
    out.push(
      missing.length
        ? { level: "warn", check: "static-ip", message: `No live.registeredIp for ${missing.map((a) => a.id).join(", ")}: the readiness check cannot compare this computer's IP with the one registered at the broker. Add it to the account in bridge.config.json (see docs/guides/deployment.md).` }
        : { level: "ok", check: "static-ip", message: `Registered static IP set for every live account (${live.map((a) => a.id).join(", ")})` },
    );
  }
  return out;
}

async function bootServices(flags, io, { server = false } = {}) {
  const { config, warnings, source } = loadConfig({ path: flags.config, env: io.env, cwd: io.cwd, knownBrokers: createBrokerRegistry().list(), demo: flags.demo === true });
  const { createApp } = await import("./app.mjs");
  // The server logs at the configured level; one-shot commands only show warnings and errors.
  const logger = createLogger({ level: server || config.logging.level === "debug" ? config.logging.level : "warn" });
  const app = await createApp({ config, logger, warnings, configFile: configFileForWrites(source, io.env) });
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
export async function startHints({ app, port, env = process.env }) {
  const cli = cliCommand(env);
  const lines = [];
  const host = app.config.server.host === "0.0.0.0" ? "127.0.0.1" : app.config.server.host;
  lines.push(`Dashboard (this computer only): http://${host.includes(":") ? `[${host}]` : host}:${port}/dashboard`);
  try {
    const keys = (await app.deps.keyStore.list()).filter((k) => !k.revokedAt && !(k.expiresAt && Date.parse(k.expiresAt) < Date.now()));
    if (keys.length === 0) lines.push(`No API keys yet. Open the dashboard signed in with: ${cli} open   (or make one: ${cli} keys create --label me --scope admin,paper)`);
    else lines.push(`${keys.length} active API key(s).`);
  } catch {
    /* key store not built */
  }
  try {
    const rows = app.deps.accounts.list().filter((a) => a.broker !== "paper");
    const live = rows.filter((a) => a.session?.state === "connected");
    if (app.config.demo) lines.push("Market data: demo (sample prices generated on this computer).");
    else if (rows.length === 0) lines.push(`No market-data source connected: no broker account is configured. Quotes and even paper orders need one: on the dashboard, open Accounts and press Add a broker, or try everything with sample data: ${cli} start --demo --open`);
    else if (live.length === 0) lines.push(`No market-data source connected (${rows.map((a) => a.id).join(", ")} not logged in). Quotes and even paper orders need one: on the dashboard, open Accounts and press Log in (or: ${cli} accounts connect <id>).`);
    else lines.push(`Market data from: ${live.map((a) => a.id).join(", ")}.`);
  } catch {
    /* account manager not built */
  }
  return lines;
}

/**
 * Open a URL in the default browser (macOS open, Windows start, Linux xdg-open). Never throws; returns false when no
 * opener could be started (for example on a server without a desktop).
 * @param {string} url  http(s) URL built by the Bridge itself
 */
export function openInBrowser(url, { platform = process.platform, env = process.env, spawnImpl } = {}) {
  if (!/^https?:\/\/[^\s"']+$/.test(url)) return false;
  // Linux and other Unix systems without a graphical session (a server over SSH): there is no browser to open.
  // Android (Node.js in Termux reports "android") opens links through Termux's own command.
  if (platform !== "darwin" && platform !== "win32" && platform !== "android" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  const [cmd, args] = platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["cmd", ["/c", "start", "", url]] : platform === "android" ? ["termux-open-url", [url]] : ["xdg-open", [url]];
  try {
    const run = spawnImpl ?? spawn;
    const child = run(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    child?.on?.("error", () => {});
    child?.unref?.();
    return true;
  } catch {
    return false;
  }
}

/** http://<host>:<port> for this computer's browser: a wildcard listen address becomes loopback. */
export function localBaseUrl(host, port) {
  const h = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return `http://${h.includes(":") ? `[${h}]` : h}:${port}`;
}

/**
 * Health of a Bridge at `baseUrl`: its /v1/health answer when a Bridge answers there, else null (nothing listening,
 * or another program that does not speak the Bridge's health format).
 * @returns {Promise<{ status: string, version?: string, demo?: boolean } | null>}
 */
export async function probeBridge(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.status === "ok" && typeof body.apiVersion === "string" ? body : null;
  } catch {
    return null;
  }
}

/**
 * Create a one-time sign-in code in `dataDir` and open <baseUrl>/dashboard#signin=<code>. The code travels in the URL
 * fragment, which browsers never send to the server, so it does not reach any request log. When no browser can be
 * opened the link is printed, with a note that it works once and expires.
 * @returns {Promise<boolean>} whether a browser was asked to open it
 */
export async function openSignedInDashboard({ dataDir, baseUrl, io }) {
  const { code } = await createSignInCode(dataDir);
  const url = `${baseUrl}/dashboard#signin=${code}`;
  const opened = (io.openUrl ?? openInBrowser)(url);
  const minutes = Math.round(SIGN_IN_TTL_MS / 60_000);
  if (opened) {
    io.err("Opening the dashboard in your browser (already signed in).");
    io.err(`If it does not open, use this link. It works once and expires in ${minutes} minutes: ${url}`);
  } else {
    io.err(`Open this link in your browser to see the dashboard, already signed in. It works once and expires in ${minutes} minutes:`);
    io.err(`  ${url}`);
  }
  return opened;
}

/**
 * Whether a running Bridge keeps its files in `dataDir`: while it listens it holds its control token there
 * (controlToken.mjs). A sign-in code only works for the Bridge that reads the same folder.
 */
const usesDataDir = (dataDir) => readControlToken(dataDir) !== null;
const otherFolderMessage = (baseUrl, dataDir) =>
  `A Bridge is running at ${baseUrl}, but it keeps its files in another folder than ${dataDir}, so a sign-in link from here would not work for it. Run this from the folder you started that Bridge in (or pass --config), or stop it and start it again.`;

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
      case "init":
      case "setup": {
        const { runInit } = await import("./init.mjs");
        const { BROKER_NAMES } = await import("../accounts/brokerInfo.mjs");
        const brokerIds = createBrokerRegistry().list().slice().sort();
        return await runInit(flags, { ...io, prompt: io.prompt ?? ((q, o) => terminalPrompt(q, o)) }, {
          brokerIds,
          brokerNames: BROKER_NAMES,
          createKey: async (configPath) => {
            const { app } = await bootServices({ ...flags, config: configPath, demo: false }, io);
            try {
              // Count the admin keys already there, so a second init can say it made another one.
              const existingAdmin = (await app.deps.keyStore.list()).filter((k) => !k.revokedAt && !(k.expiresAt && Date.parse(k.expiresAt) < Date.now()) && k.scopes.includes("admin")).length;
              const { key, record } = await app.deps.keyStore.create({ label: "admin (created by init)", scopes: ["admin", "paper"], accounts: "*", clientKind: "ui" });
              await audit(app.deps, io, { type: "key.created", data: { keyId: record.id, scopes: record.scopes, label: record.label } });
              return { key, id: record.id, existingAdmin };
            } finally {
              await app.close();
            }
          },
        });
      }
      case "start": {
        // Double-clicking the start file a second time: if this Bridge is already running on its port, open its
        // dashboard instead of failing on the busy port.
        const { config: planned, source: plannedSource } = loadConfig({ path: flags.config, env: io.env, cwd: io.cwd, knownBrokers: createBrokerRegistry().list(), demo: flags.demo === true });
        const plannedUrl = localBaseUrl(planned.server.host, planned.server.port);
        const running = planned.server.port === 0 ? null : await probeBridge(plannedUrl);
        if (running) {
          if (!usesDataDir(planned.dataDir)) {
            io.err(`Error: ${otherFolderMessage(plannedUrl, planned.dataDir)}`);
            return 1;
          }
          if (!flags.open) {
            io.err(`The Bridge is already running at ${plannedUrl}. To open its dashboard, run: mc-bridge open`);
            return 1;
          }
          io.err("The Bridge is already running; opening the dashboard.");
          if (flags.demo === true && !running.demo) io.err("Note: the running Bridge is not in demo mode. To try demo mode, stop it first (Ctrl+C in its window), then start again with --demo.");
          await openSignedInDashboard({ dataDir: planned.dataDir, baseUrl: plannedUrl, io });
          return 0;
        }
        // A new Bridge version may change how files are stored: copy the data first (never stops the start).
        const snapshot = await (await import("../backup/manager.mjs")).createBackupManager({
          dataDir: planned.dataDir,
          configFile: configFileForWrites(plannedSource, io.env),
          config: planned,
          bridgeVersion: (await import("./app.mjs")).BRIDGE_VERSION,
          env: io.env,
        }).snapshotBeforeStart();
        if (snapshot.message) io.err(snapshot.message);
        const { app } = await bootServices(flags, io, { server: true });
        let port;
        let publicPort;
        let sheetsPort;
        try {
          ({ port, publicPort, sheetsPort } = await app.listen());
        } catch (err) {
          await app.close().catch(() => {});
          if (err?.code === "EADDRINUSE") {
            throw new BridgeError("VALIDATION_FAILED", `Port ${err.port ?? app.config.server.port} is already in use by another program (not this Bridge). Close that program, or choose another port under "server" in bridge.config.json (for example "port": 4301).`);
          }
          throw err;
        }
        if (app.config.demo) {
          io.err("");
          io.err("  ************************************************************");
          io.err("  *  DEMO MODE: sample data, not live market data.           *");
          io.err("  *  No broker is connected. Orders are paper only.          *");
          io.err("  ************************************************************");
          io.err("");
        }
        io.err(`Mr. Chartist API Bridge listening on http://${app.config.server.host}:${port}${publicPort ? ` (public ingress on ${publicPort})` : ""}${sheetsPort ? ` (Sheets listener on ${sheetsPort})` : ""}`);
        io.err(`Data folder: ${app.config.dataDir}`);
        for (const line of await startHints({ app, port, env: io.env })) io.err(line);
        if (flags.open) await openSignedInDashboard({ dataDir: app.config.dataDir, baseUrl: localBaseUrl(app.config.server.host, port), io });
        io.err("Press Ctrl+C to stop.");
        // Tests close the app themselves; the real CLI stops on Ctrl+C or a termination signal.
        if (typeof io.onListening === "function") {
          io.onListening(app);
          return null;
        }
        const stop = async () => {
          await app.close();
          process.exit(0);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        return null;
      }
      case "open": {
        // Open the running Bridge's dashboard, signed in with a fresh one-time code (needs this computer's data folder).
        const { config } = loadConfig({ path: flags.config, env: io.env, cwd: io.cwd });
        const baseUrl = bridgeUrl(flags, io, config);
        if (!(await probeBridge(baseUrl))) {
          io.err(`The Bridge is not running at ${baseUrl}. Start it by double-clicking its shortcut, or run: mc-bridge start --open`);
          return 1;
        }
        if (!usesDataDir(config.dataDir)) {
          io.err(`Error: ${otherFolderMessage(baseUrl, config.dataDir)}`);
          return 1;
        }
        await openSignedInDashboard({ dataDir: config.dataDir, baseUrl, io });
        return 0;
      }
      case "doctor": {
        // Doctor must not create anything: only boot the services (which create the data folder) when it exists.
        const loaded = loadConfig({ path: flags.config, env: io.env, cwd: io.cwd, knownBrokers: createBrokerRegistry().list() });
        let deps = null;
        let { config, warnings, source } = loaded;
        if (existsSync(loaded.config.dataDir)) ({ app: { deps }, config, warnings, source } = await bootServices(flags, io));
        const checks = await runDoctor({ config, warnings, source, env: io.env, portCheck: !flags["no-port-check"], deps });
        if (flags.json) io.out(JSON.stringify(checks, null, 2));
        else {
          for (const c of checks) {
            io.out(`${(c.level === "ok" ? "OK" : c.blocking ? "BLOCK" : c.level === "warn" ? "WARN" : "FAIL").padEnd(5)} ${c.check.padEnd(20)} ${c.message}`);
            if (c.fix) io.out(`      Fix: ${c.fix}`);
          }
        }
        // --strict: a blocking exposure problem also fails the run (a monitor or scheduler can act on the exit code).
        return checks.some((c) => c.level === "fail" || (flags.strict === true && c.blocking)) ? 1 : 0;
      }
      case "expose": {
        const { runExposeCommand } = await import("./exposeCli.mjs");
        return await runExposeCommand(sub, arg, flags, { ...io, prompt: io.prompt ?? ((q, o) => terminalPrompt(q, o)) });
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
        else if (rows.length === 0) io.out("No accounts configured. Add one on the dashboard (Accounts, Add a broker), or under \"accounts\" in bridge.config.json.");
        else for (const a of rows) io.out(`${a.id.padEnd(20)} ${a.broker.padEnd(14)} ${a.session.state.padEnd(10)} ${a.liveAllowedByConfig ? "live-enabled" : "paper"}  ${a.label}`);
        return 0;
      }
      case "mcp": {
        // A relay to the RUNNING Bridge (POST /mcp), so AI tools share its connections, limits, safety and audit.
        warnKeyOnArgv(flags, io);
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
        if (!alive) io.err(`The Bridge is not running at ${baseUrl} yet. Start it from its shortcut (or: ${cliCommand(io.env)} start); the MCP relay will connect when it is up.`);
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
      case "sources":
        return await sourcesCommand(positionals.slice(1), flags, io);
      case "notify": {
        const { notifyCommand } = await import("../notify/cli.mjs");
        warnKeyOnArgv(flags, io);
        return await notifyCommand(positionals.slice(1), flags, io, { connect: () => sourcesClient(flags, io), prompt: terminalPrompt, cli: cliCommand(io.env), usage: USAGE });
      }
      case "collections":
        return await collectionsCliCommand(positionals.slice(1), flags, io);
      case "subscriptions": {
        const { subscriptionsCommand } = await import("../events/cli.mjs");
        warnKeyOnArgv(flags, io);
        return await subscriptionsCommand(positionals.slice(1), flags, io, { connect: () => sourcesClient(flags, io), cli: cliCommand(io.env), usage: USAGE });
      }
      case "download":
        return await downloadsCommand(positionals.slice(1), flags, io);
      case "record":
        return await recordCliCommand(positionals.slice(1), flags, io);
      case "kill":
        return await killCommand(sub, flags, io);
      case "backup":
      case "restore":
        return await backupRestoreCommand(cmd, positionals.slice(1), flags, io);
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
 * running process holds the kill-switch state). With no --key it uses the control token the Bridge keeps in its data
 * folder, so on this computer no key is needed; with --key, engaging needs any key and releasing an admin key, from
 * this computer. When it is not running, the CLI engages or releases the persisted kill switch directly, as the local
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
    // No key needed on this computer: the running Bridge keeps a control token in its data folder (controlToken.mjs).
    warnKeyOnArgv(flags, io);
    const key = typeof flags.key === "string" ? flags.key : (io.env.MCB_API_KEY ?? readControlToken(config.dataDir));
    if (!key) {
      throw new BridgeError("UNAUTHENTICATED", `The Bridge is running at ${baseUrl} but its control token is not in ${config.dataDir} (another data folder, or another computer). Pass --key (or MCB_API_KEY)${release ? " with an admin key" : ""}, or use the dashboard's Safety page.`);
    }
    const res = await fetch(`${baseUrl}/v1/safety/kill-switch`, {
      method: release ? "DELETE" : "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(release ? { confirm: "RELEASE" } : { reason, cancelOpenOrders: flags["cancel-open"] === true }),
    });
    if (!res.ok) {
      const problem = await res.json().catch(() => ({}));
      const usedControlToken = typeof flags.key !== "string" && !io.env.MCB_API_KEY;
      if (usedControlToken && res.status === 401) io.err(`Error: the running Bridge did not accept the control token in ${config.dataDir} (it may belong to another Bridge). Pass --key, or use the dashboard's Safety page.`);
      else io.err(`Error: ${problem.detail ?? `the Bridge answered HTTP ${res.status}`}`);
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
  warnKeyOnArgv(flags, io);
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
  io.out(`Connected ${accountId}: session ${result?.state ?? result?.session?.state ?? "saved"}.`);
  return 0;
}

/** `--key` puts a key in shell history and in the process list; say so once and point at the environment variables. */
function warnKeyOnArgv(flags, io) {
  if (typeof flags.key === "string") io.err("Warning: a key passed with --key stays in your shell history and is visible in the process list. Prefer the MCB_ADMIN_KEY (admin actions) or MCB_API_KEY environment variable.");
}

// === sources: `mc-bridge sources ...` ==========================================================================
// A separate block: data sources are managed through the RUNNING Bridge's HTTP routes (GET /v1/sources, PATCH
// /v1/sources/{id}, PUT /v1/sources/{id}/config, POST /v1/sources/{id}/test, GET /v1/sources/trace), the same way
// `accounts connect` and `kill` do. `sources plugins check|pin` work offline on a plugin folder.

const SOURCES_SUBCOMMANDS = ["list", "enable", "disable", "set-key", "test", "trace", "plugins"];
/** Flags that would carry a secret on the command line; refused for set-key. */
const SECRET_FLAGS = ["api-key", "apikey", "apiKey", "secret", "token", "password", "value"];

/** "15 min", "2 h", "1 day" from seconds. */
export function formatDelay(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "";
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86_400) return `${Math.round((sec / 3600) * 10) / 10} h`;
  return `${Math.round(sec / 86_400)} day`;
}

/** How a source's data is described to a person: "real-time", "delayed 15 min", "end of day", plus "unofficial". */
export function describeSourceClass(s) {
  const base = s.class === "realtime" ? "real-time" : s.class === "delayed" ? `delayed ${formatDelay(s.delaySec)}`.trim() : s.class === "eod" ? "end of day" : String(s.class);
  return s.official === false ? `${base}, unofficial` : base;
}

const pad = (v, n) => String(v ?? "").padEnd(n);

/** Plain-text table for `sources list`. Exported for tests. @param {any[]} rows */
export function formatSources(rows) {
  if (!rows.length) return "No data sources are registered.";
  const state = (s) => (s.enabled ? "on" : s.needsKey && !s.configured ? "needs key" : "off");
  const health = (s) => `${s.health?.state ?? "unknown"}${s.health?.state && s.health.state !== "ok" && s.health.lastError ? ` (${String(s.health.lastError).slice(0, 60)})` : ""}`;
  const lines = [`${pad("ID", 18)} ${pad("TIER", 8)} ${pad("STATE", 10)} ${pad("DATA", 28)} ${pad("HEALTH", 12)} NAME`];
  for (const s of rows) lines.push(`${pad(s.id, 18)} ${pad(s.tier, 8)} ${pad(state(s), 10)} ${pad(describeSourceClass(s), 28)} ${pad(health(s), 12)} ${s.name}`.trimEnd());
  lines.push("", "Your broker accounts are always used first for real-time data. Other sources are labelled on every answer.");
  return lines.join("\n");
}

/** Plain-text routing trace. Exported for tests. @param {any} t */
export function formatTrace(t) {
  const req = t.request ?? {};
  const lines = [`Request: ${req.capability ?? "?"}${req.symbols?.length ? ` ${req.symbols.join(",")}` : ""}, purpose ${req.purpose ?? "display"}${req.maxAgeMs !== undefined && req.maxAgeMs !== null ? `, max age ${req.maxAgeMs} ms` : ""}`, ""];
  const considered = t.considered ?? [];
  if (!considered.length) lines.push("No source was considered.");
  for (const c of considered) {
    const extra = [c.score !== undefined ? `score ${c.score}` : "", c.spareBudget !== undefined ? `spare ${c.spareBudget}` : "", c.health?.state && c.health.state !== "ok" ? `health ${c.health.state}` : ""].filter(Boolean).join(", ");
    lines.push(`${pad(String(c.verdict ?? "").toUpperCase(), 9)} ${pad(c.id, 22)} ${c.reason ?? ""}${extra ? ` (${extra})` : ""}`.trimEnd());
  }
  lines.push("", `Class of the answer: ${t.class ?? "none"}${t.note ? `. ${t.note}` : ""}`, "This was a dry run: no source was called.");
  return lines.join("\n");
}

/** The running Bridge's URL and the credential to use: --key, MCB_ADMIN_KEY, MCB_API_KEY, else the local control token. */
async function sourcesClient(flags, io) {
  const { config } = loadConfig({ path: flags.config, env: io.env, cwd: io.cwd });
  const baseUrl = bridgeUrl(flags, io, config);
  const alive = await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  if (!alive) throw new BridgeError("UPSTREAM_ERROR", `The Bridge is not running at ${baseUrl}. Start it first (${cliCommand(io.env)} start), then run this again.`);
  warnKeyOnArgv(flags, io);
  const explicit = typeof flags.key === "string" ? flags.key : (io.env.MCB_ADMIN_KEY ?? io.env.MCB_API_KEY);
  const key = explicit ?? readControlToken(config.dataDir);
  if (!key) throw new BridgeError("UNAUTHENTICATED", `This needs an admin key: pass --key (or set MCB_ADMIN_KEY). Create one with: ${cliCommand(io.env)} keys create --label cli --scope admin`);
  const call = async (method, path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const hint = explicit === undefined && (res.status === 401 || res.status === 403) ? ` The control token in ${config.dataDir} was not accepted for this action; pass --key with an admin key.` : "";
      const code = typeof json.code === "string" && json.code in ERROR_CODES_FOR_CLI ? json.code : "UPSTREAM_ERROR";
      throw new BridgeError(code, `${json.detail ?? `the Bridge answered HTTP ${res.status}`}${hint}`);
    }
    return json;
  };
  return { baseUrl, call };
}
const ERROR_CODES_FOR_CLI = { UNAUTHENTICATED: 1, SCOPE_REQUIRED: 1, LOOPBACK_ONLY: 1, NOT_FOUND: 1, VALIDATION_FAILED: 1, CONFIRMATION_REQUIRED: 1, STATE_CONFLICT: 1 };

async function sourcesCommand(args, flags, io) {
  const [sub, arg, arg2] = args;
  if (!SOURCES_SUBCOMMANDS.includes(sub)) {
    io.err(USAGE);
    return 1;
  }
  if (sub === "plugins") return await pluginsCommand(arg, arg2, flags, io);
  if (["enable", "disable", "set-key", "test"].includes(sub) && !arg) throw new BridgeError("VALIDATION_FAILED", `sources ${sub} needs a source id. List them with: ${cliCommand(io.env)} sources list`);
  if (sub === "set-key" && args.length > 2) throw new BridgeError("VALIDATION_FAILED", "set-key takes only the source id. The key is never taken from the command line (shell history and process lists would keep it): run set-key with the id alone and it reads the key from stdin or asks for it with hidden input. If you pasted a key after the id, it is in your shell history now: delete that line and rotate the key at the vendor.");
  if (sub === "set-key") for (const f of SECRET_FLAGS) if (flags[f] !== undefined) throw new BridgeError("VALIDATION_FAILED", "Keys are never taken from the command line (shell history and process lists would keep them). Run set-key without them: it reads the key from stdin or asks for it with hidden input.");
  const { call } = await sourcesClient(flags, io);
  const cli = cliCommand(io.env);
  const listed = async () => (await call("GET", "/v1/sources")).data ?? [];
  const find = async (id) => {
    const s = (await listed()).find((x) => x.id === id);
    if (!s) throw new BridgeError("NOT_FOUND", `No data source with id "${id}". List them with: ${cli} sources list`);
    return s;
  };
  const path = (id) => `/v1/sources/${encodeURIComponent(id)}`;

  switch (sub) {
    case "list": {
      const rows = await listed();
      io.out(flags.json ? JSON.stringify(rows, null, 2) : formatSources(rows));
      return 0;
    }
    case "enable": {
      const s = await find(arg);
      if (s.enabled) {
        io.out(`${s.id} is already on.`);
        return 0;
      }
      if (s.needsKey && !s.configured) throw new BridgeError("VALIDATION_FAILED", `${s.name} needs your own key first. Run: ${cli} sources set-key ${s.id}`);
      const given = typeof flags.acknowledge === "string" ? flags.acknowledge : undefined;
      if (s.noticeVersion) {
        if (given === undefined) {
          io.err(`${s.name} (${describeSourceClass(s)}) needs your acknowledgement before it is turned on.`);
          if (s.terms?.note) io.err(`  ${s.terms.note}`);
          if (s.terms?.url) io.err(`  Terms: ${s.terms.url}`);
          io.err(`Read them, then run: ${cli} sources enable ${s.id} --acknowledge ${s.noticeVersion}`);
          return 1;
        }
        if (given !== s.noticeVersion) throw new BridgeError("VALIDATION_FAILED", `The notice for ${s.name} is now version ${s.noticeVersion}, not ${given}. Read it again and pass --acknowledge ${s.noticeVersion}.`);
      }
      const { data } = await call("PATCH", path(s.id), { enabled: true, ...(given !== undefined ? { acknowledge: given } : {}) });
      io.out(`Turned on ${s.name}. Its answers are labelled: ${describeSourceClass(data ?? s)}.`);
      if (s.tier === "plugin") io.err(`This is third-party code you granted. It runs in its own process and can only fetch from the hosts in its manifest through the Bridge. ${PLUGIN_TRUST_NOTICE}`);
      return 0;
    }
    case "disable": {
      const s = await find(arg);
      await call("PATCH", path(s.id), { enabled: false });
      io.out(`Turned off ${s.name}.`);
      return 0;
    }
    case "set-key": {
      const s = await find(arg);
      if (!s.needsKey) throw new BridgeError("VALIDATION_FAILED", `${s.name} does not use a key.`);
      let value;
      if (typeof io.readStdin === "function") value = await io.readStdin();
      else if (!process.stdin.isTTY && typeof io.prompt !== "function") value = await new Promise((resolve) => {
        let text = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (c) => (text += c));
        process.stdin.on("end", () => resolve(text));
      });
      if (value === undefined) {
        io.err(`Paste the key for ${s.name}. What you type is not shown and goes only to the Bridge on this computer.`);
        value = await (typeof io.prompt === "function" ? io.prompt : terminalPrompt)("Key", { hidden: true });
      }
      const apiKey = String(value ?? "").trim();
      if (!apiKey) throw new BridgeError("VALIDATION_FAILED", "No key was given.");
      if (apiKey.length > 500 || /\s/.test(apiKey)) throw new BridgeError("VALIDATION_FAILED", "That does not look like a single key (it has spaces or is far too long).");
      await call("PUT", `${path(s.id)}/config`, { apiKey });
      io.out(`Saved the key for ${s.name}. It is stored encrypted on this computer and is never shown again. Next: ${cli} sources test ${s.id}, then ${cli} sources enable ${s.id}.`);
      return 0;
    }
    case "test": {
      const s = await find(arg);
      const { data } = await call("POST", `${path(s.id)}/test`);
      if (flags.json) io.out(JSON.stringify(data, null, 2));
      else io.out(data?.ok ? `OK: ${s.name} answered in ${data.latencyMs ?? "?"} ms${data.detail ? ` (${data.detail})` : ""}.` : `FAILED: ${s.name}${data?.detail ? `: ${data.detail}` : ""}.`);
      return data?.ok ? 0 : 1;
    }
    case "trace": {
      const { CAPABILITIES, PURPOSES } = await import("../sources/contract.mjs");
      const capability = flags.capability === undefined ? "quotes" : String(flags.capability);
      if (!CAPABILITIES.includes(capability)) throw new BridgeError("VALIDATION_FAILED", `--capability must be one of ${CAPABILITIES.join(", ")}.`);
      if (typeof flags.symbols !== "string" || !flags.symbols.trim()) throw new BridgeError("VALIDATION_FAILED", "trace needs --symbols, for example --symbols NSE:RELIANCE.");
      const purpose = flags.purpose === undefined ? "display" : String(flags.purpose);
      if (!PURPOSES.includes(purpose)) throw new BridgeError("VALIDATION_FAILED", `--purpose must be one of ${PURPOSES.join(", ")}.`);
      const q = new URLSearchParams({ capability, symbols: flags.symbols.trim(), purpose });
      if (flags["max-age"] !== undefined) {
        const n = Number(flags["max-age"]);
        if (!Number.isFinite(n) || n < 0) throw new BridgeError("VALIDATION_FAILED", "--max-age must be a number of milliseconds.");
        q.set("maxAgeMs", String(Math.round(n)));
      }
      const { data } = await call("GET", `/v1/sources/trace?${q}`);
      io.out(flags.json ? JSON.stringify(data, null, 2) : formatTrace(data ?? {}));
      return 0;
    }
    default:
      io.err(USAGE);
      return 1;
  }
}

/** `mc-bridge sources plugins check|pin <folder>`: offline, nothing is started on the Bridge. */
async function pluginsCommand(action, folder, flags, io) {
  if (!["check", "pin"].includes(action)) {
    io.err(USAGE);
    return 1;
  }
  if (!folder) throw new BridgeError("VALIDATION_FAILED", `sources plugins ${action} needs the plugin folder, for example: ${cliCommand(io.env)} sources plugins ${action} ./my-plugin`);
  const { inspectPluginFolder } = await import("../sources/plugin/loader.mjs");
  if (action === "pin") {
    const info = inspectPluginFolder(folder, { baseDir: io.cwd });
    if (!info.ok) {
      for (const p of info.problems) io.err(`Error: ${p}`);
      return 1;
    }
    const m = info.manifest;
    io.err(`Plugin ${m.id} ${m.version}: ${m.name}`);
    io.err(`  Data: ${describeSourceClass(info.descriptor)}; can answer: ${m.capabilities.join(", ")}`);
    io.err(`  May reach: ${m.network.allowHosts.join(", ") || "no hosts"}`);
    io.err(`  Terms: ${m.terms.url} (${m.terms.note})`);
    io.err(`  Files to read first: ${join(info.dir, "mc-source.json")} and ${info.entryPath}`);
    io.err(PLUGIN_TRUST_NOTICE);
    io.err("Review those, and the code in the entry file, before you grant it. Then add to \"sources\".\"plugins\" in bridge.config.json:");
    io.err(`  { "path": ${JSON.stringify(folder)}, "sha256": "${info.pin}", "granted": true }`);
    io.err("If you change either file later, the Bridge refuses it until you run this again and update the pin.");
    io.err(`Optional next step: ${cliCommand(io.env)} sources plugins check ${JSON.stringify(folder)} runs the plugin's code offline (same sandbox, scripted network) to test it.`);
    io.out(info.pin);
    return 0;
  }
  const { checkPluginFolder } = await import("../sources/plugin/check.mjs");
  // `check` starts the plugin. Order matters: read manifest and entry, pin, then check.
  io.err("Warning: check RUNS this plugin's code on this computer (restricted like in production, with a scripted network, but it is still its code). Run it only after you have read mc-source.json and the entry file and pinned them (sources plugins pin).");
  const report = await checkPluginFolder(folder, { baseDir: io.cwd });
  if (flags.json) io.out(JSON.stringify(report, null, 2));
  else {
    for (const s of report.steps) io.out(`${s.ok ? "OK  " : "FAIL"}  ${s.name}${s.detail ? `: ${s.detail}` : ""}`);
    io.out(report.ok ? `\nAll checks passed. Pin for the config (the same value \`plugins pin\` prints): ${report.pin}` : "\nSome checks failed. Fix them and run this again.");
  }
  return report.ok ? 0 : 1;
}
// === end sources ===============================================================================================

// === downloads =================================================================================================
/**
 * `mc-bridge download ...` (server/bridge/downloads/cli.mjs). A separate block: it only finds the running Bridge and the
 * credential (--key, MCB_API_KEY, or this computer's control token) and hands a small client to the command.
 */
async function downloadsCommand(args, flags, io) {
  const { downloadCommand } = await import("../downloads/cli.mjs");
  warnKeyOnArgv(flags, io);
  const connect = async () => {
    const { config } = loadConfig({ path: flags.config, env: io.env, cwd: io.cwd });
    const baseUrl = bridgeUrl(flags, io, config);
    const alive = await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
    if (!alive) throw new BridgeError("UPSTREAM_ERROR", `The Bridge is not running at ${baseUrl}. Start it first (${cliCommand(io.env)} start), then run this again.`);
    const key = (typeof flags.key === "string" ? flags.key : (io.env.MCB_API_KEY ?? io.env.MCB_ADMIN_KEY)) ?? readControlToken(config.dataDir);
    if (!key) throw new BridgeError("UNAUTHENTICATED", `Pass --key (or set MCB_API_KEY). On this computer the running Bridge's local token is used when it exists, and it does not here.`);
    const headers = { authorization: `Bearer ${key}` };
    const fail = async (res) => {
      const json = await res.json().catch(() => ({}));
      const code = typeof json.code === "string" && json.code in ERROR_CODES_FOR_CLI ? json.code : "UPSTREAM_ERROR";
      throw new BridgeError(code, json.detail ?? `the Bridge answered HTTP ${res.status}`);
    };
    const call = async (method, path, body) => {
      const res = await fetch(`${baseUrl}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
      if (res.status === 204) return {};
      if (!res.ok) await fail(res);
      return await res.json();
    };
    const raw = async (path) => {
      const res = await fetch(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(600_000) });
      if (!res.ok) await fail(res);
      return Buffer.from(await res.arrayBuffer());
    };
    return { baseUrl, call, raw };
  };
  return await downloadCommand(args, flags, io, { connect, cli: cliCommand(io.env) });
}
// === end downloads =============================================================================================

/**
 * `mc-bridge backup` and `mc-bridge restore` (server/bridge/backup/cli.mjs). A separate block: it only gathers what the
 * commands need from this file (the loaded config, the probe that detects a running Bridge) and hands it over.
 */
async function backupRestoreCommand(cmd, args, flags, io) {
  const { config, source } = loadConfig({ path: flags.config, env: io.env, cwd: io.cwd, knownBrokers: createBrokerRegistry().list() });
  const { BRIDGE_VERSION } = await import("./app.mjs");
  const { backupCommand, restoreCommand } = await import("../backup/cli.mjs");
  const ctx = { config, configFile: configFileForWrites(source, io.env), bridgeVersion: BRIDGE_VERSION, cli: cliCommand(io.env), probeBridge, localBaseUrl, usesDataDir };
  return cmd === "backup" ? backupCommand(args, flags, io, ctx) : restoreCommand(args, flags, io, ctx);
}

// === collections ===============================================================================================
/**
 * `mc-bridge collections ...` (server/bridge/library/cli.mjs). A separate block: it only hands the command the running Bridge's
 * client (the same one `notify` and `sources` use) and this file's usage text.
 */
async function collectionsCliCommand(args, flags, io) {
  const { collectionsCommand } = await import("../library/cli.mjs");
  return await collectionsCommand(args, flags, io, { connect: () => sourcesClient(flags, io), cli: cliCommand(io.env), usage: USAGE });
}
// === end collections ===========================================================================================
/** `mc-bridge record ...` (server/bridge/recorder/cli.mjs). A separate block: it only connects to the running Bridge and hands over. */
async function recordCliCommand(args, flags, io) {
  const { recordCommand } = await import("../recorder/cli.mjs");
  return recordCommand(args, flags, io, { connect: () => sourcesClient(flags, io), cli: cliCommand(io.env), usage: USAGE });
}
