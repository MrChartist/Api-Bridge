import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { USAGE, bridgeUrl, parseExpiry, runCli, runDoctor, startHints } from "./cli.mjs";
import { loadConfig } from "./config.mjs";

function io(env = {}) {
  const out = [];
  const err = [];
  const dir = mkdtempSync(join(tmpdir(), "mcb-cli-"));
  writeFileSync(join(dir, "bridge.config.json"), JSON.stringify({ dataDir: "data", logging: { level: "silent" }, accounts: [{ id: "dhan-main", broker: "dhan" }] }));
  return { out, err, dir, io: { out: (s) => out.push(s), err: (s) => err.push(s), env, cwd: dir } };
}

describe("runCli", () => {
  it("prints usage for --help and no command", async () => {
    const a = io();
    expect(await runCli([], { help: true }, a.io)).toBe(0);
    expect(a.out[0]).toBe(USAGE);
    expect(await runCli([], {}, io().io)).toBe(1);
  });

  it("prints the version", async () => {
    const a = io();
    expect(await runCli([], { version: true }, a.io)).toBe(0);
    expect(a.out[0]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("rejects unknown commands", async () => {
    const a = io();
    expect(await runCli(["fly"], {}, a.io)).toBe(1);
    expect(a.err[0]).toMatch(/Unknown command "fly"/);
  });

  it("doctor creates nothing when the data folder does not exist yet", async () => {
    const a = io();
    expect(await runCli(["doctor"], { "no-port-check": true, json: true }, a.io)).toBe(0);
    expect(existsSync(join(a.dir, "data"))).toBe(false);
    const checks = JSON.parse(a.out[0]);
    expect(checks.find((c) => c.check === "data-dir").message).toMatch(/will be created/);
  });

  it("doctor reports checks and exits 0 when nothing fails", async () => {
    const a = io();
    mkdirSync(join(a.dir, "data"), { mode: 0o700 });
    expect(await runCli(["doctor"], { "no-port-check": true, json: true }, a.io)).toBe(0);
    const checks = JSON.parse(a.out[0]);
    expect(checks.find((c) => c.check === "live-trading").message).toMatch(/off/);
    expect(checks.find((c) => c.check === "services")).toMatchObject({ level: "ok", message: "All services built" });
  });

  it("creates, lists and revokes a key, printing the key only once", async () => {
    const a = io();
    expect(await runCli(["keys", "list"], {}, a.io)).toBe(0);
    expect(a.out.at(-1)).toMatch(/No keys yet/);
    expect(await runCli(["keys", "create"], { label: "excel", scope: "read" }, a.io)).toBe(0);
    const created = a.out.at(-1);
    const key = /(mcb_[a-z2-7]{10}_[A-Za-z0-9_-]+)/.exec(created)?.[1];
    expect(key).toBeTruthy();
    const keyId = key.split("_")[1];
    expect(await runCli(["keys", "list"], { json: true }, a.io)).toBe(0);
    const rows = JSON.parse(a.out.at(-1));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(key.split("_")[2]);
    expect(await runCli(["keys", "revoke", keyId], {}, a.io)).toBe(0);
    expect(a.out.at(-1)).toMatch(new RegExp(`Revoked key ${keyId}`));
    expect(await runCli(["accounts", "list"], { json: true }, a.io)).toBe(0);
    expect(JSON.parse(a.out.at(-1)).map((r) => r.id)).toContain("dhan-main");
  });

  it("validates arguments before touching services", async () => {
    const a = io();
    expect(await runCli(["keys", "create"], { label: "x" }, a.io)).toBe(1);
    expect(a.err[0]).toMatch(/--label and --scope/);
    expect(await runCli(["mcp"], {}, io().io)).toBe(1);
  });

  it("prints the MCP tools as strict OpenAI function schemas (read-only by default)", async () => {
    const a = io();
    expect(await runCli(["openai-tools"], {}, a.io)).toBe(0);
    const tools = JSON.parse(a.out[0]);
    expect(tools.map((t) => t.name)).toContain("get_quotes");
    expect(tools.every((t) => t.type === "function" && t.strict === true)).toBe(true);
    expect(tools.some((t) => t.name === "prepare_order")).toBe(false);
    expect(await runCli(["openai-tools"], { format: "chat" }, a.io)).toBe(0);
    expect(JSON.parse(a.out[1])[0].function.name).toBeTruthy();
    expect(await runCli(["openai-tools"], { scope: "live" }, a.io)).toBe(1);
  });

  it("reports config errors without a stack trace", async () => {
    const a = io({ MCB_CONFIG: "/nope/bridge.config.json" });
    expect(await runCli(["doctor"], {}, a.io)).toBe(1);
    expect(a.err[0]).toMatch(/^Error: Config file not found/);
  });
});

describe("kill switch from the CLI", () => {
  it("engages and releases the persisted kill switch when the Bridge is not running", async () => {
    // Point the CLI at a port where nothing listens, so it takes the offline path.
    const a = io({ MCB_BRIDGE_URL: "http://127.0.0.1:9" });
    // No reason needed in a panic: it defaults to "manual".
    expect(await runCli(["kill"], {}, a.io)).toBe(0);
    expect(JSON.parse(readFileSync(join(a.dir, "data", "safety", "kill-switch.json"), "utf8")).reason).toBe("manual");
    expect(await runCli(["kill", "release"], {}, a.io)).toBe(0);
    expect(await runCli(["kill"], { reason: "Broker glitch" }, a.io)).toBe(0);
    expect(a.out.at(-1)).toMatch(/Kill switch engaged/);
    const state = JSON.parse(readFileSync(join(a.dir, "data", "safety", "kill-switch.json"), "utf8"));
    expect(JSON.stringify(state)).toMatch(/Broker glitch/);
    expect(await runCli(["kill", "release"], {}, a.io)).toBe(0);
    expect(a.out.at(-1)).toMatch(/released/);
    expect(await runCli(["kill", "sideways"], {}, a.io)).toBe(1);
  });
});

describe("bridgeUrl and start hints", () => {
  const cfg = { server: { host: "127.0.0.1", port: 4400 } };
  it("prefers --url, then MCB_BRIDGE_URL, then the config", () => {
    expect(bridgeUrl({ url: "http://127.0.0.1:5000/x" }, { env: { MCB_BRIDGE_URL: "http://127.0.0.1:6000" } }, cfg)).toBe("http://127.0.0.1:5000");
    expect(bridgeUrl({}, { env: { MCB_BRIDGE_URL: "http://127.0.0.1:6000" } }, cfg)).toBe("http://127.0.0.1:6000");
    expect(bridgeUrl({}, { env: {} }, cfg)).toBe("http://127.0.0.1:4400");
    expect(() => bridgeUrl({ url: "ftp://x" }, { env: {} }, cfg)).toThrow();
  });

  it("mcp honours MCB_BRIDGE_URL instead of reading a config from the AI app's folder", async () => {
    const a = io({ MCB_BRIDGE_URL: "not a url", MCB_API_KEY: "mcb_x" });
    expect(await runCli(["mcp"], {}, a.io)).toBe(1);
    expect(a.err.at(-1)).toMatch(/Not a valid Bridge URL/);
  });

  it("tells a new user what to do next", async () => {
    const app = { config: { server: { host: "127.0.0.1" } }, deps: { keyStore: { list: async () => [] }, accounts: { list: () => [] } } };
    const lines = await startHints({ app, port: 4300 });
    expect(lines[0]).toBe("Dashboard (this computer only): http://127.0.0.1:4300/dashboard");
    expect(lines.join("\n")).toMatch(/No API keys yet/);
    expect(lines.join("\n")).toMatch(/No market-data source connected: no broker account is configured/);
  });
});

describe("parseExpiry", () => {
  it("accepts durations and future ISO dates", () => {
    expect(parseExpiry("30d", 0)).toBe(new Date(30 * 86_400_000).toISOString());
    expect(parseExpiry("12h", 0)).toBe(new Date(12 * 3_600_000).toISOString());
    expect(parseExpiry(undefined)).toBeNull();
    expect(parseExpiry("2999-01-01T00:00:00Z", 0)).toBe("2999-01-01T00:00:00.000Z");
    expect(() => parseExpiry("2000-01-01", Date.now())).toThrow();
    expect(() => parseExpiry("soon")).toThrow();
  });
});

describe("runDoctor", () => {
  it("fails a bad master key and warns about live trading and public ingress", async () => {
    const { config } = loadConfig({
      raw: { dataDir: mkdtempSync(join(tmpdir(), "mcb-doc-")), safety: { liveTrading: true }, server: { publicIngress: { enabled: true } }, accounts: [{ id: "a1", broker: "dhan", live: { enabled: true } }] },
      env: {},
    });
    const checks = await runDoctor({ config, env: { MCB_MASTER_KEY: Buffer.alloc(8).toString("base64") }, portCheck: false });
    expect(checks.find((c) => c.check === "master-key").level).toBe("fail");
    expect(checks.find((c) => c.check === "live-trading")).toMatchObject({ level: "warn" });
    expect(checks.find((c) => c.check === "live-trading").message).toMatch(/a1/);
    expect(checks.find((c) => c.check === "public-ingress").level).toBe("warn");
    const good = await runDoctor({ config, env: { MCB_MASTER_KEY: Buffer.alloc(32).toString("base64") }, portCheck: false });
    expect(good.find((c) => c.check === "master-key").level).toBe("ok");
  });
});

describe("accounts connect (regression: no credentials on the command line)", () => {
  it("asks for each broker field with hidden input and posts them to the running Bridge", async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
        const send = (o) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(o));
        };
        if (req.url === "/v1/health") return send({ ok: true });
        if (req.url === "/v1/accounts/angel-main") return send({ data: { id: "angel-main", broker: "angelone" } });
        if (req.url === "/v1/brokers") return send({ data: [{ id: "angelone", name: "Angel One", credentialFields: ["apiKey", "clientId"], loginFields: [{ key: "password", label: "PIN" }, { key: "totpCode", label: "TOTP code" }] }] });
        if (req.url === "/v1/accounts/angel-main/session") return send({ data: { id: "angel-main", session: { state: "connected" } } });
        res.statusCode = 404;
        send({});
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const a = io({ MCB_BRIDGE_URL: `http://127.0.0.1:${server.address().port}`, MCB_ADMIN_KEY: "mcb_adminkey00_x" });
      const asked = [];
      const answers = { apiKey: "AK", clientId: "A123", "PIN (used once to log in, never stored)": "1234", "TOTP code (used once to log in, never stored)": "654321" };
      a.io.prompt = async (label, opts) => {
        asked.push({ label, hidden: opts?.hidden });
        return answers[label];
      };
      expect(await runCli(["accounts", "connect", "angel-main"], {}, a.io)).toBe(0);
      expect(asked.every((q) => q.hidden === true)).toBe(true);
      const post = seen.find((x) => x.method === "POST");
      expect(post).toMatchObject({ url: "/v1/accounts/angel-main/session", auth: "Bearer mcb_adminkey00_x", body: { values: { apiKey: "AK", clientId: "A123" }, secrets: { password: "1234", totpCode: "654321" } } });
      expect(a.out.at(-1)).toMatch(/Connected angel-main: session connected/);
    } finally {
      server.close();
    }
  });

  it("needs an account id and an admin key", async () => {
    const a = io({ MCB_BRIDGE_URL: "http://127.0.0.1:9" });
    expect(await runCli(["accounts", "connect"], {}, a.io)).toBe(1);
    expect(a.err.at(-1)).toMatch(/account id/);
  });
});

