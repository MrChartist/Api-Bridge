/**
 * The plugin host with a REAL child process (no network): proves the clean environment, the Node permission flags and
 * the runner's hash re-check on the actual Node binary. Everything the plugin tries is local.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { inspectPluginFolder, loadPlugins } from "./loader.mjs";
import { createFetchBroker } from "./netbroker.mjs";
import { createPluginHost, permissionFlagFor } from "./host.mjs";
import { parseManifest } from "./manifest.mjs";
import { testManifest } from "./__fixtures__/fakeChild.mjs";

const PROBE = `
import fs from "node:fs";
import cp from "node:child_process";
import net from "node:net";
import { Worker } from "node:worker_threads";

const probe = async (label, fn) => {
  try { return [label, await fn()]; } catch (e) { return [label, "threw:" + (e.code || e.name)]; }
};

export default {
  async quotes(symbols, ctx) {
    const results = Object.fromEntries(await Promise.all([
      probe("envCount", () => Object.keys(process.env).length),
      probe("canaryEnv", () => String(process.env.CANARY_ENV)),
      probe("fetchGlobal", () => typeof globalThis.fetch),
      probe("readEtcHosts", () => fs.readFileSync("/etc/hosts", "utf8").length > 0 ? "READ" : "EMPTY"),
      probe("readOutside", () => fs.readFileSync(process.argv[2].slice(0, -"/index.mjs".length) + ".outside", "utf8")),
      probe("readOwnFolder", () => fs.readFileSync("data.txt", "utf8")),
      probe("writeFile", () => fs.writeFileSync("out.txt", "x")),
      probe("spawn", () => cp.execSync("id").toString()),
      probe("worker", () => new Worker("1", { eval: true })),
      probe("eval", () => eval("1 + 1")),
      probe("cwd", () => process.cwd()),
      probe("net", () => new Promise((resolve) => { const s = net.connect(1, "127.0.0.1"); s.on("error", (e) => resolve("error:" + e.code)); s.on("connect", () => { s.destroy(); resolve("connected"); }); })),
    ]));
    ctx.log("info", "PROBE " + JSON.stringify(results));
    return { items: [{ symbol: "NSE:PROBE", at: ctx.now - 1000, fields: { ltp: 1 } }] };
  },
  async test(ctx) {
    const res = await ctx.fetch("https://127.0.0.1/steal").catch((e) => ({ err: e.code + ":" + e.message }));
    ctx.log("info", "FETCH " + JSON.stringify(res));
    return { ok: true };
  },
};
`;

const dirs = [];
const hostsToStop = [];
afterEach(async () => {
  await Promise.all(hostsToStop.splice(0).map((h) => h.stop()));
});

function plugin(entry = PROBE, manifest = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mcb-plugin-real-"));
  dirs.push(dir);
  writeFileSync(join(dir, "mc-source.json"), JSON.stringify(testManifest({ limits: { perSecond: 5, callTimeoutMs: 8000 }, ...manifest })));
  writeFileSync(join(dir, "index.mjs"), entry);
  writeFileSync(join(dir, "data.txt"), "inside the plugin folder");
  writeFileSync(`${dir}.outside`, "SECRET-OUTSIDE-THE-FOLDER"); // a sibling of the folder, like a Bridge data dir
  return dir;
}

const forbiddenTransport = async () => {
  throw new Error("the network must not be touched");
};

function start(dir, { logs = [], hostOptions = {}, entrySha } = {}) {
  const info = inspectPluginFolder(dir);
  const manifest = parseManifest(JSON.parse(JSON.stringify(info.manifest))).manifest;
  const host = createPluginHost({
    manifest,
    pluginDir: info.dir,
    entryPath: info.entryPath,
    entrySha: entrySha ?? info.entrySha,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: () => {} },
    broker: createFetchBroker({ id: manifest.id, version: manifest.version, allowHosts: manifest.network.allowHosts, limits: { perSecond: 5 }, transport: forbiddenTransport }),
    readyTimeoutMs: 15_000,
    ...hostOptions,
  });
  hostsToStop.push(host);
  return host;
}

describe("a real plugin process", () => {
  beforeAll(() => {
    expect(permissionFlagFor()).toBe("--permission"); // these tests need a Node with the permission model
  });

  it("runs with an empty environment, a locked-down file system, no child processes, no workers and no eval", async () => {
    process.env.CANARY_ENV = "must-not-leak";
    process.env.MCB_MASTER_KEY = "must-not-leak-either";
    try {
      const dir = plugin();
      const logs = [];
      const host = start(dir, { logs });
      const r = await host.call("quotes", { symbols: ["NSE:PROBE"] });
      expect(r.items[0].symbol).toBe("NSE:PROBE");
      const line = logs.find((l) => l.includes("PROBE "));
      expect(line).toBeDefined();
      const probe = JSON.parse(line.slice(line.indexOf("PROBE ") + 6).trim());
      expect(probe.envCount).toBe(0);
      expect(probe.canaryEnv).toBe("undefined");
      expect(probe.fetchGlobal).toBe("undefined");
      expect(probe.readEtcHosts).toBe("threw:ERR_ACCESS_DENIED");
      expect(probe.readOutside).toBe("threw:ERR_ACCESS_DENIED");
      expect(probe.readOwnFolder).toBe("inside the plugin folder");
      expect(probe.writeFile).toBe("threw:ERR_ACCESS_DENIED");
      expect(probe.spawn).toBe("threw:ERR_ACCESS_DENIED");
      expect(probe.worker).toBe("threw:ERR_ACCESS_DENIED");
      expect(probe.eval).toMatch(/threw:EvalError/);
      expect(probe.cwd).toBe(info(dir).dir);
      // The honest limit, stated in docs/source-contract.md: Node 22 has no network permission, so a plugin that opens
      // its own socket is not stopped by the flags (here it reaches a closed local port).
      expect(probe.net).toBe("error:ECONNREFUSED");
    } finally {
      delete process.env.CANARY_ENV;
      delete process.env.MCB_MASTER_KEY;
    }
  }, 30_000);

  it("a fetch to a private address goes through the host and is refused there, without touching the network", async () => {
    const dir = plugin();
    const logs = [];
    const host = start(dir, { logs });
    expect(await host.call("test", {})).toEqual({ ok: true });
    const line = logs.find((l) => l.includes("FETCH "));
    expect(line).toMatch(/HOST_NOT_ALLOWED|INTERNAL|IP addresses are not allowed/);
  }, 30_000);

  it("the runner re-checks the entry bytes against the pin: a file changed after the check is not run", async () => {
    const dir = plugin();
    const host = start(dir, { entrySha: "0".repeat(64) });
    await expect(host.call("quotes", { symbols: ["A"] })).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE" });
    const s = host.status();
    expect(s.state).toBe("disabled");
    expect(s.reason).toMatch(/does not match its pinned sha256/);
  }, 30_000);

  it("an entry that throws at load disables the plugin instead of restarting it forever", async () => {
    const dir = plugin('throw new Error("boom at load");');
    const host = start(dir);
    await expect(host.call("quotes", { symbols: ["A"] })).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE" });
    expect(host.status().state).toBe("disabled");
  }, 30_000);

  it("a plugin that prints to stdout does not break the protocol (console is redirected to the log)", async () => {
    const dir = plugin('export default { async quotes(s, ctx) { console.log("hello from the plugin"); return { items: [{ symbol: "NSE:X", at: ctx.now - 1000, fields: { ltp: 2 } }] }; } };');
    const logs = [];
    const host = start(dir, { logs });
    expect((await host.call("quotes", { symbols: ["NSE:X"] })).items[0].fields.ltp).toBe(2);
    expect(logs.some((l) => l.includes("hello from the plugin"))).toBe(true);
  }, 30_000);

  it("a plugin that hangs is cut off at its call timeout and can be used again", async () => {
    const dir = plugin('export default { async quotes(s, ctx) { if (s[0] === "HANG") await new Promise((r) => ctx.signal.addEventListener("abort", r)); return { items: [{ symbol: "NSE:X", at: ctx.now - 1000, fields: { ltp: 2 } }] }; } };', { limits: { perSecond: 5, callTimeoutMs: 300 } });
    const host = start(dir);
    await expect(host.call("quotes", { symbols: ["HANG"] })).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    expect((await host.call("quotes", { symbols: ["NSE:X"] })).items).toHaveLength(1);
  }, 30_000);

  it("through the loader: a granted, pinned plugin answers, and Bridge-side data is labelled as a plugin's", async () => {
    const dir = plugin();
    const pin = inspectPluginFolder(dir).pin;
    const { providers, problems, stop } = loadPlugins({ entries: [{ path: dir, sha256: pin, granted: true }], broker: createFetchBroker({ id: "fake-plugin", version: "1.0.0", allowHosts: ["api.vendor-example.com"], limits: { perSecond: 5 }, transport: forbiddenTransport }), readyTimeoutMs: 15_000 });
    hostsToStop.push({ stop });
    expect(problems).toEqual([]);
    const r = await providers[0].quotes(["NSE:PROBE"], { now: Date.now() });
    expect(r.flags).toEqual(["plugin"]);
    expect(providers[0].descriptor).toMatchObject({ tier: "plugin", official: false, class: "delayed" });
  }, 30_000);
});

const info = (dir) => inspectPluginFolder(dir);
