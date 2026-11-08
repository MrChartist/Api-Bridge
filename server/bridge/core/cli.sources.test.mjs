/**
 * `mc-bridge sources ...`: argument parsing, output, and what goes over the wire to a (fake) running Bridge. Never the
 * real network: the fake Bridge listens on 127.0.0.1.
 */
import http from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { USAGE, describeSourceClass, formatDelay, formatSources, formatTrace, runCli } from "./cli.mjs";
import { inspectPluginFolder } from "../sources/plugin/loader.mjs";
import { testManifest } from "../sources/plugin/__fixtures__/fakeChild.mjs";

const SOURCES = [
  { id: "yahoo", name: "Yahoo Finance", kind: "free", tier: "opt-in", enabled: false, configured: true, class: "delayed", delaySec: 900, official: false, health: { state: "ok" }, needsKey: false, noticeVersion: "yahoo-1", terms: { url: "https://example.com/terms", note: "Unofficial data; personal use only." } },
  { id: "alphavantage", name: "Alpha Vantage", kind: "free", tier: "byok", enabled: false, configured: false, class: "eod", delaySec: null, official: true, health: { state: "ok" }, needsKey: true },
  { id: "twelvedata", name: "Twelve Data", kind: "free", tier: "byok", enabled: true, configured: true, class: "delayed", delaySec: 900, official: true, health: { state: "degraded", lastError: "HTTP 500" }, needsKey: true },
  { id: "broker", name: "Your broker accounts", kind: "broker", tier: "builtin", enabled: true, configured: true, class: "realtime", delaySec: 0, official: true, health: { state: "ok" }, needsKey: false },
];

const TRACE = {
  request: { capability: "quotes", symbols: ["NSE:RELIANCE"], purpose: "display", maxAgeMs: 2000 },
  considered: [
    { id: "dhan-main", kind: "broker", verdict: "chosen", reason: "best spare budget", score: 0.91, spareBudget: 0.8, health: { state: "ok" } },
    { id: "yahoo", kind: "source", verdict: "skipped", reason: "delayed data cannot meet maxAgeMs 2000", health: { state: "ok" } },
  ],
  class: "realtime",
  note: "Served by your broker.",
};

let server;
const seen = [];
afterEach(async () => {
  seen.length = 0;
  if (server) await new Promise((r) => server.close(r));
  server = null;
});

async function bridge({ sources = SOURCES, patch = (id, body) => ({ ...sources.find((s) => s.id === id), ...body }), testResult = { ok: true, latencyMs: 42 }, status = {} } = {}) {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const send = (code, o) => {
        res.statusCode = code;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(o));
      };
      if (status[req.url]) return send(status[req.url].code, status[req.url].body);
      if (req.url === "/v1/health") return send(200, { ok: true });
      if (req.url === "/v1/sources" && req.method === "GET") return send(200, { data: sources, meta: {} });
      if (req.url.startsWith("/v1/sources/trace")) return send(200, { data: TRACE });
      const m = /^\/v1\/sources\/([^/]+)(\/config|\/test)?$/.exec(req.url);
      if (m && req.method === "PATCH") return send(200, { data: patch(m[1], JSON.parse(body)) });
      if (m && m[2] === "/config" && req.method === "PUT") return send(200, { data: { configured: true } });
      if (m && m[2] === "/test" && req.method === "POST") return send(200, { data: testResult });
      send(404, { code: "NOT_FOUND", detail: "no such route" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}

function setup(env = {}) {
  const out = [];
  const err = [];
  const dir = mkdtempSync(join(tmpdir(), "mcb-cli-src-"));
  writeFileSync(join(dir, "bridge.config.json"), JSON.stringify({ dataDir: "data", logging: { level: "silent" } }));
  return { out, err, dir, io: { out: (s) => out.push(s), err: (s) => err.push(s), env: { MCB_ADMIN_KEY: "mcb_adminkey00_x", ...env }, cwd: dir } };
}
const run = async (args, flags, a) => runCli(["sources", ...args], flags, a.io);

describe("formatting", () => {
  it("describes data in plain words", () => {
    expect(formatDelay(900)).toBe("15 min");
    expect(formatDelay(7200)).toBe("2 h");
    expect(formatDelay(86_400)).toBe("1 day");
    expect(formatDelay(0)).toBe("");
    expect(describeSourceClass(SOURCES[0])).toBe("delayed 15 min, unofficial");
    expect(describeSourceClass(SOURCES[1])).toBe("end of day");
    expect(describeSourceClass(SOURCES[3])).toBe("real-time");
  });

  it("lists sources with state, data class and health", () => {
    const text = formatSources(SOURCES);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^ID\s+TIER\s+STATE\s+DATA\s+HEALTH\s+NAME$/);
    expect(lines.find((l) => l.startsWith("yahoo"))).toMatch(/opt-in\s+off\s+delayed 15 min, unofficial\s+ok\s+Yahoo Finance/);
    expect(lines.find((l) => l.startsWith("alphavantage"))).toMatch(/needs key\s+end of day/);
    expect(lines.find((l) => l.startsWith("twelvedata"))).toMatch(/\bon\b.*degraded \(HTTP 500\)/);
    expect(lines.find((l) => l.startsWith("broker"))).toMatch(/builtin\s+on\s+real-time/);
    expect(formatSources([])).toMatch(/No data sources/);
  });

  it("prints a routing trace with the verdict of every candidate", () => {
    const text = formatTrace(TRACE);
    expect(text).toMatch(/Request: quotes NSE:RELIANCE, purpose display, max age 2000 ms/);
    expect(text).toMatch(/CHOSEN\s+dhan-main\s+best spare budget \(score 0\.91, spare 0\.8\)/);
    expect(text).toMatch(/SKIPPED\s+yahoo\s+delayed data cannot meet maxAgeMs 2000/);
    expect(text).toMatch(/Class of the answer: realtime\. Served by your broker\./);
    expect(text).toMatch(/dry run/);
  });
});

