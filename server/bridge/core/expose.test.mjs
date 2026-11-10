import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.mjs";
import {
  PROVIDER_IDS,
  PROVIDERS,
  TRADINGVIEW_SENDER_IPS,
  applyPlan,
  connectionSheet,
  defaultTransport,
  exposureChecks,
  exposureState,
  formatSelfCheck,
  isPrivateAddress,
  normaliseHost,
  planExpose,
  planOff,
  providerSteps,
  runSelfCheck,
  writeExposeConfig,
} from "./expose.mjs";

const cfg = (raw = {}) => loadConfig({ raw: { dataDir: mkdtempSync(join(tmpdir(), "mcb-ex-")), ...raw }, env: {} }).config;
const ids = (checks) => checks.filter((c) => c.level === "warn").map((c) => c.check);
const find = (checks, id) => checks.find((c) => c.check === id);

describe("normaliseHost", () => {
  it("reduces what a person pastes to a bare lower-case host", () => {
    expect(normaliseHost("https://Hooks.Example.com/hooks/x?y=1")).toBe("hooks.example.com");
    expect(normaliseHost(" hooks.example.com:443 ")).toBe("hooks.example.com");
    expect(normaliseHost("203.0.113.9")).toBe("203.0.113.9");
  });
  it("refuses wildcards, spaces and nothing", () => {
    expect(() => normaliseHost("*.example.com")).toThrow(/wildcard/);
    expect(() => normaliseHost("hooks example.com")).toThrow(/not a host name/);
    expect(() => normaliseHost("")).toThrow(/public host name/);
    expect(() => normaliseHost("-bad-.example.com")).toThrow(/not a host name/);
  });
});

describe("planExpose", () => {
  it("plans alerts through a named Cloudflare tunnel: loopback bind, own host list, the Cloudflare header, TradingView list", () => {
    const plan = planExpose({ integration: "alerts", provider: "cloudflare", host: "hooks.example.com", allowIps: true });
    expect(plan).toMatchObject({ listenerKey: "publicIngress", bind: "127.0.0.1", port: 4301, clientIpHeader: "cf-connecting-ip", allowNonLoopback: false, restartRequired: true });
    expect(plan.allowIps).toEqual([...TRADINGVIEW_SENDER_IPS]);
  });
  it("plans Sheets on its own port and listener, with no sender header", () => {
    const plan = planExpose({ integration: "sheets", provider: "ngrok", host: "sheet.example.com" });
    expect(plan).toMatchObject({ listenerKey: "sheetsIngress", port: 4302, clientIpHeader: null, allowIps: [] });
  });
  it("refuses Sheets over a port forward and a port forward without the allowlist", () => {
    expect(() => planExpose({ integration: "sheets", provider: "port-forward", host: "x.example.com" })).toThrow(/Sheets is not offered over a plain port forward/);
    expect(() => planExpose({ integration: "alerts", provider: "port-forward", host: "x.example.com" })).toThrow(/needs the sender allowlist/);
    const ok = planExpose({ integration: "alerts", provider: "port-forward", host: "x.example.com", allowIps: true });
    expect(ok).toMatchObject({ bind: "0.0.0.0", allowNonLoopback: true });
    expect(ok.warnings.join(" ")).toMatch(/no HTTPS/);
  });
  it("rejects an unknown provider, integration or port", () => {
    expect(() => planExpose({ integration: "alerts", provider: "teleport", host: "a.example.com" })).toThrow(/Unknown provider/);
    expect(() => planExpose({ integration: "orders", provider: "ngrok", host: "a.example.com" })).toThrow(/Choose what to expose/);
    expect(() => planExpose({ integration: "alerts", provider: "ngrok", host: "a.example.com", port: 70000 })).toThrow(/port/);
  });
  it("warns that the allowlist covers every webhook and that quick tunnels change", () => {
    const plan = planExpose({ integration: "alerts", provider: "cloudflare-quick", host: "abc-def.trycloudflare.com", allowIps: true });
    expect(plan.warnings.join(" ")).toMatch(/every webhook/);
    expect(plan.warnings.join(" ")).toMatch(/new address every time/);
  });
  it("every provider has exact steps and a label, and ngrok's header is marked unverified", () => {
    for (const id of PROVIDER_IDS) {
      const plan = planExpose({ integration: "alerts", provider: id, host: "hooks.example.com", allowIps: true });
      expect(providerSteps(plan).length, id).toBeGreaterThan(0);
      expect(PROVIDERS[id].label).toBeTruthy();
    }
    expect(PROVIDERS.ngrok.headerVerified).toBe(true);
    expect(PROVIDERS.cloudflare.headerVerified).toBe(false);
    expect(providerSteps(planExpose({ integration: "alerts", provider: "ngrok", host: "a.ngrok.dev" }))).toEqual(["ngrok http 4301 --url https://a.ngrok.dev"]);
  });
  it("tells the person what to paste", () => {
    const sheet = connectionSheet(planExpose({ integration: "sheets", provider: "cloudflare", host: "sheet.example.com" }));
    expect(sheet.lines.join("\n")).toMatch(/BRIDGE_URL:\s+https:\/\/sheet\.example\.com/);
    const alerts = connectionSheet(planExpose({ integration: "alerts", provider: "cloudflare", host: "hooks.example.com" }));
    expect(alerts.urlPattern).toBe("https://hooks.example.com/hooks/<source>/<token>");
  });
});

