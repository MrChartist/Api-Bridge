/**
 * Loads the plugins the owner listed under `sources.plugins` in the config: `{ path, sha256, granted }`.
 *
 * A plugin is loaded only when ALL of this holds:
 *   - `granted` is exactly true (the owner reviewed its manifest: hosts, capabilities, limits, terms);
 *   - the folder holds a valid `mc-source.json` (manifest.mjs) and the entry file it names, inside that folder;
 *   - the pin matches: `sha256` is the digest of the manifest AND the entry file (see pinOf). A changed file is refused
 *     until the owner reviews the change and updates the pin. The child process re-checks the entry bytes it imports;
 *   - the descriptor passes `validateDescriptor` (tier is forced to `plugin`, official to false).
 *
 * The result is a list of SourceProviders that proxy every call to the plugin's child process. Their data is labelled
 * with the class from the manifest, `official: false` and the flag `plugin`. Nothing here gives a plugin a way to name an
 * account: calls carry symbols, intervals and underlyings, never an account id.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { BridgeError } from "../../core/errors.mjs";
import { MANIFEST_FILE, checkedDescriptor, parseManifestText, validateConfig } from "./manifest.mjs";
import { createPluginHost } from "./host.mjs";

/** Purposes for which a plugin may never answer, whatever its data class says (the router also refuses them). */
export const PURPOSES_REFUSED_FOR_PLUGINS = Object.freeze(["alert", "paper", "risk", "order"]);

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The pin for a plugin: sha256 over a fixed header line and the digests of the manifest file and the entry file.
 * Changing either file changes it.
 * @param {Buffer|string} manifestBytes @param {Buffer|string} entryBytes
 */
export function pinOf(manifestBytes, entryBytes) {
  return sha(`mc-source-pin/1\nmanifest:${sha(manifestBytes)}\nentry:${sha(entryBytes)}\n`);
}

/** Read a plugin folder and describe it, without starting anything. Used by the loader and by `plugins check` / `plugins pin`. */
export function inspectPluginFolder(path, { baseDir = process.cwd() } = {}) {
  const problems = [];
  const dir = isAbsolute(path) ? path : resolve(baseDir, path);
  let real;
  try {
    real = realpathSync(dir);
    if (!statSync(real).isDirectory()) throw new Error("not a folder");
  } catch {
    return { ok: false, problems: [`${path}: the folder does not exist`] };
  }
  if (real.includes(",")) return { ok: false, problems: [`${path}: the folder path must not contain a comma`] };
  const manifestPath = join(real, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return { ok: false, problems: [`${path}: no ${MANIFEST_FILE} in the folder`] };
  const manifestBytes = readFileSync(manifestPath);
  const parsed = parseManifestText(manifestBytes.toString("utf8"));
  if (!parsed.ok) return { ok: false, problems: parsed.errors.map((e) => `${MANIFEST_FILE}: ${e}`) };
  const manifest = parsed.manifest;
  let entryPath;
  try {
    entryPath = realpathSync(resolve(real, manifest.entry));
  } catch {
    return { ok: false, manifest, problems: [`entry ${manifest.entry} does not exist in the folder`] };
  }
  const rel = relative(real, entryPath);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) return { ok: false, manifest, problems: [`entry ${manifest.entry} resolves outside the plugin folder`] };
  if (!statSync(entryPath).isFile()) return { ok: false, manifest, problems: [`entry ${manifest.entry} is not a file`] };
  const entryBytes = readFileSync(entryPath);
  const { ok, errors, descriptor } = checkedDescriptor(manifest);
  if (!ok) problems.push(...errors.map((e) => `descriptor: ${e}`));
  return { ok: problems.length === 0, problems, dir: real, manifest, descriptor, entryPath, entrySha: sha(entryBytes), manifestSha: sha(manifestBytes), pin: pinOf(manifestBytes, entryBytes) };
}

/** Does this descriptor claim a capability the manifest declared? (Providers expose only declared methods.) */
const declares = (descriptor, cap) => descriptor.capabilities.includes(cap);

const ensureStrings = (v, what, max = 200) => {
  if (!Array.isArray(v) || v.length === 0 || v.length > max || v.some((s) => typeof s !== "string" || !s || s.length > 60)) throw new BridgeError("VALIDATION_FAILED", `${what} must be 1 to ${max} short strings.`);
  return v;
};
const ensureOne = (v, what) => {
  if (typeof v !== "string" || !v || v.length > 60) throw new BridgeError("VALIDATION_FAILED", `${what} must be a short string.`);
  return v;
};
const refusePurpose = (id, ctx) => {
  if (ctx?.purpose && PURPOSES_REFUSED_FOR_PLUGINS.includes(ctx.purpose)) throw new BridgeError("CAPABILITY_UNSUPPORTED", `Plugin ${id} is not used for ${ctx.purpose} reads.`);
};

/**
 * The SourceProvider that proxies to a plugin host.
 * @param {ReturnType<typeof createPluginHost>} host
 */
