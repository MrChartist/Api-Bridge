/**
 * Letting TradingView (alerts) and Google Sheets reach the Bridge without exposing anything else.
 *
 * The rules this file encodes (docs/guides/expose-alerts.md says them in plain words):
 *  - A tunnel or reverse proxy points ONLY at a public listener: the alerts listener (`server.publicIngress`, serves
 *    POST /hooks/* and nothing else) or the Sheets listener (`server.sheetsIngress`, serves GET /xl/* for read-only
 *    keys and nothing else). Never at the main port (dashboard, /v1 admin, key and confirm routes).
 *  - Orders leave from the computer the Bridge runs on, so that computer must hold the broker-registered static IP.
 *    A tunnel is inbound only; it never changes where orders come from.
 *  - Host names: each public listener answers only to the names in its own `allowedHosts`. The main listener's
 *    `server.allowedHosts` is left alone.
 *
 * Everything here is pure or takes its I/O as an argument (a transport for requests, a lookup for DNS), so tests run
 * with a fake ingress and fake DNS. Nothing here calls out unless the caller passes `allowOutbound: true`.
 *
 * Config changes need a restart: the Bridge reads its config once at start and does not reload it.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, copyFileSync, chmodSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { dirname } from "node:path";
import { isIP } from "node:net";
import { writeFileAtomic } from "../auth/fsUtil.mjs";
import { HOOKS_CONFIG_SCHEMA } from "../hooks/config.mjs";
import { createHookStore } from "../hooks/hookStore.mjs";
import { BridgeError } from "./errors.mjs";
import { DEFAULT_PORT, isLoopbackHost, loadConfig } from "./config.mjs";

export const ALERTS_PORT = DEFAULT_PORT + 1;
export const SHEETS_PORT = DEFAULT_PORT + 2;

/**
 * TradingView's published webhook sender addresses, read from TradingView's own help page ("About webhooks") on
 * 2026-11-09, which also says: only ports 80 and 443, the call is cancelled after 3 seconds, no IPv6, 2-factor
 * authentication required, no credentials in the message. TradingView may change the list: the allowlist is a
 * setting (`hooks.allowSourceIps`), `mc-bridge expose --allow-ips a,b,c` replaces it, and the guide says to compare
 * it with the help page before relying on it.
 */
export const TRADINGVIEW_SENDER_IPS = Object.freeze(["52.89.214.238", "34.212.75.30", "54.218.53.128", "52.32.178.7"]);
export const TRADINGVIEW_HELP_URL = "https://www.tradingview.com/support/solutions/43000529348-about-webhooks/";

/**
 * The provider recipes. `clientIpHeader` is what the Bridge should trust for the caller's address when the tunnel or
 * proxy runs on this computer (the Bridge honours it only when the TCP peer is loopback). `headerVerified` says whether
 * the header behaviour was confirmed from the provider's own documentation on 2026-11-09: ngrok (X-Forwarded-For,
 * appended) and Caddy (sets or augments X-Forwarded-For and ignores incoming values) yes; Cloudflare's page says
 * CF-Connecting-IP is sent from its edge to the origin but does not mention Tunnel, so it is unverified. An unverified
 * one is a setting you can change, and the guide says how to test it.
 */
export const PROVIDERS = Object.freeze({
  "cloudflare": {
    label: "Cloudflare Tunnel (named, stable address)",
    needsHost: true,
    clientIpHeader: "cf-connecting-ip",
    headerVerified: false,
    tls: true,
    note: "Needs a free Cloudflare account and a domain on it. The address stays the same, so you set it up once.",
  },
  "cloudflare-quick": {
    label: "Cloudflare quick tunnel (for a first test only)",
    needsHost: true,
    clientIpHeader: "cf-connecting-ip",
    headerVerified: false,
    tls: true,
    replaceHosts: true,
    note: "No account needed, but the address changes every time the tunnel starts, and then the Bridge must be told the new address and restarted. Use it to try the setup, not for real alerts.",
  },
  "ngrok": {
    label: "ngrok (reserved domain)",
    needsHost: true,
    clientIpHeader: "x-forwarded-for",
    headerVerified: true,
    tls: true,
    note: "Needs an ngrok account and a reserved domain so the address stays the same. ngrok's documentation says it adds the caller's address to X-Forwarded-For (appending to any value the caller sent, which is why the Bridge reads the last entry).",
  },
  "caddy": {
    label: "Caddy reverse proxy on a VPS",
    needsHost: true,
    clientIpHeader: "x-forwarded-for",
    headerVerified: true,
    tls: true,
    note: "Run the Bridge and Caddy on the same VPS, with a domain pointing at the VPS. Caddy gets the HTTPS certificate by itself.",
  },
  "port-forward": {
    label: "Plain port forward on your router (not recommended)",
    needsHost: true,
    clientIpHeader: null,
    headerVerified: true,
    tls: false,
    portForward: true,
    note: "No HTTPS (the secret address travels unencrypted), your home address changes, and the Bridge listens on every network interface. Only the sender allowlist protects you. Prefer a tunnel or a VPS.",
  },
});

export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));
export const INTEGRATIONS = Object.freeze(["alerts", "sheets"]);

// ── Host names ──

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * A public host name from what a person pasted ("https://Hooks.Example.com/path" becomes "hooks.example.com").
 * Throws VALIDATION_FAILED for a wildcard, a path with a name that is not a host, a port, or an empty value.
 */
export function normaliseHost(input) {
  let s = String(input ?? "").trim().toLowerCase();
  if (!s) throw new BridgeError("VALIDATION_FAILED", "Give the public host name, for example hooks.example.com.");
  if (s.includes("*")) throw new BridgeError("VALIDATION_FAILED", "A wildcard host name does not work: the Bridge compares host names exactly. Give the one name your tunnel or domain uses.");
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "");
  s = s.replace(/:\d+$/, "");
  if (!(HOST_RE.test(s) || isIP(s) === 4) || s.length > 253) throw new BridgeError("VALIDATION_FAILED", `"${input}" is not a host name. Use something like hooks.example.com (no spaces, no path).`);
  return s;
}