describe("applyPlan and writeExposeConfig", () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), "mcb-exw-")), "bridge.config.json");
  const alerts = planExpose({ integration: "alerts", provider: "cloudflare", host: "hooks.example.com", allowIps: true });

  it("changes only the keys it owns and keeps everything else", () => {
    const raw = { dataDir: "data", accounts: [{ id: "dhan-main", broker: "dhan" }], server: { port: 4300, allowedHosts: ["mine.example"], publicIngress: { enabled: false, port: 4999 } }, hooks: { maxHooks: 5 } };
    const out = applyPlan(raw, alerts);
    expect(out.accounts).toEqual(raw.accounts);
    expect(out.server.port).toBe(4300);
    expect(out.server.allowedHosts).toEqual(["mine.example"]); // the main listener's list is never touched
    expect(out.server.publicIngress).toEqual({ enabled: true, host: "127.0.0.1", port: 4301, allowedHosts: ["hooks.example.com"] });
    expect(out.hooks).toMatchObject({ maxHooks: 5, clientIpHeader: "cf-connecting-ip", allowSourceIps: [...TRADINGVIEW_SENDER_IPS] });
    expect(raw.server.publicIngress.enabled).toBe(false); // the input is a copy
  });

  it("replaces the old hosts of the listener (a changed tunnel does not leave a stale host behind)", () => {
    const out = applyPlan({ server: { publicIngress: { enabled: true, allowedHosts: ["old.trycloudflare.com"] } } }, alerts);
    expect(out.server.publicIngress.allowedHosts).toEqual(["hooks.example.com"]);
  });

  it("writes a new file with mode 600, and the result loads", () => {
    const file = tmp();
    const res = writeExposeConfig({ file, plan: alerts });
    expect(res.backup).toBeNull();
    expect(res.restartRequired).toBe(true);
    expect(res.changes.some((c) => c.startsWith("server.publicIngress.enabled"))).toBe(true);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadConfig({ path: file, env: {} }).config.server.publicIngress.allowedHosts).toEqual(["hooks.example.com"]);
  });

  it("keeps a copy of the old file and is a no-op the second time", () => {
    const file = tmp();
    writeFileSync(file, JSON.stringify({ logging: { level: "warn" } }));
    const first = writeExposeConfig({ file, plan: alerts });
    expect(first.backup).toBe(`${file}.bak-expose`);
    expect(JSON.parse(readFileSync(first.backup, "utf8"))).toEqual({ logging: { level: "warn" } });
    const second = writeExposeConfig({ file, plan: alerts });
    expect(second.changes).toEqual([]);
    expect(second.restartRequired).toBe(false);
  });

  it("a dry run writes nothing", () => {
    const file = tmp();
    const res = writeExposeConfig({ file, plan: alerts, dryRun: true });
    expect(res.changes.length).toBeGreaterThan(0);
    expect(existsSync(file)).toBe(false);
  });

  it("writes nothing when the result would not load", () => {
    const file = tmp();
    const text = JSON.stringify({ server: { port: 4301 } });
    writeFileSync(file, text);
    expect(() => writeExposeConfig({ file, plan: alerts })).toThrow(/both 4301/);
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(existsSync(`${file}.bak-expose`)).toBe(false);
  });

  it("refuses a file that is not JSON, and leaves it alone", () => {
    const file = tmp();
    writeFileSync(file, "{ not json");
    expect(() => writeExposeConfig({ file, plan: alerts })).toThrow(/Nothing was changed/);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("a port forward needs and sets allowNonLoopback", () => {
    const pf = planExpose({ integration: "alerts", provider: "port-forward", host: "home.example.net", allowIps: true });
    const out = applyPlan({}, pf);
    expect(out.server).toMatchObject({ allowNonLoopback: true, publicIngress: { host: "0.0.0.0" } });
    expect(() => loadConfig({ raw: out, env: {} })).not.toThrow();
  });

  it("turns listeners off and leaves the rest", () => {
    const on = applyPlan(applyPlan({}, alerts), planExpose({ integration: "sheets", provider: "cloudflare", host: "s.example.com" }));
    const offAlerts = applyPlan(on, planOff("alerts"));
    expect(offAlerts.server.publicIngress.enabled).toBe(false);
    expect(offAlerts.server.sheetsIngress.enabled).toBe(true);
    const offAll = applyPlan(on, planOff());
    expect(offAll.server.sheetsIngress.enabled).toBe(false);
    expect(offAll.server.publicIngress.allowedHosts).toEqual(["hooks.example.com"]);
  });
});

