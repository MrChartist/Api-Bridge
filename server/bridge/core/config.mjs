/**
 * Configuration loader: bridge.config.json + environment, validated with zod, frozen.
 *
 * Precedence: built-in defaults < config file < environment. The environment may only change where the Bridge
 * listens and logs, or TIGHTEN safety (MCB_PAPER_ONLY, MCB_KILL_SWITCH). Nothing in the environment can switch
 * live trading on: that needs the config file (global `safety.liveTrading` AND the account's `live.enabled`),
 * plus a live-scoped key and an explicit `mode: "live"` on the request.
 *
 * Core owns the sections every module depends on (server, cors, dataDir, logging, accounts, safety). Any other
 * top-level section belongs to a module that declares `configKey` + `configSchema` (see modules.mjs); the app
 * validates those after the modules are known. An unknown top-level key is an error, so typos are caught.
 *
 * Secrets never live in this file: broker credentials go in the encrypted SecretStore, the master key comes
 * from MCB_MASTER_KEY or a key file (see docs/ARCHITECTURE.md §8).
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { BridgeError } from "./errors.mjs";
import { applyDemoConfig, demoFromEnv } from "../demo/demoMode.mjs";

export const DEFAULT_PORT = 4300;
export const DEFAULT_CONFIG_FILE = "bridge.config.json";
/** SEBI/NSE: unregistered retail algos must stay at or below 10 orders/s per exchange segment (needs verification). */
export const SEBI_UNREGISTERED_OPS_CEILING = 10;
export const DEFAULT_ORDER_RATE_PER_SECOND = 5;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
export const isLoopbackHost = (h) => LOOPBACK_HOSTS.has(String(h ?? "").toLowerCase()) || /^127\.\d+\.\d+\.\d+$/.test(String(h ?? ""));

const accountId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/, "use 2-32 lowercase letters, digits or hyphens");
const money = z.number().finite().nonnegative();
/** Sources that may send live orders. "guard" and "alert" are the automated rule sources (opt-in per account, additive). */
const sources = z.enum(["rest", "webhook", "mcp", "cli", "guard", "alert"]);

const limitsOverride = z
  .object({
    dailyMaxOrders: z.number().int().positive().optional(),
    dailyMaxLoss: money.optional(),
    maxOrderValue: money.optional(),
    maxLotsPerOrder: z.number().int().positive().optional(),
    orderRatePerSecond: z.number().positive().max(SEBI_UNREGISTERED_OPS_CEILING).optional(),
  })
  .strict();

export const accountSchema = z
  .object({
    id: accountId,
    broker: z.string().regex(/^[a-z0-9]{2,20}$/, "broker must be an adapter id such as dhan or zerodha, or 'paper'"),
    label: z.string().max(60).optional(),
    /**
     * Whose account this is: any stable label for the account holder (e.g. "self", "spouse", or a hash of the PAN;
     * never the PAN itself). Market-data pooling only ever spreads reads over accounts with the SAME holder, and an
     * account without one is never pooled. Family members are different users under the brokers' personal-use terms.
     */
    holder: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9 _.:-]+$/, "holder may use letters, digits, spaces and _ . : -").optional(),
    enabled: z.boolean().default(true),
    live: z
      .object({
        enabled: z.boolean().default(false),
        allowedSources: z.array(sources).default(["rest"]),
        /** The static IP the user registered with the broker, for the pre-order egress check (optional). */
        registeredIp: z.string().max(64).optional(),
        /** A second static IP registered with the broker (primary + backup). Readiness accepts either (optional). */
        backupIp: z.string().max(64).optional(),
      })
      .strict()
      .prefault({}),
    marketData: z
      .object({
        /** Let this account's market-data budget serve requests that did not name an account. Off by default. */
        pooling: z.boolean().default(false),
        /**
         * Also pool when the broker's terms about spreading one user's reads over that user's own accounts are not
         * confirmed (policy pooling "unknown"). The user's own decision, made in the file only; a broker whose policy
         * says "not-allowed" is never pooled, and accounts of different holders never are either.
         */
        poolingWhenTermsUnknown: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    limits: limitsOverride.prefault({}),
  })
  .strict();

