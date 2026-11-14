/**
 * Where a webhook may point. A webhook makes the Bridge call a URL somebody typed in, from a computer that sits inside a
 * home or office network, so the rules are strict and are checked twice: once when the URL is saved (so a person gets a
 * clear refusal) and again before every delivery, on the addresses the name resolves to at that moment (so a name that
 * later points inside the network is caught). The delivery then connects to the address it just checked, not to a second
 * lookup (see transport.mjs), which closes the gap a DNS-rebinding trick needs.
 *
 * Default rules:
 *  - https only; no user name or password in the URL; no trailing-dot or empty host;
 *  - the host is not `localhost`, a local-network name (.local, .internal, .lan ...), or a cloud metadata name;
 *  - every address the host resolves to (or the address in the URL) is public: never loopback, private (10/8, 172.16/12,
 *    192.168/16), link-local (169.254/16, fe80::/10), carrier-grade NAT, unique-local, multicast, reserved, documentation,
 *    or an IPv4 address wrapped inside IPv6;
 *  - the cloud metadata addresses (169.254.169.254, 100.100.100.200, 168.63.129.16, fd00:ec2::254 ...) are refused ALWAYS,
 *    even when private targets are allowed;
 *  - when `webhooks.allowedHosts` is not empty, the host must match one of its entries.
 * `webhooks.allowPrivateTargets: true` (config file only) lets http:// and loopback / private addresses through, for a
 * receiver on the same computer or LAN.
 */
import net from "node:net";

export const MAX_URL_LENGTH = 2048;

const METADATA_ADDRESSES = new Set(["169.254.169.254", "169.254.170.2", "169.254.170.23", "100.100.100.200", "168.63.129.16", "192.0.0.192", "fd00:ec2::254", "fd00:ec2:0:0:0:0:0:254"]);
const METADATA_HOSTS = new Set(["metadata", "metadata.google.internal", "metadata.goog", "instance-data", "instance-data.ec2.internal", "metadata.azure.com"]);
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".private", ".localdomain", ".home.arpa"];

/** Plain explanations, one per refusal code. Shown to people; never carry the URL's path or query. */
export const TARGET_PROBLEMS = Object.freeze({
  bad_url: "The URL is missing, too long or does not parse.",
  blocked_scheme: "Only https:// URLs are allowed. (A receiver on this computer or your own network needs events.webhooks.allowPrivateTargets in the config file.)",
  blocked_credentials: "A URL may not contain a user name or password. Put the secret in the signing secret instead.",
  blocked_host: "This host is not allowed: localhost, local-network and cloud metadata names are refused.",
  blocked_address: "This address is not allowed: private, loopback, link-local and cloud metadata addresses are refused. (Your own receiver on this computer or network needs events.webhooks.allowPrivateTargets in the config file.)",
  host_not_listed: "This host is not on events.webhooks.allowedHosts in the config file.",
  dns_failed: "The host name could not be looked up.",
});

/** The eight 16-bit groups of an IPv6 address, or null. */
function groupsV6(ip) {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const toNums = (part) => (part ? part.split(":") : []);
  let head = toNums(halves[0]);
  let tail = toNums(halves[1] ?? "");
  const last = (halves[1] ?? halves[0]).split(":").at(-1);
  const dotted = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(last ?? "");
  if (dotted) {
    const hex = [((+dotted[1] << 8) | +dotted[2]).toString(16), ((+dotted[3] << 8) | +dotted[4]).toString(16)];
    if (halves.length === 2) tail = [...tail.slice(0, -1), ...hex];
    else head = [...head.slice(0, -1), ...hex];
  }
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const nums = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.length === 8 && nums.every(Number.isFinite) ? nums : null;
}

/** The IPv4 address inside an IPv6 one (mapped ::ffff:a.b.c.d, NAT64 64:ff9b::, 6to4 2002:), or null. */
function embeddedV4(ip) {
  const g = groupsV6(ip);
  if (!g) return null;
  const dotted = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return dotted(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b) return dotted(g[6], g[7]);
  if (g[0] === 0x2002) return dotted(g[1], g[2]);
  return null;
}

/** True for an address that must never be called, whatever the config says. @param {string} ip */
export function isMetadataAddress(ip) {
  const a = String(ip).replace(/^\[|\]$/g, "").toLowerCase();
  if (METADATA_ADDRESSES.has(a)) return true;
  if (!a.includes(":")) return false;
  const inner = embeddedV4(a);
  if (inner && METADATA_ADDRESSES.has(inner)) return true;
  const g = groupsV6(a);
  return Boolean(g && g[0] === 0xfd00 && g[1] === 0x0ec2 && g.slice(2, 7).every((x) => x === 0) && g[7] === 0x254);
}

const dottedV4 = (ip) => {
  const p = ip.split(".").map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
};