const unique = (a) => [...new Set(a)];

// ── The plan and the config writer ──

/**
 * What to change for one integration and provider. Pure.
 * @param {{ integration: "alerts"|"sheets", provider: string, host: string, port?: number, allowIps?: string[] | boolean,
 *   bindAll?: boolean }} input
 *   allowIps: false = leave the sender allowlist alone; true = the TradingView list; an array = exactly those.
 */
export function planExpose(input) {
  const { integration, provider } = input;
  if (!INTEGRATIONS.includes(integration)) throw new BridgeError("VALIDATION_FAILED", `Choose what to expose: ${INTEGRATIONS.join(" or ")}.`);
  const p = PROVIDERS[provider];
  if (!p) throw new BridgeError("VALIDATION_FAILED", `Unknown provider "${provider}". Choose one of: ${PROVIDER_IDS.join(", ")}.`);
  if (integration === "sheets" && p.portForward) {
    throw new BridgeError("VALIDATION_FAILED", "Sheets is not offered over a plain port forward: the read key would travel unencrypted. Use a tunnel or a VPS with HTTPS.");
  }
  const host = normaliseHost(input.host);
  const port = input.port ?? (integration === "alerts" ? ALERTS_PORT : SHEETS_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BridgeError("VALIDATION_FAILED", "The listener port must be a number between 1 and 65535.");
  const listenerKey = integration === "alerts" ? "publicIngress" : "sheetsIngress";
  const bind = p.portForward ? "0.0.0.0" : "127.0.0.1";
  const warnings = [];
  const allowIps = input.allowIps === false || input.allowIps === undefined ? [] : input.allowIps === true ? [...TRADINGVIEW_SENDER_IPS] : [...input.allowIps];
  if (p.portForward) {
    warnings.push("A plain port forward has no HTTPS and listens on every network interface. Only the sender allowlist protects the alerts listener.");
    if (integration === "alerts" && allowIps.length === 0) {
      throw new BridgeError("VALIDATION_FAILED", "A plain port forward needs the sender allowlist (the TradingView addresses). Without it anyone on the internet could reach the listener. Add --allow-ips or choose a tunnel.");
    }
  }
  if (provider === "cloudflare-quick") warnings.push("A quick tunnel gets a new address every time it starts. When it does, run this command again with the new host and restart the Bridge.");
  if (integration === "alerts" && allowIps.length && !p.portForward && !p.clientIpHeader) warnings.push("The sender allowlist needs the caller's address from a header; this provider has none.");
  if (integration === "alerts" && allowIps.length) warnings.push("The sender allowlist applies to every webhook of this Bridge, including ChartInk and GoCharting ones. Their senders have other addresses: use a separate Bridge for them, or leave the allowlist off.");
  return Object.freeze({
    integration,
    provider,
    host,
    port,
    listenerKey,
    bind,
    clientIpHeader: integration === "alerts" ? p.clientIpHeader : null,
    allowIps,
    replaceHosts: true,
    allowNonLoopback: Boolean(p.portForward),
    warnings,
    restartRequired: true,
  });
}

/** A plan that turns the listeners off (and removes nothing else). */
export function planOff(which = "all") {
  return Object.freeze({ off: true, which: which === "alerts" || which === "sheets" ? which : "all", restartRequired: true });
}

const asObject = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

/**
 * The config object with the plan applied (a copy; the input is untouched). Only the keys the plan owns change.
 * @param {any} raw @param {ReturnType<typeof planExpose> | ReturnType<typeof planOff>} plan
 */
export function applyPlan(raw, plan) {
  const out = structuredClone(asObject(raw));
  out.server = asObject(out.server);
  if (plan.off) {
    for (const [name, key] of [["alerts", "publicIngress"], ["sheets", "sheetsIngress"]]) {
      if (plan.which !== "all" && plan.which !== name) continue;
      if (out.server[key]) out.server[key] = { ...asObject(out.server[key]), enabled: false };
    }
    return out;
  }
  const cur = asObject(out.server[plan.listenerKey]);
  out.server[plan.listenerKey] = { ...cur, enabled: true, host: plan.bind, port: plan.port, allowedHosts: [plan.host] };
  if (plan.allowNonLoopback) out.server.allowNonLoopback = true;
  if (plan.integration === "alerts") {
    const hooks = asObject(out.hooks);
    if (plan.clientIpHeader) hooks.clientIpHeader = plan.clientIpHeader;
    if (plan.allowIps.length) hooks.allowSourceIps = [...plan.allowIps];
    out.hooks = hooks;
  }
  return out;
}

/**
 * The lines "what changed" between two config objects, limited to the keys this feature owns.
 * @returns {string[]}
 */
export function describeChanges(before, after) {
  const get = (o, path) => path.reduce((v, k) => (v && typeof v === "object" ? v[k] : undefined), o);
  const paths = [
    ["server", "publicIngress", "enabled"], ["server", "publicIngress", "host"], ["server", "publicIngress", "port"], ["server", "publicIngress", "allowedHosts"],
    ["server", "sheetsIngress", "enabled"], ["server", "sheetsIngress", "host"], ["server", "sheetsIngress", "port"], ["server", "sheetsIngress", "allowedHosts"],
    ["server", "allowNonLoopback"], ["hooks", "clientIpHeader"], ["hooks", "allowSourceIps"],
  ];
  const lines = [];
  for (const p of paths) {
    const a = JSON.stringify(get(before, p));
    const b = JSON.stringify(get(after, p));
    if (a !== b) lines.push(`${p.join(".")}: ${a ?? "(not set)"} -> ${b ?? "(not set)"}`);
  }
  return lines;
}

/** Throws a BridgeError when the config object would not load (so a bad write never reaches the file). */
export function assertConfigLoads(raw) {
  loadConfig({ raw: structuredClone(raw), env: {}, cwd: process.cwd() });
  if (raw.hooks !== undefined) {
    const r = HOOKS_CONFIG_SCHEMA.safeParse(raw.hooks);
    if (!r.success) throw new BridgeError("VALIDATION_FAILED", `The hooks settings would not be valid: ${r.error.issues.map((i) => `${i.path.join(".") || "hooks"}: ${i.message}`).join("; ")}`);
  }
}

/**
 * Apply a plan to the config file: read it (a missing file starts empty), apply, check that the result loads, keep a
 * copy of the old file next to it (`<file>.bak-expose`), then write atomically with mode 0600. Nothing is written when
 * the result is not valid.
 * @param {{ file: string, plan: any, dryRun?: boolean }} opts  dryRun: validate and report the changes, write nothing
 * @returns {{ file: string, backup: string | null, changes: string[], restartRequired: boolean }}
 */
export function writeExposeConfig({ file, plan, dryRun = false }) {
  let before = {};
  const existed = existsSync(file);
  if (existed) {
    try {
      before = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new BridgeError("VALIDATION_FAILED", `Could not read ${file}: ${err.message}. Nothing was changed.`);
    }
    if (!before || typeof before !== "object" || Array.isArray(before)) throw new BridgeError("VALIDATION_FAILED", `${file} is not a JSON object. Nothing was changed.`);
  }
  const after = applyPlan(before, plan);
  assertConfigLoads(after);
  const changes = describeChanges(before, after);
  if (dryRun) return { file, backup: null, changes, restartRequired: changes.length > 0 };
  let backup = null;
  if (existed) {
    backup = `${file}.bak-expose`;
    copyFileSync(file, backup);
    try {
      chmodSync(backup, 0o600);
    } catch {
      /* not supported on this file system */
    }
  } else mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, `${JSON.stringify(after, null, 2)}\n`);
  return { file, backup, changes, restartRequired: changes.length > 0 };
}