describe("sources: usage and arguments", () => {
  it("documents every subcommand in the usage text", () => {
    for (const s of ["sources list", "sources enable <id>", "--acknowledge", "sources disable <id>", "sources set-key <id>", "sources test <id>", "sources trace --capability", "sources plugins check", "sources plugins pin"]) expect(USAGE).toContain(s);
    expect(USAGE).toMatch(/never from the command line/);
  });

  it("prints usage and exits 1 for a missing or unknown subcommand, without contacting a Bridge", async () => {
    const a = setup();
    expect(await run([], {}, a)).toBe(1);
    expect(await run(["frobnicate"], {}, a)).toBe(1);
    expect(a.err.join("\n")).toContain("mc-bridge sources list");
  });

  it("enable, disable, set-key and test need an id", async () => {
    const a = setup();
    for (const sub of ["enable", "disable", "set-key", "test"]) {
      expect(await run([sub], {}, a)).toBe(1);
      expect(a.err.at(-1)).toMatch(new RegExp(`sources ${sub} needs a source id`));
    }
  });

  it("explains when the Bridge is not running", async () => {
    const a = setup({ MCB_BRIDGE_URL: "http://127.0.0.1:9" });
    expect(await run(["list"], {}, a)).toBe(1);
    expect(a.err.at(-1)).toMatch(/not running at http:\/\/127\.0\.0\.1:9/);
  });

  it("asks for an admin key when there is none", async () => {
    const url = await bridge();
    const a = setup({ MCB_BRIDGE_URL: url, MCB_ADMIN_KEY: "", MCB_API_KEY: "" });
    a.io.env = { MCB_BRIDGE_URL: url };
    expect(await run(["list"], {}, a)).toBe(1);
    expect(a.err.at(-1)).toMatch(/needs an admin key/);
  });
});

