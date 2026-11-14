/**
 * Network policy for source plugins: which host names a manifest may ask for, which addresses a plugin may never
 * reach, and the check the host runs on every URL a plugin asks it to fetch. Pure: no I/O, no clock.
 *
 * The plugin cannot be stopped from opening its own sockets on Node 22 (the permission model has no network flag), so
 * these rules govern the honest path: every request that goes through the host is checked here first.
 */
import net from "node:net";

/**
 * Domains of the brokers the Bridge talks to. A plugin may never be given one of these: broker hosts take
 * credentials and orders, and a plugin is read-only market data. Matched as the domain itself or any subdomain.
 */
export const BROKER_HOST_SUFFIXES = Object.freeze([
  "5paisa.com", "aliceblueonline.com", "angelone.in", "arrow.trade", "axisdirect.in", "bigul.co", "compositedge.com",
  "definedgesecurities.com", "dhan.co", "dhanhq.co", "fyers.in", "flattrade.in", "groww.in", "gwcindia.in",
  "hdfcsec.com", "hdfcsky.com", "ibullssecurities.com", "icicidirect.com", "iifl.com", "iiflcapital.com",
  "indstocks.com", "jainam.in", "kite.trade", "kotaksecurities.com", "motilaloswal.com", "mstock.com", "mstock.trade",
  "mynt.in", "nubra.io", "paytmmoney.com", "pocketful.in", "profitmart.in", "rathi.com", "rmoneyindia.co.in",
  "rupeezy.in", "samco.in", "shoonya.com", "stocknote.com", "symphonyfintech.com", "tradejini.com",
  "tradesmartonline.in", "upstox.com", "wisdomcapital.in", "zerodha.com",
  // Hosts the in-tree adapters talk to that no suffix above covers (found by the adapter scan in netpolicy.test.mjs, which
  // fails when a new adapter host is missing here): Firstock's own domain, Zebu's Firebase-hosted API, and two broker-owned
  // storage buckets (exact hosts: amazonaws.com itself is shared and cannot be listed).
  "firstock.in", "zebumyntapi.web.app", "bigul.s3.ap-south-1.amazonaws.com", "flattrade.s3.ap-south-1.amazonaws.com",
]);

/**
 * Public suffixes with more than one label (a registry hands out names directly below them to anyone), a small built-in
 * list of the common ones. A wildcard such as `*.co.uk` would cover every site under it. Not the whole public suffix list:
 * sharedDomainReason() also treats a two-letter country code with a generic second label (`co`, `com`, `org`, `gov`...) as one.
 */
export const PUBLIC_SUFFIXES = Object.freeze([
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "ac.uk", "gov.uk", "sch.uk",
  "co.in", "net.in", "org.in", "firm.in", "gen.in", "ind.in", "ac.in", "edu.in", "res.in", "gov.in", "nic.in",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.nz", "org.nz", "net.nz", "co.za", "org.za", "web.za",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "co.kr", "or.kr", "com.cn", "net.cn", "org.cn", "com.hk", "com.sg", "com.my",
  "com.br", "net.br", "org.br", "com.mx", "com.ar", "com.tr", "com.tw", "com.ua", "com.pk", "com.bd", "com.ng", "co.ke",
  "com.eg", "com.sa", "com.ph", "com.vn", "co.th", "in.th", "co.id", "co.il", "com.pl", "com.ru", "com.de", "com.es", "com.fr",
]);

/**
 * Domains where anyone can get a subdomain (hosting, static sites, functions, tunnels, storage). A wildcard over one of
 * them (`*.herokuapp.com`) would let any tenant of that service answer as the vendor. A SPECIFIC name below one
 * (`*.myvendor.vercel.app`, `api.myvendor.herokuapp.com`) is one owner's and is allowed.
 */
