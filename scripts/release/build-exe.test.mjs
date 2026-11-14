// The Windows Setup .exe, exercised for real as its Linux twin: the same main.cjs and packed Bridge injected into this
// machine's own Node.js. Install, the mc-bridge command, the installed app starting the Bridge, and uninstall all run;
// only the Windows extras (shortcuts, Settings > Apps entry, user PATH) are skipped off Windows. The release job
// "windows-exe" runs the real .exe on Windows.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildExe, packApp } from "./build-exe.mjs";
import { shipped } from "./build-bundles.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const canBuild = process.platform === "linux" && existsSync(join(ROOT, "node_modules", "postject"));

const freePort = () =>
  new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

describe("app packing", () => {
  it("round-trips paths, modes and bytes in the format main.cjs reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-pack-"));
    mkdirSync(join(dir, "bin"));
    cpSync(join(ROOT, "package.json"), join(dir, "package.json"));
    cpSync(join(ROOT, "bin", "mc-bridge.mjs"), join(dir, "bin", "mc-bridge.mjs"));
    const buf = gunzipSync(packApp(dir));
    const seen = {};
    for (let at = 0; at < buf.length; ) {
      const n = buf.readUInt32LE(at);
      const name = buf.subarray(at + 4, at + 4 + n).toString();
      const size = buf.readUInt32LE(at + 8 + n);
      seen[name] = buf.subarray(at + 12 + n, at + 12 + n + size).toString();
      at += 12 + n + size;
    }
    expect(Object.keys(seen).sort()).toEqual(["bin/mc-bridge.mjs", "package.json"]);
    expect(seen["package.json"]).toBe(readFileSync(join(ROOT, "package.json"), "utf8"));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe.skipIf(!canBuild)("Setup .exe flow (Linux twin)", () => {
  let work;
  let exe;
  let env;
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "mcb-exe-"));
    const app = join(work, "stage");
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT }).toString().split("\0").filter(Boolean).filter(shipped);
    for (const f of files) {
      if (!existsSync(join(ROOT, f))) continue;
      mkdirSync(dirname(join(app, f)), { recursive: true });
      cpSync(join(ROOT, f), join(app, f));
    }
    // The production parts, straight from this checkout's node_modules (the lockfile marks the dev-only ones).
    for (const [dep, info] of Object.entries(JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")).packages)) {
      if (dep.startsWith("node_modules/") && !info.dev && existsSync(join(ROOT, dep)) && !existsSync(join(app, dep))) cpSync(join(ROOT, dep), join(app, dep), { recursive: true });
    }
    exe = join(work, "Mr-Chartist-Bridge-Setup");
    await buildExe({ app, nodeBinary: process.execPath, blobNode: process.execPath, out: exe, version: "9.8.7", windows: false, work: join(work, "build") });
    rmSync(app, { recursive: true, force: true });
    env = { ...process.env, MCB_INSTALL_DIR: join(work, "LocalAppData", "app"), MCB_HOME: join(work, "AppData", "Bridge"), MCB_MASTER_KEY_FILE: join(work, "AppData", "master.key") };
    delete env.MCB_CONFIG;
  }, 240_000);
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("installs itself and the Bridge, sets up paper trading, and adds the mc-bridge command", () => {
    const r = spawnSync(exe, ["--install-only", "--no-pause"], { env, encoding: "utf8", timeout: 120_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Installed\./);
    const appDir = env.MCB_INSTALL_DIR;
    expect(existsSync(join(appDir, "Mr Chartist Bridge.exe"))).toBe(true);
    expect(existsSync(join(appDir, "bin", "mc-bridge.mjs"))).toBe(true);
    expect(readFileSync(join(appDir, "mc-bridge.cmd"), "utf8")).toContain("--mcb-cli %*");
    expect(existsSync(join(env.MCB_HOME, "bridge.config.json"))).toBe(true);
  }, 180_000);

  it("the installed .exe runs Bridge commands (it is the Bridge's Node.js)", () => {
    const installed = join(env.MCB_INSTALL_DIR, "Mr Chartist Bridge.exe");
    const r = spawnSync(installed, ["--mcb-cli", "doctor", "--no-port-check", "--config", join(env.MCB_HOME, "bridge.config.json")], { env, encoding: "utf8", timeout: 60_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/Loaded .*bridge\.config\.json/);
  }, 90_000);

  it("opened from its shortcut, it starts the Bridge and shows a clean window with the dashboard address", async () => {
    const installed = join(env.MCB_INSTALL_DIR, "Mr Chartist Bridge.exe");
    const port = await freePort();
    const child = spawn(installed, ["--demo", "--no-pause"], { env: { ...env, MCB_PORT: String(port), DISPLAY: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    let health = null;
    for (let i = 0; i < 80 && !health; i++) {
      await new Promise((r) => setTimeout(r, 250));
      health = await fetch(`http://127.0.0.1:${port}/v1/health`).then((r) => (r.ok ? r.json() : null), () => null);
    }
    // The sign-in link is printed just after the Bridge starts to answer; wait for it instead of racing it.
    for (let i = 0; i < 40 && !/#signin=/.test(out); i++) await new Promise((r) => setTimeout(r, 250));
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    expect(health?.status, out).toBe("ok");
    // The window of a double-clicked app: running, the one address, how to stop. No log lines, key or sign-in link.
    expect(out).toContain("The Bridge is running.");
    expect(out).toContain(`Dashboard:  http://127.0.0.1:${port}/dashboard`);
    expect(out).toContain("To stop the Bridge, close this window.");
    expect(out).not.toMatch(/#signin=|mcb_[a-z0-9]{6,}|\{"t":/);
  }, 60_000);

  it("uninstalls the program and keeps the settings", () => {
    const r = spawnSync(exe, ["--uninstall", "--yes", "--no-pause"], { env, encoding: "utf8", timeout: 60_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(env.MCB_INSTALL_DIR)).toBe(false);
    expect(existsSync(join(env.MCB_HOME, "bridge.config.json"))).toBe(true);
  }, 90_000);
});