export function providerFor(descriptor, host, extra = {}) {
  const id = descriptor.id;
  const provider = { descriptor, hosts: [...(extra.hosts ?? [])], ...extra };
  // Every answer is labelled: it came from a plugin, it is unofficial, and it is as late as the manifest says.
  const flags = () => ["plugin", "unofficial", descriptor.class];
  const opts = (ctx) => ({ signal: ctx?.signal });
  if (declares(descriptor, "quotes")) {
    provider.quotes = async (symbols, ctx) => {
      refusePurpose(id, ctx);
      const r = await host.call("quotes", { symbols: ensureStrings(symbols, "symbols") }, opts(ctx));
      return { items: r.items.map((it) => ({ ...it, flags: flags() })), flags: flags() };
    };
  }
  if (declares(descriptor, "history")) {
    provider.history = async (req, ctx) => {
      refusePurpose(id, ctx);
      const symbol = ensureOne(req?.symbol, "symbol");
      const interval = ensureOne(req?.interval, "interval");
      if (!Number.isFinite(req.fromMs) || !Number.isFinite(req.toMs)) throw new BridgeError("VALIDATION_FAILED", "fromMs and toMs must be numbers.");
      const r = await host.call("history", { symbol, interval, fromMs: req.fromMs, toMs: req.toMs }, opts(ctx));
      return { ...r, flags: flags() };
    };
  }
  if (declares(descriptor, "expiries")) {
    provider.expiries = async (underlying, ctx) => {
      refusePurpose(id, ctx);
      const r = await host.call("expiries", { underlying: ensureOne(underlying, "underlying") }, opts(ctx));
      return { ...r, flags: flags() };
    };
  }
  if (declares(descriptor, "optionChain")) {
    provider.optionChain = async (underlying, expiry, ctx) => {
      refusePurpose(id, ctx);
      if (expiry !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(expiry))) throw new BridgeError("VALIDATION_FAILED", "expiry must be YYYY-MM-DD.");
      const r = await host.call("optionChain", { underlying: ensureOne(underlying, "underlying"), ...(expiry ? { expiry } : {}) }, opts(ctx));
      return { ...r, flags: flags() };
    };
  }
  provider.test = async (ctx) => {
    const t0 = Date.now();
    try {
      const r = await host.call("test", {}, opts(ctx));
      return { ok: r.ok, latencyMs: r.latencyMs ?? Date.now() - t0, ...(r.detail ? { detail: r.detail } : {}) };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, detail: String(err?.detail ?? err?.message ?? err).slice(0, 200) };
    }
  };
  /** Health the service can merge into the source's `health`: disabled and restarting are surfaced with their reason. */
  provider.health = () => {
    const s = host.status();
    const state = s.state === "disabled" ? "disabled" : s.state === "restarting" ? "open" : s.restarts > 0 ? "degraded" : "ok";
    return { state, errorRate: null, p50Ms: null, lastError: s.reason ?? s.lastError, nextTryAt: s.nextTryAt ? new Date(s.nextTryAt).toISOString() : null };
  };
  provider.stop = () => host.stop();
  return provider;
}

/**
 * @param {object} opts
 * @param {Array<{ path: string, sha256: string, granted: boolean, config?: object }>} opts.entries  `sources.plugins`
 * @param {string} [opts.baseDir]  relative paths resolve against this (the folder of the config file)
 * @param {(pluginId: string) => Promise<string|undefined>|string|undefined} [opts.readSecret]  the key stored for `source:<id>`
 * @param {object} [opts.logger]
 * @param {(id: string, state: { state: string, reason?: string }) => void} [opts.onStateChange]
 * @param {Set<string>|string[]} [opts.takenIds]  ids already registered (built-in sources); a plugin may not reuse one
 * @param {typeof createPluginHost} [opts.hostFactory]  injected in tests
 * @returns {{ providers: object[], problems: Array<{ path: string, id?: string, reason: string }>, stop(): Promise<void> }}
 */
export function loadPlugins({ entries = [], baseDir = process.cwd(), readSecret, logger, onStateChange, takenIds = [], hostFactory = createPluginHost, ...hostOptions } = {}) {
  const providers = [];
  const problems = [];
  const hosts = [];
  const seen = new Set(takenIds);
  for (const entry of entries) {
    const path = String(entry?.path ?? "");
    const refuse = (reason, id) => {
      problems.push({ path, ...(id ? { id } : {}), reason });
      logger?.warn?.(`plugin ${id ?? path} not loaded: ${reason}`);
    };
    if (!path) {
      refuse("an entry has no path");
      continue;
    }
    if (entry.granted !== true) {
      refuse("not granted: set granted to true after reviewing the plugin's manifest");
      continue;
    }
    if (!/^[0-9a-f]{64}$/.test(String(entry.sha256 ?? ""))) {
      refuse("no valid sha256 pin: run `mc-bridge sources plugins pin <folder>` and put the result in the config");
      continue;
    }
    const info = inspectPluginFolder(path, { baseDir });
    if (!info.ok) {
      refuse(info.problems.join("; "), info.manifest?.id);
      continue;
    }
    const id = info.manifest.id;
    if (info.pin !== entry.sha256) {
      refuse(`the plugin files changed since they were pinned (found ${info.pin.slice(0, 12)}..., config has ${entry.sha256.slice(0, 12)}...). Review the change, then update sha256 in the config (mc-bridge sources plugins pin <folder>)`, id);
      continue;
    }
    if (seen.has(id)) {
      refuse(`the id ${id} is already used by another source`, id);
      continue;
    }
    const cfg = validateConfig(info.manifest, entry.config ?? {});
    if (!cfg.ok) {
      refuse(`config: ${cfg.errors.join("; ")}`, id);
      continue;
    }
    seen.add(id);
    const host = hostFactory({
      manifest: info.manifest,
      pluginDir: info.dir,
      entryPath: info.entryPath,
      entrySha: info.entrySha,
      config: cfg.value,
      readSecret: readSecret ? () => readSecret(id) : undefined,
      logger,
      onStateChange: onStateChange ? (s) => onStateChange(id, s) : undefined,
      ...hostOptions,
    });
    hosts.push(host);
    providers.push(providerFor(info.descriptor, host, { hosts: info.manifest.network.allowHosts, plugin: { version: info.manifest.version, folder: info.dir, pin: info.pin } }));
  }
  return { providers, problems, stop: async () => void (await Promise.all(hosts.map((h) => h.stop()))) };
}
