/**
 * Facts the Docker, upgrading, Dhan and TradingView guides state, checked against the code and files they describe:
 * the compose file, the Dockerfile and the entrypoint; the messages the Bridge really prints on an upgrade and for a bad
 * settings file; the Dhan adapter and its limits; the messages and address list the hook code produces. A guide that drifts from
 * the thing it describes fails here. Also: every JSON settings example in the new guides is a valid configuration, every guide
 * is on the docs home, and each new guide is in the guides index.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootDemoBridge } from "../server/bridge/core/__fixtures__/demoBridge.mjs";
import { BUILTIN_MODULES } from "../server/bridge/core/builtinModules.mjs";
import { REMOVED_SETTINGS, coreSchema, loadConfig } from "../server/bridge/core/config.mjs";
import { applyModuleConfig } from "../server/bridge/core/modules.mjs";
import { ROOT, repoFiles } from "./lib/repo-files.mjs";

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const NEW_GUIDES = ["config", "data", "dhan", "docker", "orders", "tradingview", "upgrading"];

describe("the new guides are findable", () => {
  it("each one is in the guides index and on the docs home", () => {
    const index = read("docs/guides/README.md");
    const home = read("docs/README.md");
    for (const g of NEW_GUIDES) {
      expect(index, g).toContain(`| [${g}.md](${g}.md) |`);
      expect(home, g).toContain(`(guides/${g}.md)`);
    }
  });

  it("every guide in docs/guides is linked from the docs home (the home is complete)", () => {
    const home = read("docs/README.md");
    const guides = readdirSync(join(ROOT, "docs/guides")).filter((f) => f.endsWith(".md") && f !== "README.md");
    expect(guides.filter((g) => !home.includes(`guides/${g}`))).toEqual([]);
  });

  it("the docs home is organised by what a person wants to do", () => {
    const headings = [...read("docs/README.md").matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    for (const want of ["Trade on paper", "Connect a tool", "Receive events", "Save data", "Run it for weeks"]) expect(headings, want).toContain(want);
  });
});

describe("every JSON settings example in the new guides is a valid configuration", () => {
  const FENCE = /```json\n([\s\S]*?)```/g;
  for (const g of NEW_GUIDES.filter((x) => x !== "config")) {
    it(`${g}.md`, () => {
      let checked = 0;
      for (const m of read(`docs/guides/${g}.md`).matchAll(FENCE)) {
        let obj;
        try {
          obj = JSON.parse(m[1]);
        } catch {
          continue; // not JSON (a fragment with a comment): not a configuration example
        }
        if (obj && typeof obj === "object" && !Array.isArray(obj) && "broker" in obj) obj = { accounts: [obj] };
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
        const parsed = coreSchema.safeParse(obj);
        expect(parsed.success, `${g}.md: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
        expect(() => applyModuleConfig(parsed.data, BUILTIN_MODULES), `${g}.md: ${m[1].slice(0, 80)}`).not.toThrow();
        checked += 1;
      }
      if (["dhan", "tradingview"].includes(g)) expect(checked, g).toBeGreaterThan(0);
    });
  }
});

describe("docker.md matches the Dockerfile, the compose file and the entrypoint", () => {
  const guide = read("docs/guides/docker.md");
  const compose = read("docker-compose.yml");
  const docker = read("Dockerfile");
  const entry = read("docker/entrypoint.sh");

  it("the port is published on this computer only, and the guide says so", () => {
    expect(compose).toMatch(/"127\.0\.0\.1:4300:4300"/);
    expect(compose).not.toMatch(/"0\.0\.0\.0:/);
    expect(guide).toContain('"127.0.0.1:4300:4300"');
    expect(docker).toMatch(/EXPOSE 4300/);
  });

  it("the volumes, the hardening and the network are the ones the guide lists", () => {
    for (const x of ["bridge-data:/data", "bridge-secrets:/secrets", "read_only: true", "no-new-privileges:true", "cap_drop: [ALL]", "restart: unless-stopped", "172.31.240.0/24", "172.31.240.1", 'MCB_DEMO: "0"', "container_name: mc-bridge"]) {
      expect(compose, x).toContain(x);
    }
    for (const x of ["bridge-data:/data", "bridge-secrets:/secrets", "read_only: true", "cap_drop: [ALL]", "no-new-privileges", "172.31.240.0/24", "172.31.240.1", "restart: unless-stopped", "MCB_DEMO", "mc-bridge"]) {
      expect(guide, x).toContain(x);
    }
    expect(docker).toMatch(/FROM node:25-alpine@sha256:[0-9a-f]{64}/);
    expect(docker).toMatch(/USER node/);
    expect(docker).toMatch(/npm ci --omit=dev/);
    expect(docker).toMatch(/HEALTHCHECK[\s\S]*\/v1\/health/);
    expect(guide).toMatch(/node:25-alpine/);
  });

  it("the first start writes the settings with live trading off and prints the key once (entrypoint and init)", () => {
    expect(entry).toMatch(/init --yes --config/);
    expect(entry).toMatch(/printed once|shown once|admin key/);
    expect(docker).toMatch(/MCB_MASTER_KEY_FILE=\/secrets\/master\.key/);
    expect(docker).toMatch(/MCB_CONFIG=\/data\/bridge\.config\.json/);
    expect(guide).toContain("/data/bridge.config.json");
    expect(guide).toContain("/secrets/master.key");
  });

  it("the settings written in Docker use the gateway the compose file creates", async () => {
    const { DOCKER_LOCAL_PEERS, buildConfig } = await import("../server/bridge/core/init.mjs");
    expect(DOCKER_LOCAL_PEERS).toContain("172.31.240.1");
    expect(guide).toContain("192.168.65.0/24");
    const cfg = buildConfig({ example: JSON.parse(read("bridge.config.example.json")), accounts: [], masterKeyFile: "x", configDir: "/data", docker: true });
    expect(cfg.server.host).toBe("0.0.0.0");
    expect(cfg.server.allowNonLoopback).toBe(true);
    expect(cfg.server.localPeers).toEqual([...DOCKER_LOCAL_PEERS]);
    expect(cfg.safety.liveTrading).toBe(false);
  });

  it("the commands in the guide are ones the container has (the wrapper script and the entrypoint list)", () => {
    expect(docker).toMatch(/usr\/local\/bin\/mc-bridge/);
    expect(entry).toMatch(/start\|init\|setup\|doctor\|keys\|accounts\|kill\|mcp\|openai-tools/);
    for (const cmd of ["doctor", "keys create", "accounts connect", "kill", "backup", "restore"]) expect(guide, cmd).toContain(`mc-bridge ${cmd}`);
  });

  it("it does not claim a test or CI that builds the image (there is none)", () => {
    const ci = repoFiles().filter((f) => f.startsWith(".github/workflows/")).map(read).join("\n");
    expect(ci).not.toMatch(/docker (build|compose)/);
    expect(guide).toMatch(/Nothing in this repository's tests or CI builds and runs the image/);
  });
});

describe("upgrading.md quotes what the Bridge really says", () => {
  const guide = read("docs/guides/upgrading.md");
  const manager = read("server/bridge/backup/manager.mjs");
  const archive = read("server/bridge/backup/archive.mjs");

  it("the copy before an upgrade: the file name, the message and the warning", () => {
    expect(manager).toContain("Saved a copy of your data before this version runs");
    expect(guide).toContain("Saved a copy of your data before this version runs");
    expect(manager).toContain("Warning: no copy of your data was made before this version runs");
    expect(guide).toContain("Warning: no copy of your data was made before this version runs");
    expect(manager).toMatch(/kind: "upgrade"/);
    expect(guide).toContain("-upgrade.tar.gz");
    expect(manager).toContain("last-version.json");
    expect(guide).toContain("last-version.json");
  });

  it("an upgrade to a different version copies the data first and prints the line; the same version does not", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { createBackupManager } = await import("../server/bridge/backup/manager.mjs");
    const dir = mkdtempSync(join(tmpdir(), "mcb-upgrade-"));
    try {
      const dataDir = join(dir, "data");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, "keys.json"), "{}");
      const configFile = join(dir, "bridge.config.json");
      writeFileSync(configFile, "{}");
      const make = (version) => createBackupManager({ dataDir, configFile, config: { dataDir, backup: {} }, bridgeVersion: version, env: {} });
      const first = await make("2.0.0").snapshotBeforeStart();
      expect(first.took).toBe(true); // no last-version.json yet: a copy is made
      const again = await make("2.0.0").snapshotBeforeStart();
      expect(again).toMatchObject({ took: false, message: null });
      const up = await make("2.1.0").snapshotBeforeStart();
      expect(up.took).toBe(true);
      expect(up.message).toMatch(/^Saved a copy of your data before this version runs \(2\.0\.0 to 2\.1\.0\): .*-upgrade\.tar\.gz\. Restore it with: mc-bridge restore "/);
      expect(existsSync(up.path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restore refuses a backup from a newer version with the words the guide quotes", () => {
    expect(archive).toContain("which is newer than this one");
    expect(guide).toContain("which is newer than this one");
    expect(archive).toContain("Older programs can misread newer data. Install Bridge");
    expect(guide).toContain("Older programs can misread newer data. Install Bridge");
  });

  it("a removed setting is ignored with the note the guide shows, and never stops the start", () => {
    const warnings = [];
    const out = applyModuleConfig(coreSchema.parse({ alerts: {}, watchlists: [] }), BUILTIN_MODULES, warnings);
    expect(out.alerts).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/^Ignored settings that v2 no longer has: alerts: this setting was removed in v2 \(position alerts are not part of v2\); watchlists:/);
    expect(guide).toContain("Ignored settings that v2 no longer has: alerts: this setting was removed in v2 (position alerts are not part of v2); watchlists: this setting was removed in v2 (watchlists are not part of v2); stream.candles:");
    expect(Object.keys(REMOVED_SETTINGS)).toEqual(expect.arrayContaining(["alerts", "watchlists", "stream.candles"]));
  });

  it("a typo, an unknown section and an out-of-range value give the messages the guide shows", () => {
    const msg = (raw) => {
      try {
        const { config } = loadConfig({ raw, env: {} });
        applyModuleConfig(config, BUILTIN_MODULES);
        return null;
      } catch (e) {
        return e.message;
      }
    };
    expect(msg({ safety: { maxOrderValu: 5 } })).toBe('Config is not valid: safety: Unrecognized key: "maxOrderValu"');
    expect(msg({ fooo: 1 })).toBe('Unknown config section "fooo".');
    expect(msg({ stream: { heartbeatMs: 5 } })).toBe("Config is not valid: stream.heartbeatMs: Too small: expected number to be >=1000");
    expect(msg({ safety: { maxOrderValue: "x" } })).toBe("Config is not valid: safety.maxOrderValue: Invalid input: expected number, received string");
    for (const m of ['Config is not valid: safety: Unrecognized key: "maxOrderValu"', 'Unknown config section "fooo".', "Config is not valid: stream.heartbeatMs: Too small: expected number to be >=1000", "Config is not valid: safety.maxOrderValue: Invalid input: expected number, received string"]) {
      expect(guide, m).toContain(m);
    }
  });

  it("the other settings it names exist", () => {
    for (const name of ["backup.keep", "backup.maxSizeMb", "market.chain.ivModelDefault", "server.port"]) expect(guide, name).toContain(name);
    expect(read("docs/API-DEPRECATIONS.md")).toMatch(/1 May 2027/);
    expect(guide).toContain("1 May 2027");
  });
});

describe("dhan.md matches the Dhan adapter and the policy table", () => {
  const guide = read("docs/guides/dhan.md");

  it("the login fields, the verification level and the intervals", async () => {
    const dhan = await import("../server/brokers/dhan.mjs");
    expect(dhan.credentialFields).toEqual(["clientId", "accessToken"]);
    expect(dhan.capabilities.auth.kind).toBe("apiKeyToken");
    expect(dhan.capabilities.historical.intervals).toEqual(["1m", "5m", "15m", "60m", "1d"]);
    expect(dhan.capabilities.historical.maxSpanDays["5m"]).toBe(90);
    for (const x of ["`clientId`", "`accessToken`", "`1m`", "`5m`", "`15m`", "`60m`", "`1d`", "90 days per call", "apiKeyToken"]) expect(guide, x).toContain(x);
    expect(Object.keys(dhan.INDEX_SECURITY_IDS)).toEqual(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"]);
    expect(guide).toContain("NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX, BANKEX");
  });

  it("Dhan is the only broker marked live-verified", () => {
    const v = JSON.parse(read("server/brokers/verification.json"));
    const live = Object.entries(v.brokers ?? v).filter(([, e]) => e?.level === "live-verified").map(([id]) => id);
    expect(live).toEqual(["dhan"]);
    expect(guide).toMatch(/the broker this project has checked end to end with a real account|checked end to end with a real account/);
    expect(guide).not.toMatch(/screenshot of|\.png|\.jpg/i);
  });

  it("the limits in the guide are the numbers in the policy table", async () => {
    const { BROKER_POLICIES } = await import("../server/bridge/ratelimit/brokerPolicies.mjs");
    const p = BROKER_POLICIES.dhan;
    expect(p.limits.order).toMatchObject({ perSecond: 10, perMinute: 250, perDay: 7000, extraWindows: [{ windowMs: 3_600_000, limit: 1000 }] });
    expect(p.limits.history).toMatchObject({ perSecond: 5, perDay: 100_000 });
    expect(p.limits.chain.extraWindows).toEqual([{ windowMs: 3000, limit: 1 }]);
    expect(p.limits.portfolio.perSecond).toBe(20);
    expect(p.limits.other.perSecond).toBe(20);
    expect(p.maxQuoteBatch).toBe(1000);
    expect(p.maxModificationsPerOrder).toBe(25);
    expect(p.feed).toMatchObject({ maxConnections: 5, maxSubscriptions: 5000, perSubscribeMessage: 100 });
    expect(p.dataEntitlement.value).toBe("paid-for-live");
    expect(p.dataEntitlement.note).toMatch(/Rs 499/);
    for (const x of ["10 a second, 250 a minute, 1,000 an hour, 7,000 a day", "5 a second, 100,000 a day", "one unique request every 3 seconds", "20 a second", "up to 1,000 instruments", "5 connections of 5,000 instruments", "100 per subscribe message", "Dhan allows 25 modifications per order", "Rs 499"]) {
      expect(guide, x).toContain(x);
    }
  });

  it("the connection test says what the guide quotes", () => {
    const src = read("server/brokers/dhan.mjs");
    expect(src).toContain("Dhan token works, but the Data API plan is not active on this account (needed for option chain and quotes).");
    expect(guide).toContain("Dhan token works, but the Data API plan is not active on this account (needed for option chain and quotes).");
    expect(src).toContain("Dhan API connected.");
    expect(guide).toContain("Dhan API connected. Token valid until");
  });

  it("the error codes are mapped as the guide says", async () => {
    const { normaliseError } = await import("../server/brokers/dhanContract.mjs");
    const { DhanApiError } = await import("../server/brokers/dhan.mjs");
    const code = (status, body) => normaliseError(new DhanApiError(status, body)).code;
    expect(code(401, '{"errorCode":"DH-901"}')).toBe("UPSTREAM_AUTH");
    expect(code(200, '{"data":{"807":"expired"}}')).toBe("UPSTREAM_AUTH");
    expect(code(429, "x")).toBe("UPSTREAM_RATE_LIMIT");
    expect(code(400, '{"errorCode":"DH-905"}')).toBe("UPSTREAM_INPUT");
    expect(code(400, '{"errorCode":"DH-902"}')).toBe("UPSTREAM_NOT_SUBSCRIBED");
    for (const c of ["UPSTREAM_AUTH", "UPSTREAM_RATE_LIMIT", "UPSTREAM_INPUT", "UPSTREAM_NOT_SUBSCRIBED"]) expect(guide, c).toContain(c);
  });

  it("the products, order types and segments the guide lists are the ones wired", async () => {
    const mappers = read("server/bridge/orders/brokerOrders.mjs");
    for (const seg of ["NSE_EQ", "BSE_EQ", "NSE_FNO", "BSE_FNO", "MCX_COMM", "NSE_CURRENCY"]) expect(mappers).toContain(seg);
    const { LIVE_ORDER_MAPPERS } = await import("../server/bridge/orders/brokerOrders.mjs");
    expect(LIVE_ORDER_MAPPERS.dhan.nativeMarketProtection).toBe(false);
    expect(LIVE_ORDER_MAPPERS.dhan.liveVerified).toBe(true);
    expect(LIVE_ORDER_MAPPERS.zerodha.liveVerified).toBe(false);
    for (const x of ["`CNC`", "`INTRADAY`", "`MARGIN`", "`MTF`", "`LIMIT`", "`MARKET`", "`SL`", "`SL-M`", "NSE, BSE, NFO, BFO, MCX and CDS"]) expect(guide, x).toContain(x);
  });

  it("the token is not checked for an expiry by the Bridge (apiKeyToken sessions have none)", async () => {
    const { sessionExpiryFor } = await import("../server/bridge/accounts/session.mjs");
    expect(sessionExpiryFor({ kind: "apiKeyToken" }, Date.now())).toBeNull();
    expect(guide).toContain("The Bridge is not told when your token ends");
  });
});

describe("tradingview.md matches the hook code", () => {
  const guide = read("docs/guides/tradingview.md");
  let demo;
  beforeAll(async () => {
    demo = await bootDemoBridge();
  });
  afterAll(async () => demo?.close());

  it("the address list is the one built into the Bridge, with its date and source", async () => {
    const { TRADINGVIEW_IP_PRESET } = await import("../server/bridge/hooks/config.mjs");
    for (const ip of TRADINGVIEW_IP_PRESET.ips) expect(guide, ip).toContain(`\`${ip}\``);
    expect(guide).toContain(TRADINGVIEW_IP_PRESET.verifiedAt);
    expect(guide).toContain(TRADINGVIEW_IP_PRESET.source);
    const presets = await demo.call("GET", "/v1/hooks/presets");
    expect(presets.json.data.ipPresets[0].ips).toEqual([...TRADINGVIEW_IP_PRESET.ips]);
    expect(presets.json.data.tradingview).toMatchObject({ defaultMaxAgeSec: 120, sourceIpPreset: "tradingview" });
  });

  it("the three alert messages in the guide are the templates the Bridge hands out (passphrase aside)", async () => {
    const made = await demo.call("POST", "/v1/hooks", { body: { source: "tradingview", label: "t", account: "demo-paper", sourceIpPreset: "tradingview" }, headers: { "Idempotency-Key": "tv-claims-0001" } });
    expect(made.status).toBe(201);
    expect(made.json.data.templates).toHaveLength(3);
    const pass = made.json.data.passphrase;
    for (const t of made.json.data.templates) {
      const message = t.message.replaceAll(pass, "YOUR_PASSPHRASE");
      expect(guide, t.name).toContain(message);
    }
    expect(made.json.data.maxLotsPerSignal).toBe(1);
    expect(made.json.data.maxAgeSec).toBe(120);
    expect(made.json.data.mode).toBe("paper");
  });

  it("the settings it names exist in the hooks section and the signal outcomes it lists are real", () => {
    const hooks = read("docs/guides/config.md");
    for (const k of ["hooks.clientIpHeader", "hooks.maxSignalsPerMinute", "hooks.rateWaitSec", "hooks.presets.tradingview.ips"]) {
      expect(hooks, k).toContain(`\`${k}\``);
    }
    for (const k of ["hooks.clientIpHeader", "hooks.maxSignalsPerMinute", "hooks.rateWaitSec"]) expect(guide, k).toContain(k);
    const spec = read("docs/openapi.yaml");
    for (const o of ["placed", "duplicate", "stale", "rejected", "refused", "queued", "awaiting_confirmation", "outcome_unknown"]) expect(spec, o).toContain(o);
  });

  it("a test alert places a paper order through the same checks and a repeat is not a duplicate of it", async () => {
    const made = await demo.call("POST", "/v1/hooks", { body: { source: "tradingview", label: "t2", account: "demo-paper", orderType: "MARKET", product: "INTRADAY" }, headers: { "Idempotency-Key": "tv-claims-0002" } });
    const id = made.json.data.id;
    const t1 = await demo.call("POST", `/v1/hooks/${id}/test`, { body: {} });
    const t2 = await demo.call("POST", `/v1/hooks/${id}/test`, { body: {} });
    expect(t1.json.data).toMatchObject({ test: true, mode: "paper", accepted: true, outcome: "placed" });
    expect(t2.json.data.outcome).toBe("placed");
    expect(guide).toContain('"outcome": "placed"');
  });
});
