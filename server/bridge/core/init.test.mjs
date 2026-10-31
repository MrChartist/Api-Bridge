import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openInBrowser, runCli } from "./cli.mjs";
import { loadConfig } from "./config.mjs";
import { buildConfig, defaultMasterKeyPath, ensureMasterKey } from "./init.mjs";

function setup(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mcb-init-"));
  const home = join(dir, "home");
  const out = [];
  const err = [];
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), MCB_LOG_LEVEL: "silent", ...extraEnv };
  return { dir, home, out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s), env, cwd: dir, interactive: false } };
}

describe("mc-bridge init", () => {
  it("writes a config, a private master key outside the data folder and an admin key shown once", async () => {
    const t = setup();
    expect(await runCli(["init"], { yes: true, broker: "dhan" }, t.io)).toBe(0);
    const cfg = JSON.parse(readFileSync(join(t.dir, "bridge.config.json"), "utf8"));
    expect(cfg.accounts.map((a) => a.id)).toEqual(["paper", "dhan-main"]);
    expect(cfg.safety.liveTrading).toBe(false);
    // The rate lives in reference.rate (Market calendar page); a pinned market.chain.riskFreeRate would override it.
    expect(cfg.market?.chain?.riskFreeRate).toBeUndefined();
    const example = JSON.parse(readFileSync(new URL("../../../bridge.config.example.json", import.meta.url), "utf8"));
    expect(example.market.chain).toEqual({ source: "auto" });
    expect(cfg.masterKeyFile).toBe(join(t.home, ".config", "mc-bridge", "master.key"));
    expect(statSync(cfg.masterKeyFile).mode & 0o777).toBe(0o600);
    expect(Buffer.from(readFileSync(cfg.masterKeyFile, "utf8").trim(), "base64")).toHaveLength(32);
    const text = t.out.join("\n");
    const key = /(mcb_[a-z2-7]{10}_[A-Za-z0-9_-]+)/.exec(text)?.[1];
    expect(key).toBeTruthy();
    expect(text).toMatch(/shown only once/);
    expect(text).toMatch(/accounts connect dhan-main/);
    // The config it wrote loads, and the key works for the admin key list.
    const { config } = loadConfig({ path: join(t.dir, "bridge.config.json"), env: {} });
    expect(config.masterKeyFile).toBe(cfg.masterKeyFile);
    t.out.length = 0;
    expect(await runCli(["keys", "list"], { json: true }, t.io)).toBe(0);
    expect(JSON.parse(t.out.at(-1))[0].scopes.sort()).toEqual(["admin", "paper"]);
  });

  it("says so when a re-run creates another admin key", async () => {
    const t = setup();
    expect(await runCli(["init"], { yes: true }, t.io)).toBe(0);
    expect(t.out.join("\n")).not.toMatch(/already existed/);
    t.out.length = 0;
    expect(await runCli(["init"], { yes: true }, t.io)).toBe(0);
    const text = t.out.join("\n");
    expect(text).toMatch(/1 admin key\(s\) already existed, so this is an extra one/);
    expect(text).toMatch(/mc-bridge keys revoke/);
    expect(text).toMatch(/--no-key/);
  });

  it("keeps an existing config and master key unless --force", async () => {
    const t = setup();
    writeFileSync(join(t.dir, "bridge.config.json"), JSON.stringify({ dataDir: "data", accounts: [] }));
    expect(await runCli(["init"], { yes: true, "no-key": true }, t.io)).toBe(0);
    expect(JSON.parse(readFileSync(join(t.dir, "bridge.config.json"), "utf8")).accounts).toEqual([]);
    const keyFile = defaultMasterKeyPath(t.io.env);
    const before = readFileSync(keyFile, "utf8");
    expect(await runCli(["init"], { yes: true, force: true, demo: true, "no-key": true }, t.io)).toBe(0);
    expect(readFileSync(keyFile, "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(join(t.dir, "bridge.config.json"), "utf8")).demo).toBe(true);
  });

  it("refuses an unknown broker or a bad account id", async () => {
    const t = setup();
    expect(await runCli(["init"], { yes: true, broker: "nope", "no-key": true }, t.io)).toBe(1);
    expect(t.err.join(" ")).toMatch(/Unknown broker "nope"/);
    expect(await runCli(["setup"], { yes: true, broker: "dhan", account: "Bad Id", "no-key": true, force: true }, t.io)).toBe(1);
  });

  it("asks questions when interactive", async () => {
    const t = setup();
    const answers = ["n", "y", "y", "zerodha", "zerodha-me", "My Kite"];
    const asked = [];
    t.io.interactive = true;
    t.io.prompt = async (q) => (asked.push(q), answers.shift() ?? "");
    expect(await runCli(["init"], { "no-key": true }, t.io)).toBe(0);
    const cfg = JSON.parse(readFileSync(join(t.dir, "bridge.config.json"), "utf8"));
    expect(cfg.accounts[1]).toMatchObject({ id: "zerodha-me", broker: "zerodha", label: "My Kite" });
  });

  it("ensureMasterKey never overwrites and builds configs without browser origins", () => {
    const t = setup();
    const p = join(t.dir, "k", "master.key");
    expect(ensureMasterKey(p).created).toBe(true);
    expect(ensureMasterKey(p).created).toBe(false);
    expect(existsSync(p)).toBe(true);
    const cfg = buildConfig({ example: { dataDir: "./data", cors: { allowedOrigins: ["http://x:1"] }, safety: { liveTrading: true } }, accounts: [], masterKeyFile: p, configDir: t.dir });
    expect(Object.keys(cfg)).toEqual(["dataDir", "masterKeyFile", "cors", "safety", "accounts"]);
    expect(cfg.cors.allowedOrigins).toEqual([]);
    expect(cfg.safety.liveTrading).toBe(false);
  });
});

describe("openInBrowser", () => {
  it("uses the platform opener and refuses odd URLs", () => {
    const calls = [];
    const spawnImpl = (cmd, args) => {
      calls.push([cmd, args]);
      return { on() {}, unref() {} };
    };
    expect(openInBrowser("http://127.0.0.1:4300/dashboard", { platform: "darwin", spawnImpl })).toBe(true);
    expect(openInBrowser("http://127.0.0.1:4300/dashboard", { platform: "win32", spawnImpl })).toBe(true);
    expect(openInBrowser("http://127.0.0.1:4300/dashboard", { platform: "linux", env: { DISPLAY: ":0" }, spawnImpl })).toBe(true);
    // Android (Node.js in Termux): Termux's own opener, with or without a display variable.
    expect(openInBrowser("http://127.0.0.1:4300/dashboard", { platform: "android", env: {}, spawnImpl })).toBe(true);
    expect(calls.map((c) => c[0])).toEqual(["open", "cmd", "xdg-open", "termux-open-url"]);
    expect(openInBrowser("javascript:alert(1)", { spawnImpl })).toBe(false);
    expect(openInBrowser("http://x/\" & calc", { spawnImpl })).toBe(false);
    expect(openInBrowser("http://x/", { platform: "darwin", spawnImpl: () => { throw new Error("no"); } })).toBe(false);
  });
});
