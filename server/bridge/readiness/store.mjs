/**
 * Readiness state on disk: <dataDir>/readiness/state.json, mode 0600 in a 0700
 * folder, written atomically. Holds the last state per account, the pre-open run date and the last 200 transitions.
 *
 * The egress IP address is NEVER written here (a personal identifier in a folder users back up and sync); only whether
 * it matched each account. A corrupt or unreadable file is renamed state.json.corrupt-<ts> and a fresh state is used,
 * so a damaged file never stops the next day's checks. No secrets, tokens or broker client codes.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { quarantine, writeFileAtomic } from "../../lib/jsonl.mjs";

export const STATE_VERSION = 1;
export const TRANSITIONS_KEPT = 200;

export const freshState = () => ({ version: STATE_VERSION, accounts: {}, egress: null, preopen: { lastRunDate: null }, transitions: [] });

const ACCOUNT_KEYS = ["state", "since", "checkedAt", "reasons", "lastProbe", "lastNotifiedAt", "lastNotifiedKey"];

/** Keep only the documented fields (so nothing else, such as an address, can ever be persisted by mistake). */
export function sanitiseState(s) {
  const out = freshState();
  if (!s || typeof s !== "object") return out;
  for (const [id, a] of Object.entries(s.accounts ?? {})) {
    if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(id) || !a || typeof a !== "object") continue;
    const acc = {};
    for (const k of ACCOUNT_KEYS) if (a[k] !== undefined) acc[k] = a[k];
    if (Array.isArray(acc.reasons)) acc.reasons = acc.reasons.slice(0, 20).map((r) => ({ check: String(r?.check ?? ""), code: String(r?.code ?? ""), severity: r?.severity === "fail" ? "fail" : "warn", message: String(r?.message ?? "").slice(0, 300) }));
    if (acc.lastProbe && typeof acc.lastProbe === "object") acc.lastProbe = { at: Number(acc.lastProbe.at) || null, result: String(acc.lastProbe.result ?? "") };
    out.accounts[id] = acc;
  }
  if (s.egress && typeof s.egress === "object") {
    const m = {};
    for (const [id, v] of Object.entries(s.egress.matchesByAccount ?? {})) if (typeof v === "boolean") m[id] = v;
    out.egress = { at: Number(s.egress.at) || null, family: s.egress.family === "ipv6" ? "ipv6" : s.egress.family === "ipv4" ? "ipv4" : null, seenBy: typeof s.egress.seenBy === "string" ? s.egress.seenBy.slice(0, 120) : null, matchesByAccount: m };
  }
  if (s.preopen && typeof s.preopen.lastRunDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.preopen.lastRunDate)) out.preopen.lastRunDate = s.preopen.lastRunDate;
  if (Array.isArray(s.transitions)) {
    out.transitions = s.transitions
      .filter((t) => t && typeof t === "object")
      .slice(-TRANSITIONS_KEPT)
      .map((t) => ({ at: String(t.at ?? ""), accountId: String(t.accountId ?? ""), from: String(t.from ?? ""), to: String(t.to ?? ""), codes: Array.isArray(t.codes) ? t.codes.map(String).slice(0, 20) : [] }));
  }
  return out;
}

/**
 * @param {{ dir: string, logger?: any, now?: () => number }} opts
 */
export function createReadinessStore({ dir, logger, now = () => Date.now() }) {
  const file = join(dir, "state.json");
  let loadedFrom = "new";
  return {
    file,
    get loadedFrom() {
      return loadedFrom;
    },
    /** Read state.json; a corrupt file is quarantined and a fresh state returned. */
    load() {
      if (!existsSync(file)) {
        loadedFrom = "new";
        return freshState();
      }
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (!parsed || typeof parsed !== "object" || parsed.version !== STATE_VERSION) throw new Error("unknown version");
        loadedFrom = "file";
        return sanitiseState(parsed);
      } catch (err) {
        loadedFrom = "corrupt";
        try {
          const to = quarantine(file, { now: now() });
          logger?.warn?.("readiness state could not be read; starting fresh", { movedTo: to, err: err?.message });
        } catch (qErr) {
          logger?.warn?.("readiness state could not be read or moved aside; starting fresh", { err: qErr?.message });
        }
        return freshState();
      }
    },
    /** Write the state (sanitised) atomically; returns false (and logs) on failure. */
    save(state) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileAtomic(file, `${JSON.stringify(sanitiseState(state), null, 1)}\n`);
        return true;
      } catch (err) {
        logger?.warn?.("readiness state could not be saved", { err: err?.message });
        return false;
      }
    },
  };
}