describe("config rules for the new listener", () => {
  it("each listener needs its own port, and a non-loopback bind needs allowNonLoopback", () => {
    expect(() => cfg({ server: { port: 4300, publicIngress: { enabled: true, port: 4300 } } })).toThrow(/each listener needs its own port/);
    expect(() => cfg({ server: { sheetsIngress: { enabled: true, port: 4301 }, publicIngress: { enabled: true, port: 4301 } } })).toThrow(/each listener needs its own port/);
    expect(() => cfg({ server: { sheetsIngress: { enabled: true, host: "0.0.0.0" } } })).toThrow(/sheetsIngress\.host .* not a loopback/);
    const { warnings } = loadConfig({ raw: { dataDir: "x", server: { sheetsIngress: { enabled: true } } }, env: {} });
    expect(warnings.join(" ")).toMatch(/Sheets listener is on/);
  });
  it("is off by default", () => {
    expect(cfg().server.sheetsIngress).toMatchObject({ enabled: false, port: 4302, requestsPerMinute: 600 });
  });
});

describe("doctor exposure rules", () => {
  const live = { safety: { liveTrading: true }, accounts: [{ id: "dhan-main", broker: "dhan", live: { enabled: true, allowedSources: ["rest", "webhook"] } }] };
  const ingress = (extra = {}) => ({ server: { publicIngress: { enabled: true, allowedHosts: ["hooks.example.com"] }, ...extra.server }, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "server")) });

  it("says nothing is exposed on a default config", () => {
    const checks = exposureChecks(cfg());
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ level: "ok", check: "expose" });
  });

  it("a safe tunnel setup has no warnings", () => {
    const checks = exposureChecks(cfg({ ...ingress(), hooks: { clientIpHeader: "cf-connecting-ip", allowSourceIps: [...TRADINGVIEW_SENDER_IPS] } }));
    expect(ids(checks)).toEqual([]);
    expect(checks[0].message).toMatch(/set up safely/);
  });

  it("flags an API bound beyond this computer, blocking when live trading or a public listener is on", () => {
    const plain = exposureChecks(cfg({ server: { host: "0.0.0.0", allowNonLoopback: true } }));
    expect(find(plain, "expose-bind")).toMatchObject({ level: "warn" });
    expect(find(plain, "expose-bind").blocking).toBeUndefined();
    expect(find(plain, "expose-bind").fix).toMatch(/127\.0\.0\.1/);
    const liveBound = exposureChecks(cfg({ ...live, server: { host: "0.0.0.0", allowNonLoopback: true } }));
    expect(find(liveBound, "expose-bind").blocking).toBe(true);
  });

  it("flags remoteDashboard outside demo as blocking, and inside demo as a note", () => {
    const outside = exposureChecks({ ...cfg(), server: { ...cfg().server, remoteDashboard: true } });
    expect(find(outside, "expose-dashboard")).toMatchObject({ level: "warn", blocking: true });
    const demo = exposureChecks({ ...cfg(), demo: true, server: { ...cfg().server, remoteDashboard: true } });
    expect(find(demo, "expose-dashboard").blocking).toBeUndefined();
  });

  it("flags the alerts listener bound to every interface: blocking without an allowlist, a warning with one", () => {
    const open = exposureChecks(cfg({ server: { allowNonLoopback: true, publicIngress: { enabled: true, host: "0.0.0.0", allowedHosts: ["h.example.com"] } } }));
    expect(find(open, "expose-alerts-open")).toMatchObject({ blocking: true });
    const listed = exposureChecks(cfg({ server: { allowNonLoopback: true, publicIngress: { enabled: true, host: "0.0.0.0", allowedHosts: ["h.example.com"] } }, hooks: { allowSourceIps: ["52.89.214.238"] } }));
    expect(find(listed, "expose-alerts-open").blocking).toBeUndefined();
    expect(find(listed, "expose-alerts-open").level).toBe("warn");
  });

  it("flags the Sheets listener bound to every interface as blocking (it has no sender list)", () => {
    const open = exposureChecks(cfg({ server: { allowNonLoopback: true, sheetsIngress: { enabled: true, host: "0.0.0.0", allowedHosts: ["s.example.com"] } } }));
    expect(find(open, "expose-sheets-open")).toMatchObject({ blocking: true });
  });

  it("flags a missing clientIpHeader behind a local tunnel, and says every alert is refused when an allowlist is set", () => {
    const none = exposureChecks(cfg(ingress()));
    expect(find(none, "expose-client-ip").message).toMatch(/every call looks like it comes from 127\.0\.0\.1/);
    const withList = exposureChecks(cfg({ ...ingress(), hooks: { allowSourceIps: ["52.89.214.238"] } }));
    expect(find(withList, "expose-client-ip").message).toMatch(/refuses them all/);
    const fixed = exposureChecks(cfg({ ...ingress(), hooks: { clientIpHeader: "cf-connecting-ip" } }));
    expect(find(fixed, "expose-client-ip")).toBeUndefined();
  });

  it("flags wildcard and malformed hosts and an empty host list", () => {
    const w = exposureChecks(cfg({ server: { publicIngress: { enabled: true, allowedHosts: ["*.trycloudflare.com", "https://x.example.com/"] } } }));
    expect(find(w, "expose-alerts-wildcard").message).toMatch(/\*\.trycloudflare\.com/);
    const empty = exposureChecks(cfg({ server: { publicIngress: { enabled: true } } }));
    expect(find(empty, "expose-alerts-hosts").fix).toMatch(/mc-bridge expose alerts/);
    const main = exposureChecks(cfg({ server: { allowedHosts: ["*"] } }));
    expect(find(main, "expose-main-wildcard")).toBeTruthy();
  });

  it("flags a tunnel host that is also allowed on the main listener", () => {
    const checks = exposureChecks(cfg({ ...live, server: { allowedHosts: ["hooks.example.com"], publicIngress: { enabled: true, allowedHosts: ["hooks.example.com"] } }, hooks: { clientIpHeader: "cf-connecting-ip" } }));
    expect(find(checks, "expose-alerts-shared-host")).toMatchObject({ level: "warn", blocking: true });
  });

  it("INT-07: a real host name on the main listener warns (a tunnel could be pointed at the API port), blocking with live trading", () => {
    const only = exposureChecks(cfg({ server: { allowedHosts: ["hooks.example.com"] } }));
    expect(find(only, "expose-main-tunnel")).toMatchObject({ level: "warn" });
    expect(find(only, "expose-main-tunnel").blocking).toBeUndefined();
    expect(find(only, "expose-main-tunnel").message).toMatch(/hooks\.example\.com/);
    expect(find(only, "expose-main-tunnel").fix).toMatch(/Sheets or alerts listener/);
    expect(find(exposureChecks(cfg({ ...live, server: { allowedHosts: ["hooks.example.com"] } })), "expose-main-tunnel").blocking).toBe(true);
    // loopback names, wildcards (their own warning) and names already covered by the shared-host warning say nothing more
    expect(find(exposureChecks(cfg({ server: { allowedHosts: ["localhost", "127.0.0.1"] } })), "expose-main-tunnel")).toBeUndefined();
    expect(find(exposureChecks(cfg({ server: { allowedHosts: ["*"] } })), "expose-main-tunnel")).toBeUndefined();
    const shared = exposureChecks(cfg({ ...live, server: { allowedHosts: ["hooks.example.com"], publicIngress: { enabled: true, allowedHosts: ["hooks.example.com"] } }, hooks: { clientIpHeader: "cf-connecting-ip" } }));
    expect(find(shared, "expose-main-tunnel")).toBeUndefined();
    expect(find(shared, "expose-alerts-shared-host")).toBeTruthy();
  });

  it("flags live webhooks without confirmation: blocking when there is also no allowlist", () => {
    const base = { ...live, ...ingress(), hooks: { clientIpHeader: "cf-connecting-ip" } };
    const bad = exposureChecks(cfg(base), { hooks: [{ source: "gocharting", mode: "live", requireConfirmation: false, allowSourceIps: [] }] });
    expect(find(bad, "expose-live-alerts")).toMatchObject({ level: "warn", blocking: true });
    const listed = exposureChecks(cfg({ ...base, hooks: { clientIpHeader: "cf-connecting-ip", allowSourceIps: ["52.89.214.238"] } }), { hooks: [{ source: "gocharting", mode: "live", requireConfirmation: false, allowSourceIps: [] }] });
    expect(find(listed, "expose-live-alerts").blocking).toBeUndefined();
    const confirmed = exposureChecks(cfg(base), { hooks: [{ source: "gocharting", mode: "live", requireConfirmation: true, allowSourceIps: [] }] });
    expect(find(confirmed, "expose-live-alerts")).toBeUndefined();
  });

  it("flags a missing registered static IP when live trading and a public listener are both on", () => {
    const missing = exposureChecks(cfg({ ...live, ...ingress(), hooks: { clientIpHeader: "cf-connecting-ip" } }));
    expect(find(missing, "expose-static-ip").message).toMatch(/dhan-main/);
    const set = exposureChecks(cfg({ safety: { liveTrading: true }, accounts: [{ id: "dhan-main", broker: "dhan", live: { enabled: true, registeredIp: "203.0.113.10" } }], ...ingress(), hooks: { clientIpHeader: "cf-connecting-ip" } }));
    expect(find(set, "expose-static-ip")).toBeUndefined();
  });

  it("flags long-lived URL keys when the Sheets listener is on", () => {
    const c = cfg({ server: { sheetsIngress: { enabled: true, allowedHosts: ["s.example.com"] } } });
    const now = Date.parse("2026-11-09T00:00:00Z");
    const keys = [
      { id: "mcb_a", allowQuery: true, expiresAt: null },
      { id: "mcb_b", allowQuery: true, expiresAt: "2026-12-01T00:00:00Z" },
      { id: "mcb_c", allowQuery: true, expiresAt: "2028-01-01T00:00:00Z" },
      { id: "mcb_d", allowQuery: false, expiresAt: null },
      { id: "mcb_e", allowQuery: true, expiresAt: null, revokedAt: "2026-11-01T00:00:00Z" },
    ];
    const msg = find(exposureChecks(c, { keys, now }), "expose-url-keys").message;
    expect(msg).toMatch(/mcb_a/);
    expect(msg).toMatch(/mcb_c/);
    expect(msg).not.toMatch(/mcb_b|mcb_d|mcb_e/);
    expect(find(exposureChecks(cfg(), { keys, now }), "expose-url-keys")).toBeUndefined();
  });

  it("every warning carries a one-line fix", () => {
    const bad = cfg({ ...live, server: { allowNonLoopback: true, host: "0.0.0.0", allowedHosts: ["h.example.com"], publicIngress: { enabled: true, host: "0.0.0.0", allowedHosts: ["h.example.com", "*"] }, sheetsIngress: { enabled: true, host: "0.0.0.0" } } });
    const warns = exposureChecks(bad, { hooks: [{ mode: "live", requireConfirmation: false }] }).filter((c) => c.level === "warn");
    expect(warns.length).toBeGreaterThan(6);
    for (const w of warns) {
      expect(w.fix, w.check).toBeTruthy();
      expect(w.fix).not.toMatch(/\n/);
    }
  });
});