export const coreSchema = z
  .object({
    server: z
      .object({
        host: z.string().default("127.0.0.1"),
        port: z.number().int().min(0).max(65535).default(DEFAULT_PORT),
        /** Must be true to bind anything but loopback. Keys are still required for every route. */
        allowNonLoopback: z.boolean().default(false),
        /**
         * Peer addresses (IPv4 or IPv4/CIDR) that count as "this computer" for this-computer-only routes, besides
         * loopback. Only for Docker, where the host's own browser arrives from the container network's gateway.
         * Leave empty otherwise.
         */
        /**
         * Serve the dashboard pages to other computers, not only this one. Demo mode only (a public demo behind an
         * HTTPS proxy, see deploy/hostinger): the config is refused when demo mode is off, so a Bridge with real
         * broker accounts never shows its dashboard to the internet. Every API call still needs a key.
         */
        remoteDashboard: z.boolean().default(false),
        localPeers: z.array(z.string().regex(/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/, "use an IPv4 address or IPv4/CIDR")).max(8).default([]),
        /** Extra Host header values to accept (DNS-rebinding guard). Loopback names are always accepted. */
        allowedHosts: z.array(z.string()).default([]),
        bodyLimitBytes: z.number().int().positive().max(1_048_576).default(65_536),
        /** Opt-in second listener that serves ONLY routes marked public (webhooks). Off by default. */
        publicIngress: z
          .object({
            enabled: z.boolean().default(false),
            host: z.string().default("127.0.0.1"),
            port: z.number().int().min(0).max(65535).default(DEFAULT_PORT + 1),
            allowedHosts: z.array(z.string()).default([]),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    cors: z
      .object({ allowedOrigins: z.array(z.string().regex(/^https?:\/\/[^/\s]+$/, "an origin is scheme://host[:port] with no path")).default([]) })
      .strict()
      .prefault({}),
    dataDir: z.string().default("./data"),
    /**
     * Where the master key file lives (relative to this config file). `mc-bridge init` puts it OUTSIDE the data folder
     * so a backup or cloud sync of the data folder never carries the key with the secrets. MCB_MASTER_KEY or
     * MCB_MASTER_KEY_FILE in the environment take precedence. Default: <dataDir>/master.key.
     */
    masterKeyFile: z.string().min(1).optional(),
    /** Demo mode: sample market data, no real broker, live trading off (see server/bridge/demo/demoMode.mjs). */
    demo: z.boolean().default(false),
    logging: z
      .object({ level: z.enum(["debug", "info", "warn", "error", "silent"]).default("info") })
      .strict()
      .prefault({}),
    accounts: z.array(accountSchema).default([]),
    safety: z
      .object({
        /** Global master switch for live orders. Off by default; env can never turn it on. */
        liveTrading: z.boolean().default(false),
        orderRatePerSecond: z.number().positive().max(SEBI_UNREGISTERED_OPS_CEILING).default(DEFAULT_ORDER_RATE_PER_SECOND),
        dailyMaxOrders: z.number().int().positive().default(100),
        dailyMaxLoss: money.default(10_000),
        maxOrderValue: money.default(200_000),
        maxLotsPerOrder: z.number().int().positive().default(10),
        priceBandPct: z.number().positive().max(20).default(3),
        marketOrders: z.enum(["protect", "reject"]).default("protect"),
        marketProtectionPct: z.number().positive().max(10).default(2),
        killSwitchOnStart: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
  })
  .catchall(z.unknown());

export const CORE_SECTIONS = Object.freeze(Object.keys(coreSchema.shape));

/**
 * The per-user Bridge folder: MCB_HOME, else %APPDATA%\MrChartist\Bridge on Windows, else ~/.mc-bridge. Used for the
 * config file and data when the current folder has no bridge.config.json, so `mc-bridge keys create` run from any
 * folder talks to the same keys as the running Bridge.
 */
export function userBridgeDir(env = process.env, platform = process.platform) {
  if (env.MCB_HOME) return resolve(env.MCB_HOME);
  if (platform === "win32" && env.APPDATA) return join(env.APPDATA, "MrChartist", "Bridge");
  return join(env.HOME || env.USERPROFILE || homedir(), ".mc-bridge");
}

/**
 * Where the dashboard saves accounts it adds: the file this Bridge loaded, else the per-user file loadConfig looks for
 * last (so a Bridge started without any config file finds the new file on its next start, from any folder).
 * @param {string | null} source  loadConfig's `source`
 */
export function configFileForWrites(source, env = process.env) {
  return source ?? join(userBridgeDir(env), DEFAULT_CONFIG_FILE);
}

/**
 * The config the running app shares with its services: frozen like the loaded one, except that `accounts` is a plain
 * array of frozen entries, so an account added from the dashboard (AccountManager.addAccount) is seen at once by every
 * service that reads config.accounts (safety limits, the paper engine, rate-limit routes). Only AccountManager changes
 * it; nothing else may.
 */
export function withAddableAccounts(config) {
  return Object.freeze({ ...config, accounts: [...config.accounts] });
}

function readConfigFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new BridgeError("VALIDATION_FAILED", `Could not read config file ${path}: ${err.message}`);
  }
}

function envOverrides(env) {
  const o = {};
  if (env.MCB_HOST) o.host = env.MCB_HOST;
  if (env.MCB_PORT) {
    const p = Number(env.MCB_PORT);
    if (!Number.isInteger(p) || p < 0 || p > 65535) throw new BridgeError("VALIDATION_FAILED", "MCB_PORT must be a port number.");
    o.port = p;
  }
  if (env.MCB_DATA_DIR) o.dataDir = env.MCB_DATA_DIR;
  if (env.MCB_LOG_LEVEL) o.logLevel = env.MCB_LOG_LEVEL;
  o.paperOnly = env.MCB_PAPER_ONLY === "1" || env.MCB_PAPER_ONLY === "true";
  o.killSwitch = env.MCB_KILL_SWITCH === "1" || env.MCB_KILL_SWITCH === "true";
  return o;
}

/**
 * Load, merge and validate the configuration.
 * @param {{ path?: string, env?: NodeJS.ProcessEnv, cwd?: string, raw?: object, knownBrokers?: string[], demo?: boolean }} [opts]
 *   raw: use this object instead of reading a file (tests, `doctor`). knownBrokers: adapter ids for account checks.
 *   demo: force demo mode (`mc-bridge start --demo`); MCB_DEMO=1 and `"demo": true` in the file do the same.
 * @returns {{ config: Readonly<any>, warnings: string[], source: string | null }}
 */
export function loadConfig({ path, env = process.env, cwd = process.cwd(), raw, knownBrokers, demo = false } = {}) {
  const warnings = [];
  let source = null;
  let fileObj = raw ?? {};
  /** Without any config file, data goes to the per-user folder (never a stray ./data in whatever folder this ran). */
  let userDefaultDataDir = null;
  if (!raw) {
    const p = path ?? env.MCB_CONFIG ?? DEFAULT_CONFIG_FILE;
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    if (existsSync(abs)) {
      fileObj = readConfigFile(abs);
      source = abs;
    } else if (path || env.MCB_CONFIG) {
      throw new BridgeError("VALIDATION_FAILED", `Config file not found: ${abs}`);
    } else {
      const userFile = join(userBridgeDir(env), DEFAULT_CONFIG_FILE);
      if (existsSync(userFile)) {
        fileObj = readConfigFile(userFile);
        source = userFile;
      } else {
        userDefaultDataDir = join(userBridgeDir(env), "data");
        warnings.push(`No ${DEFAULT_CONFIG_FILE} found in ${cwd} or ${dirname(userFile)}; using safe defaults (paper only, no accounts). Data is kept in ${userDefaultDataDir}.`);
      }
    }
  }
  if (!fileObj || typeof fileObj !== "object" || Array.isArray(fileObj)) throw new BridgeError("VALIDATION_FAILED", "The config must be a JSON object.");

  const parsed = coreSchema.safeParse(fileObj);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message }));
    throw new BridgeError("VALIDATION_FAILED", `Config is not valid: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`, { errors });
  }
  const cfg = structuredClone(parsed.data);

  const ov = envOverrides(env);
  if (ov.host !== undefined) cfg.server.host = ov.host;
  if (ov.port !== undefined) cfg.server.port = ov.port;
  if (ov.dataDir !== undefined) cfg.dataDir = ov.dataDir;
  if (ov.logLevel !== undefined) {
    if (!["debug", "info", "warn", "error", "silent"].includes(ov.logLevel)) throw new BridgeError("VALIDATION_FAILED", "MCB_LOG_LEVEL must be debug, info, warn, error or silent.");
    cfg.logging.level = ov.logLevel;
  }
  if (ov.paperOnly) cfg.safety.liveTrading = false;
  if (ov.killSwitch) cfg.safety.killSwitchOnStart = true;
  if (demo || cfg.demo || demoFromEnv(env)) warnings.push(...applyDemoConfig(cfg));

  // Cross-field rules.
  if (!isLoopbackHost(cfg.server.host) && !cfg.server.allowNonLoopback) {
    throw new BridgeError("VALIDATION_FAILED", `server.host ${cfg.server.host} is not a loopback address. Set server.allowNonLoopback to true in the config file if you really mean it.`);
  }
  if (!isLoopbackHost(cfg.server.host)) warnings.push(`The Bridge will listen on ${cfg.server.host}, not only on this computer. Every route still needs an API key.`);
  if (cfg.server.localPeers.length) warnings.push(`server.localPeers treats ${cfg.server.localPeers.join(", ")} as this computer (meant for Docker). Publish the port on 127.0.0.1 only.`);
  const pi = cfg.server.publicIngress;
  if (pi.enabled && !isLoopbackHost(pi.host)) {
    if (!cfg.server.allowNonLoopback) {
      throw new BridgeError("VALIDATION_FAILED", `server.publicIngress.host ${pi.host} is not a loopback address. Point your tunnel at 127.0.0.1, or set server.allowNonLoopback to true in the config file if you really mean it.`);
    }
    warnings.push(`The webhook listener will listen on ${pi.host}, not only on this computer.`);
  }
  if (cfg.server.remoteDashboard) {
    if (!cfg.demo) throw new BridgeError("VALIDATION_FAILED", "server.remoteDashboard is only allowed in demo mode. A Bridge with real broker accounts serves its dashboard to this computer only.");
    warnings.push("server.remoteDashboard is on (demo mode): the dashboard pages are served to other computers. API calls still need a key.");
  }
  if (cfg.server.publicIngress.enabled) warnings.push("Public ingress is on: only webhook routes are served on it. Keep the tunnel URL private.");
  const ids = new Set();
  for (const a of cfg.accounts) {
    if (ids.has(a.id)) throw new BridgeError("VALIDATION_FAILED", `Duplicate account id ${a.id}.`);
    ids.add(a.id);
    if (knownBrokers && a.broker !== "paper" && !(cfg.demo && a.broker === "demo") && !knownBrokers.includes(a.broker)) {
      throw new BridgeError("VALIDATION_FAILED", `Account ${a.id}: unknown broker ${a.broker}.`);
    }
    if (a.broker === "paper" && a.live.enabled) throw new BridgeError("VALIDATION_FAILED", `Account ${a.id}: a paper account cannot enable live trading.`);
    if (a.live.enabled && !cfg.safety.liveTrading) warnings.push(`Account ${a.id} has live.enabled but safety.liveTrading is off, so it stays paper only.`);
    if (a.live.allowedSources.includes("mcp")) warnings.push(`Account ${a.id} allows live orders from AI assistants. Each one still needs your confirmation in the Bridge.`);
    const r = a.limits.orderRatePerSecond;
    if (r !== undefined && r > cfg.safety.orderRatePerSecond) {
      warnings.push(`Account ${a.id}: limits.orderRatePerSecond ${r} is above the global ${cfg.safety.orderRatePerSecond}; the lower value applies.`);
    }
  }
  const baseDir = source ? dirname(source) : cwd;
  if (userDefaultDataDir && ov.dataDir === undefined) cfg.dataDir = userDefaultDataDir;
  cfg.dataDir = isAbsolute(cfg.dataDir) ? cfg.dataDir : resolve(baseDir, cfg.dataDir);
  if (cfg.masterKeyFile !== undefined) cfg.masterKeyFile = isAbsolute(cfg.masterKeyFile) ? cfg.masterKeyFile : resolve(baseDir, cfg.masterKeyFile);

  return { config: deepFreeze(cfg), warnings, source };
}

