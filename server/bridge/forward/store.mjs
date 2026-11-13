/**
 * Forward targets: the URLs of other projects that get the Bridge's events (order updates first of all).
 *
 * A target is { id, label, url, events, enabled } plus delivery counters. Targets live in <dataDir>/forwards.json
 * (0600). Each target has its own signing secret, made here, shown once at creation and kept in the encrypted
 * SecretStore (name "forward:<id>"); it never goes in forwards.json or in a list response.
 *
 * URL rule: https:// anywhere, or http:// only to this computer (127.0.0.1, localhost, [::1]). Order data never
 * leaves this computer in plain text.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { BridgeError, fromValidation } from "../core/errors.mjs";

export const FORWARD_EVENTS = Object.freeze(["order.updated", "order.outcome_unknown", "safety.kill_switch", "account.status"]);
export const DEFAULT_FORWARD_EVENTS = Object.freeze(["order.updated"]);
export const FORWARD_ID_RE = /^fw_[a-z0-9]{12}$/;
export const MAX_FORWARDS = 20;
const FILE_VERSION = 1;

/** https:// anywhere, or http:// to this computer only. Pure. */
export function forwardUrlAllowed(u) {
  let url;
  try {
    url = new URL(String(u));
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

export const forwardCreateSchema = z
  .object({
    label: z.string().trim().min(1).max(60),
    url: z.string().max(2000).refine(forwardUrlAllowed, "use https://, or http:// only to this computer (127.0.0.1 or localhost)"),
    events: z.array(z.enum(FORWARD_EVENTS)).min(1).max(FORWARD_EVENTS.length).default([...DEFAULT_FORWARD_EVENTS]),
  })
  .strict();

/** What a list or create response shows of a target (never its secret). Pure. */
export function publicForward(t) {
  return { id: t.id, label: t.label, url: t.url, events: [...t.events], enabled: t.enabled !== false, createdAt: t.createdAt, delivered: t.delivered ?? 0, failed: t.failed ?? 0, lastDeliveryAt: t.lastDeliveryAt ?? null, lastStatus: t.lastStatus ?? null, lastError: t.lastError ?? null };
}

/**
 * @param {{ dataDir: string, secrets?: { get(n: string): Promise<object|null>, set(n: string, v: object): Promise<void>, delete(n: string): Promise<boolean> },
 *   now?: () => number, logger?: { warn(m: string, f?: object): void, addSecret?(v: string): void } }} opts
 */
export function createForwardStore({ dataDir, secrets, now = () => Date.now(), logger }) {
  const file = join(dataDir, "forwards.json");
  /** @type {Map<string, any>} */
  const byId = new Map();
  const secretCache = new Map();
  let dirty = false;

  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      for (const t of parsed?.version === FILE_VERSION && Array.isArray(parsed.forwards) ? parsed.forwards : []) {
        if (t && FORWARD_ID_RE.test(t.id) && forwardUrlAllowed(t.url) && Array.isArray(t.events)) byId.set(t.id, { ...t, events: t.events.filter((e) => FORWARD_EVENTS.includes(e)) });
        else logger?.warn("forwards.json: skipping a malformed entry");
      }
    } catch (err) {
      throw new BridgeError("INTERNAL", `forwards.json could not be read: ${err.message}`);
    }
  }

  const persist = () => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: FILE_VERSION, forwards: [...byId.values()] }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort on platforms without POSIX modes */
    }
    dirty = false;
  };

  return {
    list: () => [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    get: (id) => byId.get(String(id)) ?? null,

    /** Create a target. Returns its signing secret ONCE. */
    async create(input) {
      const parsed = forwardCreateSchema.safeParse(input);
      if (!parsed.success) throw fromValidation(parsed.error, "The forward target is not valid.");
      if (!secrets) throw new BridgeError("NOT_IMPLEMENTED", "Forwarding needs the encrypted secret store, which is not available.");
      if (byId.size >= MAX_FORWARDS) throw new BridgeError("VALIDATION_FAILED", `There are already ${MAX_FORWARDS} forward targets. Delete one first.`);
      const id = `fw_${randomBytes(9).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x").slice(0, 12)}`;
      const signingSecret = `mcbfw_${randomBytes(32).toString("base64url")}`;
      logger?.addSecret?.(signingSecret);
      await secrets.set(`forward:${id}`, { signingSecret });
      secretCache.set(id, signingSecret);
      const target = { id, label: parsed.data.label, url: parsed.data.url, events: [...new Set(parsed.data.events)], enabled: true, createdAt: new Date(now()).toISOString(), delivered: 0, failed: 0, lastDeliveryAt: null, lastStatus: null, lastError: null };
      byId.set(id, target);
      persist();
      return { target, signingSecret };
    },

    async delete(id) {
      const t = byId.get(String(id));
      if (!t) return false;
      byId.delete(t.id);
      secretCache.delete(t.id);
      persist();
      try {
        await secrets?.delete(`forward:${t.id}`);
      } catch (err) {
        logger?.warn("forward secret could not be deleted", { id: t.id, code: err?.code ?? "ERROR" });
      }
      return true;
    },

    /** The signing secret of a target, or null. */
    async secretFor(id) {
      if (secretCache.has(id)) return secretCache.get(id);
      const v = secrets ? await secrets.get(`forward:${id}`) : null;
      const s = typeof v?.signingSecret === "string" ? v.signingSecret : null;
      if (s) {
        secretCache.set(id, s);
        logger?.addSecret?.(s);
      }
      return s;
    },

    /** Record the outcome of one delivery (written to disk on flush(), not on every event). */
    recordDelivery(id, { ok, status = null, error = null }) {
      const t = byId.get(id);
      if (!t) return;
      t.lastDeliveryAt = new Date(now()).toISOString();
      t.lastStatus = status;
      t.lastError = ok ? null : String(error ?? "failed").slice(0, 200);
      if (ok) t.delivered = (t.delivered ?? 0) + 1;
      else t.failed = (t.failed ?? 0) + 1;
      dirty = true;
    },

    flush() {
      if (!dirty) return;
      try {
        persist();
      } catch (err) {
        logger?.warn("forwards.json could not be written", { code: err?.code ?? "ERROR" });
      }
    },
  };
}
