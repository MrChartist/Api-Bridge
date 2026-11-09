/**
 * The recipes under deploy/expose and the two guides must agree with the code: the same TradingView addresses, the
 * tunnel pointed at a public listener port and never the main port, nothing published by the compose file.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALERTS_PORT, SHEETS_PORT, TRADINGVIEW_SENDER_IPS } from "./expose.mjs";

const root = resolve(import.meta.dirname, "../../..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const strip = (s) => s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

describe("deploy/expose recipes", () => {
  it("Caddyfile: the same sender addresses as the code, the alerts port, never the main port, 404 for the rest", () => {
    const c = read("deploy/expose/Caddyfile.example");
    const live = strip(c);
    for (const ip of TRADINGVIEW_SENDER_IPS) expect(live).toContain(ip);
    expect(live).toContain(`reverse_proxy 127.0.0.1:${ALERTS_PORT}`);
    expect(live).not.toMatch(/:4300\b/);
    expect(live).toMatch(/respond "Not found" 404/);
    expect(live).toMatch(/max_size 16KB/);
    expect(c).toMatch(new RegExp(`127\\.0\\.0\\.1:${SHEETS_PORT}`)); // the optional Sheets block is there, commented out
    expect(live).not.toContain(String(SHEETS_PORT));
    expect(c).toMatch(/not run against a real Caddy/);
  });

  it("systemd unit: unprivileged user, hardened, state folders apart, loopback config path", () => {
    const u = read("deploy/expose/mc-bridge.service");
    for (const line of ["User=mcbridge", "NoNewPrivileges=yes", "ProtectSystem=strict", "CapabilityBoundingSet=", "Restart=on-failure", "StateDirectory=mc-bridge mc-bridge-secrets", "Environment=MCB_CONFIG=/etc/mc-bridge/bridge.config.json"]) expect(u).toContain(line);
    expect(u).toMatch(/ExecStart=\/usr\/bin\/node \/opt\/mc-bridge\/bin\/mc-bridge\.mjs start/);
  });

  it("compose: host network for both (so the proxy header is trusted), nothing published, read-only, separate key volume", () => {
    const y = read("deploy/expose/docker-compose.yml");
    expect(y.match(/network_mode: host/g)).toHaveLength(2);
    expect(strip(y)).not.toMatch(/^\s*ports:/m);
    expect(y).toContain("read_only: true");
    expect(y).toContain("cap_drop: [ALL]");
    expect(y).toMatch(/bridge-secrets:\/secrets/);
    expect(y).toMatch(/bridge-data:\/data/);
  });

  it("cloudflared sample: the tunnel points at the alerts port and ends with a 404 rule; the Sheets entry is commented", () => {
    const y = read("deploy/expose/cloudflared-config.example.yml");
    expect(strip(y)).toContain(`service: http://127.0.0.1:${ALERTS_PORT}`);
    expect(strip(y)).toContain("service: http_status:404");
    expect(strip(y)).not.toMatch(/:4300\b/);
    expect(y).toMatch(/untested/i);
  });

  it("the recipes say which of them were tested and how", () => {
    expect(read("deploy/expose/mc-bridge.service")).toMatch(/systemd-analyze verify/);
    expect(read("deploy/expose/docker-compose.yml")).toMatch(/docker compose config/);
  });
});

describe("the guides", () => {
  const g = read("docs/guides/expose-alerts.md");
  const v = read("docs/guides/vps.md");
  it("list the same TradingView addresses as the code, with the date they were read", () => {
    for (const ip of TRADINGVIEW_SENDER_IPS) expect(g).toContain(ip);
    expect(g).toMatch(/read 2026-11-09/);
  });
  it("state the topology rules: only the narrow listeners, the main port never, orders leave from the Bridge's host", () => {
    expect(g).toMatch(/Do not point a tunnel or proxy at port 4300/);
    expect(g).toMatch(/inbound only/);
    expect(g).toMatch(/home address/);
    expect(g).toMatch(/needs verification/);
  });
  it("name every flag and provider the wizard accepts", () => {
    for (const w of ["--provider", "--host", "--allow-ips", "--public-url", "--allow-outbound", "--yes", "--check", "cloudflare-quick", "ngrok", "caddy", "port-forward"]) expect(g, w).toContain(w);
  });
  it("the VPS guide covers firewall, unit, compose, dashboard access, static IP change planning, updating and backups", () => {
    for (const h of ["Harden it", "Or with Docker", "Reach the dashboard", "Register the static address, and plan changes", "Updating", "Backups"]) expect(v, h).toContain(h);
    expect(v).toMatch(/ssh -L 4300:127\.0\.0\.1:4300/);
    expect(v).toMatch(/Never open 4300, 4301 or 4302/);
  });
  it("every relative link in both guides points at a file that exists", () => {
    for (const [name, text] of [["expose-alerts.md", g], ["vps.md", v]]) {
      for (const m of text.matchAll(/\]\((\.{1,2}\/[^)#\s]+)(#[^)]*)?\)/g)) expect(existsSync(resolve(root, "docs/guides", m[1])), `${name}: ${m[1]}`).toBe(true);
    }
  });
});
