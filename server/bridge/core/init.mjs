/**
 * `mc-bridge init` (alias `setup`): a friendly first-run wizard that also works without questions.
 *
 *  1. bridge.config.json from bridge.config.example.json (accounts replaced by what you choose here);
 *  2. a master key in a private file OUTSIDE the data folder (0600 in a 0700 folder; on Windows the file is
 *     restricted to your user with icacls), recorded as `masterKeyFile` in the config;
 *  3. a first admin key (admin + paper), printed once;
 *  4. a paper account and, optionally, one broker account;
 *  5. the next steps.
 *
 * Interactive when stdin is a terminal and --yes is not given. Flags: --yes, --force, --demo, --broker <id>,
 * --account <id>, --label <text>, --no-paper, --no-key, --config <file>. Nothing secret is asked for here:
 * broker keys are typed later with `mc-bridge accounts connect`, into the encrypted store.
 */
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeError } from "./errors.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const EXAMPLE_CONFIG = join(ROOT, "bridge.config.example.json");

/** Where init keeps the master key: outside the data folder, in a per-user folder only you can read. */
export function defaultMasterKeyPath(env = process.env, platform = process.platform) {
  if (env.MCB_MASTER_KEY_FILE) return resolve(env.MCB_MASTER_KEY_FILE);
  if (platform === "win32" && env.APPDATA) return join(env.APPDATA, "MrChartist", "master.key");
  const base = env.XDG_CONFIG_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".config");
  return join(base, "mc-bridge", "master.key");
}

/**
 * Create the master key file if it does not exist (exclusive create, mode 0600, folder 0700). Never overwrites.
 * @returns {{ path: string, created: boolean, warning: string | null }}
 */
export function ensureMasterKey(path, { platform = process.platform, env = process.env } = {}) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    let warning = null;
    if (platform !== "win32") {
      const mode = statSync(path).mode & 0o777;
      if (mode & 0o077) warning = `${path} is readable by other users (mode ${mode.toString(8)}). Run: chmod 600 "${path}"`;
    }
    return { path, created: false, warning };
  }
  const key = randomBytes(32).toString("base64");
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, `${key}\n`);
  } finally {
    closeSync(fd);
  }
  let warning = null;
  if (platform === "win32") {
    // NTFS ignores the mode: restrict the file to the current user (best effort; doctor reminds otherwise).
    try {
      const user = env.USERNAME ? `${env.USERDOMAIN ? `${env.USERDOMAIN}\\` : ""}${env.USERNAME}` : null;
      if (!user) throw new Error("no USERNAME");
      execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore", windowsHide: true });
    } catch {
      warning = `Could not restrict ${path} to your Windows user automatically. Run: icacls "${path}" /inheritance:r /grant:r %USERNAME%:F`;
    }
  } else {
    try {
      chmodSync(path, 0o600);
      chmodSync(dir, 0o700);
    } catch {
      /* the exclusive create already used 0600 */
    }
  }
  return { path, created: true, warning };
}

/** A config object built from the example: same sections, your accounts, the key file recorded. */
export function buildConfig({ example, accounts, masterKeyFile, configDir, demo = false, docker = false }) {
  const cfg = structuredClone(example);
  if (docker) {
    // Inside the container the Bridge listens on all interfaces; docker-compose.yml publishes it on the host's
    // 127.0.0.1 only. The compose network's gateway is where the host's own browser arrives from.
    cfg.server = { ...cfg.server, host: "0.0.0.0", allowNonLoopback: true, localPeers: DOCKER_LOCAL_PEERS };
  }
  cfg.accounts = accounts;
  // Browser origins are opt-in: start with none (scripts, Excel, AmiBroker, MCP and the dashboard need none).
  cfg.cors = { allowedOrigins: [] };
  // Absolute, so the key never ends up inside a project folder that might be zipped, synced or committed.
  cfg.masterKeyFile = resolve(configDir, masterKeyFile);
  if (demo) cfg.demo = true;
  else delete cfg.demo;
  cfg.safety = { ...cfg.safety, liveTrading: false };
  // Keep the key order readable: put masterKeyFile and demo right after dataDir.
  const ordered = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (k === "masterKeyFile" || k === "demo") continue;
    ordered[k] = v;
    if (k === "dataDir") {
      ordered.masterKeyFile = cfg.masterKeyFile;
      if (cfg.demo) ordered.demo = true;
    }
  }
  return ordered;
}