describe("sources list", () => {
  it("prints the table and sends the admin key", async () => {
    const url = await bridge();
    const a = setup({ MCB_BRIDGE_URL: url });
    expect(await run(["list"], {}, a)).toBe(0);
    expect(a.out[0]).toMatch(/Yahoo Finance/);
    expect(seen.find((r) => r.url === "/v1/sources")).toMatchObject({ method: "GET", auth: "Bearer mcb_adminkey00_x" });
  });

  it("--json prints the rows as they are", async () => {
    const url = await bridge();
    const a = setup({ MCB_BRIDGE_URL: url });
    expect(await run(["list"], { json: true }, a)).toBe(0);
    expect(JSON.parse(a.out[0]).map((s) => s.id)).toEqual(["yahoo", "alphavantage", "twelvedata", "broker"]);
  });

  it("--key and --url override the environment", async () => {
    const url = await bridge();
    const a = setup({ MCB_BRIDGE_URL: "http://127.0.0.1:9", MCB_ADMIN_KEY: "mcb_env_key_x" });
    expect(await run(["list"], { url, key: "mcb_flag_key_x" }, a)).toBe(0);
    expect(seen.find((r) => r.url === "/v1/sources").auth).toBe("Bearer mcb_flag_key_x");
  });
});

describe("sources enable / disable", () => {
  it("an opt-in source shows its notice and does nothing until it is acknowledged", async () => {
    const url = await bridge();
    const a = setup({ MCB_BRIDGE_URL: url });
    expect(await run(["enable", "yahoo"], {}, a)).toBe(1);
    const text = a.err.join("\n");
    expect(text).toMatch(/needs your acknowledgement/);
    expect(text).toMatch(/Unofficial data; personal use only\./);
    expect(text).toMatch(/Terms: https:\/\/example\.com\/terms/);
    expect(text).toMatch(/sources enable yahoo --acknowledge yahoo-1/);
    expect(seen.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("enables with the right acknowledgement and says how the data is labelled", async () => {
    const url = await bridge();
    const a = setup({ MCB_BRIDGE_URL: url });
    expect(await run(["enable", "yahoo"], { acknowledge: "yahoo-1" }, a)).toBe(0);
    expect(seen.find((r) => r.method === "PATCH")).toMatchObject({ url: "/v1/sources/yahoo", body: { enabled: true, acknowledge: "yahoo-1" } });
    expect(a.out.at(-1)).toMatch(/Turned on Yahoo Finance\. Its answers are labelled: delayed 15 min, unofficial\./);
  });

  it("refuses a stale acknowledgement before asking the Bridge", async () => {
    const url = await bridge();
    const a = setup({ MCB_BRIDGE_URL: url });
    expect(await run(["enable", "yahoo"], { acknowledge: "yahoo-0" }, a)).toBe(1);
    expect(a.err.at(-1)).toMatch(/now version yahoo-1, not yahoo-0/);
    expect(seen.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("a key-based source needs its key first", async () => {
    const url = await bridge();
    const a = setup({ MCB_BRIDGE_URL: url });
    expect(await run(["enable", "alphavantage"], {}, a)).toBe(1);
    expect(a.err.at(-1)).toMatch(/needs your own key first.*sources set-key alphavantage/);
  });

  it("says when a source is already on, and when the id is unknown", async () => {
    const url = await bridge();
    const a = setup({ MCB_BRIDGE_URL: url });
    expect(await run(["enable", "twelvedata"], {}, a)).toBe(0);
    expect(a.out.at(-1)).toMatch(/already on/);
    expect(await run(["enable", "nope"], {}, a)).toBe(1);
    expect(a.err.at(-1)).toMatch(/No data source with id "nope"/);
  });

  it("disables a source", async () => {
    const url = await bridge();
    const a = setup({ MCB_BRIDGE_URL: url });
    expect(await run(["disable", "twelvedata"], {}, a)).toBe(0);
    expect(seen.find((r) => r.method === "PATCH")).toMatchObject({ url: "/v1/sources/twelvedata", body: { enabled: false } });
    expect(a.out.at(-1)).toMatch(/Turned off Twelve Data/);
  });

  it("shows the Bridge's own refusal message", async () => {
    const url = await bridge({ status: { "/v1/sources/yahoo": { code: 422, body: { code: "CONFIRMATION_REQUIRED", detail: "The notice has changed." } } } });
    const a = setup({ MCB_BRIDGE_URL: url });
    expect(await run(["enable", "yahoo"], { acknowledge: "yahoo-1" }, a)).toBe(1);
    expect(a.err.at(-1)).toBe("Error: The notice has changed.");
  });

  it("with only the control token, a refused action tells the owner to pass --key", async () => {
    const url = await bridge({ status: { "/v1/sources/twelvedata": { code: 401, body: { code: "UNAUTHENTICATED", detail: "A valid API key is required" } } } });
    const a = setup({ MCB_BRIDGE_URL: url, MCB_ADMIN_KEY: "" });
    a.io.env = { MCB_BRIDGE_URL: url };
    mkdirSync(join(a.dir, "data"), { recursive: true });
    writeFileSync(join(a.dir, "data", "control.token"), "mcbctl_local-token\n");
    expect(await run(["disable", "twelvedata"], {}, a)).toBe(1);
    expect(seen.find((r) => r.method === "GET" && r.url === "/v1/sources").auth).toBe("Bearer mcbctl_local-token");
    expect(a.err.at(-1)).toMatch(/pass --key with an admin key/);
  });
});

describe("sources set-key: the key never touches the command line", () => {
  const KEY = "SECRET-VENDOR-KEY-0123456789";

  it("reads the key from piped stdin and sends it only in the request body", async () => {
    const url = await bridge();
    const a = setup({ MCB_BRIDGE_URL: url });
    a.io.readStdin = async () => `${KEY}\n`;
    expect(await run(["set-key", "alphavantage"], {}, a)).toBe(0);
    const put = seen.find((r) => r.method === "PUT");
    expect(put).toMatchObject({ url: "/v1/sources/alphavantage/config", body: { apiKey: KEY } });
    expect(a.out.join("\n")).not.toContain(KEY);
    expect(a.err.join("\n")).not.toContain(KEY);
    expect(a.out.at(-1)).toMatch(/Saved the key for Alpha Vantage.*never shown again/);
    expect(JSON.stringify(seen.filter((r) => r.method !== "PUT"))).not.toContain(KEY);
  });

  it("asks with a hidden prompt when nothing is piped", async () => {
    const url = await bridge();
    const a = setup({ MCB_BRIDGE_URL: url });
    const asked = [];
    a.io.prompt = async (label, opts) => (asked.push({ label, hidden: opts?.hidden }), KEY);
    expect(await run(["set-key", "alphavantage"], {}, a)).toBe(0);
    expect(asked).toEqual([{ label: "Key", hidden: true }]);
    expect(seen.find((r) => r.method === "PUT").body).toEqual({ apiKey: KEY });
    expect(a.err.join("\n")).not.toContain(KEY);
  });

  it("refuses a key given as a flag, before contacting the Bridge", async () => {
    const a = setup({ MCB_BRIDGE_URL: "http://127.0.0.1:9" });
    for (const f of ["api-key", "apiKey", "token", "secret", "password", "value"]) {
      expect(await run(["set-key", "alphavantage"], { [f]: KEY }, a)).toBe(1);
      expect(a.err.at(-1)).toMatch(/never taken from the command line/);
      expect(a.err.at(-1)).not.toContain(KEY);
    }
  });

  it("rejects an extra positional (a key pasted after the id) without echoing it or contacting the Bridge, and says what to do", async () => {
    const a = setup({ MCB_BRIDGE_URL: "http://127.0.0.1:9" });
    expect(await run(["set-key", "alphavantage", KEY], {}, a)).toBe(1);
    const msg = a.err.at(-1);
    expect(msg).toMatch(/takes only the source id/);
    expect(msg).toMatch(/stdin or asks for it with hidden input/);
    expect(msg).toMatch(/shell history/);
    expect(msg).not.toContain(KEY);
    expect(a.out.join("\n")).not.toContain(KEY);
    expect(seen).toEqual([]);
  });

  it("rejects empty or implausible keys, and sources that use no key", async () => {
    const url = await bridge();
    const a = setup({ MCB_BRIDGE_URL: url });
    a.io.readStdin = async () => "   \n";
    expect(await run(["set-key", "alphavantage"], {}, a)).toBe(1);
    expect(a.err.at(-1)).toMatch(/No key was given/);
    a.io.readStdin = async () => "two words";
    expect(await run(["set-key", "alphavantage"], {}, a)).toBe(1);
    expect(a.err.at(-1)).toMatch(/single key/);
    expect(await run(["set-key", "yahoo"], {}, a)).toBe(1);
    expect(a.err.at(-1)).toMatch(/does not use a key/);
    expect(seen.some((r) => r.method === "PUT")).toBe(false);
  });
});

describe("sources test", () => {
  it("reports a working source", async () => {
    const url = await bridge();
    const a = setup({ MCB_BRIDGE_URL: url });
    expect(await run(["test", "twelvedata"], {}, a)).toBe(0);
    expect(a.out.at(-1)).toBe("OK: Twelve Data answered in 42 ms.");
    expect(seen.find((r) => r.method === "POST")).toMatchObject({ url: "/v1/sources/twelvedata/test" });
  });

  it("reports a failing one with the reason and a non-zero exit code", async () => {
    const url = await bridge({ testResult: { ok: false, latencyMs: 9, detail: "the key was rejected" } });
    const a = setup({ MCB_BRIDGE_URL: url });
    expect(await run(["test", "twelvedata"], {}, a)).toBe(1);
    expect(a.out.at(-1)).toBe("FAILED: Twelve Data: the key was rejected.");
  });
});

describe("sources trace", () => {
  it("builds the query from the flags and prints the trace", async () => {
    const url = await bridge();
    const a = setup({ MCB_BRIDGE_URL: url });
    expect(await run(["trace"], { capability: "quotes", symbols: "NSE:RELIANCE,NSE:TCS", purpose: "analysis", "max-age": "5000" }, a)).toBe(0);
    const req = seen.find((r) => r.url.startsWith("/v1/sources/trace"));
    expect(req.method).toBe("GET");
    const q = new URL(req.url, "http://x").searchParams;
    expect(Object.fromEntries(q)).toEqual({ capability: "quotes", symbols: "NSE:RELIANCE,NSE:TCS", purpose: "analysis", maxAgeMs: "5000" });
    expect(a.out[0]).toMatch(/CHOSEN\s+dhan-main/);
  });

  it("defaults to quotes and display, and prints JSON on request", async () => {
    const url = await bridge();
    const a = setup({ MCB_BRIDGE_URL: url });
    expect(await run(["trace"], { symbols: "NSE:X", json: true }, a)).toBe(0);
    expect(Object.fromEntries(new URL(seen.at(-1).url, "http://x").searchParams)).toEqual({ capability: "quotes", symbols: "NSE:X", purpose: "display" });
    expect(JSON.parse(a.out[0]).class).toBe("realtime");
  });

  it("validates its flags before contacting the Bridge", async () => {
    const url = await bridge();
    const a = setup({ MCB_BRIDGE_URL: url });
    expect(await run(["trace"], { capability: "quotes" }, a)).toBe(1);
    expect(a.err.at(-1)).toMatch(/needs --symbols/);
    expect(await run(["trace"], { capability: "orders", symbols: "NSE:X" }, a)).toBe(1);
    expect(a.err.at(-1)).toMatch(/--capability must be one of/);
    expect(await run(["trace"], { symbols: "NSE:X", purpose: "yolo" }, a)).toBe(1);
    expect(a.err.at(-1)).toMatch(/--purpose must be one of/);
    expect(await run(["trace"], { symbols: "NSE:X", "max-age": "soon" }, a)).toBe(1);
    expect(a.err.at(-1)).toMatch(/--max-age/);
    expect(seen.some((r) => r.url.startsWith("/v1/sources/trace"))).toBe(false);
  });
});

describe("sources plugins pin / check (offline)", () => {
  const exampleDir = resolve(import.meta.dirname, "../../../examples/source-plugin");
  const copyExample = (a) => {
    const dest = join(a.dir, "plugin");
    cpSync(exampleDir, dest, { recursive: true, filter: (p) => !p.endsWith(".test.mjs") });
    return dest;
  };

  it("pin prints the sha256 on stdout (just the hash) and the review summary on stderr", async () => {
    const a = setup();
    const dest = copyExample(a);
    expect(await run(["plugins", "pin", dest], {}, a)).toBe(0);
    expect(a.out).toEqual([inspectPluginFolder(dest).pin]);
    expect(a.out[0]).toMatch(/^[0-9a-f]{64}$/);
    const text = a.err.join("\n");
    expect(text).toMatch(/May reach: quotes\.example\.com/);
    expect(text).toMatch(/Review those/);
    expect(text).toMatch(/Files to read first: .*mc-source\.json and .*index\.mjs/);
    expect(text).toMatch(/signalling the Bridge process/); // the trust notice: signals and own sockets are not stopped
    expect(text).toMatch(/sources\.pluginUser/);
    expect(text).toMatch(/Optional next step:.*plugins check.*runs the plugin's code/);
    expect(text).toMatch(new RegExp(`"sha256": "${a.out[0]}", "granted": true`));
  });

  it("pin changes when the code changes", async () => {
    const a = setup();
    const dest = copyExample(a);
    await run(["plugins", "pin", dest], {}, a);
    const before = a.out[0];
    writeFileSync(join(dest, "index.mjs"), `${readFileSync(join(dest, "index.mjs"), "utf8")}\n// edit\n`);
    await run(["plugins", "pin", dest], {}, a);
    expect(a.out[1]).not.toBe(before);
  });

  it("pin and check refuse a folder that is not a valid plugin, with every problem", async () => {
    const a = setup();
    const dir = join(a.dir, "bad");
    mkdirSync(dir);
    writeFileSync(join(dir, "mc-source.json"), JSON.stringify(testManifest({ capabilities: ["orders"], official: true })));
    writeFileSync(join(dir, "index.mjs"), "export default {};");
    expect(await run(["plugins", "pin", dir], {}, a)).toBe(1);
    expect(a.err.join("\n")).toMatch(/capabilities/);
    expect(a.err.join("\n")).toMatch(/official/);
    expect(a.out).toEqual([]);
    expect(await run(["plugins", "check", dir], {}, a)).toBe(1);
    expect(a.out.join("\n")).toMatch(/FAIL\s+manifest/);
    expect(await run(["plugins", "pin", join(a.dir, "missing")], {}, a)).toBe(1);
    expect(a.err.at(-1)).toMatch(/does not exist/);
  });

  it("needs a folder, and a known action", async () => {
    const a = setup();
    expect(await run(["plugins", "check"], {}, a)).toBe(1);
    expect(a.err.at(-1)).toMatch(/needs the plugin folder/);
    expect(await run(["plugins", "install", "x"], {}, a)).toBe(1);
    expect(await run(["plugins"], {}, a)).toBe(1);
  });

  it.skipIf(!existsSync(resolve(import.meta.dirname, "../sources/conformance.mjs")))("check runs the conformance harness offline and prints each result", async () => {
    const a = setup();
    const dest = copyExample(a);
    expect(await run(["plugins", "check", dest], {}, a)).toBe(0);
    const text = a.out.join("\n");
    expect(text).toMatch(/OK\s+manifest: example-delayed 1\.0\.0/);
    expect(text).toMatch(/OK\s+conformance: errors:rate-limited/);
    expect(text).toMatch(/All checks passed\. Pin for the config.*: [0-9a-f]{64}/);
    // check starts the plugin: it says so first, and puts reading and pinning before it.
    expect(a.err.join("\n")).toMatch(/check RUNS this plugin's code.*read mc-source\.json and the entry file and pinned them/);
    expect(await run(["plugins", "check", dest], { json: true }, a)).toBe(0);
    expect(JSON.parse(a.out.at(-1)).ok).toBe(true);
  }, 60_000);
});

describe("a key on the command line", () => {
  it("--key is used but warned about, naming the environment variables to prefer", async () => {
    const url = await bridge();
    const a = setup({ MCB_BRIDGE_URL: url });
    delete a.io.env.MCB_ADMIN_KEY;
    expect(await run(["list"], { key: "mcb_adminkey00_x" }, a)).toBe(0);
    expect(a.err.join("\n")).toMatch(/--key stays in your shell history.*MCB_ADMIN_KEY.*MCB_API_KEY/);
    expect(seen.find((r) => r.url === "/v1/sources").auth).toBe("Bearer mcb_adminkey00_x");
  });

  it("no warning when the key comes from the environment", async () => {
    const url = await bridge();
    const a = setup({ MCB_BRIDGE_URL: url });
    expect(await run(["list"], {}, a)).toBe(0);
    expect(a.err.join("\n")).not.toMatch(/shell history/);
  });
});
