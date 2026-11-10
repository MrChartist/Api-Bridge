import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli, runDoctor } from "./cli.mjs";
import { loadConfig } from "./config.mjs";
import { TRADINGVIEW_SENDER_IPS } from "./expose.mjs";

function setup(rawConfig, { prompts } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mcb-excli-"));
  const file = join(dir, "bridge.config.json");
  if (rawConfig) writeFileSync(file, JSON.stringify({ dataDir: "data", logging: { level: "silent" }, ...rawConfig }));
  const out = [];
  const err = [];
  const asked = [];
  const answers = prompts ? [...prompts] : null;
  const io = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env: { MCB_HOME: dir },
    cwd: dir,
    ...(answers ? { interactive: true, prompt: async (q) => (asked.push(q), answers.shift() ?? "") } : { interactive: false }),
  };
  return { dir, file, out, err, asked, io, text: () => out.join("\n"), config: () => JSON.parse(readFileSync(file, "utf8")) };
}
const flags = (s, f = {}) => ({ config: s.file, yes: true, ...f });

describe("mc-bridge expose (non-interactive)", () => {
  it("alerts through Cloudflare: writes the config, prints the steps, the URL pattern and the restart sentence", async () => {
    const s = setup({});
    expect(await runCli(["expose", "alerts"], flags(s, { provider: "cloudflare", host: "hooks.example.com" }), s.io)).toBe(0);
    const c = s.config();
    expect(c.server.publicIngress).toEqual({ enabled: true, host: "127.0.0.1", port: 4301, allowedHosts: ["hooks.example.com"] });
    expect(c.hooks).toEqual({ clientIpHeader: "cf-connecting-ip", allowSourceIps: [...TRADINGVIEW_SENDER_IPS] });
    const t = s.text();
    expect(t).toMatch(/cloudflared tunnel route dns mc-bridge hooks\.example\.com/);
    expect(t).toMatch(/https:\/\/hooks\.example\.com\/hooks\/<source>\/<token>/);
    expect(t).toMatch(/Restart the Bridge to apply this/);
    expect(t).toMatch(/ports 80 and 443 only/);
    expect(s.err).toEqual([]);
  });

  it("INT-08: --yes --dry-run prints the change and writes nothing: not the config, not a backup copy", async () => {
    const s = setup({ server: { port: 4300 } });
    const before = readFileSync(s.file, "utf8");
    expect(await runCli(["expose", "alerts"], flags(s, { provider: "cloudflare", host: "hooks.example.com", "dry-run": true }), s.io)).toBe(0);
    expect(readFileSync(s.file, "utf8")).toBe(before);
    expect(readdirSync(s.dir).filter((f) => f.includes("bak"))).toEqual([]);
    expect(s.text()).toMatch(/This will change/);
    expect(s.text()).toMatch(/hooks\.example\.com/);
    expect(s.text()).toMatch(/Dry run: nothing was written\./);
    expect(s.text()).not.toMatch(/Saved to/);
    const j = setup({});
    expect(await runCli(["expose", "alerts"], flags(j, { provider: "cloudflare", host: "hooks.example.com", "dry-run": true, json: true }), j.io)).toBe(0);
    const out = JSON.parse(j.out.join("\n"));
    expect(out).toMatchObject({ dryRun: true, file: j.file });
    expect(out.wouldChange.length).toBeGreaterThan(0);
    expect(j.config().server?.publicIngress).toBeUndefined();
    // turning off previews too
    const on = setup({});
    await runCli(["expose", "alerts"], flags(on, { provider: "cloudflare", host: "hooks.example.com" }), on.io);
    const written = readFileSync(on.file, "utf8");
    const off = { ...on, out: [], text: () => off.out.join("\n") };
    expect(await runCli(["expose", "off"], flags(on, { "dry-run": true }), { ...on.io, out: (x) => off.out.push(x) })).toBe(0);
    expect(readFileSync(on.file, "utf8")).toBe(written);
    expect(off.text()).toMatch(/Dry run: this would turn off/);
  });

  it("--allow-ips none leaves the sender allowlist alone; a custom list is validated", async () => {
    const s = setup({});
    expect(await runCli(["expose", "alerts"], flags(s, { provider: "caddy", host: "hooks.example.com", "allow-ips": "none" }), s.io)).toBe(0);
    expect(s.config().hooks).toEqual({ clientIpHeader: "x-forwarded-for" });
    const s2 = setup({});
    expect(await runCli(["expose", "alerts"], flags(s2, { provider: "caddy", host: "hooks.example.com", "allow-ips": "10.1.1.1,52.89.0.0/16" }), s2.io)).toBe(0);
    expect(s2.config().hooks.allowSourceIps).toEqual(["10.1.1.1", "52.89.0.0/16"]);
    const s3 = setup({});
    expect(await runCli(["expose", "alerts"], flags(s3, { provider: "caddy", host: "hooks.example.com", "allow-ips": "not-an-ip" }), s3.io)).toBe(1);
    expect(s3.err.join("\n")).toMatch(/not an IP address/);
    expect(existsSync(s3.file)).toBe(true); // the file given at setup is untouched
    expect(s3.config().hooks).toBeUndefined();
  });

  it("with a ChartInk webhook already there, the allowlist defaults to off (their senders differ)", async () => {
    const s = setup({});
    const hooksFile = join(s.dir, "data");
    mkdirSync(hooksFile, { recursive: true });
    writeFileSync(join(hooksFile, "hooks.json"), JSON.stringify({ version: 1, hooks: [{ id: "hk_abcdefghijkl", source: "chartink", label: "scan", account: "paper", mode: "paper", requireConfirmation: false, allowedSymbols: [], maxLotsPerSignal: 1, product: null, orderType: "LIMIT", allowSourceIps: [], side: null, tokenHash: "a".repeat(64), createdAt: "2026-11-01T00:00:00+05:30", lastSignalAt: null }] }));
    expect(await runCli(["expose", "alerts"], flags(s, { provider: "ngrok", host: "x.ngrok.dev" }), s.io)).toBe(0);
    expect(s.config().hooks.allowSourceIps).toBeUndefined();
  });

  it("Sheets: its own listener and port, no sender header, the Apps Script settings", async () => {
    const s = setup({});
    expect(await runCli(["expose", "sheets"], flags(s, { provider: "cloudflare", host: "sheet.example.com" }), s.io)).toBe(0);
    expect(s.config().server.sheetsIngress).toEqual({ enabled: true, host: "127.0.0.1", port: 4302, allowedHosts: ["sheet.example.com"] });
    expect(s.config().hooks).toBeUndefined();
    expect(s.text()).toMatch(/BRIDGE_URL:\s+https:\/\/sheet\.example\.com/);
    expect(s.text()).toMatch(/keys create --label sheet --scope read --expires 90d/);
  });

  it("asks for what is missing instead of guessing, and refuses an unsafe port forward", async () => {
    const s = setup({});
    expect(await runCli(["expose", "alerts"], flags(s, { host: "hooks.example.com" }), s.io)).toBe(1);
    expect(s.err.join("\n")).toMatch(/provider is needed/);
    const s2 = setup({});
    expect(await runCli(["expose", "alerts"], flags(s2, { provider: "port-forward", host: "home.example.net", "allow-ips": "none" }), s2.io)).toBe(1);
    expect(s2.err.join("\n")).toMatch(/needs the sender allowlist/);
    const s3 = setup({});
    expect(await runCli(["expose", "alerts"], flags(s3, { provider: "cloudflare" }), s3.io)).toBe(1);
    expect(s3.err.join("\n")).toMatch(/public host name is needed/);
  });

  it("keeps the old file and says so; a second run changes nothing", async () => {
    const s = setup({ accounts: [{ id: "dhan-main", broker: "dhan" }] });
    await runCli(["expose", "alerts"], flags(s, { provider: "cloudflare", host: "hooks.example.com" }), s.io);
    expect(s.text()).toMatch(/The old file is kept as .*\.bak-expose/);
    expect(s.config().accounts).toEqual([{ id: "dhan-main", broker: "dhan" }]);
    s.out.length = 0;
    await runCli(["expose", "alerts"], flags(s, { provider: "cloudflare", host: "hooks.example.com" }), s.io);
    expect(s.text()).toMatch(/Nothing needed to change/);
  });

  it("--check runs the self-check right away; with a fake transport it reports the verdict, and no public call is made without --allow-outbound", async () => {
    const s = setup({});
    const transport = vi.fn(async () => ({ status: 404, headers: { "x-request-id": "r1", "content-type": "application/problem+json" }, text: "{}" }));
    const lookup = vi.fn();
    const io = { ...s.io, transport, lookup };
    const code = await runCli(["expose", "alerts"], flags(s, { provider: "cloudflare", host: "hooks.example.com", check: true, "public-url": "https://hooks.example.com" }), io);
    expect(lookup).not.toHaveBeenCalled();
    expect(transport.mock.calls.every(([o]) => o.host === "127.0.0.1")).toBe(true);
    expect(s.text()).toMatch(/Self-check/);
    expect(s.text()).toMatch(/Not tested: testing it sends requests/);
    expect([0, 1]).toContain(code);
  });

  it("--json prints one parseable object", async () => {
    const s = setup({});
    expect(await runCli(["expose", "alerts"], flags(s, { provider: "ngrok", host: "x.ngrok.dev", json: true }), s.io)).toBe(0);
    const o = JSON.parse(s.out.join("\n"));
    expect(o.plan).toMatchObject({ provider: "ngrok", host: "x.ngrok.dev" });
    expect(o.steps).toEqual(["ngrok http 4301 --url https://x.ngrok.dev"]);
    expect(o.restart).toMatch(/Restart the Bridge/);
  });
});

