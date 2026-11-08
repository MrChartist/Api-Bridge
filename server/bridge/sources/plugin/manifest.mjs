/**
 * The plugin manifest (`mc-source.json`): what a plugin says about itself, validated here before any plugin code runs.
 * The host never executes plugin code to read the manifest. Unknown keys are refused so a typo cannot silently drop a
 * restriction.
 *
 * A plugin is a read-only market-data source. The manifest has no way to name accounts, sessions, orders or portfolio:
 * `capabilities` only accepts the four read capabilities of the source contract.
 */
import { z } from "zod";
import { CAPABILITIES, validateDescriptor } from "../contract.mjs";
import { checkHostPattern } from "./netpolicy.mjs";

export const MANIFEST_FILE = "mc-source.json";
export const API_VERSION = 1;

/** Hard host caps. A manifest may lower these, never raise them. */
export const HOST_LIMITS = Object.freeze({
  callTimeoutMs: { default: 5000, max: 15000 },
  maxInFlight: { default: 1, max: 4 },
  maxResponseBytes: { default: 2 * 1024 * 1024, max: 5 * 1024 * 1024 },
  maxHosts: 10,
});

/** Ids that belong to the Bridge's own sources; a plugin may not shadow them. */
export const RESERVED_IDS = Object.freeze(["broker", "brokers", "demo", "demo-delayed", "demo-eod", "yahoo", "nse", "alphavantage", "twelvedata", "backup", "paper"]);

const SECRET_NAME = /(secret|token|passw|api[-_]?key|credential)/i;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const positive = z.number().finite().positive();

const configField = z
  .object({
    type: z.enum(["string", "number", "integer", "boolean"]),
    enum: z.array(z.union([z.string().max(100), z.number().finite()])).min(1).max(50).optional(),
    default: z.union([z.string().max(1000), z.number().finite(), z.boolean()]).optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    maxLength: z.number().int().min(1).max(1000).optional(),
    required: z.boolean().optional(),
    description: z.string().max(300).optional(),
  })
  .strict();

const manifestSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, "must be lowercase letters, digits and dashes, 2 to 31 characters, starting with a letter"),
    name: z.string().trim().min(1).max(60),
    version: z.string().regex(SEMVER, "must be a semantic version such as 1.0.0"),
    apiVersion: z.literal(API_VERSION, { error: `apiVersion must be ${API_VERSION}` }),
    entry: z.string().min(1).max(120),
    description: z.string().max(300).optional(),
    capabilities: z.array(z.enum(CAPABILITIES, { error: `must be one of ${CAPABILITIES.join(", ")} (a plugin is read-only market data)` })).min(1).max(CAPABILITIES.length),
    class: z.enum(["realtime", "delayed", "eod"]),
    delaySec: positive.max(7 * 86400).nullable().optional(),
    official: z.literal(false, { error: "official must be false: a plugin is never an official source" }).optional(),
    network: z
      .object({
        allowHosts: z.array(z.string()).max(HOST_LIMITS.maxHosts),
        allowPost: z.boolean().optional(),
      })
      .strict(),
    limits: z
      .object({
        perSecond: positive.max(1000).optional(),
        perMinute: positive.max(60_000).optional(),
        perDay: positive.max(10_000_000).optional(),
        callTimeoutMs: z.number().int().min(100).max(HOST_LIMITS.callTimeoutMs.max).optional(),
        maxInFlight: z.number().int().min(1).max(HOST_LIMITS.maxInFlight.max).optional(),
        maxResponseBytes: z.number().int().min(1024).max(HOST_LIMITS.maxResponseBytes.max).optional(),
      })
      .strict(),
    terms: z.object({ url: z.string().regex(/^https:\/\//, "must be an https URL").max(300), note: z.string().trim().min(1).max(300) }).strict(),
    secrets: z.array(z.literal("apiKey")).max(1).optional(),
    configSchema: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/, "config names are letters, digits and underscores"), configField).optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    const add = (path, message) => ctx.addIssue({ code: "custom", path, message });
    if (RESERVED_IDS.includes(m.id)) add(["id"], `${m.id} is reserved for a built-in source`);
    if (m.class === "delayed" && !m.delaySec) add(["delaySec"], "a delayed plugin must state delaySec");
    if (m.class === "realtime" && m.delaySec) add(["delaySec"], "a realtime plugin must not state delaySec");
    if (!["perSecond", "perMinute", "perDay"].some((k) => m.limits[k] !== undefined)) add(["limits"], "state at least one of perSecond, perMinute, perDay");
    m.network.allowHosts.forEach((h, i) => {
      const why = checkHostPattern(h);
      if (why) add(["network", "allowHosts", i], `${JSON.stringify(h)} ${why}`);
    });
    if (new Set(m.network.allowHosts).size !== m.network.allowHosts.length) add(["network", "allowHosts"], "duplicate host entries");
    if (new Set(m.capabilities).size !== m.capabilities.length) add(["capabilities"], "duplicate capabilities");
    const e = m.entry;
    if (e.startsWith("/") || e.startsWith("\\") || /^[a-zA-Z]:/.test(e) || e.split(/[\\/]/).some((p) => p === ".." || p === "") || !/\.(mjs|js)$/.test(e)) {
      add(["entry"], "must be a relative path to one .mjs or .js file inside the plugin folder");
    }
    for (const [k, f] of Object.entries(m.configSchema ?? {})) {
      if (SECRET_NAME.test(k)) add(["configSchema", k], "secrets are not config: declare `secrets: [\"apiKey\"]` and set the key with `mc-bridge sources set-key`");
      if (f.default !== undefined && !fieldAccepts(f, f.default)) add(["configSchema", k, "default"], "the default does not satisfy the field's own rules");
    }
  });