// ── What to tell the person ──

/** The public address patterns and the exact settings to paste. Pure. */
export function connectionSheet(plan, { hookToken = null } = {}) {
  const scheme = PROVIDERS[plan.provider].tls ? "https" : "http";
  const base = `${scheme}://${plan.host}`;
  if (plan.integration === "alerts") {
    return {
      base,
      urlPattern: `${base}/hooks/<source>/<token>`,
      lines: [
        `Webhook URL in the TradingView alert:  ${base}/hooks/<source>/<token>   (copy the real one from Dashboard > API > Integrations > Webhooks)`,
        "Message: paste the template shown next to that webhook (do not type credentials into the message).",
        `TradingView only calls port 80 or 443, waits 3 seconds, does not use IPv6 and needs 2-factor sign-in turned on (${TRADINGVIEW_HELP_URL}).`,
        ...(hookToken ? [`Your new webhook address: ${base}/hooks/<source>/${hookToken}`] : []),
      ],
    };
  }
  return {
    base,
    urlPattern: `${base}/xl/<route>`,
    lines: [
      `Apps Script property BRIDGE_URL:  ${base}   (no slash at the end)`,
      "Apps Script property BRIDGE_KEY:  a read-only key, made with:",
      "  mc-bridge keys create --label sheet --scope read --expires 90d",
      "The Sheets address serves only read-only /xl routes. Do not share the sheet or the key.",
    ],
  };
}

/** The commands for the chosen provider. Pure; each is exact text for a terminal or a file. */
export function providerSteps(plan) {
  const { provider, host, port } = plan;
  const local = `http://127.0.0.1:${port}`;
  switch (provider) {
    case "cloudflare":
      return [
        "Install cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).",
        "cloudflared tunnel login",
        "cloudflared tunnel create mc-bridge",
        `cloudflared tunnel route dns mc-bridge ${host}`,
        "Create ~/.cloudflared/config.yml with these lines (use the id that `tunnel create` printed):",
        "  tunnel: <Tunnel-UUID>",
        "  credentials-file: /home/<you>/.cloudflared/<Tunnel-UUID>.json",
        `  url: ${local}`,
        "cloudflared tunnel run mc-bridge",
      ];
    case "cloudflare-quick":
      return [`cloudflared tunnel --url ${local}`, "It prints an address ending in trycloudflare.com. That is the host to give this command (--host)."];
    case "ngrok":
      return [`ngrok http ${port} --url https://${host}`];
    case "caddy":
      return [
        "Install Caddy on the VPS (https://caddyserver.com/docs/install) and point the domain's DNS A record at the VPS address.",
        "Use deploy/expose/Caddyfile.example (copy it, set DOMAIN, optionally the sender allowlist), then:",
        "caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy",
      ];
    case "port-forward":
      return [
        `On your router, forward external port 443 (or 80) to this computer, internal port ${port}, TCP, and nothing else.`,
        `The listener is bound to every interface on port ${port}. Keep the main port ${DEFAULT_PORT} off the router, and allow only the TradingView addresses in the computer's firewall.`,
      ];
    default:
      return [];
  }
}

/** When to restart: the one sentence every output uses. */
export const RESTART_SENTENCE = "Restart the Bridge to apply this: stop it (Ctrl+C in its window, or stop the service) and start it again. The Bridge reads its settings only when it starts.";

// ── Doctor rules ──

const isWildcardish = (h) => /[*?\s]/.test(h) || h === "." || h === "" || /^[a-z]+:\/\//i.test(h) || /\//.test(h);
const hasLive = (config) => (config.accounts ?? []).some((a) => a.live?.enabled && a.broker !== "paper");
const liveWebhookAccounts = (config) => (config.safety?.liveTrading ? (config.accounts ?? []).filter((a) => a.live?.enabled && a.broker !== "paper" && (a.live.allowedSources ?? []).includes("webhook")) : []);

/** @typedef {{ level: "ok"|"warn", check: string, message: string, fix?: string, blocking?: boolean }} ExposureCheck */

/**
 * The exposure rules of `mc-bridge doctor`. A rule that finds a mistake gives `level: "warn"`, a one-line `fix`, and
 * `blocking: true` when the mistake leaves the Bridge open to the internet or makes a safety rule meaningless
 * (`doctor --strict` then exits non-zero). Pure.
 * @param {any} config
 * @param {{ hooks?: Array<{ source?: string, mode?: string, requireConfirmation?: boolean, allowSourceIps?: string[] }>, keys?: any[] | null, now?: number }} [extra]
 * @returns {ExposureCheck[]}
 */