describe("mc-bridge expose (interactive)", () => {
  it("asks what, how, the address, the allowlist and a final yes; then writes", async () => {
    const s = setup({}, { prompts: ["1", "1", "hooks.example.com", "y", "y"] });
    expect(await runCli(["expose"], { config: s.file }, s.io)).toBe(0);
    expect(s.asked[0]).toMatch(/TradingView alerts/);
    expect(s.asked[1]).toMatch(/Choose a number/);
    expect(s.asked[2]).toMatch(/Public host name/);
    expect(s.config().server.publicIngress.allowedHosts).toEqual(["hooks.example.com"]);
    expect(s.config().hooks.clientIpHeader).toBe("cf-connecting-ip");
    expect(s.text()).toMatch(/every webhook|applies to every webhook/);
  });

  it("answering no at the end changes nothing", async () => {
    const s = setup({}, { prompts: ["1", "1", "hooks.example.com", "n", "n"] });
    expect(await runCli(["expose"], { config: s.file }, s.io)).toBe(0);
    expect(s.text()).toMatch(/Nothing was changed/);
    expect(s.config()).toEqual({ dataDir: "data", logging: { level: "silent" } });
  });

  it("the Sheets menu does not offer a port forward", async () => {
    const s = setup({}, { prompts: ["2", "1", "sheet.example.com", "y"] });
    await runCli(["expose"], { config: s.file }, s.io);
    expect(s.text()).not.toMatch(/Plain port forward/);
    expect(s.config().server.sheetsIngress.enabled).toBe(true);
  });
});

