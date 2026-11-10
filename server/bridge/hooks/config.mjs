/**
 * The `hooks` config section (owned by the hooks module; core validates it with this schema).
 *
 *   "hooks": {
 *     "queueSize": 200,                 // signals waiting to be processed; a full queue answers 429 (never unbounded)
 *     "concurrency": 2,                 // signals processed at the same time (orders are still rate-capped by safety)
 *     "dedupeWindowMs": 120000,         // the same alert seen again inside this window is acknowledged as a duplicate
 *     "signatureToleranceS": 300,       // generic hooks: |now - t| allowed in X-MCB-Signature (at most 5 minutes)
 *     "maxSignalsPerMinute": 30,        // per hook, counting only alerts that pass every check; more are held (rateWaitSec)
 *     "maxHooks": 100,
 *     "allowSourceIps": [],             // global allowlist added to every hook's own list
 *     "clientIpHeader": null            // "cf-connecting-ip" | "x-forwarded-for" | "x-real-ip": trusted ONLY when the
 *                                       //  TCP peer is loopback (a local tunnel such as cloudflared), never otherwise
 *     "burstWaitSec": 30,               // an alert that meets the per-account order-rate cap waits (queued) up to this long
 *                                       //  for a free slot, then is reported as rejected; 0 turns the waiting off
 *     "rateWaitSec": 60,                // an alert over maxSignalsPerMinute is held (queued) up to this long and then
 *                                       //  handled, because TradingView does not resend; past it, 429; 0 = always 429
 *     "signalsKept": 100,               // recent alerts remembered per hook for GET /v1/hooks/{id}/signals (memory only)
 *     "presets": {                      // address lists a hook can switch on; editable, with the date you last checked them
 *       "tradingview": { "ips": ["52.89.214.238", "..."], "verifiedAt": "2026-11-09", "source": "https://..." }
 *     }
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
  burstWaitSec: 30,
  rateWaitSec: 60,
  signalsKept: 100,
});

/**
 * Where TradingView says its webhook requests come from. Checked against TradingView's own help page on
 * 2026-11-09 (https://www.tradingview.com/support/solutions/43000529348-about-webhooks/). TradingView can change this
 * list at any time: check the page again now and then, and edit `hooks.presets.tradingview` in your config file when
 * it differs. IPv6 is not used (the page says it is not supported for webhooks).
 */
export const TRADINGVIEW_IP_PRESET = Object.freeze({
  ips: Object.freeze(["52.89.214.238", "34.212.75.30", "54.218.53.128", "52.32.178.7"]),
  verifiedAt: "2026-11-09",
  source: "https://www.tradingview.com/support/solutions/43000529348-about-webhooks/",
});

/** The preset names a hook may switch on (HookCreate.sourceIpPreset). */
export const IP_PRESET_NAMES = Object.freeze(["tradingview"]);

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
    burstWaitSec: z.number().int().min(0).max(300).default(HOOKS_DEFAULTS.burstWaitSec),
    rateWaitSec: z.number().int().min(0).max(300).default(HOOKS_DEFAULTS.rateWaitSec),
    signalsKept: z.number().int().min(10).max(1000).default(HOOKS_DEFAULTS.signalsKept),
    presets: z
      .object({
        tradingview: z
          .object({
            ips: z.array(ipEntrySchema).min(1).max(50),
            verifiedAt: z.string().max(40).nullable().default(null),
            source: z.string().max(300).nullable().default(null),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
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

/**
 * The address preset `name` as it applies now: the config file's version when it has one, else the built-in list.
 * @param {ReturnType<typeof hooksConfig>} cfg
 * @param {string} name
 * @returns {{ name: string, ips: string[], verifiedAt: string | null, source: string | null, edited: boolean }}
 */
export function ipPreset(cfg, name) {
  const mine = cfg?.presets?.[name];
  if (mine) return { name, ips: [...mine.ips], verifiedAt: mine.verifiedAt ?? null, source: mine.source ?? null, edited: true };
  if (name === "tradingview") return { name, ips: [...TRADINGVIEW_IP_PRESET.ips], verifiedAt: TRADINGVIEW_IP_PRESET.verifiedAt, source: TRADINGVIEW_IP_PRESET.source, edited: false };
  return { name, ips: [], verifiedAt: null, source: null, edited: false };
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
