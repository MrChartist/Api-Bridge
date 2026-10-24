/**
 * The `hooks` config section — stream S11 (owned by the hooks module; core validates it with this schema).
 *
 *   "hooks": {
 *     "queueSize": 200,                 // signals waiting to be processed; a full queue answers 429 (never unbounded)
 *     "concurrency": 2,                 // signals processed at the same time (orders are still rate-capped by safety)
 *     "dedupeWindowMs": 120000,         // the same alert seen again inside this window is acknowledged as a duplicate
 *     "signatureToleranceS": 300,       // generic hooks: |now - t| allowed in X-MCB-Signature (at most 5 minutes)
 *     "maxSignalsPerMinute": 30,        // per hook; more answers 429
 *     "maxHooks": 100,
 *     "allowSourceIps": [],             // global allowlist added to every hook's own list
 *     "clientIpHeader": null            // "cf-connecting-ip" | "x-forwarded-for" | "x-real-ip": trusted ONLY when the
 *                                       //  TCP peer is loopback (a local tunnel such as cloudflared), never otherwise
 *   }
 *
 * Everything is optional; `{}` gives the defaults. Nothing here can switch live trading on: a hook created with
 * mode "live" still needs safety.liveTrading, the account's live.enabled and "webhook" in its live.allowedSources.
 */
import { isIP } from "node:net";
import { z } from "zod";

export const HOOKS_DEFAULTS = Object.freeze({
  queueSize: 200,
  concurrency: 2,
  dedupeWindowMs: 120_000,
  signatureToleranceS: 300,
  maxSignalsPerMinute: 30,
  maxHooks: 100,
  allowSourceIps: [],
  clientIpHeader: null,
});

/** An IPv4/IPv6 address or an IPv4 CIDR block (a.b.c.d/n). */
export const ipEntrySchema = z
  .string()
  .max(64)
  .refine((s) => isIP(s) !== 0 || isIpv4Cidr(s), { message: "use an IP address or an IPv4 CIDR block such as 52.89.0.0/16" });

export const HOOKS_CONFIG_SCHEMA = z
  .object({
    queueSize: z.number().int().min(1).max(5000).default(HOOKS_DEFAULTS.queueSize),
    concurrency: z.number().int().min(1).max(16).default(HOOKS_DEFAULTS.concurrency),
    dedupeWindowMs: z.number().int().min(1000).max(86_400_000).default(HOOKS_DEFAULTS.dedupeWindowMs),
    signatureToleranceS: z.number().int().min(30).max(300).default(HOOKS_DEFAULTS.signatureToleranceS),
    maxSignalsPerMinute: z.number().int().min(1).max(600).default(HOOKS_DEFAULTS.maxSignalsPerMinute),
    maxHooks: z.number().int().min(1).max(1000).default(HOOKS_DEFAULTS.maxHooks),
    allowSourceIps: z.array(ipEntrySchema).max(100).default([]),
    clientIpHeader: z.enum(["cf-connecting-ip", "x-forwarded-for", "x-real-ip"]).nullable().default(null),
  })
  .strict();

/**
 * The effective hooks config: the parsed section when core applied it, else the defaults.
 * @param {any} config
 * @returns {typeof HOOKS_DEFAULTS}
 */
export function hooksConfig(config) {
  const raw = config?.hooks;
  const parsed = HOOKS_CONFIG_SCHEMA.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { ...HOOKS_DEFAULTS };
}

/** @param {string} s */
export function isIpv4Cidr(s) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(s));
  return Boolean(m && isIP(m[1]) === 4 && Number(m[2]) <= 32);
}

const ipv4ToInt = (ip) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);

/** Strip the IPv4-mapped IPv6 prefix and an IPv6 zone. */
export function normaliseIp(ip) {
  let s = String(ip ?? "").trim();
  if (s.startsWith("::ffff:") && isIP(s.slice(7)) === 4) s = s.slice(7);
  const pct = s.indexOf("%");
  if (pct > 0) s = s.slice(0, pct);
  return s.toLowerCase();
}

/** Normalise an allowlist (addresses and CIDR blocks) for ipAllowed. */
export function expandIpList(list) {
  return (list ?? []).map((e) => String(e).toLowerCase());
}

/**
 * Whether `ip` matches any entry of an (expanded) allowlist.
 * @param {string} ip
 * @param {string[]} list
 */
export function ipAllowed(ip, list) {
  const a = normaliseIp(ip);
  if (!a) return false;
  for (const e of list) {
    if (e.includes("/")) {
      if (isIP(a) !== 4) continue;
      const [base, bits] = e.split("/");
      const n = Number(bits);
      const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
      if (((ipv4ToInt(a) & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0)) return true;
    } else if (normaliseIp(e) === a) return true;
  }
  return false;
}
