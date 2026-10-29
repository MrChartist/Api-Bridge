/**
 * The `readiness` config section (stream S20, docs/spec/p1-05-readiness.md §3.6). All optional; zod `.strict()`.
 *
 *   "readiness": {
 *     "enabled": true,
 *     "intervalMinutes": 4,                          continuous checks inside `window` on trading days (1..15)
 *     "window": { "from": "08:45", "to": "15:45" },  IST "HH:MM"; from < to
 *     "preOpenAt": "09:00",                          IST "HH:MM"; inside `window`
 *     "probe": { "enabled": true, "timeoutMs": 10000, "cooldownSeconds": 30, "endpointClass": "portfolio" },
 *     "egressIp": { "mode": "off" | "lookup" | "manual", "lookupUrl": null, "manualIp": null, "timeoutMs": 5000, "maxSkewMs": 5000 },
 *     "gateAutomated": true,                         automated live sends are refused while cannot_trade
 *     "staleAfterMinutes": 10,
 *     "warn": { "sessionExpiresWithinMinutes": 60, "dailyOrdersLeftPct": 10, "dailyLossLeftPct": 20 },
 *     "notify": { "cooldownMinutes": 15, "onRecovery": true, "preopenOnlyIfFailing": true }
 *   }
 *
 * The egress lookup is OFF by default: no third-party call is ever made unless the user chooses a service (privacy).
 */
import { z } from "zod";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const hhmm = z.string().regex(HHMM, 'a time like "09:00" (IST, 24-hour)');
export const toMinutes = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** https://…, or http:// only to this computer (a test or a local echo service). */
export function lookupUrlProblem(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return "not a URL";
  }
  if (url.username || url.password) return "must not carry a user name or password";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
  return "use https://, or http:// only to this computer";
}

const ENDPOINT_CLASSES = ["portfolio", "other", "quote"];

export const READINESS_CONFIG_SCHEMA = z
  .object({
    enabled: z.boolean().default(true),
    intervalMinutes: z.number().int().min(1).max(15).default(4),
    window: z
      .object({ from: hhmm.default("08:45"), to: hhmm.default("15:45") })
      .strict()
      .prefault({})
      .refine((w) => toMinutes(w.from) < toMinutes(w.to), { message: "window.from must be before window.to" }),
    preOpenAt: hhmm.default("09:00"),
    probe: z
      .object({
        enabled: z.boolean().default(true),
        timeoutMs: z.number().int().min(1000).max(30_000).default(10_000),
        cooldownSeconds: z.number().int().min(30).max(3600).default(30),
        endpointClass: z.enum(ENDPOINT_CLASSES).default("portfolio"),
      })
      .strict()
      .prefault({}),
    egressIp: z
      .object({
        mode: z.enum(["off", "lookup", "manual"]).default("off"),
        lookupUrl: z.string().max(500).nullable().default(null),
        manualIp: z.string().max(64).nullable().default(null),
        timeoutMs: z.number().int().min(500).max(15_000).default(5000),
        maxSkewMs: z.number().int().min(500).max(600_000).default(5000),
      })
      .strict()
      .prefault({})
      .superRefine((e, ctx) => {
        if (e.mode === "lookup") {
          if (!e.lookupUrl) ctx.addIssue({ code: "custom", path: ["lookupUrl"], message: 'mode "lookup" needs lookupUrl (an https:// IP-echo service you choose)' });
          else {
            const problem = lookupUrlProblem(e.lookupUrl);
            if (problem) ctx.addIssue({ code: "custom", path: ["lookupUrl"], message: problem });
          }
        }
        if (e.mode === "manual" && !e.manualIp) ctx.addIssue({ code: "custom", path: ["manualIp"], message: 'mode "manual" needs manualIp (the address you state this computer uses)' });
      }),
    gateAutomated: z.boolean().default(true),
    staleAfterMinutes: z.number().int().min(2).max(240).default(10),
    warn: z
      .object({
        sessionExpiresWithinMinutes: z.number().int().min(0).max(720).default(60),
        dailyOrdersLeftPct: z.number().min(0).max(100).default(10),
        dailyLossLeftPct: z.number().min(0).max(100).default(20),
      })
      .strict()
      .prefault({}),
    notify: z
      .object({
        cooldownMinutes: z.number().int().min(1).max(1440).default(15),
        onRecovery: z.boolean().default(true),
        preopenOnlyIfFailing: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .superRefine((c, ctx) => {
    const p = toMinutes(c.preOpenAt);
    if (p < toMinutes(c.window.from) || p > toMinutes(c.window.to)) {
      ctx.addIssue({ code: "custom", path: ["preOpenAt"], message: `preOpenAt must lie inside window (${c.window.from}–${c.window.to})` });
    }
  });

/** Parse (and default) a raw `readiness` section. Throws a ZodError when it is not valid. */
export const parseReadinessConfig = (raw) => READINESS_CONFIG_SCHEMA.parse(raw ?? {});

/** The parsed section from an app config (module-validated) or a raw one (tests). */
export function readinessConfig(config) {
  const r = config?.readiness;
  return r && typeof r === "object" && "probe" in r && "warn" in r && "notify" in r ? r : parseReadinessConfig(r);
}

/**
 * Detection bound for an IP change (§7.5): interval + jitter + slowest call + debounce, in seconds.
 * @param {ReturnType<typeof parseReadinessConfig>} cfg
 */
export function detectionBoundSeconds(cfg) {
  return cfg.intervalMinutes * 60 + 30 + Math.max(cfg.probe.timeoutMs, cfg.egressIp.timeoutMs) / 1000 + 0.25;
}

/** Warnings (not errors) for a parsed section, logged at start. */
export function readinessWarnings(cfg) {
  const out = [];
  const bound = detectionBoundSeconds(cfg);
  if (bound > 300) out.push(`Readiness can take up to ${Math.ceil(bound / 60)} minutes to notice an IP change or an expired session (readiness.intervalMinutes is ${cfg.intervalMinutes}; 4 or less keeps it under 5 minutes).`);
  return out;
}
