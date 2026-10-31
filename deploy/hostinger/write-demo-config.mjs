/**
 * First start of a public DEMO deployment (deploy/hostinger): writes /data/bridge.config.json for demo mode on the
 * container network behind the Caddy HTTPS proxy, and creates the first admin key (printed once in the logs).
 *
 * Demo mode only: sample prices, no broker, no broker credentials, paper orders only. A Bridge holding real broker
 * accounts must never be reachable from the internet; see deploy/hostinger/README.md.
 *
 * Reads DOMAIN (required, e.g. bridge.example.com). Run inside the image: node /deploy/write-demo-config.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const configPath = process.env.MCB_CONFIG || "/data/bridge.config.json";
const appDir = process.env.MCB_APP_DIR || "/app";
const domain = String(process.env.DOMAIN || "").trim().toLowerCase();
if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
  console.error("Set DOMAIN to the domain or subdomain this demo is served on, for example bridge.example.com.");
  process.exit(1);
}

if (!existsSync(configPath)) {
  console.log("First start: setting up a public demo (your admin key is printed once below).");
  const r = spawnSync(process.execPath, [`${appDir}/bin/mc-bridge.mjs`, "init", "--yes", "--demo", "--config", configPath], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const cfg = JSON.parse(readFileSync(configPath, "utf8"));
cfg.demo = true;
cfg.server = {
  ...(cfg.server ?? {}),
  host: "0.0.0.0", // inside the container network only; the compose file publishes no Bridge port
  port: 4300,
  allowNonLoopback: true,
  remoteDashboard: true, // demo mode only; the Bridge refuses this setting otherwise
  allowedHosts: [domain],
  localPeers: [],
};
cfg.cors = { allowedOrigins: [`https://${domain}`] };
// Nothing reaches out from a public demo: no backup data, no notifications.
if (cfg.backup) cfg.backup.enabled = false;
if (cfg.notify) cfg.notify.targets = [];
writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
console.log(`Demo config ready for https://${domain}`);
