/**
 * Developer starters, tested the way a developer uses them: `mc-bridge init <starter>` writes a project, and the
 * project is RUN against a real demo Bridge (loopback only, in this process; the starters run as child processes).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { runCli } from "../core/cli.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { chooseKeyAccounts, runInitStarter, starterList } from "./initStarter.mjs";
import { STARTERS, STARTER_IDS, newWebhookSecret, planStarter, writeStarter } from "./starters.mjs";
import { SIGNATURE_HEADER, sign, signatureHeaders, verifySignature } from "./webhook-receiver/verify.mjs";

const FAKE_KEY = "mcb_abcdefghij_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-_abcde"; // shape of a key, never valid
const hasCmd = async (cmd, args = ["--version"]) => (await run(cmd, args, { cwd: tmpdir() }).catch(() => ({ code: 127 }))).code === 0;

/** Run a program, collect its output, fail it after 40 s. The child sees no BRIDGE_ or MCB_ variables of ours. */
function run(cmd, args, { cwd, env = {} }) {
  return new Promise((resolve, reject) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(BRIDGE_|MCB_|RECEIVER_|WEBHOOK_)/.test(k)));
    const child = spawn(cmd, args, { cwd, env: { ...clean, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => (child.kill("SIGKILL"), reject(new Error(`timed out: ${cmd} ${args.join(" ")}\n${out}\n${err}`))), 40_000);
    child.on("error", (e) => (clearTimeout(t), reject(e)));
    child.on("close", (code) => (clearTimeout(t), resolve({ code, out, err })));
  });
}

let bridge;
let base;
let readKey;
let adminKey;
let work;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "mcb-starters-"));
  const { config } = loadConfig({ raw: { dataDir: join(work, "data"), logging: { level: "silent" }, server: { port: 0 } }, env: {}, demo: true });
  bridge = await createApp({ config, logger: createNullLogger() });
  const { port } = await bridge.listen();
  base = `http://127.0.0.1:${port}`;
  readKey = (await bridge.deps.keyStore.create({ label: "starter-test", scopes: ["read"], accounts: "*", clientKind: "script" })).key;
  adminKey = (await bridge.deps.keyStore.create({ label: "starter-admin", scopes: ["admin"], accounts: "*", clientKind: "ui" })).key;
});
afterAll(async () => {
  await bridge?.close();
});

/** Make a starter project in a fresh folder, with the Bridge's real address and (optionally) a key. */
function project(id, { key = null, keyRecord = null } = {}) {
  const dir = join(work, `p-${id}-${Math.random().toString(36).slice(2, 8)}`);
  writeStarter(dir, planStarter(id, { baseUrl: base, folder: dir, key, keyRecord }));
  return dir;
}
const filesOf = (dir, sub = "") =>
  readdirSync(join(dir, sub)).flatMap((f) => (statSync(join(dir, sub, f)).isDirectory() ? filesOf(dir, join(sub, f)) : [join(sub, f)]));