export function exposureChecks(config, { hooks = [], keys = null, now = Date.now() } = {}) {
  const out = [];
  const warn = (check, message, fix, blocking = false) => out.push({ level: "warn", check, message, fix, ...(blocking ? { blocking: true } : {}) });
  const s = config.server;
  const pi = s.publicIngress;
  const si = s.sheetsIngress ?? { enabled: false, host: "127.0.0.1", port: SHEETS_PORT, allowedHosts: [] };
  const hk = config.hooks ?? {};
  const live = hasLive(config) && config.safety?.liveTrading;
  const anyPublic = pi.enabled || si.enabled;

  if (!isLoopbackHost(s.host)) {
    warn(
      "expose-bind",
      `The Bridge listens on ${s.host}:${s.port}, so other computers on the network can reach its API login. Dashboard pages still refuse other computers, but every key you hand out now works from anywhere that can connect.`,
      `Set server.host to 127.0.0.1 (and reach it from another computer with an SSH tunnel or VPN).`,
      Boolean(live || anyPublic),
    );
  }
  if (s.remoteDashboard && !config.demo) {
    warn("expose-dashboard", "server.remoteDashboard is on outside demo mode: the dashboard pages are served to other computers.", "Remove server.remoteDashboard from bridge.config.json.", true);
  } else if (s.remoteDashboard) {
    warn("expose-dashboard", "server.remoteDashboard is on (demo mode): dashboard pages are served to other computers.", "Fine for a public demo; never with real broker accounts.");
  }

  for (const [key, label, l] of [["alerts", "alerts", pi], ["sheets", "Sheets", si]]) {
    if (!l.enabled) continue;
    const path = key === "alerts" ? "server.publicIngress" : "server.sheetsIngress";
    const hosts = l.allowedHosts ?? [];
    const open = !isLoopbackHost(l.host);
    if (open) {
      const guarded = key === "alerts" ? (hk.allowSourceIps ?? []).length > 0 : false;
      if (!guarded) warn(`expose-${key}-open`, `The ${label} listener is bound to ${l.host}:${l.port}, which is open to every network the computer is on, and nothing limits who may call it.`, `Set ${path}.host to 127.0.0.1 and point your tunnel or proxy at it${key === "alerts" ? ", or set hooks.allowSourceIps" : ""}.`, true);
      else warn(`expose-${key}-open`, `The ${label} listener is bound to ${l.host}:${l.port} (open to every network); only the sender allowlist limits callers.`, `Prefer ${path}.host 127.0.0.1 behind a tunnel or reverse proxy on this computer.`);
    }
    if (hosts.length === 0) warn(`expose-${key}-hosts`, `The ${label} listener is on but ${path}.allowedHosts is empty, so it refuses every request that is not addressed to 127.0.0.1.`, `Run: mc-bridge expose ${key} (it sets the host for you).`);
    const bad = hosts.filter(isWildcardish);
    if (bad.length) warn(`expose-${key}-wildcard`, `${path}.allowedHosts has entries that can never match (${bad.join(", ")}): the Bridge compares host names exactly and takes no wildcards, schemes or paths.`, `Replace them with the plain host name, for example hooks.example.com.`);
    const shared = hosts.filter((h) => (s.allowedHosts ?? []).includes(h));
    if (shared.length) warn(`expose-${key}-shared-host`, `${shared.join(", ")} is allowed on the main listener as well as the ${label} listener, so a tunnel pointed at the wrong port would reach the API.`, `Remove it from server.allowedHosts; only ${path}.allowedHosts needs it.`, Boolean(live));
  }
  // A real host name on the MAIN listener means a tunnel (or a proxy) can be pointed at the API port itself. The alerts
  // and Sheets listeners exist so that nothing has to be. (A name that is also on one of them already has its own warning.)
  const onOwnListener = new Set([...(pi.allowedHosts ?? []), ...(si.allowedHosts ?? [])]);
  const tunnelled = (s.allowedHosts ?? []).filter((h) => !isWildcardish(h) && !isLoopbackHost(h) && !onOwnListener.has(h));
  if (tunnelled.length) {
    warn(
      "expose-main-tunnel",
      `server.allowedHosts names ${tunnelled.join(", ")}, so the main API port answers requests addressed to ${tunnelled.length === 1 ? "that name" : "those names"}. A tunnel pointed at it would put the API (and any read key's reach) on a public name.`,
      "Point the tunnel at the Sheets or alerts listener instead (mc-bridge expose sheets / alerts), and remove the name from server.allowedHosts.",
      Boolean(live),
    );
  }
  if ((s.allowedHosts ?? []).some(isWildcardish)) warn("expose-main-wildcard", `server.allowedHosts has entries that can never match (${(s.allowedHosts ?? []).filter(isWildcardish).join(", ")}).`, "Use plain host names without wildcards, schemes or paths.");

  if (pi.enabled && (pi.allowedHosts ?? []).some((h) => !isLoopbackHost(h)) && !hk.clientIpHeader && isLoopbackHost(pi.host)) {
    const needs = (hk.allowSourceIps ?? []).length > 0;
    warn(
      "expose-client-ip",
      needs
        ? "Alerts arrive through a tunnel or proxy on this computer, so every call looks like it comes from 127.0.0.1 and the sender allowlist refuses them all."
        : "Alerts arrive through a tunnel or proxy on this computer, so every call looks like it comes from 127.0.0.1: logs and per-address rules cannot tell senders apart.",
      "Set hooks.clientIpHeader to your provider's header (cf-connecting-ip for Cloudflare, x-forwarded-for for ngrok or Caddy): mc-bridge expose alerts does it.",
    );
  }
  if (pi.enabled && (hk.allowSourceIps ?? []).length === 0 && !hooks.some((h) => (h.allowSourceIps ?? []).length)) {
    warn("expose-allowlist", "No sender allowlist is set, so the secret webhook address is the only protection for alerts.", `Run mc-bridge expose alerts and accept the TradingView allowlist, or set hooks.allowSourceIps.`);
  }

  if (pi.enabled && live) {
    const liveHooks = hooks.filter((h) => h.mode === "live");
    const unguarded = liveHooks.filter((h) => !h.requireConfirmation);
    const listed = (hk.allowSourceIps ?? []).length > 0;
    const webhookLive = liveWebhookAccounts(config);
    if (unguarded.length) {
      const noList = unguarded.filter((h) => !listed && !(h.allowSourceIps ?? []).length);
      warn(
        "expose-live-alerts",
        `Live trading is on and ${unguarded.length} live webhook${unguarded.length === 1 ? "" : "s"} can place orders without your confirmation${noList.length ? `; ${noList.length} of them have no sender allowlist either` : ""}.`,
        "Turn on requireConfirmation for live webhooks (you confirm each order on this computer), or set the sender allowlist.",
        noList.length > 0,
      );
    } else if (webhookLive.length && !liveHooks.length) {
      out.push({ level: "ok", check: "expose-live-alerts", message: `Live orders from webhooks are allowed on ${webhookLive.map((a) => a.id).join(", ")}; no live webhook exists yet.` });
    }
  }

  if (anyPublic && live) {
    const missing = (config.accounts ?? []).filter((a) => a.live?.enabled && a.broker !== "paper" && !String(a.live?.registeredIp ?? "").trim());
    if (missing.length) warn("expose-static-ip", `A public listener is on, live trading is on, and ${missing.map((a) => a.id).join(", ")} has no registered static IP in the config, so a changed address would not be noticed before an order is refused.`, "Register your static IP with the broker and set live.registeredIp (docs/guides/deployment.md). Orders leave from this computer, not from the tunnel.");
  }

  if ((si.enabled || !isLoopbackHost(s.host)) && Array.isArray(keys)) {
    const long = keys.filter((k) => !k.revokedAt && k.allowQuery && (!k.expiresAt || Date.parse(k.expiresAt) - now > 90 * 86_400_000));
    if (long.length) warn("expose-url-keys", `${long.length} key${long.length === 1 ? "" : "s"} for URL use (allowQuery) ${long.length === 1 ? "has" : "have"} no expiry or one longer than 90 days (${long.map((k) => k.id).join(", ")}); a key in a sheet address ends up in Google's and the tunnel's logs.`, "Create a new one with --expires 90d and revoke the old one: mc-bridge keys revoke <keyId>.");
  }

  if (out.length === 0) {
    out.push({ level: "ok", check: "expose", message: anyPublic ? `Public listeners (${[pi.enabled ? "alerts" : null, si.enabled ? "Sheets" : null].filter(Boolean).join(", ")}) are set up safely.` : "Nothing on this computer is set up to be reached from the internet." });
  }
  return out;
}