export const SHARED_HOSTING_DOMAINS = Object.freeze([
  "herokuapp.com", "herokudns.com", "vercel.app", "now.sh", "netlify.app", "netlify.com", "github.io", "githubusercontent.com", "gitlab.io",
  "pages.dev", "workers.dev", "web.app", "firebaseapp.com", "appspot.com", "run.app", "cloudfunctions.net", "googleusercontent.com", "googleapis.com",
  "azurewebsites.net", "azurestaticapps.net", "blob.core.windows.net", "cloudapp.azure.com", "trafficmanager.net", "windows.net",
  "amazonaws.com", "s3.amazonaws.com", "cloudfront.net", "elasticbeanstalk.com", "awsglobalaccelerator.com", "execute-api.amazonaws.com",
  "onrender.com", "fly.dev", "railway.app", "up.railway.app", "glitch.me", "repl.co", "replit.app", "replit.dev", "surge.sh", "deno.dev",
  "ngrok.io", "ngrok-free.app", "ngrok.app", "trycloudflare.com", "loca.lt", "localtunnel.me", "serveo.net",
  "blogspot.com", "wordpress.com", "wixsite.com", "weebly.com", "myshopify.com", "squarespace.com", "bubbleapps.io", "webflow.io",
  "000webhostapp.com", "infinityfreeapp.com", "rf.gd", "dynu.net", "duckdns.org", "no-ip.com", "no-ip.org", "ddns.net", "hopto.org", "zapto.org",
  "ondigitalocean.app", "digitaloceanspaces.com", "supabase.co", "neon.tech", "streamlit.app", "hf.space", "vercel.dev", "stackblitz.io",
]);

const GENERIC_SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "edu", "gov", "gob", "go", "ne", "or", "nic", "mil", "ltd", "plc", "sch", "me", "firm", "gen", "ind"]);

/**
 * Why a wildcard over `body` (the part after `*.`) would be too wide, or null when it is a domain one party can own: not a
 * known public suffix (or a two-letter country code with a generic second label) and not a shared-hosting domain itself.
 * A name one label below such a domain is fine.
 */