describe("exposureState", () => {
  it("not exposed, on, and unsafe in words", () => {
    expect(exposureState(cfg())).toMatchObject({ state: "off", tone: "ok", headline: expect.stringMatching(/Nothing on this computer/) });
    const on = exposureState(cfg({ server: { publicIngress: { enabled: true, allowedHosts: ["hooks.example.com"] } }, hooks: { clientIpHeader: "cf-connecting-ip", allowSourceIps: ["52.89.214.238"] } }));
    expect(on).toMatchObject({ state: "on", exposed: ["alerts"], tone: "ok" });
    expect(on.headline).toMatch(/Alerts can reach this Bridge at hooks\.example\.com/);
    expect(on.alerts.urlPattern).toBe("https://hooks.example.com/hooks/<source>/<token>");
    const bad = exposureState(cfg({ server: { allowNonLoopback: true, publicIngress: { enabled: true, host: "0.0.0.0", allowedHosts: ["h.example.com"] } } }));
    expect(bad.tone).toBe("bad");
  });
});

// ── The self-check, against a fake ingress and fake DNS ──

/** A fake listener that behaves like a correct public listener; `leak` makes one route answer 200. */
function fakeListener({ kind, port, leak = null, acceptAnyHost = false, hostsOk = ["127.0.0.1"], noOriginCheck = false, noBodyCap = false, down = false }) {
  const calls = [];
  const bridgeHeaders = { "x-request-id": "req_fake00001", "content-type": "application/problem+json; charset=utf-8" };
  const fn = vi.fn(async (o) => {
    calls.push(o);
    if (down) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const host = String(o.headers?.host ?? "").replace(/:\d+$/, "");
    const reply = (status, code) => ({ status, headers: bridgeHeaders, text: JSON.stringify({ code }) });
    if (!acceptAnyHost && !hostsOk.includes(host)) return reply(403, "HOST_NOT_ALLOWED");
    if (o.headers?.origin && !noOriginCheck) return reply(403, "ORIGIN_NOT_ALLOWED");
    const path = o.path.split("?")[0];
    if (leak && `${o.method} ${path}` === leak) return { status: 200, headers: { "content-type": "text/html" }, text: "<html>" };
    if (kind === "alerts") {
      if (o.method === "POST" && path.startsWith("/hooks/generic/")) return String(o.body ?? "").length > 16_384 && !noBodyCap ? reply(413, "PAYLOAD_TOO_LARGE") : reply(404, "NOT_FOUND");
    } else if (o.method === "GET" && path === "/xl/ltp") return reply(401, "UNAUTHENTICATED");
    return reply(404, "NOT_FOUND");
  });
  fn.calls = calls;
  return fn;
}

