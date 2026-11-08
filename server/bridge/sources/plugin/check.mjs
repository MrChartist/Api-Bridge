/**
 * `mc-bridge sources plugins check <folder>`: validate a plugin folder and run the provider conformance harness against
 * it, fully offline. The plugin is started for real (the same process, flags and host as in production) but every
 * request it makes goes through the host-brokered fetch to a scripted upstream built from the plugin's own fixtures.
 *
 * The folder needs `fixtures/conformance.json`:
 *
 *   {
 *     "inputs": { "quotes": ["NSE:RELIANCE"] },                       one entry per declared capability (see conformance.mjs)
 *     "responses": [ { "urlContains": "/v1/quotes", "file": "quotes.json" },
 *                    { "urlContains": "/v1/status", "json": { "ok": true } } ],   what the vendor answers; a request no entry
 *                                                                                  matches fails the check
 *     "config": { "market": "NSE" },                                  optional owner settings
 *     "hosts": ["quotes.example.com"]                                 optional; concrete host names when allowHosts uses wildcards
 *   }
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { effectiveLimits } from "./manifest.mjs";
import { inspectPluginFolder, loadPlugins } from "./loader.mjs";
import { createFetchBroker } from "./netbroker.mjs";

export const FIXTURE_FILE = join("fixtures", "conformance.json");
const CANARY = "CONFORMANCE-CANARY-KEY-123";

const step = (name, ok, detail) => ({ name, ok, ...(detail ? { detail } : {}) });

/** Load fixtures/conformance.json; `responses[].file` is read from the fixtures folder (and may not leave it). */
function readFixtures(dir) {
  const file = join(dir, FIXTURE_FILE);
  if (!existsSync(file)) return { error: `no ${FIXTURE_FILE}: add one with "inputs" (a value for each declared capability) and "responses" (what the vendor answers). See docs/source-contract.md.` };
  let json;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { error: `${FIXTURE_FILE} is not valid JSON: ${String(err.message).slice(0, 100)}` };
  }
  if (!json || typeof json !== "object" || !json.inputs || typeof json.inputs !== "object") return { error: `${FIXTURE_FILE} needs an "inputs" object` };
  if (!Array.isArray(json.responses) || json.responses.length === 0) return { error: `${FIXTURE_FILE} needs a non-empty "responses" array` };
  const root = resolve(dir, "fixtures");
  const responses = [];
  for (const r of json.responses) {
    if (!r || typeof r.urlContains !== "string" || !r.urlContains) return { error: `every response needs "urlContains"` };
    let body;
    if (typeof r.file === "string") {
      const p = resolve(root, r.file);
      if (!p.startsWith(root + sep) || !existsSync(p)) return { error: `fixture file ${r.file} is missing or outside the fixtures folder` };
      body = readFileSync(p, "utf8");
    } else if (r.json !== undefined) body = JSON.stringify(r.json);
    else if (typeof r.text === "string") body = r.text;
    else return { error: `response for ${r.urlContains} needs "file", "json" or "text"` };
    responses.push({ urlContains: r.urlContains, status: Number.isInteger(r.status) ? r.status : 200, headers: r.headers ?? {}, body });
  }
  return { inputs: json.inputs, responses, config: json.config ?? {}, hosts: Array.isArray(json.hosts) ? json.hosts : null };
}

/**
 * @param {string} path  the plugin folder
 * @param {{ baseDir?: string, harness?: { runProviderConformance: Function, createFakeClock: Function, createScriptedFetch: Function } }} [opts]
 *   harness: the conformance module; loaded from ../conformance.mjs when not given
 * @returns {Promise<{ ok: boolean, steps: Array<{ name: string, ok: boolean, detail?: string }>, pin?: string, descriptor?: object }>}
 */