describe("the starters themselves", () => {
  it("are the six the developer kit promises, each with a title, a line of purpose and a run command", () => {
    expect(STARTER_IDS).toEqual(["node", "python", "curl", "sheets", "webhook-receiver", "mcp-client"]);
    for (const s of STARTERS) {
      expect(s.title.length, s.id).toBeGreaterThan(2);
      expect(s.about, s.id).toMatch(/[.]$/);
      expect(s.run, s.id).toBeTruthy();
    }
    expect(starterList()).toMatch(/webhook-receiver/);
  });

  for (const id of STARTER_IDS) {
    it(`${id}: README has three runnable steps, the real address, and no unfilled word`, () => {
      const files = planStarter(id, { baseUrl: "http://127.0.0.1:4300", folder: "my-project", key: FAKE_KEY, keyRecord: { id: "abcdefghij", scopes: ["read"], expiresAt: "2027-01-01T00:00:00.000Z" } });
      const readme = files.find((f) => f.path === "README.md").content;
      expect(readme).toContain("## Three steps");
      const steps = readme.slice(readme.indexOf("## Three steps")).split(/\n(?=\d\. )/).filter((x) => /^\d\. /.test(x));
      expect(steps.length, "numbered steps").toBe(3);
      expect(readme).not.toMatch(/\{\{/);
      expect(readme).toContain("cd my-project");
      if (id !== "webhook-receiver") expect(readme).toContain("abcdefghij");
      for (const f of files) {
        if (f.path === ".env") continue;
        expect(f.content, `${id}/${f.path} must not contain the key`).not.toContain(FAKE_KEY);
      }
    });

    it(`${id}: the key is only in .env; .env is ignored by git, owner-only, and .env.example is safe to share`, () => {
      const files = planStarter(id, { baseUrl: "http://127.0.0.1:4300", key: FAKE_KEY, keyRecord: { id: "abcdefghij", scopes: ["read"], expiresAt: null } });
      const env = files.find((f) => f.path === ".env");
      expect(env.secret).toBe(true);
      expect(env.content).toContain("BRIDGE_URL=http://127.0.0.1:4300");
      if (STARTERS.find((s) => s.id === id).needsKey) expect(env.content).toContain(`BRIDGE_KEY=${FAKE_KEY}`);
      const ignore = files.find((f) => f.path === ".gitignore").content.split("\n");
      expect(ignore).toContain(".env");
      expect(files.find((f) => f.path === ".env.example").content).not.toMatch(/mcb_|whsec_/);
      expect(files.filter((f) => f.content.includes(FAKE_KEY)).map((f) => f.path)).toEqual(STARTERS.find((s) => s.id === id).needsKey ? [".env"] : []);
    });

    it(`${id}: no key is written when none was asked for, and the README says how to make one`, () => {
      const files = planStarter(id, { baseUrl: "http://127.0.0.1:4300" });
      expect(files.find((f) => f.path === ".env").content).not.toMatch(/mcb_[a-z2-7]{10}_/);
      if (STARTERS.find((s) => s.id === id).needsKey) expect(files.find((f) => f.path === "README.md").content).toMatch(/keys create .*--scope read/);
    });
  }

  it("writes owner-only .env, refuses a folder that already has files, and with --force never replaces an existing .env", () => {
    const dir = join(work, "writer");
    const files = planStarter("node", { baseUrl: base, key: FAKE_KEY });
    const r = writeStarter(dir, files);
    expect(r.written).toContain(".env");
    if (process.platform !== "win32") expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(() => writeStarter(dir, files)).toThrow(/not empty/);
    const second = writeStarter(dir, planStarter("node", { baseUrl: base, key: "mcb_replaced" }), { force: true });
    expect(second.kept).toEqual([".env"]);
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain(FAKE_KEY);
  });

  it("the sheets starter carries the very script the Bridge ships (no second copy to drift)", () => {
    const files = planStarter("sheets", { baseUrl: base });
    expect(files.find((f) => f.path === "Code.gs").content).toBe(readFileSync(join(import.meta.dirname, "..", "..", "..", "integrations", "google-sheets", "bridge.gs"), "utf8"));
  });

  it("each webhook receiver project gets its own secret", () => {
    const a = planStarter("webhook-receiver", { baseUrl: base }).find((f) => f.path === ".env").content;
    const b = planStarter("webhook-receiver", { baseUrl: base }).find((f) => f.path === ".env").content;
    expect(a).toMatch(/WEBHOOK_SECRET=whsec_[A-Za-z0-9_-]{43}/);
    expect(a).not.toBe(b);
    expect(newWebhookSecret()).toMatch(/^whsec_/);
  });
});

describe("mc-bridge init <starter>", () => {
  const io = (cwd) => {
    const out = [];
    const err = [];
    return { out: (s) => out.push(s), err: (s) => err.push(s), env: {}, cwd, lines: out, errs: err };
  };
  const deps = (created = []) => ({
    baseUrl: () => "http://127.0.0.1:4300",
    probe: async () => null,
    createKey: async (body) => {
      created.push(body);
      return { key: FAKE_KEY, record: { id: "abcdefghij", scopes: body.scopes, expiresAt: body.expiresAt } };
    },
  });

  it("writes a project in ./bridge-<starter>, makes no key without --with-key, and says what to do next", async () => {
    const cwd = mkdtempSync(join(work, "cwd-"));
    const t = io(cwd);
    const created = [];
    expect(await runInitStarter({ id: "node" }, {}, t, deps(created))).toBe(0);
    expect(created).toEqual([]);
    expect(existsSync(join(cwd, "bridge-node", "index.mjs"))).toBe(true);
    expect(readFileSync(join(cwd, "bridge-node", ".env"), "utf8")).toContain("BRIDGE_KEY=\n");
    const text = t.lines.join("\n");
    expect(text).toContain("http://127.0.0.1:4300");
    expect(text).toContain("No key was made");
    expect(text).toContain("cd bridge-node && node index.mjs");
    expect(text).toContain("not answering");
  });

  it("--with-key makes ONE read key with an expiry, writes it only to .env, and never prints it", async () => {
    const cwd = mkdtempSync(join(work, "cwd-"));
    const t = io(cwd);
    const created = [];
    expect(await runInitStarter({ id: "python", folder: "bot" }, { "with-key": true }, t, deps(created))).toBe(0);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ label: "starter-python", scopes: ["read"], accounts: "*", clientKind: "script" });
    expect(Date.parse(created[0].expiresAt)).toBeGreaterThan(Date.now() + 80 * 86_400_000);
    expect(readFileSync(join(cwd, "bot", ".env"), "utf8")).toContain(`BRIDGE_KEY=${FAKE_KEY}`);
    expect(t.lines.join("\n") + t.errs.join("\n")).not.toContain(FAKE_KEY);
    expect(t.lines.join("\n")).toContain("abcdefghij");
    for (const f of filesOf(join(cwd, "bot"))) if (f !== ".env") expect(readFileSync(join(cwd, "bot", f), "utf8"), f).not.toContain(FAKE_KEY);
  });

  describe("which accounts the key may use", () => {
    const ACCOUNTS = [{ id: "paper", state: "connected" }, { id: "zerodha-main", state: "connected" }, { id: "dhan-two", state: "expired" }];
    const withAccounts = (list, created = []) => ({ ...deps(created), listAccounts: async () => list });

    it("defaults to the accounts connected right now, says so, and writes it in the README", async () => {
      const cwd = mkdtempSync(join(work, "cwd-"));
      const t = io(cwd);
      const created = [];
      expect(await runInitStarter({ id: "python", folder: "bot" }, { "with-key": true }, t, withAccounts(ACCOUNTS, created))).toBe(0);
      expect(created[0].accounts).toEqual(["paper", "zerodha-main"]);
      expect(t.lines.join("\n")).toMatch(/only the accounts connected right now: paper, zerodha-main/);
      const readme = readFileSync(join(cwd, "bot", "README.md"), "utf8");
      expect(readme).toMatch(/only these accounts, the ones connected when it was made: `paper`, `zerodha-main`/);
      expect(readme).not.toContain("dhan-two");
    });

    it("--accounts all gives every account; --accounts a,b is checked against the Bridge's accounts before a key exists", async () => {
      const cwd = mkdtempSync(join(work, "cwd-"));
      const created = [];
      expect(await runInitStarter({ id: "python", folder: "all" }, { "with-key": true, accounts: "all" }, io(cwd), withAccounts(ACCOUNTS, created))).toBe(0);
      expect(created[0].accounts).toBe("*");
      expect(readFileSync(join(cwd, "all", "README.md"), "utf8")).toMatch(/every broker account, including accounts you add later/);
      await expect(runInitStarter({ id: "python", folder: "bad" }, { "with-key": true, accounts: "nope" }, io(cwd), withAccounts(ACCOUNTS, created))).rejects.toThrow(/no account called nope/);
      expect(created).toHaveLength(1);
      expect(existsSync(join(cwd, "bad"))).toBe(false);
    });

    it("keeps starters easy: with nothing connected, or no way to read the accounts, the key may use all and the output says so", async () => {
      const cwd = mkdtempSync(join(work, "cwd-"));
      const created = [];
      const t = io(cwd);
      expect(await runInitStarter({ id: "node", folder: "none" }, { "with-key": true }, t, withAccounts([{ id: "zerodha-main", state: "expired" }], created))).toBe(0);
      expect(created[0].accounts).toBe("*");
      expect(t.lines.join("\n")).toMatch(/No account is connected right now, so the key may use all of them \(zerodha-main\)/);
      expect(await runInitStarter({ id: "node", folder: "fresh" }, { "with-key": true }, io(cwd), deps(created))).toBe(0);
      expect(created[1].accounts).toBe("*");
      const broken = { ...deps(created), listAccounts: async () => { throw new Error("no"); } };
      expect(await runInitStarter({ id: "node", folder: "broken" }, { "with-key": true }, io(cwd), broken)).toBe(0);
      expect(created[2].accounts).toBe("*");
    });

    it("asks a person once when several accounts are connected: Enter accepts, ids narrow it", async () => {
      const asked = [];
      const ask = (answer) => async (q) => (asked.push(q), answer);
      expect((await chooseKeyAccounts({ known: ACCOUNTS, ask: ask("") })).accounts).toEqual(["paper", "zerodha-main"]);
      expect((await chooseKeyAccounts({ known: ACCOUNTS, ask: ask("paper") })).accounts).toEqual(["paper"]);
      expect((await chooseKeyAccounts({ known: ACCOUNTS, ask: ask("all") })).accounts).toBe("*");
      expect(asked[0]).toMatch(/Connected now: paper, zerodha-main/);
      // one connected account, or no person at the terminal: no question
      const never = async () => { throw new Error("must not ask"); };
      expect((await chooseKeyAccounts({ known: [{ id: "paper", state: "connected" }], ask: never })).accounts).toEqual(["paper"]);
      expect((await chooseKeyAccounts({ known: ACCOUNTS })).accounts).toEqual(["paper", "zerodha-main"]);
      // an account id the key store cannot hold never makes a starter fail by default; naming it on purpose is explained
      expect(await chooseKeyAccounts({ known: [{ id: "my_acct", state: "connected" }] })).toMatchObject({ accounts: "*", note: /my_acct\) cannot be named in a key/ });
      await expect(chooseKeyAccounts({ flag: "my_acct", known: [{ id: "my_acct", state: "connected" }] })).rejects.toThrow(/2 to 32 lower-case/);
    });
  });

  it("never makes an admin or live key, and a bad --expires is refused", async () => {
    const cwd = mkdtempSync(join(work, "cwd-"));
    await expect(runInitStarter({ id: "node" }, { "with-key": true, scope: "admin" }, io(cwd), deps())).rejects.toThrow(/may have the scope read or paper/);
    await expect(runInitStarter({ id: "node" }, { "with-key": true, scope: "live" }, io(cwd), deps())).rejects.toThrow(/Live and admin keys/);
    await expect(runInitStarter({ id: "node" }, { "with-key": true, expires: "soon" }, io(cwd), deps())).rejects.toThrow(/--expires/);
    expect(existsSync(join(cwd, "bridge-node"))).toBe(false);
  });

  it("refuses a folder with files in it without making a key first, and lists starters for an unknown name", async () => {
    const cwd = mkdtempSync(join(work, "cwd-"));
    const t = io(cwd);
    expect(await runInitStarter({ id: "node" }, {}, t, deps())).toBe(0);
    const created = [];
    const again = io(cwd);
    expect(await runInitStarter({ id: "node" }, { "with-key": true }, again, deps(created))).toBe(1);
    expect(created).toEqual([]);
    expect(again.errs.join("\n")).toMatch(/not empty/);
    const unknown = io(cwd);
    expect(await runInitStarter({ id: "rust" }, {}, unknown, deps())).toBe(1);
    expect(unknown.errs.join("\n")).toMatch(/Unknown starter "rust"[\s\S]*webhook-receiver/);
    const list = io(cwd);
    expect(await runInitStarter({}, { list: true }, list, deps())).toBe(0);
    expect(list.lines.join("\n")).toMatch(/mcp-client/);
  });

  describe("--force is careful (audit S9)", () => {
    const posix = process.platform !== "win32";

    it("--with-key --force does not make a key that no file would hold when .env already exists", async () => {
      const cwd = mkdtempSync(join(work, "cwd-"));
      mkdirSync(join(cwd, "a1"));
      writeFileSync(join(cwd, "a1", ".env"), "BRIDGE_KEY=oldvalue\n");
      const t = io(cwd);
      const created = [];
      expect(await runInitStarter({ id: "node", folder: "a1" }, { "with-key": true, force: true }, t, deps(created))).toBe(0);
      expect(created).toEqual([]); // before the fix a live key was made and shown nowhere
      expect(readFileSync(join(cwd, "a1", ".env"), "utf8")).toBe("BRIDGE_KEY=oldvalue\n");
      expect(t.lines.join("\n")).toMatch(/No key was made: a1\/\.env already exists/);
      expect(t.lines.join("\n")).not.toMatch(/It is in a1\/\.env only/);
    });

    it.skipIf(!posix)("refuses a dangling .env link and a linked README without writing through them, and makes no key", async () => {
      const cwd = mkdtempSync(join(work, "cwd-"));
      mkdirSync(join(cwd, "a2"));
      symlinkSync(join(cwd, "victim.txt"), join(cwd, "a2", ".env")); // dangling
      writeFileSync(join(cwd, "precious.txt"), "precious");
      symlinkSync(join(cwd, "precious.txt"), join(cwd, "a2", "README.md"));
      const t = io(cwd);
      const created = [];
      expect(await runInitStarter({ id: "node", folder: "a2" }, { "with-key": true, force: true }, t, deps(created))).toBe(1);
      expect(created).toEqual([]);
      expect(t.errs.join("\n")).toMatch(/is a link/);
      expect(existsSync(join(cwd, "victim.txt"))).toBe(false);
      expect(readFileSync(join(cwd, "precious.txt"), "utf8")).toBe("precious");
    });

    it.skipIf(!posix)("refuses a linked sub-folder too", async () => {
      const cwd = mkdtempSync(join(work, "cwd-"));
      mkdirSync(join(cwd, "a3"));
      mkdirSync(join(cwd, "elsewhere"));
      symlinkSync(join(cwd, "elsewhere"), join(cwd, "a3", "examples"));
      const t = io(cwd);
      expect(await runInitStarter({ id: "node", folder: "a3" }, { force: true }, t, deps())).toBe(1);
      expect(readdirSync(join(cwd, "elsewhere"))).toEqual([]);
    });

    it("keeps a .bak of a file it replaces, and does not touch one that is already the same", async () => {
      const cwd = mkdtempSync(join(work, "cwd-"));
      expect(await runInitStarter({ id: "node", folder: "a4" }, {}, io(cwd), deps())).toBe(0);
      const edited = "// my own work\nconsole.log('mine');\n";
      writeFileSync(join(cwd, "a4", "index.mjs"), edited);
      const t = io(cwd);
      expect(await runInitStarter({ id: "node", folder: "a4" }, { force: true }, t, deps())).toBe(0);
      expect(readFileSync(join(cwd, "a4", "index.mjs.bak"), "utf8")).toBe(edited);
      expect(readFileSync(join(cwd, "a4", "index.mjs"), "utf8")).not.toBe(edited);
      expect(t.lines.join("\n")).toMatch(/index\.mjs replaced; the old file is saved as index\.mjs\.bak/);
      expect(readdirSync(join(cwd, "a4")).filter((f) => f.endsWith(".bak"))).toEqual(["index.mjs.bak"]); // the unchanged files got no copy
      // a second round keeps the first copy
      writeFileSync(join(cwd, "a4", "index.mjs"), "second edit\n");
      await runInitStarter({ id: "node", folder: "a4" }, { force: true }, io(cwd), deps());
      expect(readFileSync(join(cwd, "a4", "index.mjs.bak"), "utf8")).toBe(edited);
      expect(readFileSync(join(cwd, "a4", "index.mjs.bak2"), "utf8")).toBe("second edit\n");
    });
  });

  it("a starter that needs no key says so when --with-key is given", async () => {
    const cwd = mkdtempSync(join(work, "cwd-"));
    const t = io(cwd);
    const created = [];
    expect(await runInitStarter({ id: "webhook-receiver" }, { "with-key": true }, t, deps(created))).toBe(0);
    expect(created).toEqual([]);
    expect(t.errs.join("\n")).toMatch(/does not call the Bridge with a key/);
  });

  it("is wired into the command line: `init <starter>` goes here, plain `init` is still the first-run setup", async () => {
    const cwd = mkdtempSync(join(work, "cwd-"));
    const home = mkdtempSync(join(work, "home-"));
    const t = io(cwd);
    t.env = { MCB_HOME: home };
    expect(await runCli(["init", "curl", "from-cli"], { url: "http://127.0.0.1:4300", "with-key": true }, t)).toBe(0);
    const env = readFileSync(join(cwd, "from-cli", ".env"), "utf8");
    expect(env).toMatch(/^BRIDGE_KEY=mcb_[a-z2-7]{10}_[A-Za-z0-9_-]{43}$/m);
    expect(env).toContain("BRIDGE_URL=http://127.0.0.1:4300");
    expect(t.lines.join("\n") + t.errs.join("\n")).not.toMatch(/mcb_[a-z2-7]{10}_[A-Za-z0-9_-]{43}/);
    // the key really exists in this computer's key store, with only the read scope
    const keys = JSON.parse(readFileSync(join(home, "data", "keys.json"), "utf8")).keys;
    expect(keys.map((k) => [k.label, k.scopes])).toEqual([["starter-curl", ["read"]]]);
  });
});