describe("mc-bridge expose status / off / check", () => {
  it("status says nothing is exposed, then what is on", async () => {
    const s = setup({});
    expect(await runCli(["expose", "status"], { config: s.file }, s.io)).toBe(0);
    expect(s.text()).toMatch(/Nothing on this computer is set up/);
    await runCli(["expose", "alerts"], flags(s, { provider: "cloudflare", host: "hooks.example.com" }), s.io);
    s.out.length = 0;
    expect(await runCli(["expose", "status"], { config: s.file }, s.io)).toBe(0);
    expect(s.text()).toMatch(/Alerts can reach this Bridge at hooks\.example\.com/);
    expect(s.text()).toMatch(/Alerts: on, listening on 127\.0\.0\.1:4301/);
  });

  it("off turns the listener off, keeps the rest, and lists what else to remove", async () => {
    const s = setup({});
    await runCli(["expose", "alerts"], flags(s, { provider: "cloudflare", host: "hooks.example.com" }), s.io);
    await runCli(["expose", "sheets"], flags(s, { provider: "cloudflare", host: "sheet.example.com" }), s.io);
    s.out.length = 0;
    expect(await runCli(["expose", "off", "alerts"], { config: s.file }, s.io)).toBe(0);
    expect(s.config().server.publicIngress.enabled).toBe(false);
    expect(s.config().server.sheetsIngress.enabled).toBe(true);
    expect(s.text()).toMatch(/Restart the Bridge/);
    expect(s.text()).toMatch(/stop the tunnel/);
    await runCli(["expose", "off"], { config: s.file }, s.io);
    expect(s.config().server.sheetsIngress.enabled).toBe(false);
  });

  it("check with nothing on says so; with a down listener exits 1 and gives the restart fix", async () => {
    const s = setup({});
    expect(await runCli(["expose", "check"], { config: s.file }, s.io)).toBe(0);
    expect(s.text()).toMatch(/nothing to check/);
    await runCli(["expose", "alerts"], flags(s, { provider: "cloudflare", host: "hooks.example.com", port: "14999" }), s.io);
    s.out.length = 0;
    const down = vi.fn(async () => {
      throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    });
    expect(await runCli(["expose", "check"], { config: s.file }, { ...s.io, transport: down })).toBe(1);
    expect(s.text()).toMatch(/Nothing answered on 127\.0\.0\.1:14999/);
    expect(s.text()).toMatch(/Restart the Bridge/);
  });

  it("check asks before a public call when interactive, and makes none on a no", async () => {
    const s = setup({});
    await runCli(["expose", "alerts"], flags(s, { provider: "cloudflare", host: "hooks.example.com" }), s.io);
    const transport = vi.fn(async (o) => ({ status: 404, headers: { "x-request-id": "r", "content-type": "application/problem+json" }, text: o.headers?.host === "hooks.example.com" ? "{}" : "{}" }));
    const lookup = vi.fn();
    const asked = [];
    const io = { ...s.io, interactive: true, prompt: async (q) => (asked.push(q), "n"), transport, lookup };
    await runCli(["expose", "check"], { config: s.file, "public-url": "https://hooks.example.com" }, io);
    expect(asked[0]).toMatch(/look up its name and send three small requests/);
    expect(lookup).not.toHaveBeenCalled();
    expect(transport.mock.calls.every(([o]) => o.host === "127.0.0.1")).toBe(true);
  });

  it("an unknown subcommand is a plain error", async () => {
    const s = setup({});
    expect(await runCli(["expose", "banana"], { config: s.file }, s.io)).toBe(1);
    expect(s.err.join("\n")).toMatch(/Unknown expose command/);
  });
});

