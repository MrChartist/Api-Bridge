import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { USAGE, bridgeUrl, openInBrowser, parseExpiry, readinessDoctorChecks, runCli, runDoctor, startHints } from "./cli.mjs";
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
    expect(JSON.stringify(rows)).not.toContain(key.split("_").slice(2).join("_"));
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

describe("kill switch on a running Bridge", () => {
  it("needs no key on this computer: it uses the control token in the data folder, removed on stop", async () => {
    const a = io();
    const { config } = loadConfig({ path: join(a.dir, "bridge.config.json"), env: {}, cwd: a.dir });
    const { createApp } = await import("./app.mjs");
    const { createNullLogger } = await import("./logger.mjs");
    const app = await createApp({ config: { ...config, server: { ...config.server, port: 0 } }, logger: createNullLogger() });
    const { port } = await app.listen();
    const tokenFile = join(config.dataDir, "control.token");
    try {
      expect(existsSync(tokenFile)).toBe(true);
      if (process.platform !== "win32") expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
      a.io.env = { MCB_BRIDGE_URL: `http://127.0.0.1:${port}` };
      expect(await runCli(["kill"], { reason: "panic" }, a.io)).toBe(0);
      expect(a.out.at(-1)).toMatch(/Kill switch engaged: panic/);
      expect(app.deps.safety.status().killSwitch.engaged).toBe(true);
      expect(await runCli(["kill", "release"], {}, a.io)).toBe(0);
      expect(app.deps.safety.status().killSwitch.engaged).toBe(false);

      // A read key exported as MCB_API_KEY (the quickstart says to) must not stop `kill release` on this computer: the
      // control token is used first, and only without a token does MCB_API_KEY serve as the fallback.
      const { key: readKey } = await app.deps.keyStore.create({ label: "read-only", scopes: ["read"], accounts: "*" });
      a.io.env = { MCB_BRIDGE_URL: `http://127.0.0.1:${port}`, MCB_API_KEY: readKey };
      expect(await runCli(["kill"], { reason: "with a read key exported" }, a.io)).toBe(0);
      expect(app.deps.safety.status().killSwitch.engaged).toBe(true);
      expect(await runCli(["kill", "release"], {}, a.io)).toBe(0);
      expect(app.deps.safety.status().killSwitch.engaged).toBe(false);
      a.io.env = { MCB_BRIDGE_URL: `http://127.0.0.1:${port}` };

      // A command that needs a key, run with none: say what to do, not "this API key is not valid" (no key was given).
      expect(await runCli(["sources", "list"], {}, a.io)).toBe(1);
      expect(a.err.at(-1)).toMatch(/needs an admin key/);
      expect(a.err.at(-1)).toMatch(/MCB_ADMIN_KEY/);
      expect(a.err.at(-1)).not.toMatch(/not valid, has expired or was revoked/);

      // The token works only on the kill-switch routes.
      const token = readFileSync(tokenFile, "utf8").trim();
      const keys = await fetch(`http://127.0.0.1:${port}/v1/keys`, { headers: { authorization: `Bearer ${token}` } });
      expect(keys.status).toBe(401);
      // ...and only from this computer (a proxied request is not local).
      const proxied = await fetch(`http://127.0.0.1:${port}/v1/safety/kill-switch`, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.9" } });
      expect(proxied.status).toBe(401);
      // A wrong token is an ordinary bad key, with a clear message from the CLI.
      writeFileSync(tokenFile, "mcbctl_not-the-real-one\n");
      expect(await runCli(["kill"], {}, a.io)).toBe(1);
      expect(a.err.at(-1)).toMatch(/did not accept the control token/);
    } finally {
      await app.close();
    }
    expect(existsSync(tokenFile)).toBe(true); // not ours any more (overwritten above), so left alone
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

describe("doctor: trading readiness checks", () => {
  const cfg = (raw) => loadConfig({ raw: { dataDir: mkdtempSync(join(tmpdir(), "mcb-doc-")), ...raw }, env: {} }).config;
  it("warns about a live-enabled account without live.registeredIp, and passes when every live account has one", async () => {
    const bad = cfg({ safety: { liveTrading: true }, accounts: [{ id: "a1", broker: "dhan", live: { enabled: true } }, { id: "a2", broker: "zerodha", live: { enabled: true, registeredIp: "203.0.113.10" } }, { id: "a3", broker: "upstox" }] });
    const c = readinessDoctorChecks(bad).find((x) => x.check === "static-ip");
    expect(c.level).toBe("warn");
    expect(c.message).toMatch(/a1/);
    expect(c.message).not.toMatch(/a2|a3/);
    expect(c.message).toMatch(/deployment\.md/);
    const checks = await runDoctor({ config: bad, env: {}, portCheck: false });
    expect(checks.find((x) => x.check === "static-ip")).toMatchObject({ level: "warn" });
    const good = cfg({ accounts: [{ id: "a2", broker: "zerodha", live: { enabled: true, registeredIp: "203.0.113.10" } }] });
    expect(readinessDoctorChecks(good).find((x) => x.check === "static-ip").level).toBe("ok");
    // No live account: nothing to say.
    expect(readinessDoctorChecks(cfg({ accounts: [{ id: "a3", broker: "upstox" }] })).find((x) => x.check === "static-ip")).toBeUndefined();
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
    expect(md.message).toMatch(/npm run bridge -- start --demo --open/);
    // Hints name the command that works in the user's setup: the installers set MCB_CLI_NAME.
    const installed = await runDoctor({ config, env: { MCB_CLI_NAME: "mc-bridge" }, portCheck: false, deps });
    expect(installed.find((c) => c.check === "market-data").message).toMatch(/\(mc-bridge start --demo --open\)/);
    const docker = await runDoctor({ config, env: { MCB_DOCKER: "1" }, portCheck: false, deps });
    expect(docker.find((c) => c.check === "market-data").message).toMatch(/docker compose exec bridge mc-bridge start --demo/);
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

describe("one-time sign-in links from the CLI", () => {
  /** A CLI test folder whose config listens on `port` (0: any free port). */
  function signInIo(port = 0, env = {}) {
    const a = io(env);
    writeFileSync(join(a.dir, "bridge.config.json"), JSON.stringify({ dataDir: "data", logging: { level: "silent" }, server: { port } }));
    a.opened = [];
    a.io.openUrl = (url) => {
      a.opened.push(url);
      return true;
    };
    return a;
  }
  const codeOf = (url) => /#signin=([A-Za-z0-9_-]{43})$/.exec(url)?.[1];
  const redeem = (port, code) => fetch(`http://127.0.0.1:${port}/v1/sign-in`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  async function runningBridge(a) {
    const { config } = loadConfig({ path: join(a.dir, "bridge.config.json"), env: {}, cwd: a.dir });
    const { createApp } = await import("./app.mjs");
    const { createNullLogger } = await import("./logger.mjs");
    const app = await createApp({ config, logger: createNullLogger() });
    const { port } = await app.listen();
    return { app, port };
  }

  it("start --open opens the dashboard with a one-time code in the fragment, and the code signs in once", async () => {
    for (const flags of [{ open: true }, { open: true, demo: true }]) {
      const a = signInIo();
      let app = null;
      a.io.onListening = (x) => (app = x);
      expect(await runCli(["start"], flags, a.io)).toBeNull();
      try {
        expect(a.opened).toHaveLength(1);
        const m = /^http:\/\/127\.0\.0\.1:(\d+)\/dashboard#signin=([A-Za-z0-9_-]{43})$/.exec(a.opened[0]);
        expect(m).toBeTruthy();
        expect(a.err.join("\n")).toMatch(/works once and expires in 10 minutes/);
        const first = await redeem(Number(m[1]), m[2]);
        expect(first.status).toBe(201);
        const { data } = await first.json();
        expect(data.record.scopes).toContain("admin");
        expect((await redeem(Number(m[1]), m[2])).status).toBe(401);
        if (flags.demo) expect(app.config.demo).toBe(true);
      } finally {
        await app?.close();
      }
    }
  });

  it("start --open with the Bridge already running opens a fresh link and exits 0 (double-click twice)", async () => {
    const first = signInIo();
    const { app, port } = await runningBridge(first);
    try {
      // Same folder and config, now with the port the first Bridge took.
      writeFileSync(join(first.dir, "bridge.config.json"), JSON.stringify({ dataDir: "data", logging: { level: "silent" }, server: { port } }));
      expect(await runCli(["start"], { open: true }, first.io)).toBe(0);
      expect(first.err.join("\n")).toMatch(/The Bridge is already running; opening the dashboard\./);
      expect(first.opened).toHaveLength(1);
      expect(first.opened[0]).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/dashboard#signin=`));
      expect((await redeem(port, codeOf(first.opened[0]))).status).toBe(201);
      // Without --open it says how to open the dashboard instead of failing on the port.
      expect(await runCli(["start"], {}, first.io)).toBe(1);
      expect(first.err.at(-1)).toMatch(/already running.*mc-bridge open/);
      // demo mode asked for, but the running Bridge is not in demo mode: still opens, with a note.
      expect(await runCli(["start"], { open: true, demo: true }, first.io)).toBe(0);
      expect(first.err.join("\n")).toMatch(/not in demo mode/);
    } finally {
      await app.close();
    }
  });

  it("start keeps a clear error when the port belongs to another program", async () => {
    const other = http.createServer((req, res) => {
      res.statusCode = 404;
      res.end("not the Bridge");
    });
    await new Promise((r) => other.listen(0, "127.0.0.1", r));
    try {
      const a = signInIo(other.address().port);
      expect(await runCli(["start"], { open: true }, a.io)).toBe(1);
      expect(a.err.at(-1)).toMatch(/already in use by another program/);
      expect(a.opened).toEqual([]);
    } finally {
      other.close();
    }
  });

  it("open: signs in to the running Bridge, or says how to start it", async () => {
    const a = signInIo(0, { MCB_BRIDGE_URL: "http://127.0.0.1:9" });
    expect(await runCli(["open"], {}, a.io)).toBe(1);
    expect(a.err.at(-1)).toMatch(/not running.*mc-bridge start --open/);
    expect(a.opened).toEqual([]);

    const { app, port } = await runningBridge(a);
    try {
      a.io.env = { MCB_BRIDGE_URL: `http://127.0.0.1:${port}` };
      expect(await runCli(["open"], {}, a.io)).toBe(0);
      expect(a.opened).toHaveLength(1);
      expect((await redeem(port, codeOf(a.opened[0]))).status).toBe(201);

      // A Bridge that keeps its files elsewhere would not know the code: say so instead of opening a dead link.
      const elsewhere = signInIo(0, { MCB_BRIDGE_URL: `http://127.0.0.1:${port}` });
      expect(await runCli(["open"], {}, elsewhere.io)).toBe(1);
      expect(elsewhere.err.at(-1)).toMatch(/another folder/);
      expect(elsewhere.opened).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("prints the link, with its limits, when no browser can be opened", async () => {
    const a = signInIo(0, { MCB_BRIDGE_URL: "http://127.0.0.1:9" });
    const { app, port } = await runningBridge(a);
    try {
      a.io.env = { MCB_BRIDGE_URL: `http://127.0.0.1:${port}` };
      a.io.openUrl = () => false;
      expect(await runCli(["open"], {}, a.io)).toBe(0);
      expect(a.err.join("\n")).toMatch(/It works once and expires in 10 minutes/);
      expect(a.err.at(-1)).toMatch(new RegExp(`http://127\\.0\\.0\\.1:${port}/dashboard#signin=[A-Za-z0-9_-]{43}$`));
    } finally {
      await app.close();
    }
  });

  it("openInBrowser does not pretend to open a browser on a machine without a desktop", () => {
    const calls = [];
    const spawnImpl = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { on() {}, unref() {} };
    };
    const url = "http://127.0.0.1:4300/dashboard#signin=abc";
    expect(openInBrowser(url, { platform: "linux", env: {}, spawnImpl })).toBe(false);
    expect(openInBrowser(url, { platform: "linux", env: { DISPLAY: ":0" }, spawnImpl })).toBe(true);
    expect(openInBrowser(url, { platform: "darwin", env: {}, spawnImpl })).toBe(true);
    expect(calls).toEqual([["xdg-open", url], ["open", url]]);
    expect(openInBrowser("javascript:alert(1)", { platform: "darwin", env: {}, spawnImpl })).toBe(false);
  });

  it("lists the open command in the usage text", () => {
    expect(USAGE).toMatch(/mc-bridge open/);
  });
});

describe("the window of a double-clicked app (MCB_APP_WINDOW=1)", async () => {
  const { appWindowLines } = await import("./cli.mjs");
  const app = (o = {}) => ({ config: { server: { host: "127.0.0.1" }, demo: false, ...o.config }, deps: { accounts: { list: () => o.accounts ?? [] } } });
  const text = (o) => appWindowLines({ app: app(o), port: 4300, version: "2.0.0" }).join("\n");

  it("says it is running, gives the one address and how to stop, in plain ASCII", () => {
    const t = text();
    expect(t).toContain("Mr. Chartist API Bridge 2.0.0");
    expect(t).toContain("The Bridge is running.");
    expect(t).toContain("Dashboard:  http://127.0.0.1:4300/dashboard");
    expect(t).toContain("To stop the Bridge, close this window.");
    // eslint-disable-next-line no-control-regex
    expect(t).toMatch(/^[\x00-\x7F]*$/);
  });

  it("names the one next step: add a broker, log in, or nothing when connected", () => {
    expect(text()).toContain("Next step: add your broker on the Accounts page");
    expect(text({ accounts: [{ id: "dhan-main", broker: "dhan", session: { state: "expired" } }] })).toContain("Next step: log in to your broker");
    expect(text({ accounts: [{ id: "dhan-main", label: "Dhan", broker: "dhan", session: { state: "connected" } }, { id: "p", broker: "paper" }] })).toContain("Connected: Dhan.");
    expect(text({ config: { demo: true } })).toContain("Demo mode");
  });

  it("shows no key, no command to type and no sign-in link", () => {
    for (const t of [text(), text({ config: { demo: true } })]) {
      expect(t).not.toMatch(/mcb_|mc-bridge|npm run|#signin=|Ctrl\+C|API key/);
    }
  });
});

describe("a double-clicked app never gives up on a busy port", async () => {
  const { runCli } = await import("./cli.mjs");
  const net = await import("node:net");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  it("starts on the next free port when another program holds the configured one, and says so", async () => {
    // Another program on the port: it accepts connections and says nothing (the worst case for a health probe).
    const sockets = new Set();
    const blocker = net.createServer((sock) => {
      sockets.add(sock);
      sock.on("error", () => {});
      sock.on("close", () => sockets.delete(sock));
    });
    await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
    const taken = blocker.address().port;
    const dir = mkdtempSync(join(tmpdir(), "mcb-appwin-"));
    writeFileSync(join(dir, "bridge.config.json"), JSON.stringify({ server: { port: taken }, dataDir: join(dir, "data"), logging: { level: "silent" } }));
    const lines = [];
    let started = null;
    const io = { out: (s) => lines.push(s), err: (s) => lines.push(s), env: { MCB_APP_WINDOW: "1" }, cwd: dir, openUrl: () => true, onListening: (app) => (started = app) };
    try {
      const code = await runCli(["start"], { config: join(dir, "bridge.config.json"), open: true }, io);
      expect(code).toBeNull();
      const text = lines.join("\n");
      expect(text).toContain("The Bridge is running.");
      expect(text).toMatch(new RegExp(`Port ${taken} is used by another program, so the Bridge uses port \\d+\\.`));
      expect(text).not.toContain(`Dashboard:  http://127.0.0.1:${taken}/dashboard`);
      // Without the app window, the same situation is still an error a person at a terminal can read. (The first
      // Bridge is stopped first: two Bridges on one data folder are refused before the port is even looked at.)
      await started.close();
      started = null;
      lines.length = 0;
      expect(await runCli(["start"], { config: join(dir, "bridge.config.json") }, { ...io, env: {} })).toBe(1);
      expect(lines.join("\n")).toMatch(/already in use by another program/);
    } finally {
      await started?.close();
      for (const sock of sockets) sock.destroy();
      await new Promise((r) => blocker.close(r));
    }
  });
});