describe("the starters, run against a demo Bridge", () => {
  it("node: index, history, download and events work, or say plainly that this Bridge is too old", async () => {
    const dir = project("node", { key: readKey });
    const first = await run(process.execPath, ["index.mjs"], { cwd: dir });
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/Bridge .* is ok \(demo mode/);
    expect(first.out).toMatch(/NSE:RELIANCE\s+\d+(\.\d+)?\s+realtime, from /);
    expect(first.out).toMatch(/NSE:NIFTY/);

    const hist = await run(process.execPath, ["examples/history.mjs", "NSE:RELIANCE", "5m", "3"], { cwd: dir });
    expect(hist.code, hist.err).toBe(0);
    expect(hist.out).toMatch(/NSE:RELIANCE 5m: 3 candles/);

    const dl = await run(process.execPath, ["examples/download.mjs", "NSE:RELIANCE", "5m"], { cwd: dir });
    expect(dl.code, dl.err).toBe(0);
    expect(dl.out).toMatch(/does not have this feature yet|Job \S+ is /);

    const ev = await run(process.execPath, ["examples/events.mjs", "1"], { cwd: dir });
    expect(ev.code, ev.err).toBe(0);
    expect(ev.out).toMatch(/does not have this feature yet|Listening for 1 seconds/);
  });

  it("node: a wrong key says UNAUTHENTICATED and what to check, and exits 1; no key says how to make one", async () => {
    const bad = await run(process.execPath, ["index.mjs"], { cwd: project("node", { key: FAKE_KEY }) });
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/UNAUTHENTICATED/);
    expect(bad.err).toMatch(/BRIDGE_KEY in \.env/);
    expect(bad.err).toMatch(/request id: req_/);
    const none = await run(process.execPath, ["index.mjs"], { cwd: project("node") });
    expect(none.code).toBe(1);
    expect(none.err).toMatch(/No API key[\s\S]*keys create/);
  });

  it("node: a Bridge that is not running is named, not a stack trace", async () => {
    const dir = project("node", { key: readKey });
    const r = await run(process.execPath, ["index.mjs"], { cwd: dir, env: { BRIDGE_URL: "http://127.0.0.1:9" } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Could not reach the Bridge at http:\/\/127\.0\.0\.1:9/);
    expect(r.err).not.toMatch(/\n\s+at /);
  });

  it("python: main and history work", async (ctx) => {
    if (!(await hasCmd("python3"))) return ctx.skip();
    const dir = project("python", { key: readKey });
    const first = await run("python3", ["main.py"], { cwd: dir });
    expect(first.err.replace(/\s+/g, " ")).toBe("");
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/Bridge .* is ok \(demo mode/);
    expect(first.out).toMatch(/NSE:RELIANCE\s+\d+(\.\d+)?\s+realtime, from /);
    const hist = await run("python3", ["examples/history.py", "NSE:RELIANCE", "5m", "3"], { cwd: dir });
    expect(hist.code, hist.err).toBe(0);
    expect(hist.out).toMatch(/NSE:RELIANCE 5m: 3 candles/);
    for (const script of ["examples/download.py", "examples/events.py"]) {
      const r = await run("python3", [script, ...(script.includes("events") ? ["1"] : [])], { cwd: dir });
      expect(r.code, `${script}: ${r.err}`).toBe(0);
      expect(r.out).toMatch(/does not have this feature yet|Job \S+ is |Listening for/);
    }
    const bad = await run("python3", ["main.py"], { cwd: project("python", { key: FAKE_KEY }) });
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/UNAUTHENTICATED/);
  });

  it("curl: quote and history work, and a wrong key is explained", async (ctx) => {
    if (!(await hasCmd("bash")) || !(await hasCmd("curl"))) return ctx.skip();
    const dir = project("curl", { key: readKey });
    const first = await run("bash", ["quote.sh"], { cwd: dir });
    expect(first.code, first.err).toBe(0);
    expect(first.out).toMatch(/"status": ?"ok"/);
    expect(first.out).toMatch(/NSE:RELIANCE/);
    expect(first.out).toMatch(/It works\./);
    const hist = await run("bash", ["history.sh", "NSE:RELIANCE", "5m", "2"], { cwd: dir });
    expect(hist.code, hist.err).toBe(0);
    expect(hist.out).toMatch(/candles/);
    for (const script of [["download.sh"], ["events.sh", "1"]]) {
      const r = await run("bash", script, { cwd: dir });
      expect(r.code, `${script[0]}: ${r.err}`).toBe(0);
      expect(r.out).toMatch(/does not have this feature yet|"id"|Listening for/);
    }
    const bad = await run("bash", ["quote.sh"], { cwd: project("curl", { key: FAKE_KEY }) });
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/401 UNAUTHENTICATED/);
  });

  it("sheets: check.mjs passes, and Code.gs itself returns prices from this Bridge (Apps Script services stubbed)", async () => {
    const dir = project("sheets", { key: readKey });
    const check = await run(process.execPath, ["check.mjs"], { cwd: dir });
    expect(check.code, check.err).toBe(0);
    expect(check.out).toMatch(/NSE:RELIANCE/);
    expect(check.out).toMatch(/The key and the route work/);
    const gs = await run(process.execPath, [join(import.meta.dirname, "__fixtures__", "sheetsHarness.mjs"), join(dir, "Code.gs"), base, readKey], { cwd: tmpdir() });
    expect(gs.code, gs.err).toBe(0);
    const table = JSON.parse(gs.out);
    expect(table[0].slice(0, 5)).toEqual(["symbol", "ltp", "chg", "pct", "volume"]);
    expect(table.slice(1).map((r) => r[0])).toEqual(["NSE:RELIANCE", "NSE:NIFTY"]);
    expect(typeof table[1][1]).toBe("number");
    expect(table[1]).toContain("realtime");
  });

  it("sheets: check.mjs explains a refused key", async () => {
    const r = await run(process.execPath, ["check.mjs"], { cwd: project("sheets", { key: FAKE_KEY }) });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/The Bridge answered 401/);
  });

  it("mcp-client: lists the tools this read key may use and calls one", async () => {
    const dir = project("mcp-client", { key: readKey });
    const list = await run(process.execPath, ["mcp.mjs"], { cwd: dir });
    expect(list.code, list.err).toBe(0);
    expect(list.out).toMatch(/Connected to .* 2\./);
    expect(list.out).toMatch(/get_ltp/);
    expect(list.out).not.toMatch(/submit_confirmed_order|prepare_order/);
    const call = await run(process.execPath, ["mcp.mjs", "get_ltp", '{"symbols":["NSE:RELIANCE"]}'], { cwd: dir });
    expect(call.code, call.err).toBe(0);
    expect(JSON.parse(call.out).data.items[0]).toMatchObject({ symbol: "NSE:RELIANCE", freshness: { class: "realtime" } });
    const bad = await run(process.execPath, ["mcp.mjs"], { cwd: project("mcp-client", { key: FAKE_KEY }) });
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/UNAUTHENTICATED/);
  });

  it("webhook-receiver: accepts a signed event once, refuses an unsigned one, and register.mjs is guarded", async () => {
    const dir = project("webhook-receiver");
    const { createReceiver } = await import(join(dir, "receiver.mjs"));
    const secret = /WEBHOOK_SECRET=(\S+)/.exec(readFileSync(join(dir, ".env"), "utf8"))[1];
    const got = [];
    const server = createReceiver({ secret, onEvent: (e) => got.push(e) });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}/events`;
    try {
      const sent = await run(process.execPath, ["send-test.mjs"], { cwd: dir, env: { RECEIVER_URL: url } });
      expect(sent.code, sent.err).toBe(0);
      expect(sent.out).toMatch(/signed event {2}: 200 .*"duplicate":false/);
      expect(sent.out).toMatch(/unsigned event: 401/);
      await new Promise((r) => setTimeout(r, 50));
      expect(got).toHaveLength(1);
      expect(got[0].topic).toBe("test.ping");

      // the same event again (a retry): acknowledged, not handled twice
      const body = JSON.stringify({ id: "evt_once", topic: "x", data: {} });
      const t = Math.floor(Date.now() / 1000);
      const post = (b, h) => fetch(url, { method: "POST", body: b, headers: h });
      const h = { ...signatureHeaders(secret, t, body), "X-Bridge-Event-Id": "evt_once" };
      expect(((await (await post(body, h)).json()).duplicate)).toBe(false);
      expect(((await (await post(body, h)).json()).duplicate)).toBe(true);
      // a captured request sent again with another, unsigned X-Bridge-Event-Id header is still the same event (audit S3)
      for (const fake of ["evt_x1", "evt_x2", ""]) {
        const replay = await post(body, { ...signatureHeaders(secret, t, body), ...(fake ? { "X-Bridge-Event-Id": fake } : {}) });
        expect((await replay.json()).duplicate, `header ${fake || "(none)"}`).toBe(true);
      }
      // a body changed after signing, and a stale timestamp
      expect((await post(body.replace("evt_once", "evt_twice"), h)).status).toBe(401);
      const old = t - 3600;
      expect((await post(body, { ...signatureHeaders(secret, old, body), "X-Bridge-Event-Id": "evt_old" })).status).toBe(401);
      await new Promise((r) => setTimeout(r, 50));
      expect(got.map((e) => e.id).filter((i) => i === "evt_once")).toHaveLength(1);
      expect(got.some((e) => e.id === "evt_x1" || e.id === "evt_x2")).toBe(false);
      // the memory of handled ids is bounded and forgets old ids, never the recent ones
      const { seenBefore } = await import(join(dir, "receiver.mjs"));
      const t0 = 1_000_000_000;
      for (let i = 0; i < 12_000; i += 1) seenBefore(`bulk_${i}`, t0 + i);
      expect(seenBefore("bulk_11999", t0 + 12_000)).toBe(true); // recent: remembered
      expect(seenBefore("bulk_0", t0 + 12_001)).toBe(false); // oldest: dropped to stay inside the bound
      expect(seenBefore("bulk_11999", t0 + 12_000 + 11 * 60_000)).toBe(false); // older than 10 minutes: forgotten
    } finally {
      await new Promise((r) => server.close(r));
    }
    const reg = await run(process.execPath, ["register.mjs"], { cwd: dir, env: { BRIDGE_URL: base, MCB_ADMIN_KEY: adminKey } });
    // An older Bridge says it has no events; a newer one subscribes, or refuses the address with its own code.
    expect(`${reg.out}${reg.err}`).toMatch(/does not have this feature yet|Subscribed:|[A-Z_]{5,}: /);
    const noAdmin = await run(process.execPath, ["register.mjs"], { cwd: dir, env: { BRIDGE_URL: base } });
    expect(noAdmin.code).toBe(1);
    expect(noAdmin.err).toMatch(/MCB_ADMIN_KEY/);
  });
});

describe("starter hardening (audit S13)", () => {
  it("python: a redirect is refused, so the key never goes to another address", async (ctx) => {
    if (!(await hasCmd("python3"))) return ctx.skip();
    const seen = [];
    const target = createServer((req, res) => {
      seen.push(req.headers.authorization ?? null);
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
    await new Promise((r) => target.listen(0, "127.0.0.1", r));
    const bounce = createServer((req, res) => res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/elsewhere` }).end());
    await new Promise((r) => bounce.listen(0, "127.0.0.1", r));
    try {
      const dir = project("python", { key: FAKE_KEY });
      const r = await run("python3", ["-c", "from bridge import Bridge\ntry:\n    Bridge().get('/v1/health')\nexcept Exception as e:\n    print('refused:', type(e).__name__)"], { cwd: dir, env: { BRIDGE_URL: `http://127.0.0.1:${bounce.address().port}` } });
      expect(r.out).toMatch(/refused/);
      expect(seen).toEqual([]); // the second server was never asked, so it never saw the Authorization header
    } finally {
      await new Promise((r) => bounce.close(r));
      await new Promise((r) => target.close(r));
    }
  });

  it("node: a redirect is refused as well", async () => {
    const seen = [];
    const target = createServer((req, res) => (seen.push(req.headers.authorization ?? null), res.writeHead(200).end("{}")));
    await new Promise((r) => target.listen(0, "127.0.0.1", r));
    const bounce = createServer((req, res) => res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/elsewhere` }).end());
    await new Promise((r) => bounce.listen(0, "127.0.0.1", r));
    try {
      const dir = project("node", { key: FAKE_KEY });
      const { createBridge } = await import(join(dir, "bridge.mjs"));
      await expect(createBridge({ baseUrl: `http://127.0.0.1:${bounce.address().port}`, key: FAKE_KEY, maxRetries: 0 }).get("/v1/health")).rejects.toThrow();
      expect(seen).toEqual([]);
    } finally {
      await new Promise((r) => bounce.close(r));
      await new Promise((r) => target.close(r));
    }
  });

  it("curl: .env is read as KEY=value lines, never run as shell code, and the key is not on the curl command line", async (ctx) => {
    if (process.platform === "win32" || !(await hasCmd("bash"))) return ctx.skip();
    const dir = project("curl", { key: FAKE_KEY });
    const marker = join(dir, "ran-as-code");
    writeFileSync(join(dir, ".env"), `BRIDGE_KEY=${FAKE_KEY}\nBRIDGE_URL=${base}\nOTHER=$(touch ${marker})\nBRIDGE_NOTE=$(touch ${marker})\n`);
    const r = await run("bash", ["-c", `. ./lib.sh; echo "key=$BRIDGE_KEY"; echo "url=$BRIDGE_URL"`], { cwd: dir });
    expect(r.out).toContain(`key=${FAKE_KEY}`);
    expect(r.out).toContain(`url=${base}`);
    expect(existsSync(marker)).toBe(false);
    const lib = readFileSync(join(dir, "lib.sh"), "utf8");
    expect(lib).not.toMatch(/-H "Authorization: Bearer \$BRIDGE_KEY"/);
    expect(lib).toMatch(/-H "@\$keyfile"/);
    // and it still works against the Bridge
    const ok = await run("bash", ["-c", `. ./lib.sh; bridge GET /v1/health && echo "status=$BRIDGE_STATUS"`], { cwd: dir });
    expect(ok.out).toMatch(/status=200/);
  });

  it("the receiver's register.mjs says before posting that a plain http address is refused by default", async () => {
    const dir = project("webhook-receiver");
    const r = await run(process.execPath, ["register.mjs"], { cwd: dir, env: { BRIDGE_URL: base, MCB_ADMIN_KEY: adminKey } });
    expect(r.out).toMatch(/is plain http\. The Bridge refuses that by default/);
  });
});