/**
 * Settings that older, fuller releases accepted and v2 does not have. A config file that still holds one gets a
 * friendly message naming it (see findRemovedSettings), not a bare "unknown key" and never a crash. Add an entry when
 * a setting is removed; keys are dotted paths, and a top-level section removes everything under it.
 */
export const REMOVED_SETTINGS = Object.freeze({
  alerts: "position alerts are not part of v2",
  triggers: "GTT, trailing stops and position stops are not part of v2",
  watchlists: "watchlists are not part of v2",
  journal: "the trade journal is not part of v2",
  strategies: "the Bridge does not run strategies in v2 (run a script yourself with the Python SDK)",
  scanner: "the scanner is not part of v2",
  analytics: "analytics are not part of v2",
  studies: "studies are not part of v2",
  vol: "volatility data is not part of v2",
  recorder: "the options recorder is not part of v2",
  reference: "the reference-data store is not part of v2",
  participants: "participant open interest is not part of v2",
  notify: "notification targets are not part of v2",
  backup: "backup data is now the sources section (see docs/guides/sources.md)",
  "stream.candles": "live candles are not served by the stream",
});

/**
 * Removed settings present in a raw config object, as readable lines ("alerts: this setting was removed in v2 (...)").
 * Also catches the MCP toolset "options", which no longer exists.
 * @param {any} raw
 * @returns {string[]}
 */