describe("mc-bridge doctor: exposure checks and --strict", () => {
  const unsafe = { server: { allowNonLoopback: true, publicIngress: { enabled: true, host: "0.0.0.0", allowedHosts: ["hooks.example.com"] } } };

  it("prints a BLOCK line with its fix, and exits 0 without --strict", async () => {
    const s = setup(unsafe);
    expect(await runCli(["doctor"], { config: s.file, "no-port-check": true }, s.io)).toBe(0);
    const t = s.text();
    expect(t).toMatch(/^BLOCK {1,2}expose-alerts-open/m);
    expect(t).toMatch(/Fix: Set server\.publicIngress\.host to 127\.0\.0\.1/);
  });

  it("--strict exits 1 for a blocking exposure problem, and 0 when there is none", async () => {
    const s = setup(unsafe);
    expect(await runCli(["doctor"], { config: s.file, "no-port-check": true, strict: true }, s.io)).toBe(1);
    const ok = setup({});
    expect(await runCli(["doctor"], { config: ok.file, "no-port-check": true, strict: true }, ok.io)).toBe(0);
    const warnOnly = setup({ server: { publicIngress: { enabled: true, allowedHosts: ["hooks.example.com"] } } });
    expect(await runCli(["doctor"], { config: warnOnly.file, "no-port-check": true, strict: true }, warnOnly.io)).toBe(0);
  });

  it("--json carries severity and fix", async () => {
    const s = setup(unsafe);
    await runCli(["doctor"], { config: s.file, "no-port-check": true, json: true }, s.io);
    const rows = JSON.parse(s.out.join("\n"));
    const row = rows.find((r) => r.check === "expose-alerts-open");
    expect(row).toMatchObject({ level: "warn", blocking: true });
    expect(row.fix).toBeTruthy();
  });

  it("INT-07: doctor warns about a host name on the main listener, and --strict fails with live trading on", async () => {
    const mk = (extra) => loadConfig({ raw: { dataDir: join(mkdtempSync(join(tmpdir(), "mcb-exdoc2-")), "data"), server: { allowedHosts: ["hooks.example.com"] }, ...extra }, env: {} }).config;
    const checks = await runDoctor({ config: mk({}), env: {}, portCheck: false });
    expect(checks.find((c) => c.check === "expose-main-tunnel")).toMatchObject({ level: "warn" });
    const liveCfg = mk({ safety: { liveTrading: true }, accounts: [{ id: "dhan-main", broker: "dhan", live: { enabled: true, allowedSources: ["rest"], registeredIp: "203.0.113.10" } }] });
    const s = setup({ dataDir: liveCfg.dataDir, server: { allowedHosts: ["hooks.example.com"] }, safety: { liveTrading: true }, accounts: [{ id: "dhan-main", broker: "dhan", live: { enabled: true, allowedSources: ["rest"], registeredIp: "203.0.113.10" } }] });
    expect(await runCli(["doctor"], { config: s.file, strict: true, "no-port-check": true }, s.io)).toBe(1);
    expect(s.text()).toMatch(/BLOCK\s+expose-main-tunnel/);
    const plain = setup({ dataDir: liveCfg.dataDir, server: { allowedHosts: ["hooks.example.com"] } });
    expect(await runCli(["doctor"], { config: plain.file, strict: true, "no-port-check": true }, plain.io)).toBe(0);
    expect(plain.text()).toMatch(/WARN\s+expose-main-tunnel/);
  });

  it("INT-14: a fresh data folder gets one master-key warning, not a second one about a key that does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-exdoc3-"));
    const { config } = loadConfig({ raw: { dataDir: join(dir, "data") }, env: {} });
    const fresh = (await runDoctor({ config, env: {}, portCheck: false })).filter((c) => c.check === "master-key");
    expect(fresh.map((c) => c.message)).toEqual([expect.stringMatching(/^No master key yet/)]);
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "master.key"), "k".repeat(44), { mode: 0o600 });
    const there = (await runDoctor({ config, env: {}, portCheck: false })).filter((c) => c.check === "master-key");
    expect(there.map((c) => c.message).join("\n")).toMatch(/The master key sits in the data folder next to secrets\.enc/);
    expect(there.map((c) => c.message).join("\n")).not.toMatch(/No master key yet/);
  });

  it("runDoctor reads the hooks of the data folder: a live hook without confirmation is flagged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-exdoc-"));
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "hooks.json"), JSON.stringify({ version: 1, hooks: [{ id: "hk_abcdefghijkl", source: "gocharting", label: "live one", account: "dhan-main", mode: "live", requireConfirmation: false, allowedSymbols: [], maxLotsPerSignal: 1, product: "INTRADAY", orderType: "LIMIT", allowSourceIps: [], side: null, acknowledgeUnsignedLive: true, tokenHash: "b".repeat(64), createdAt: "2026-11-01T00:00:00+05:30", lastSignalAt: null }] }));
    const { config } = loadConfig({ raw: { dataDir: join(dir, "data"), safety: { liveTrading: true }, accounts: [{ id: "dhan-main", broker: "dhan", live: { enabled: true, allowedSources: ["rest", "webhook"], registeredIp: "203.0.113.10" } }], server: { publicIngress: { enabled: true, allowedHosts: ["hooks.example.com"] } }, hooks: { clientIpHeader: "cf-connecting-ip" } }, env: {} });
    const checks = await runDoctor({ config, env: {}, portCheck: false });
    const live = checks.find((c) => c.check === "expose-alerts" || c.check === "expose-live-alerts");
    expect(checks.find((c) => c.check === "expose-live-alerts")).toMatchObject({ level: "warn", blocking: true });
    expect(live).toBeTruthy();
  });
});