/** Hook summaries (source, mode, confirmation, allowlist) from the data folder, or [] when unreadable. Read-only. */
export function readHooksQuietly(dataDir) {
  try {
    if (!existsSync(`${dataDir}/hooks.json`)) return [];
    return createHookStore({ dataDir }).list().map((h) => ({ source: h.source, mode: h.mode, requireConfirmation: h.requireConfirmation, allowSourceIps: h.allowSourceIps ?? [] }));
  } catch {
    return [];
  }
}

/**
 * The Expose card's model: what is on, the addresses to use, and the doctor's checks.
 * @param {any} config @param {{ hooks?: any[], keys?: any[] | null }} [extra]
 */
export function exposureState(config, { hooks = [], keys = null } = {}) {
  const s = config.server;
  const pi = s.publicIngress;
  const si = s.sheetsIngress ?? { enabled: false, host: "127.0.0.1", port: SHEETS_PORT, allowedHosts: [] };
  const hk = config.hooks ?? {};
  const checks = exposureChecks(config, { hooks, keys });
  const warnings = checks.filter((c) => c.level === "warn");
  const blocking = warnings.some((c) => c.blocking);
  const listener = (l, route, extra = {}) => ({
    enabled: Boolean(l.enabled),
    listen: `${l.host}:${l.port}`,
    hosts: l.allowedHosts ?? [],
    ...(l.allowedHosts?.length ? { urlPattern: `https://${l.allowedHosts[0]}${route}` } : {}),
    ...extra,
  });
  const alerts = listener(pi, "/hooks/<source>/<token>", { clientIpHeader: hk.clientIpHeader ?? null, senderAllowlist: (hk.allowSourceIps ?? []).length });
  const sheets = listener(si, "/xl/<route>", { requestsPerMinute: si.requestsPerMinute ?? 600 });
  const on = [alerts.enabled ? "alerts" : null, sheets.enabled ? "sheets" : null].filter(Boolean);
  const where = (l) => (l.hosts.length ? l.hosts[0] : null);
  let headline;
  if (!on.length) headline = "Nothing on this computer is set up to be reached from the internet.";
  else {
    const bits = [];
    if (alerts.enabled) bits.push(where(alerts) ? `Alerts can reach this Bridge at ${where(alerts)}` : "The alerts listener is on, but no public address is set yet");
    if (sheets.enabled) bits.push(where(sheets) ? `Google Sheets can read prices at ${where(sheets)}` : "The Sheets listener is on, but no public address is set yet");
    headline = `${bits.join(". ")}. The dashboard and the rest of the API stay on this computer.`;
  }
  return { state: on.length ? "on" : "off", exposed: on, headline, tone: blocking ? "bad" : warnings.length ? "warn" : "ok", alerts, sheets, checks, restartNote: RESTART_SENTENCE };
}

// ── The self-check ──

/**
 * The real transport: one HTTP(S) request, no redirects followed. Resolves { status, headers, text } as soon as the
 * response head arrives and the body is read (capped at 4 KB); rejects with an Error carrying `.code` when no response
 * came. Tests pass a fake instead.
 * @param {{ protocol?: "http:"|"https:", host: string, port: number, method?: string, path: string, headers?: Record<string,string>, body?: string, timeoutMs?: number }} o
 */