export function sharedDomainReason(body) {
  const labels = body.split(".");
  if (PUBLIC_SUFFIXES.includes(body) || (labels.length === 2 && labels[1].length === 2 && GENERIC_SECOND_LEVEL.has(labels[0]))) {
    return `a wildcard over the public suffix ${body} would cover every site registered under it. Name the vendor's own domain, for example *.vendor.${body}, or list exact hosts`;
  }
  if (SHARED_HOSTING_DOMAINS.includes(body)) {
    return `a wildcard over ${body} would cover every customer of that shared hosting service, not only the vendor. Name the vendor's own subdomain (for example *.vendor.${body}) or list exact hosts`;
  }
  return null;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Top-level names that never leave this computer or its network. */
const LOCAL_TLDS = new Set(["localhost", "local", "internal", "intranet", "lan", "home", "corp", "private", "localdomain", "onion"]);

/** True when `host` (lowercase, no port) is a broker domain or a subdomain of one. */
export function isBrokerHost(host, extra = []) {
  const h = String(host).toLowerCase().replace(/\.$/, "");
  return [...BROKER_HOST_SUFFIXES, ...extra].some((s) => h === s || h.endsWith(`.${s}`));
}

/**
 * Why a manifest `network.allowHosts` entry is not acceptable, or null when it is. Allowed: `host.example.com` and
 * `*.example.com` (one leading wildcard, at least two labels after it). No IP addresses, no ports, no paths, no
 * localhost or local-network names, no broker domains.
 * @param {unknown} pattern
 * @returns {string|null}
 */
export function checkHostPattern(pattern) {
  if (typeof pattern !== "string" || !pattern) return "must be a non-empty string";
  if (pattern !== pattern.toLowerCase()) return "must be lowercase";
  if (/[\s/:@?#\\]/.test(pattern)) return "must be a bare host name (no scheme, port, path or credentials)";
  const wildcard = pattern.startsWith("*.");
  const body = wildcard ? pattern.slice(2) : pattern;
  if (body.includes("*")) return "a wildcard is only allowed as a single leading `*.`";
  if (body.endsWith(".") || body.startsWith(".")) return "must not start or end with a dot";
  const labels = body.split(".");
  if (labels.length < 2) return "must be a full host name such as api.example.com";
  if (labels.some((l) => !LABEL.test(l))) return "has an invalid label (letters, digits and dashes only)";
  if (/^\d+$/.test(labels.at(-1))) return "IP addresses are not allowed; use a host name";
  if (net.isIP(body)) return "IP addresses are not allowed; use a host name";
  if (LOCAL_TLDS.has(labels.at(-1)) || body === "localhost") return "local-network names are not allowed";
  if (isBrokerHost(body)) return "broker domains are never allowed for a plugin";
  if (wildcard) return sharedDomainReason(body);
  return null;
}

/** True when `host` matches one of the manifest patterns (`a.b.com` exactly, or `*.b.com` for any subdomain of b.com). */
export function hostMatches(patterns, host) {
  const h = String(host).toLowerCase();
  return patterns.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p));
}

const v4 = (ip) => {
  const p = ip.split(".").map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
};

function privateV4(p) {
  const [a, b, c] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** Expand an IPv6 address to eight 16-bit groups, or null when it does not parse. */
function groupsV6(ip) {
  let s = ip.split("%")[0].toLowerCase();
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    const q = v4(m[2]);
    if (!q) return null;
    s = `${m[1]}${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const nums = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.length === 8 && nums.every(Number.isFinite) ? nums : null;
}

/**
 * True when an address must never be reached by a plugin: loopback, private, link-local, carrier-grade NAT, documentation,
 * multicast and reserved ranges, IPv4 inside IPv6 (mapped, translated, 6to4), and anything that does not parse.
 * @param {string} address
 */
export function isPrivateAddress(address) {
  const ip = String(address).replace(/^\[|\]$/g, "");
  if (net.isIPv4(ip)) return privateV4(v4(ip));
  if (!net.isIPv6(ip)) return true;
  const g = groupsV6(ip);
  if (!g) return true;
  const embedded = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return privateV4(embedded(g[6], g[7])); // ::ffff:a.b.c.d, ::a.b.c.d (also ::, ::1)
  if (g[0] === 0x64 && g[1] === 0xff9b) return privateV4(embedded(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return privateV4(embedded(g[1], g[2])); // 6to4
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] === 0)) return true; // documentation, Teredo
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard prefix
  return false;
}

const MAX_URL_LENGTH = 2048;

/**
 * Check a URL a plugin asked the host to fetch. Pure: DNS is checked later, at connection time, by the broker.
 * @param {unknown} raw
 * @param {{ allowHosts: string[], denyExtra?: string[] }} policy
 * @returns {{ ok: true, url: URL } | { ok: false, code: "BAD_REQUEST"|"HOST_NOT_ALLOWED", message: string }}
 */
export function checkOutboundUrl(raw, { allowHosts, denyExtra = [] }) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return { ok: false, code: "BAD_REQUEST", message: "the URL is missing or too long" };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: "BAD_REQUEST", message: "the URL does not parse" };
  }
  if (url.protocol !== "https:") return { ok: false, code: "HOST_NOT_ALLOWED", message: "only https URLs are allowed" };
  if (url.username || url.password) return { ok: false, code: "HOST_NOT_ALLOWED", message: "URLs with credentials are not allowed" };
  if (url.port && url.port !== "443") return { ok: false, code: "HOST_NOT_ALLOWED", message: "only the standard https port is allowed" };
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[") || net.isIP(host) || /^[\d.]+$/.test(host)) return { ok: false, code: "HOST_NOT_ALLOWED", message: "IP addresses are not allowed; use a host name" };
  if (host.endsWith(".")) return { ok: false, code: "HOST_NOT_ALLOWED", message: "host names with a trailing dot are not allowed" };
  if (isBrokerHost(host, denyExtra)) return { ok: false, code: "HOST_NOT_ALLOWED", message: "broker hosts are never reachable from a plugin" };
  if (!hostMatches(allowHosts, host)) return { ok: false, code: "HOST_NOT_ALLOWED", message: `${host} is not in the plugin's network.allowHosts` };
  return { ok: true, url };
}