export function findRemovedSettings(raw) {
  const out = [];
  if (!raw || typeof raw !== "object") return out;
  for (const [path, why] of Object.entries(REMOVED_SETTINGS)) {
    const [head, ...rest] = path.split(".");
    let v = raw[head];
    for (const k of rest) v = v && typeof v === "object" ? v[k] : undefined;
    if (v !== undefined) out.push(`${path}: this setting was removed in v2 (${why})`);
  }
  if (Array.isArray(raw.mcp?.toolsets) && raw.mcp.toolsets.includes("options")) out.push('mcp.toolsets "options": this setting was removed in v2 (there are no options tools)');
  return out;
}

/** Sections in `config` that core does not own (each must be claimed by a module). */
export function moduleSections(config) {
  return Object.keys(config).filter((k) => !CORE_SECTIONS.includes(k));
}

/** Effective per-account limits: the stricter of global and account values. */
export function effectiveAccountLimits(config, account) {
  const s = config.safety;
  const o = account?.limits ?? {};
  const min = (a, b) => (b === undefined ? a : Math.min(a, b));
  return Object.freeze({
    dailyMaxOrders: min(s.dailyMaxOrders, o.dailyMaxOrders),
    dailyMaxLoss: min(s.dailyMaxLoss, o.dailyMaxLoss),
    maxOrderValue: min(s.maxOrderValue, o.maxOrderValue),
    maxLotsPerOrder: min(s.maxLotsPerOrder, o.maxLotsPerOrder),
    orderRatePerSecond: min(s.orderRatePerSecond, o.orderRatePerSecond),
  });
}

/** Whether config allows live orders on this account at all (keys, sources and the request still decide). */
export function liveAllowedByConfig(config, account) {
  return Boolean(config.safety.liveTrading && account?.live?.enabled && account.broker !== "paper" && account.enabled !== false);
}

export function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}