const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{1,31}$/;
/** docker-compose.yml's network gateway, plus Docker Desktop's host address range (needs verification per setup). */
export const DOCKER_LOCAL_PEERS = Object.freeze(["172.31.240.1", "192.168.65.0/24"]);

/**
 * Run the wizard.
 * @param {Record<string, any>} flags
 * @param {{ out(s: string): void, err(s: string): void, env: NodeJS.ProcessEnv, cwd: string, prompt?: (q: string, o?: object) => Promise<string>, interactive?: boolean }} io
 * @param {{ brokerIds: string[], brokerNames: Record<string, string>, createKey: (configPath: string) => Promise<{ key: string, id: string, existingAdmin?: number } | null> }} deps
 */
export async function runInit(flags, io, deps) {
  const interactive = io.interactive ?? (!flags.yes && Boolean(process.stdin.isTTY));
  const ask = async (q, def) => {
    if (!interactive || !io.prompt) return def;
    const a = String(await io.prompt(`${q}${def !== undefined && def !== "" ? ` [${def}]` : ""}`, { hidden: false })).trim();
    return a === "" ? def : a;
  };
  const yes = async (q, def) => {
    const a = String(await ask(`${q} (y/n)`, def ? "y" : "n")).toLowerCase();
    return a.startsWith("y");
  };
  const say = (s = "") => io.out(s);

  const configPath = resolve(io.cwd, typeof flags.config === "string" ? flags.config : "bridge.config.json");
  const configDir = dirname(configPath);
  say("Mr. Chartist API Bridge: setup");
  say("This sets up the Bridge on this computer. Nothing here sends data anywhere.");
  say("");

  // 1. Config file
  let writeConfig = true;
  if (existsSync(configPath)) {
    if (flags.force) say(`Replacing ${configPath} (--force).`);
    else if (interactive) writeConfig = await yes(`${configPath} already exists. Replace it?`, false);
    else writeConfig = false;
    if (!writeConfig) say(`Keeping your existing ${configPath}.`);
  }

  // 2. Master key (also when the config is kept: a key that exists is never replaced)
  const existing = !writeConfig ? safeJson(configPath) : null;
  const keyPath = existing?.masterKeyFile ? resolve(configDir, existing.masterKeyFile) : defaultMasterKeyPath(io.env);
  let mk = null;
  if (io.env.MCB_MASTER_KEY) say("Master key: using MCB_MASTER_KEY from the environment.");
  else {
    mk = ensureMasterKey(keyPath, { env: io.env });
    say(mk.created ? `Master key: created ${mk.path} (only your user can read it). Back it up somewhere safe; without it saved broker keys cannot be read.` : `Master key: keeping ${mk.path}.`);
    if (mk.warning) io.err(`Warning: ${mk.warning}`);
  }

  if (writeConfig) {
    const example = JSON.parse(readFileSync(EXAMPLE_CONFIG, "utf8"));
    const accounts = [];
    const demo = flags.demo === true || (interactive && !flags.broker && (await yes("Turn on demo mode (sample prices, no broker needed)? You can switch it off later", false)));
    const wantPaper = flags["no-paper"] !== true && (await yes("Add a paper (practice) account with Rs 10,00,000 of virtual money?", true));
    if (wantPaper) accounts.push({ id: "paper", broker: "paper", label: "Practice account" });

    let broker = typeof flags.broker === "string" ? flags.broker.trim().toLowerCase() : null;
    if (!broker && interactive && (await yes("Add a broker account now? (you log in to it later; no keys are asked for here)", false))) {
      say("Brokers: " + deps.brokerIds.join(", "));
      broker = String(await ask("Broker id", "dhan")).trim().toLowerCase();
    }
    if (broker) {
      if (!deps.brokerIds.includes(broker)) throw new BridgeError("VALIDATION_FAILED", `Unknown broker "${broker}". Choose one of: ${deps.brokerIds.join(", ")}.`);
      const id = String(typeof flags.account === "string" ? flags.account : await ask("Account id (lowercase, for example dhan-main)", `${broker}-main`)).trim();
      if (!ACCOUNT_ID.test(id)) throw new BridgeError("VALIDATION_FAILED", `Account id "${id}" is not valid: use 2-32 lowercase letters, digits or hyphens.`);
      if (accounts.some((a) => a.id === id)) throw new BridgeError("VALIDATION_FAILED", `Account id "${id}" is already used.`);
      const label = String(typeof flags.label === "string" ? flags.label : await ask("A name you will recognise", `${deps.brokerNames[broker] ?? broker} (main)`)).slice(0, 60);
      accounts.push({ id, broker, label, holder: "self", live: { enabled: false, allowedSources: ["rest"] }, marketData: { pooling: false } });
    }
    const docker = io.env.MCB_DOCKER === "1";
    const cfg = buildConfig({ example, accounts, masterKeyFile: io.env.MCB_MASTER_KEY ? keyPath : mk.path, configDir, demo, docker });
    if (io.env.MCB_MASTER_KEY) delete cfg.masterKeyFile;
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
    say(`Config: wrote ${configPath} (${accounts.length} account(s)${demo ? ", demo mode on" : ""}; live trading off).`);
  }

  // 3. First admin key
  let created = null;
  if (flags["no-key"] !== true) {
    created = await deps.createKey(configPath);
    if (created) {
      say("");
      say("Your admin key (for the dashboard and for connecting brokers). Copy it now: it is shown only once.");
      say("");
      say(`  ${created.key}`);
      say("");
      say("Keep it like a password. Make smaller keys for each tool on the dashboard's Keys page.");
      if (created.existingAdmin > 0) {
        say("");
        say(`Note: ${created.existingAdmin} admin key(s) already existed, so this is an extra one (${created.id}); the old ones still work.`);
        say("Revoke any you no longer use on the dashboard's Keys page or with: mc-bridge keys revoke <keyId>  (list them: mc-bridge keys list).");
        say("Next time, run init with --no-key to keep your keys, or make another key with: mc-bridge keys create --label <name> --scope admin,paper");
      }
    }
  }

  // 4. Next steps
  const cfg = safeJson(configPath) ?? {};
  const brokerAccount = (cfg.accounts ?? []).find((a) => a.broker !== "paper");
  const docker = io.env.MCB_DOCKER === "1";
  const cmd = docker ? "docker compose exec bridge mc-bridge" : "npm run bridge --";
  say("");
  say("Next steps");
  if (docker) {
    say("  1. The Bridge starts now:    http://127.0.0.1:4300/dashboard (paste the admin key above)");
    say("     Demo mode instead:        set MCB_DEMO=1 in docker-compose.yml and run docker compose up -d");
    if (brokerAccount) say(`  2. Log in to your broker:   docker compose exec -it bridge mc-bridge accounts connect ${brokerAccount.id}`);
    else say("  2. Add a broker:             edit bridge.config.json in the bridge-data volume (docs/guides/accounts.md)");
    say(`  3. Check everything:        ${cmd} doctor`);
    return 0;
  }
  say(`  1. Start the Bridge:        ${cfg.demo ? "npm start -- --open" : "npm start -- --demo --open    (sample data, no broker needed)"}`);
  if (!cfg.demo) say(`                              npm start -- --open           (your real accounts)`);
  say("  2. Open the dashboard:      http://127.0.0.1:4300/dashboard and paste the admin key");
  if (brokerAccount) say(`  3. Log in to your broker:   ${cmd} accounts connect ${brokerAccount.id}   (while the Bridge is running)`);
  else say(`  3. Add a broker later:      add it under "accounts" in bridge.config.json (see docs/guides/accounts.md), then restart`);
  say(`  4. Check everything:        ${cmd} doctor`);
  say("");
  say("Paper trading is the default. Live orders stay off until you switch them on in bridge.config.json.");
  return 0;
}

function safeJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