describe("runSelfCheck (fake ingress)", () => {
  const alertsCfg = () => cfg({ server: { publicIngress: { enabled: true, port: 14111, allowedHosts: ["hooks.example.com"] } } });
  const sheetsCfg = () => cfg({ server: { sheetsIngress: { enabled: true, port: 14112, allowedHosts: ["sheet.example.com"] } } });

  it("a correct alerts listener passes every local check and makes no name lookup", async () => {
    const request = fakeListener({ kind: "alerts" });
    const lookup = vi.fn();
    const r = await runSelfCheck({ config: alertsCfg(), request, lookup });
    expect(r.verdict).toBe("good");
    expect(r.items.map((i) => i.id)).toEqual(["alerts-answers", "alerts-hides-rest", "alerts-host-refused", "alerts-origin-refused", "alerts-body-cap"]);
    expect(r.items.every((i) => i.status === "pass")).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
    // every probe went to this computer, on the listener's own port
    expect(request.calls.every((c) => c.host === "127.0.0.1" && c.port === 14111)).toBe(true);
  });

  it("a correct Sheets listener passes, and writes and webhook paths are probed too", async () => {
    const request = fakeListener({ kind: "sheets" });
    const r = await runSelfCheck({ config: sheetsCfg(), request });
    expect(r.verdict).toBe("good");
    const seen = request.calls.map((c) => `${c.method} ${c.path.split("?")[0]}`);
    expect(seen).toContain("POST /xl/ltp");
    expect(seen).toContain("GET /dashboard");
    expect(seen.some((s) => s.startsWith("POST /hooks/generic/"))).toBe(true);
  });

  it("the dashboard answering on the ingress port is UNSAFE and says to turn the tunnel off", async () => {
    const r = await runSelfCheck({ config: alertsCfg(), request: fakeListener({ kind: "alerts", leak: "GET /dashboard" }) });
    expect(r.verdict).toBe("unsafe");
    const item = r.items.find((i) => i.id === "alerts-hides-rest");
    expect(item).toMatchObject({ status: "fail", severity: "blocking" });
    expect(item.detail).toMatch(/GET \/dashboard -> 200/);
    expect(item.fix).toMatch(/Turn the tunnel off now/);
  });

  it("an admin route answering is unsafe", async () => {
    const r = await runSelfCheck({ config: alertsCfg(), request: fakeListener({ kind: "alerts", leak: "GET /v1/keys" }) });
    expect(r.verdict).toBe("unsafe");
  });

  it("a catch-all host (a foreign Host header accepted) is unsafe", async () => {
    const r = await runSelfCheck({ config: alertsCfg(), request: fakeListener({ kind: "alerts", acceptAnyHost: true }) });
    expect(r.items.find((i) => i.id === "alerts-host-refused")).toMatchObject({ status: "fail", severity: "blocking" });
    expect(r.verdict).toBe("unsafe");
  });

  it("a missing origin rule is unsafe; a missing body cap is a note", async () => {
    const o = await runSelfCheck({ config: alertsCfg(), request: fakeListener({ kind: "alerts", noOriginCheck: true }) });
    expect(o.items.find((i) => i.id === "alerts-origin-refused").status).toBe("fail");
    expect(o.verdict).toBe("unsafe");
    const b = await runSelfCheck({ config: alertsCfg(), request: fakeListener({ kind: "alerts", noBodyCap: true }) });
    expect(b.items.find((i) => i.id === "alerts-body-cap")).toMatchObject({ status: "fail", severity: "note" });
    expect(b.verdict).toBe("notes");
  });

  it("nothing listening is 'not working' with the restart sentence, not 'unsafe'", async () => {
    const r = await runSelfCheck({ config: alertsCfg(), request: fakeListener({ kind: "alerts", down: true }) });
    expect(r.verdict).toBe("not_working");
    expect(r.items).toHaveLength(1);
    expect(r.items[0].fix).toMatch(/Restart the Bridge/);
  });

  it("with no public listener there is nothing to check", async () => {
    const request = vi.fn();
    const r = await runSelfCheck({ config: cfg(), request });
    expect(r.verdict).toBe("not_exposed");
    expect(request).not.toHaveBeenCalled();
  });

  it("explicit kinds check a listener that is off in the config (reports it as not answering)", async () => {
    const r = await runSelfCheck({ config: cfg(), kinds: ["sheets"], request: fakeListener({ kind: "sheets", down: true }) });
    expect(r.verdict).toBe("not_working");
    expect(r.items[0].fix).toMatch(/mc-bridge expose sheets/);
  });

  it("formats as plain lines with the fix under each failure", async () => {
    const r = await runSelfCheck({ config: alertsCfg(), request: fakeListener({ kind: "alerts", leak: "GET /dashboard" }) });
    const text = formatSelfCheck(r);
    expect(text).toMatch(/^FAIL {2}Alerts listener does not serve the dashboard or the API/m);
    expect(text).toMatch(/Fix: Turn the tunnel off now/);
    expect(text).toMatch(/Unsafe: turn the tunnel off/);
  });
});