function fieldAccepts(f, v) {
  return compileField(f).safeParse(v).success;
}

function compileField(f) {
  let s;
  if (f.type === "boolean") s = z.boolean();
  else if (f.type === "string") s = f.maxLength ? z.string().max(f.maxLength) : z.string().max(1000);
  else {
    let n = f.type === "integer" ? z.number().int() : z.number().finite();
    if (f.minimum !== undefined) n = n.min(f.minimum);
    if (f.maximum !== undefined) n = n.max(f.maximum);
    s = n;
  }
  if (f.enum) {
    const allowed = new Set(f.enum);
    s = s.refine((v) => allowed.has(v), { message: `must be one of ${f.enum.join(", ")}` });
  }
  return s;
}

/** Zod issues as short readable lines: `network.allowHosts.0: "10.0.0.1" IP addresses are not allowed`. */
function lines(error) {
  return error.issues.map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`);
}

/**
 * Validate manifest JSON (already parsed). Returns every problem at once.
 * @param {unknown} json
 * @returns {{ ok: true, manifest: Manifest } | { ok: false, errors: string[] }}
 *
 * @typedef {z.infer<typeof manifestSchema>} Manifest
 */
export function parseManifest(json) {
  const r = manifestSchema.safeParse(json);
  return r.success ? { ok: true, manifest: r.data } : { ok: false, errors: lines(r.error) };
}

/** Parse manifest text; invalid JSON is one clear error, not a crash. */
export function parseManifestText(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [`${MANIFEST_FILE} is not valid JSON: ${String(err.message).slice(0, 120)}`] };
  }
  return parseManifest(json);
}

/** The limits the host enforces for this plugin: the manifest's own figures, never above the host caps. */
export function effectiveLimits(manifest) {
  const l = manifest.limits;
  return {
    callTimeoutMs: Math.min(l.callTimeoutMs ?? HOST_LIMITS.callTimeoutMs.default, HOST_LIMITS.callTimeoutMs.max),
    maxInFlight: Math.min(l.maxInFlight ?? HOST_LIMITS.maxInFlight.default, HOST_LIMITS.maxInFlight.max),
    maxResponseBytes: Math.min(l.maxResponseBytes ?? HOST_LIMITS.maxResponseBytes.default, HOST_LIMITS.maxResponseBytes.max),
    perSecond: l.perSecond,
    perMinute: l.perMinute,
    perDay: l.perDay,
  };
}

/**
 * The source descriptor for a manifest. Tier is always `plugin`, kind `plugin`, official false; the data class is
 * the manifest's own claim. `flags` and `trust` label every answer from it.
 */
export function descriptorFromManifest(manifest) {
  const { perSecond, perMinute, perDay } = effectiveLimits(manifest);
  const limits = {};
  if (perSecond !== undefined) limits.perSecond = perSecond;
  if (perMinute !== undefined) limits.perMinute = perMinute;
  if (perDay !== undefined) limits.perDay = perDay;
  const descriptor = {
    id: manifest.id,
    name: manifest.name,
    kind: "plugin",
    tier: "plugin",
    class: manifest.class,
    delaySec: manifest.class === "realtime" ? null : (manifest.delaySec ?? null),
    official: false,
    capabilities: [...manifest.capabilities],
    limits,
    terms: { url: manifest.terms.url, note: manifest.terms.note },
    version: manifest.version,
    flags: ["plugin"],
    trust: "untrusted",
  };
  if (manifest.secrets?.length) descriptor.needsKey = true;
  return descriptor;
}

/**
 * Validate a plugin's descriptor with the shared contract check, after forcing the fields a plugin may not choose.
 * @returns {{ ok: boolean, errors: string[], descriptor: object }}
 */
export function checkedDescriptor(manifest) {
  const descriptor = { ...descriptorFromManifest(manifest), tier: "plugin", kind: "plugin", official: false };
  const v = validateDescriptor(descriptor);
  return { ok: v.ok, errors: v.errors, descriptor };
}

/**
 * Check an owner-supplied config object against the manifest's `configSchema` (unknown keys refused, defaults applied).
 * @returns {{ ok: true, value: Record<string, string|number|boolean> } | { ok: false, errors: string[] }}
 */
export function validateConfig(manifest, config = {}) {
  const spec = manifest.configSchema ?? {};
  const input = config && typeof config === "object" && !Array.isArray(config) ? config : null;
  if (!input) return { ok: false, errors: ["config must be an object"] };
  const errors = [];
  const value = {};
  for (const k of Object.keys(input)) if (!Object.hasOwn(spec, k)) errors.push(`${k}: unknown setting`);
  for (const [k, f] of Object.entries(spec)) {
    const given = Object.hasOwn(input, k) ? input[k] : undefined;
    if (given === undefined) {
      if (f.default !== undefined) value[k] = f.default;
      else if (f.required) errors.push(`${k}: required`);
      continue;
    }
    const r = compileField(f).safeParse(given);
    if (r.success) value[k] = r.data;
    else errors.push(`${k}: ${r.error.issues[0].message}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}