export function defaultTransport(o) {
  return new Promise((resolve, reject) => {
    const lib = o.protocol === "https:" ? https : http;
    const headers = { ...(o.headers ?? {}) };
    if (o.body !== undefined) headers["content-length"] = String(Buffer.byteLength(o.body));
    let answered = false;
    const req = lib.request({ host: o.host, port: o.port, method: o.method ?? "GET", path: o.path, headers, agent: false, timeout: o.timeoutMs ?? 8000 }, (res) => {
      answered = true;
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        if (text.length < 4096) text += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      res.on("error", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    req.on("error", (err) => {
      if (!answered) reject(err);
    });
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/** Private, loopback and link-local addresses (what a public host name should not resolve to). */
export function isPrivateAddress(addr) {
  const a = String(addr ?? "").toLowerCase();
  if (isIP(a) === 4) {
    const [p, q] = a.split(".").map(Number);
    return p === 10 || p === 127 || p === 0 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 169 && q === 254) || (p === 100 && q >= 64 && q <= 127);
  }
  return a === "::1" || a === "::" || a.startsWith("fe80:") || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("::ffff:127.");
}

const HIDDEN = Object.freeze([
  ["GET", "/dashboard"],
  ["GET", "/dashboard/app.js"],
  ["GET", "/"],
  ["GET", "/v1/health"],
  ["GET", "/v1/keys"],
  ["GET", "/v1/accounts"],
  ["GET", "/v1/orders"],
  ["GET", "/v1/hooks"],
  ["GET", "/v1/expose"],
  ["POST", "/v1/sign-in"],
  ["POST", "/v1/orders"],
  ["POST", "/api/v1/placeorder"],
  ["GET", "/openapi.yaml"],
]);

const randomToken = () => randomBytes(24).toString("base64url");
const isBridgeAnswer = (r) => Boolean(r?.headers?.["x-request-id"]) && /json/.test(String(r.headers["content-type"] ?? ""));
const problemCode = (r) => {
  try {
    return JSON.parse(r.text)?.code ?? null;
  } catch {
    return null;
  }
};

/**
 * Run the self-check. Local probes go to 127.0.0.1 on each enabled public listener. With `publicUrl` and
 * `allowOutbound: true` it also resolves the host and calls the public address from this computer; without
 * `allowOutbound` no name lookup or outbound request is made at all.
 *
 * @param {{ config: any, request?: Function, lookup?: Function, kinds?: Array<"alerts"|"sheets">, publicUrl?: string | null,
 *   allowOutbound?: boolean, ports?: { alerts?: number, sheets?: number } }} opts
 * @returns {Promise<{ verdict: "good"|"notes"|"not_working"|"unsafe"|"not_exposed", headline: string, items: Array<{ id: string, title: string, status: "pass"|"warn"|"fail"|"skipped", severity?: "blocking"|"setup"|"note", detail: string, fix?: string }> }>}
 */
export async function runSelfCheck({ config, request = defaultTransport, lookup = (h) => dnsLookup(h, { all: true }), kinds, publicUrl = null, allowOutbound = false, ports = {} }) {
  const s = config.server;
  const enabled = [s.publicIngress.enabled ? "alerts" : null, s.sheetsIngress?.enabled ? "sheets" : null].filter(Boolean);
  const run = (kinds && kinds.length ? kinds : enabled).filter((k) => INTEGRATIONS.includes(k));
  const items = [];
  const add = (item) => items.push(item);
  if (!run.length) {
    return { verdict: "not_exposed", headline: "No public listener is turned on, so there is nothing to check. Run mc-bridge expose to set one up.", items };
  }
  for (const kind of run) {
    const l = kind === "alerts" ? s.publicIngress : s.sheetsIngress;
    const port = ports[kind] ?? l.port;
    const name = kind === "alerts" ? "Alerts listener" : "Sheets listener";
    const path = kind === "alerts" ? "server.publicIngress" : "server.sheetsIngress";
    const probe = async (o) => {
      try {
        return await request({ protocol: "http:", host: "127.0.0.1", port, timeoutMs: 6000, ...o, headers: { host: `127.0.0.1:${port}`, ...(o.headers ?? {}) } });
      } catch (err) {
        return { error: err };
      }
    };
    const tok = `/hooks/generic/${randomToken()}`;
    // 1. does it answer, and only as its kind of listener?
    const first = kind === "alerts" ? await probe({ method: "POST", path: tok, headers: { "content-type": "application/json" }, body: "{}" }) : await probe({ method: "GET", path: "/xl/ltp?symbol=NSE:NIFTY" });
    if (first.error) {
      add({ id: `${kind}-answers`, title: `${name} answers on port ${port}`, status: "fail", severity: "setup", detail: `Nothing answered on 127.0.0.1:${port} (${first.error.code ?? first.error.message}).`, fix: enabled.includes(kind) ? `Start the Bridge, or restart it if you just changed ${path} (${RESTART_SENTENCE})` : `Turn it on first: mc-bridge expose ${kind}.` });
      continue; // the rest cannot be tested without an answer
    }
    if (first.status === 429) {
      add({ id: `${kind}-answers`, title: `${name} answers on port ${port}`, status: "fail", severity: "setup", detail: "It answered 429: the request cap for this address was reached in the last minute, so the checks cannot run now.", fix: "Wait a minute and run the check again." });
      continue;
    }
    const expected = kind === "alerts" ? first.status === 404 : first.status === 401;
    add({ id: `${kind}-answers`, title: `${name} answers on port ${port}`, status: expected ? "pass" : "fail", severity: expected ? undefined : "setup", detail: expected ? "It answered the way a listener of this kind should." : `It answered ${first.status}, not ${kind === "alerts" ? "404 (unknown webhook)" : "401 (no key)"}.`, ...(expected ? {} : { fix: kind === "sheets" ? "Check that the spreadsheet routes (/xl) are available: mc-bridge doctor." : "Check that the webhook routes are available: mc-bridge doctor." }) });

    // 2. nothing else answers
    const leaks = [];
    const hidden = [...HIDDEN, ...(kind === "alerts" ? [["GET", "/xl/ltp?symbol=NSE:NIFTY"]] : [["POST", tok], ["POST", "/xl/ltp?symbol=NSE:NIFTY"]])];
    for (const [method, p] of hidden) {
      const r = await probe({ method, path: p, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) });
      if (r.error || r.status !== 404) leaks.push(`${method} ${p.split("?")[0]} -> ${r.error ? (r.error.code ?? "error") : r.status}`);
    }
    add({
      id: `${kind}-hides-rest`,
      title: `${name} does not serve the dashboard or the API`,
      status: leaks.length ? "fail" : "pass",
      severity: leaks.length ? "blocking" : undefined,
      detail: leaks.length ? `These should be 404 and were not: ${leaks.join("; ")}.` : `${hidden.length} routes (dashboard, keys, orders, sign-in${kind === "alerts" ? ", spreadsheet" : ", webhooks"}) all answered 404.`,
      ...(leaks.length ? { fix: `Turn the tunnel off now. This port is serving more than it should: check that ${port} really is the ${kind} listener and not the main port (${s.port}).` } : {}),
    });

    // 3. foreign Host and Origin refused
    const hostProbe = await probe(kind === "alerts" ? { method: "POST", path: tok, headers: { host: "self-check.invalid", "content-type": "application/json" }, body: "{}" } : { method: "GET", path: "/xl/ltp?symbol=NSE:NIFTY", headers: { host: "self-check.invalid" } });
    const hostOk = !hostProbe.error && hostProbe.status === 403;
    add({ id: `${kind}-host-refused`, title: `${name}: a request for a foreign host name is refused`, status: hostOk ? "pass" : "fail", severity: hostOk ? undefined : "blocking", detail: hostOk ? "A made-up host name got 403." : `A made-up host name got ${hostProbe.error ? (hostProbe.error.code ?? "an error") : hostProbe.status}, not 403.`, ...(hostOk ? {} : { fix: `Remove any "*" or catch-all from ${path}.allowedHosts and restart.` }) });
    const originProbe = await probe(kind === "alerts" ? { method: "POST", path: tok, headers: { origin: "https://self-check.invalid", "content-type": "application/json" }, body: "{}" } : { method: "GET", path: "/xl/ltp?symbol=NSE:NIFTY", headers: { origin: "https://self-check.invalid" } });
    const originOk = !originProbe.error && originProbe.status === 403;
    add({ id: `${kind}-origin-refused`, title: `${name}: a web page from another site is refused`, status: originOk ? "pass" : "fail", severity: originOk ? undefined : "blocking", detail: originOk ? "A browser-style request from a foreign origin got 403." : `It got ${originProbe.error ? (originProbe.error.code ?? "an error") : originProbe.status}, not 403.`, ...(originOk ? {} : { fix: "Remove any origin you do not recognise from cors.allowedOrigins." }) });

    // 4. body cap (alerts only: the Sheets listener takes no body)
    if (kind === "alerts") {
      const big = await probe({ method: "POST", path: tok, headers: { "content-type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(20_000) }) });
      const capped = !big.error && big.status === 413;
      add({ id: "alerts-body-cap", title: `${name}: an oversized alert is refused`, status: capped ? "pass" : "fail", severity: capped ? undefined : "note", detail: capped ? "A 20 KB message got 413 (the limit for alerts is 16 KB)." : `A 20 KB message got ${big.error ? (big.error.code ?? "an error") : big.status}, not 413.`, ...(capped ? {} : { fix: "Update the Bridge: the alerts listener should cap the body at 16 KB." }) });
    } else {
      add({ id: "sheets-limits", title: `${name}: read-only keys and a request cap apply`, status: "pass", detail: `Only read-only keys are accepted here, and each caller address is limited to ${l.requestsPerMinute} requests a minute.` });
    }
  }

  // 5. the public address (outbound, only when asked for)
  if (publicUrl) {
    if (!allowOutbound) {
      add({ id: "public-url", title: "Public address", status: "skipped", severity: "note", detail: "Not tested: testing it sends requests from this computer to that address and looks up its name. Run again with allow-outbound to do that." });
    } else {
      for (const it of await checkPublicUrl({ config, publicUrl, request, lookup, kinds: run })) add(it);
    }
  }

  const failed = items.filter((i) => i.status === "fail");
  const verdict = failed.some((i) => i.severity === "blocking") ? "unsafe" : failed.some((i) => i.severity === "setup") ? "not_working" : failed.length || items.some((i) => i.status === "warn") ? "notes" : "good";
  const headline = {
    unsafe: "Unsafe: turn the tunnel off until this is fixed. Something other than the intended routes answers, or a foreign host is accepted.",
    not_working: "Not working yet: the safety rules hold, but the address does not reach the Bridge. Follow the fix on each failed line.",
    notes: "Safe, with notes below.",
    good: "Good: only the intended routes answer, and foreign hosts and pages are refused.",
  }[verdict];
  return { verdict, headline, items };
}

/** The public-address part of the self-check. Only called with outbound allowed. */
async function checkPublicUrl({ config, publicUrl, request, lookup, kinds }) {
  const items = [];
  let u;
  try {
    u = new URL(publicUrl);
  } catch {
    return [{ id: "public-url", title: "Public address", status: "fail", severity: "setup", detail: `"${publicUrl}" is not a web address.`, fix: "Use the full address, for example https://hooks.example.com." }];
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return [{ id: "public-url", title: "Public address", status: "fail", severity: "setup", detail: "The address must start with https:// (or http://).", fix: "Use https://your-host." }];
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  const wantsAlerts = kinds.includes("alerts");
  if (wantsAlerts && port !== 80 && port !== 443) {
    items.push({ id: "public-port", title: "TradingView can call this port", status: "fail", severity: "setup", detail: `The address uses port ${port}. TradingView only calls port 80 and 443 (its help page says so).`, fix: "Use a tunnel or proxy on the standard HTTPS port, without a port number in the address." });
  } else items.push({ id: "public-port", title: "Address uses a standard port", status: "pass", detail: `Port ${port}.` });
  if (u.protocol === "http:") items.push({ id: "public-tls", title: "The address uses HTTPS", status: "warn", severity: "note", detail: "Plain http: the secret in the address travels unencrypted.", fix: "Use a tunnel or proxy that terminates HTTPS." });

  const host = u.hostname.toLowerCase();
  const kind = wantsAlerts ? "alerts" : kinds[0];
  const l = kind === "alerts" ? config.server.publicIngress : config.server.sheetsIngress;
  const listed = (l.allowedHosts ?? []).includes(host) || (l.allowedHosts ?? []).includes(u.host.toLowerCase());
  items.push({ id: "public-host-listed", title: "The host is on the listener's allowed list", status: listed ? "pass" : "fail", severity: listed ? undefined : "setup", detail: listed ? `${host} is in allowedHosts.` : `${host} is not in ${kind === "alerts" ? "server.publicIngress" : "server.sheetsIngress"}.allowedHosts, so the Bridge answers it with 403.`, ...(listed ? {} : { fix: `Run: mc-bridge expose ${kind} --host ${host}, then restart the Bridge.` }) });

  if (isIP(host) === 0) {
    let addrs = [];
    try {
      const r = await lookup(host);
      addrs = (Array.isArray(r) ? r : [r]).map((x) => (typeof x === "string" ? x : x.address)).filter(Boolean);
    } catch (err) {
      items.push({ id: "public-dns", title: "The host name resolves", status: "fail", severity: "setup", detail: `The name ${host} did not resolve (${err.code ?? err.message}).`, fix: "Check the DNS record. A new record can take several minutes." });
      return items;
    }
    const priv = addrs.filter(isPrivateAddress);
    items.push(
      priv.length
        ? { id: "public-dns", title: "The host name resolves to a public address", status: "warn", severity: "note", detail: `${host} resolves to ${priv.join(", ")}, a private address. From the internet it may resolve differently, but check the DNS record.`, fix: "Point the record at your tunnel or at the VPS's public address." }
        : { id: "public-dns", title: "The host name resolves", status: "pass", detail: `${host} -> ${addrs.join(", ") || "(no address)"}.` },
    );
  }

  const target = { protocol: u.protocol, host, port, timeoutMs: 8000, headers: { host: u.host } };
  const call = async (method, path, extra = {}) => {
    try {
      return await request({ ...target, method, path, ...extra });
    } catch (err) {
      return { error: err };
    }
  };
  const tok = `/hooks/generic/${randomToken()}`;
  const reach = wantsAlerts ? await call("POST", tok, { headers: { ...target.headers, "content-type": "application/json" }, body: "{}" }) : await call("GET", "/xl/ltp?symbol=NSE:NIFTY");
  const failReach = (detail, fix) => items.push({ id: "public-reach", title: "The public address reaches the Bridge", status: "fail", severity: "setup", detail, fix });
  if (reach.error) {
    failReach(`The call failed before any answer (${reach.error.code ?? reach.error.message}).`, /CERT|SSL|TLS/i.test(String(reach.error.code ?? reach.error.message)) ? "The HTTPS certificate is not valid for this host: check the tunnel or proxy certificate." : "Check that the tunnel or proxy is running and the DNS record is in place.");
    return items;
  }
  if (isBridgeAnswer(reach) && reach.status === 403 && problemCode(reach) === "HOST_NOT_ALLOWED") failReach("The Bridge answered 403: it does not know this host name.", `Add ${host} to ${wantsAlerts ? "server.publicIngress" : "server.sheetsIngress"}.allowedHosts (mc-bridge expose ${kind} --host ${host}) and restart the Bridge.`);
  else if (!isBridgeAnswer(reach)) failReach(`Something answered ${reach.status}, but it was not the Bridge (the tunnel or proxy itself, or another program).`, reach.status >= 500 ? "The tunnel or proxy is up but cannot reach the Bridge: check it points at the listener port, and that the Bridge is running." : "Check that the tunnel or proxy points at the listener port on this computer.");
  else if (wantsAlerts ? reach.status !== 404 : reach.status !== 401) failReach(`The Bridge answered ${reach.status}, not what a ${wantsAlerts ? "alerts" : "Sheets"} listener answers to a probe.`, "Check which port the tunnel or proxy points at.");
  else items.push({ id: "public-reach", title: "The public address reaches the Bridge", status: "pass", detail: "The Bridge answered through that address." });

  const exposed = [];
  for (const [method, p] of [["GET", "/dashboard"], ["GET", "/v1/keys"], ["GET", "/v1/health"]]) {
    const r = await call(method, p);
    if (!r.error && r.headers?.["x-request-id"] && r.status !== 404 && r.status !== 403) exposed.push(`${method} ${p} -> ${r.status}`);
  }
  items.push({ id: "public-hides-rest", title: "The public address does not serve the dashboard or the API", status: exposed.length ? "fail" : "pass", severity: exposed.length ? "blocking" : undefined, detail: exposed.length ? `The Bridge answered where it should not: ${exposed.join("; ")}.` : "The dashboard and the API routes are not reachable through that address.", ...(exposed.length ? { fix: `Turn the tunnel off now and point it at port ${l.port}, not the main port ${config.server.port}.` } : {}) });
  return items;
}

/** The self-check as lines of text for a terminal. */
export function formatSelfCheck(result) {
  const mark = { pass: "OK  ", warn: "NOTE", fail: "FAIL", skipped: "SKIP" };
  const lines = [];
  for (const i of result.items) {
    lines.push(`${mark[i.status]}  ${i.title}`);
    lines.push(`      ${i.detail}`);
    if (i.fix && i.status !== "pass") lines.push(`      Fix: ${i.fix}`);
  }
  lines.push("", result.headline);
  return lines.join("\n");
}