describe("webhook signature check (verify.mjs)", () => {
  const body = '{"id":"e1"}';
  const secret = "whsec_test_secret_long_enough";
  const at = 1_800_000_000;
  const check = (o = {}) => verifySignature({ secret, timestamp: String(at), signature: `v1=${sign(secret, at, body)}`, rawBody: body, now: at * 1000, ...o });

  it("accepts a good signature and says why it refuses a bad one", () => {
    expect(check()).toEqual({ ok: true });
    expect(check({ signature: undefined })).toEqual({ ok: false, reason: "missing" });
    expect(check({ timestamp: undefined })).toEqual({ ok: false, reason: "missing" });
    expect(check({ timestamp: "12ab" })).toEqual({ ok: false, reason: "timestamp" });
    expect(check({ signature: "garbage" })).toEqual({ ok: false, reason: "mismatch" });
    expect(check({ signature: `v1=${sign("other", at, body)}` })).toEqual({ ok: false, reason: "mismatch" });
    expect(check({ timestamp: String(at - 301), signature: `v1=${sign(secret, at - 301, body)}` })).toEqual({ ok: false, reason: "stale" });
    expect(check({ timestamp: String(at + 301), signature: `v1=${sign(secret, at + 301, body)}` })).toEqual({ ok: false, reason: "stale" });
    expect(check({ timestamp: String(at - 299), signature: `v1=${sign(secret, at - 299, body)}` }).ok).toBe(true);
    expect(check({ rawBody: `${body} ` }).ok).toBe(false);
  });

  it("accepts either of two secrets while one is being rotated, and either of two v1 entries", () => {
    expect(check({ secret: ["old-secret-long-enough", secret] }).ok).toBe(true);
    expect(check({ signature: `v1=${"0".repeat(64)} v1=${sign(secret, at, body)}` }).ok).toBe(true);
    expect(check({ signature: `v1=${"0".repeat(64)},v1=${sign(secret, at, body)}` }).ok).toBe(true);
  });

  it("uses the header names the Bridge sends, and a fixed vector computed the documented way", () => {
    expect(SIGNATURE_HEADER).toBe("x-bridge-signature");
    expect(signatureHeaders(secret, at, body)).toEqual({ "X-Bridge-Timestamp": String(at), "X-Bridge-Signature": `v1=${sign(secret, at, body)}` });
    // HMAC-SHA256 over "<timestamp>.<raw body>", lower-case hex
    expect(sign("k", 1, "b")).toBe(createHmac("sha256", "k").update("1.b").digest("hex"));
  });

  it("agrees with the Bridge's own outbound signer when this checkout has one", async (ctx) => {
    const file = join(import.meta.dirname, "..", "events", "signature.mjs");
    if (!existsSync(file)) return ctx.skip();
    const bridge = await import(file);
    const h = bridge.signatureHeaders(secret, at, body);
    expect(verifySignature({ secret, timestamp: h["X-Bridge-Timestamp"], signature: h["X-Bridge-Signature"], rawBody: body, now: at * 1000 }).ok).toBe(true);
  });
});