describe("runSelfCheck: the public address (fake transport and fake DNS)", () => {
  const config = () => cfg({ server: { publicIngress: { enabled: true, port: 14111, allowedHosts: ["hooks.example.com"] } } });
  /** Routes by Host/port: the local probes get a correct listener, the public ones get `publicReply`. */
  const split = (publicReply) => {
    const local = fakeListener({ kind: "alerts", port: 14111 });
    const calls = [];
    const fn = async (o) => {
      calls.push(o);
      if (o.host === "127.0.0.1") return local(o);
      return typeof publicReply === "function" ? publicReply(o) : publicReply;
    };
    fn.calls = calls;
    return fn;
  };
  const bridge404 = { status: 404, headers: { "x-request-id": "req_fake00002", "content-type": "application/problem+json" }, text: JSON.stringify({ code: "NOT_FOUND" }) };

  it("without allowOutbound nothing is looked up or called, and the item says so", async () => {
    const lookup = vi.fn();
    const request = split(bridge404);
    const r = await runSelfCheck({ config: config(), request, lookup, publicUrl: "https://hooks.example.com", allowOutbound: false });
    expect(lookup).not.toHaveBeenCalled();
    expect(request.calls.some((c) => c.host !== "127.0.0.1")).toBe(false);
    expect(r.items.find((i) => i.id === "public-url")).toMatchObject({ status: "skipped" });
  });

  it("a working tunnel: resolves, reaches the Bridge, dashboard hidden", async () => {
    const lookup = vi.fn(async () => [{ address: "104.16.0.1", family: 4 }]);
    const request = split(bridge404);
    const r = await runSelfCheck({ config: config(), request, lookup, publicUrl: "https://hooks.example.com", allowOutbound: true });
    expect(lookup).toHaveBeenCalledWith("hooks.example.com");
    expect(r.verdict).toBe("good");
    expect(r.items.filter((i) => i.id.startsWith("public")).every((i) => i.status === "pass")).toBe(true);
    const publicCalls = request.calls.filter((c) => c.host !== "127.0.0.1");
    expect(publicCalls[0]).toMatchObject({ protocol: "https:", host: "hooks.example.com", port: 443, method: "POST" });
  });

  it("the Bridge refusing the host name gives the allowedHosts fix", async () => {
    const r = await runSelfCheck({
      config: config(),
      request: split({ status: 403, headers: { "x-request-id": "req_fake00003", "content-type": "application/problem+json" }, text: JSON.stringify({ code: "HOST_NOT_ALLOWED" }) }),
      lookup: async () => [{ address: "104.16.0.1" }],
      publicUrl: "https://hooks.example.com",
      allowOutbound: true,
    });
    const item = r.items.find((i) => i.id === "public-reach");
    expect(item.status).toBe("fail");
    expect(item.fix).toMatch(/allowedHosts/);
    expect(r.verdict).toBe("not_working");
  });

  it("a tunnel that is down (a 502 from the tunnel's own page, not the Bridge) is not working", async () => {
    const r = await runSelfCheck({ config: config(), request: split({ status: 502, headers: { "content-type": "text/html" }, text: "Bad gateway" }), lookup: async () => [{ address: "104.16.0.1" }], publicUrl: "https://hooks.example.com", allowOutbound: true });
    const item = r.items.find((i) => i.id === "public-reach");
    expect(item.detail).toMatch(/not the Bridge/);
    expect(item.fix).toMatch(/points at the Bridge|cannot reach the Bridge/);
  });

  it("the dashboard answering through the public address is unsafe", async () => {
    const r = await runSelfCheck({
      config: config(),
      request: split((o) => (o.path === "/dashboard" ? { status: 200, headers: { "x-request-id": "req_fake00004", "content-type": "text/html" }, text: "<html>" } : bridge404)),
      lookup: async () => [{ address: "104.16.0.1" }],
      publicUrl: "https://hooks.example.com",
      allowOutbound: true,
    });
    expect(r.verdict).toBe("unsafe");
    expect(r.items.find((i) => i.id === "public-hides-rest").detail).toMatch(/GET \/dashboard -> 200/);
  });

  it("DNS that does not resolve, and a name that resolves to a private address", async () => {
    const gone = await runSelfCheck({ config: config(), request: split(bridge404), lookup: async () => { throw Object.assign(new Error("nope"), { code: "ENOTFOUND" }); }, publicUrl: "https://hooks.example.com", allowOutbound: true });
    expect(gone.items.find((i) => i.id === "public-dns")).toMatchObject({ status: "fail" });
    expect(gone.items.find((i) => i.id === "public-dns").detail).toMatch(/ENOTFOUND/);
    const priv = await runSelfCheck({ config: config(), request: split(bridge404), lookup: async () => [{ address: "192.168.1.20" }], publicUrl: "https://hooks.example.com", allowOutbound: true });
    expect(priv.items.find((i) => i.id === "public-dns")).toMatchObject({ status: "warn" });
  });

  it("a port TradingView cannot use, and a host that is not on the list", async () => {
    const r = await runSelfCheck({ config: config(), request: split(bridge404), lookup: async () => [{ address: "104.16.0.1" }], publicUrl: "https://other.example.com:8443", allowOutbound: true });
    expect(r.items.find((i) => i.id === "public-port")).toMatchObject({ status: "fail" });
    expect(r.items.find((i) => i.id === "public-port").detail).toMatch(/80 and 443/);
    expect(r.items.find((i) => i.id === "public-host-listed")).toMatchObject({ status: "fail" });
  });

  it("a certificate error is explained", async () => {
    const r = await runSelfCheck({ config: config(), request: split(() => { throw Object.assign(new Error("bad cert"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }); }), lookup: async () => [{ address: "104.16.0.1" }], publicUrl: "https://hooks.example.com", allowOutbound: true });
    expect(r.items.find((i) => i.id === "public-reach").fix).toMatch(/certificate/);
  });

  it("a malformed address fails without a call", async () => {
    const request = split(bridge404);
    const r = await runSelfCheck({ config: config(), request, publicUrl: "not a url", allowOutbound: true });
    expect(r.items.find((i) => i.id === "public-url")).toMatchObject({ status: "fail" });
    expect(request.calls.some((c) => c.host !== "127.0.0.1")).toBe(false);
  });
});

describe("helpers", () => {
  it("recognises private addresses", () => {
    for (const a of ["10.0.0.1", "127.0.0.1", "192.168.1.1", "172.20.1.1", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1"]) expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ["8.8.8.8", "172.32.0.1", "52.89.214.238", "2606:4700::1"]) expect(isPrivateAddress(a), a).toBe(false);
  });

  it("the real transport reads status, headers and a capped body from a loopback server, and rejects with a code when nothing listens", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(404, { "x-request-id": "r", "content-type": "application/json" });
      res.end(JSON.stringify({ code: "NOT_FOUND", host: req.headers.host }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    try {
      const res = await defaultTransport({ host: "127.0.0.1", port, method: "POST", path: "/x", headers: { host: "hooks.example.com" }, body: "{}" });
      expect(res.status).toBe(404);
      expect(res.headers["x-request-id"]).toBe("r");
      expect(JSON.parse(res.text).host).toBe("hooks.example.com");
    } finally {
      await new Promise((r) => server.close(r));
    }
    await expect(defaultTransport({ host: "127.0.0.1", port, path: "/", timeoutMs: 1000 })).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});