export async function checkPluginFolder(path, { baseDir = process.cwd(), harness } = {}) {
  const steps = [];
  const info = inspectPluginFolder(path, { baseDir });
  if (!info.ok) {
    for (const p of info.problems) steps.push(step("manifest", false, p));
    return { ok: false, steps };
  }
  steps.push(step("manifest", true, `${info.manifest.id} ${info.manifest.version}, ${info.descriptor.class}${info.descriptor.delaySec ? ` (${info.descriptor.delaySec} s)` : ""}, ${info.manifest.capabilities.join(", ")}`));
  steps.push(step("hosts", true, info.manifest.network.allowHosts.length ? `may reach ${info.manifest.network.allowHosts.join(", ")}` : "no network access"));

  let mod = harness;
  if (!mod) {
    try {
      mod = await import("../conformance.mjs");
    } catch {
      steps.push(step("conformance harness", false, "server/bridge/sources/conformance.mjs is not available in this build"));
      return { ok: false, steps, pin: info.pin, descriptor: info.descriptor };
    }
  }
  const fx = readFixtures(info.dir);
  if (fx.error) {
    steps.push(step("fixtures", false, fx.error));
    return { ok: false, steps, pin: info.pin, descriptor: info.descriptor };
  }
  steps.push(step("fixtures", true, `${fx.responses.length} scripted response(s)`));

  const clock = mod.createFakeClock();
  const unmatched = new Set();
  const scenarios = {
    ok: (url) => {
      const hit = fx.responses.find((r) => url.includes(r.urlContains));
      if (!hit) {
        unmatched.add(url);
        return { status: 599, text: "no fixture matches this request" };
      }
      return { status: hit.status, headers: hit.headers, text: hit.body };
    },
    "rate-limited": () => ({ status: 429, headers: { "retry-after": "30" }, text: "slow down" }),
    "not-found": () => ({ status: 404, text: "no such symbol" }),
    upstream: () => ({ status: 500, text: "boom" }),
    auth: () => ({ status: 401, text: "bad key" }),
  };
  const upstream = mod.createScriptedFetch({ clock, scenarios });
  const transport = async ({ url, method, headers, body, signal }) => {
    const r = await upstream(url.href, { method, headers, body, signal, redirect: "error" });
    return { status: r.status, headers: Object.fromEntries(r.headers.entries()), body: await r.text() };
  };
  const broker = createFetchBroker({
    id: info.manifest.id,
    version: info.manifest.version,
    allowHosts: info.manifest.network.allowHosts,
    allowPost: info.manifest.network.allowPost === true,
    limits: effectiveLimits(info.manifest),
    clock: clock.now,
    transport,
  });
  const needsKey = info.manifest.secrets?.includes("apiKey");
  const logs = [];
  const loaded = loadPlugins({
    entries: [{ path: info.dir, sha256: info.pin, granted: true, config: fx.config }],
    broker,
    clock: clock.now,
    readSecret: needsKey ? () => CANARY : undefined,
    logger: { debug: (m) => logs.push(m), info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  try {
    if (loaded.problems.length || !loaded.providers.length) {
      steps.push(step("load", false, loaded.problems.map((p) => p.reason).join("; ") || "the plugin did not load"));
      return { ok: false, steps, pin: info.pin, descriptor: info.descriptor };
    }
    const provider = loaded.providers[0];
    steps.push(step("load", true, "granted, pinned, descriptor valid"));
    const hosts = fx.hosts ?? info.manifest.network.allowHosts.filter((h) => !h.startsWith("*."));
    const report = await mod.runProviderConformance(provider, { clock, upstream, inputs: fx.inputs, hosts, secrets: needsKey ? [CANARY] : [], logs: () => logs });
    for (const c of report.checks) steps.push(step(`conformance: ${c.name}`, c.ok, c.detail));

    steps.push(step("requests matched fixtures", unmatched.size === 0, unmatched.size ? `no fixture for: ${[...unmatched].slice(0, 3).join(", ")}` : undefined));
    const status = provider.health();
    steps.push(step("plugin stayed healthy", status.state !== "disabled", status.state === "disabled" ? status.lastError : undefined));
    return { ok: steps.every((s) => s.ok), steps, pin: info.pin, descriptor: info.descriptor };
  } finally {
    await loaded.stop();
  }
}