/** IPv4 ranges that are not the public internet: this host, private, loopback, shared (CGNAT), link-local, benchmark, documentation, multicast, reserved. */
function privateV4(p) {
  const [a, b, c] = p;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/**
 * True when an address is not a public one: any of the IPv4 ranges above, IPv6 loopback, unspecified, link-local, unique-local,
 * multicast, documentation and discard ranges, an IPv4 address wrapped in IPv6 (mapped, NAT64, 6to4), and anything that does not
 * parse (an address we cannot read is never called).
 * @param {string} address
 */
export function isPrivateAddress(address) {
  const ip = String(address).replace(/^\[|\]$/g, "").split("%")[0];
  if (net.isIPv4(ip)) return privateV4(dottedV4(ip));
  if (!net.isIPv6(ip)) return true;
  const g = groupsV6(ip.toLowerCase());
  if (!g) return true;
  if (g.every((x) => x === 0) || (g.slice(0, 7).every((x) => x === 0) && g[7] === 1)) return true; // :: and ::1
  const inner = embeddedV4(ip.toLowerCase());
  if (inner) return privateV4(dottedV4(inner));
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0) return privateV4(dottedV4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`)); // ::a.b.c.d
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated, still routed on some networks)
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return true; // 3fff::/20 documentation
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return true; // ::ffff:0:a.b.c.d (SIIT)
  if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] === 0)) return true; // documentation, Teredo
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard
  return false;
}

/** @param {string} address  @param {boolean} allowPrivate  @returns {boolean} true when the address may be called */
export function addressAllowed(address, allowPrivate) {
  if (isMetadataAddress(address)) return false;
  if (allowPrivate) return net.isIP(String(address).replace(/^\[|\]$/g, "")) !== 0;
  return !isPrivateAddress(address);
}

const hostListed = (patterns, host) => patterns.some((p) => (p.startsWith("*.") ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === p));

/**
 * Check a URL as written. Pure: no lookup.
 * @param {unknown} raw
 * @param {{ allowPrivateTargets?: boolean, allowedHosts?: string[] }} [policy]
 * @returns {{ ok: true, url: URL, host: string, ipLiteral: string | null } | { ok: false, code: keyof typeof TARGET_PROBLEMS, message: string }}
 */
export function checkTargetUrl(raw, { allowPrivateTargets = false, allowedHosts = [] } = {}) {
  const no = (code) => ({ ok: false, code, message: TARGET_PROBLEMS[code] });
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH || /[\u0000-\u001f\u007f\s]/.test(raw)) return no("bad_url");
  let url;
  try {
    url = new URL(raw);
  } catch {
    return no("bad_url");
  }
  if (url.protocol !== "https:" && !(allowPrivateTargets && url.protocol === "http:")) return no("blocked_scheme");
  if (url.username || url.password) return no("blocked_credentials");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host.endsWith(".")) return no("bad_url");
  const ipLiteral = net.isIP(host) ? host : null;
  if (METADATA_HOSTS.has(host)) return no("blocked_host");
  if (!ipLiteral && !allowPrivateTargets && (host === "localhost" || !host.includes(".") || LOCAL_SUFFIXES.some((s) => host.endsWith(s)))) return no("blocked_host");
  if (ipLiteral && !addressAllowed(ipLiteral, allowPrivateTargets)) return no("blocked_address");
  if (allowedHosts.length && !hostListed(allowedHosts, host)) return no("host_not_listed");
  return { ok: true, url, host, ipLiteral };
}

/**
 * Look the host up and check EVERY address it resolves to. One bad address refuses the delivery (a name that answers with
 * a mix of public and private addresses is how rebinding tricks start).
 * @param {{ host: string, ipLiteral: string | null }} target
 * @param {{ resolve: (host: string) => Promise<Array<{ address: string, family: number }>>, allowPrivateTargets?: boolean }} opts
 * @returns {Promise<{ ok: true, address: string, family: 4 | 6 } | { ok: false, code: "dns_failed" | "blocked_address", message: string }>}
 */
export async function resolveAllowed(target, { resolve, allowPrivateTargets = false }) {
  if (target.ipLiteral) return { ok: true, address: target.ipLiteral, family: net.isIPv6(target.ipLiteral) ? 6 : 4 };
  let list;
  try {
    list = await resolve(target.host);
  } catch {
    return { ok: false, code: "dns_failed", message: TARGET_PROBLEMS.dns_failed };
  }
  if (!Array.isArray(list) || list.length === 0) return { ok: false, code: "dns_failed", message: TARGET_PROBLEMS.dns_failed };
  for (const a of list) {
    if (typeof a?.address !== "string" || !addressAllowed(a.address, allowPrivateTargets)) return { ok: false, code: "blocked_address", message: TARGET_PROBLEMS.blocked_address };
  }
  const first = list[0];
  return { ok: true, address: first.address, family: net.isIPv6(first.address) ? 6 : 4 };
}

/** What a person sees in lists: the host (and port) only. The path and query may be a secret. @param {URL} url */
export const displayTarget = (url) => `${url.protocol}//${url.host}${url.pathname !== "/" || url.search ? "/…" : ""}`;