describe("doctor: market-data source", () => {
  it("warns when no broker account is connected (paper orders need one too)", async () => {
    const { config } = loadConfig({ raw: { dataDir: "/tmp/unused-mcb" }, env: {} });
    const deps = { accounts: { list: () => [{ id: "paper", broker: "paper", session: { state: "connected" } }, { id: "dhan-main", broker: "dhan", session: { state: "missing" } }] } };
    const checks = await runDoctor({ config, env: {}, portCheck: false, deps });
    const md = checks.find((c) => c.check === "market-data");
    expect(md).toMatchObject({ level: "warn" });
    expect(md.message).toMatch(/No market-data source connected \(log in dhan-main\)/);
  });
});

describe("doctor: master key location", () => {
  it("warns when the master key would sit next to secrets.enc, and not when MCB_MASTER_KEY_FILE points elsewhere", async () => {
    const { config } = loadConfig({ raw: { dataDir: "/tmp/unused-mcb-mk" }, env: {} });
    const same = await runDoctor({ config, env: {}, portCheck: false });
    expect(same.some((c) => c.check === "master-key" && /next to secrets.enc/.test(c.message))).toBe(true);
    const apart = await runDoctor({ config, env: { MCB_MASTER_KEY_FILE: "/tmp/elsewhere-mcb/master.key" }, portCheck: false });
    expect(apart.some((c) => /next to secrets.enc/.test(c.message))).toBe(false);
  });
});
