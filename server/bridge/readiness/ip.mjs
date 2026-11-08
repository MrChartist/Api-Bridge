/**
 * IP address helpers for the readiness egress check. Pure functions.
 *
 *  normaliseIp(s)        -> { ip, family: "ipv4"|"ipv6" } | null   trimmed; "::ffff:a.b.c.d" becomes IPv4; IPv4 must be four
 *                           0-255 decimal octets without leading zeros; IPv6 lower-cased and expanded to 8 groups; zone ids
 *                           ("%eth0") are refused
 *  sameIp(a, b)          -> boolean                                    both parse and are the same address
 *  parseLookupBody(text, contentType) -> { ip, family } | { error }    text/plain: first line; JSON: ip, query or origin
 *                           (first token before a comma); at most 1 KB
 */
import { isIPv6 } from "node:net";

export const LOOKUP_BODY_MAX_BYTES = 1024;

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** Expand a valid IPv6 text to 8 lower-case groups without leading zeros ("2001:db8:0:0:0:0:0:1"). */
function expandV6(text) {
  let s = text.toLowerCase();
  // An embedded IPv4 tail (::ffff:1.2.3.4 is handled by the caller; others such as 64:ff9b::1.2.3.4) becomes two groups.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    if (!V4.test(tail[1])) return null;
    const o = tail[1].split(".").map(Number);
    s = `${s.slice(0, -tail[1].length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => Number.parseInt(g, 16).toString(16)).join(":");
}

/**
 * @param {unknown} s
 * @returns {{ ip: string, family: "ipv4"|"ipv6" } | null}
 */
export function normaliseIp(s) {
  if (typeof s !== "string") return null;
  let t = s.trim();
  if (!t || t.length > 64) return null;
  if (t.startsWith("[") && t.endsWith("]")) t = t.slice(1, -1);
  if (t.includes("%")) return null; // zone ids are local to one machine and never what a broker registers
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(t);
  if (mapped) t = mapped[1];
  if (V4.test(t)) return { ip: t, family: "ipv4" };
  if (!t.includes(":") || !isIPv6(t)) return null;
  const ip = expandV6(t);
  return ip ? { ip, family: "ipv6" } : null;
}

/** Same address (after normalising both); false when either does not parse. */
export function sameIp(a, b) {
  const x = normaliseIp(a);
  const y = normaliseIp(b);
  return Boolean(x && y && x.ip === y.ip);
}

/**
 * Read the address out of an IP-echo service's answer.
 * @param {string} text
 * @param {string | null | undefined} contentType
 * @returns {{ ip: string, family: "ipv4"|"ipv6" } | { error: string }}
 */
export function parseLookupBody(text, contentType) {
  const body = typeof text === "string" ? text : "";
  if (Buffer.byteLength(body, "utf8") > LOOKUP_BODY_MAX_BYTES) return { error: "The lookup service answered with more than 1 KB." };
  const ct = String(contentType ?? "").toLowerCase();
  let candidate = null;
  const trimmed = body.trim();
  if (ct.includes("json") || trimmed.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { error: "The lookup service's answer is not valid JSON." };
    }
    const v = parsed && typeof parsed === "object" ? parsed.ip ?? parsed.query ?? parsed.origin : null;
    if (typeof v !== "string") return { error: "The lookup service's JSON has no ip, query or origin field." };
    candidate = v.split(",")[0];
  } else {
    candidate = trimmed.split(/\r?\n/)[0] ?? "";
  }
  const n = normaliseIp(candidate);
  return n ?? { error: "The lookup service did not answer with an IP address." };
}
