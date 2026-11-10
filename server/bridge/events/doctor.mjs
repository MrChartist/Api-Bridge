/**
 * Doctor lines for events and webhooks, read from the events folder (the Bridge need not be running): subscriptions that
 * keep failing, deliveries waiting for a signing secret, dead letters, and the age of the oldest queued delivery.
 * Creates nothing.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readLinesSync } from "../../lib/jsonl.mjs";

function replay(file) {
  const map = new Map();
  for (const r of readLinesSync(file).items) {
    if (r?.op === "put" && typeof r.r?.id === "string") {
      map.delete(r.r.id);
      map.set(r.r.id, r.r);
    } else if (r?.op === "del" && typeof r.id === "string") map.delete(r.id);
  }
  return [...map.values()];
}

/**
 * @param {{ config: any, now?: number }} o
 * @returns {Array<{ level: "ok"|"warn", check: string, message: string }>}
 */
export function eventsDoctorChecks({ config, now = Date.now() }) {
  const out = [];
  const dir = join(config.dataDir, "events");
  if (!existsSync(dir) || config.events?.enabled === false) return out;
  let subs;
  try {
    subs = replay(join(dir, "subscriptions.jsonl"));
  } catch {
    return out;
  }
  if (!subs.length) return out;
  const pending = replay(join(dir, "outbox.jsonl"));
  const dead = replay(join(dir, "deadletter.jsonl"));
  const failing = subs.filter((s) => s.active && (s.consecutiveFailures ?? 0) >= 3 && !s.needsSecret);
  const needSecret = subs.filter((s) => s.needsSecret);
  out.push({ level: "ok", check: "webhooks", message: `${subs.length} subscription${subs.length === 1 ? "" : "s"} (${subs.filter((s) => s.active).length} on); ${pending.length} delivery${pending.length === 1 ? "" : "ies"} queued, ${dead.length} dead letter${dead.length === 1 ? "" : "s"}` });
  if (needSecret.length) out.push({ level: "warn", check: "webhooks", message: `${needSecret.length} subscription${needSecret.length === 1 ? "" : "s"} need${needSecret.length === 1 ? "s" : ""} the signing secret again (after a restore or a new computer); deliveries wait until it is set: mc-bridge subscriptions rotate-secret <id>` });
  if (failing.length) out.push({ level: "warn", check: "webhooks", message: `${failing.length} subscription${failing.length === 1 ? " is" : "s are"} failing (${failing.slice(0, 3).map((s) => `${s.label ?? s.id}: ${s.lastFailureCode ?? "error"}`).join(", ")}). Fix or pause ${failing.length === 1 ? "it" : "them"}; events keep queuing for each.` });
  if (dead.length >= 10) out.push({ level: "warn", check: "webhooks", message: `${dead.length} dead letters are set aside. Look at them (mc-bridge subscriptions dead-letters <id>), retry or clear them.` });
  const oldest = pending.reduce((m, p) => Math.min(m, Number(p.createdAt) || now), now);
  if (pending.length && now - oldest > 3_600_000) out.push({ level: "warn", check: "webhooks", message: `The oldest queued delivery is ${Math.round((now - oldest) / 60_000)} minutes old. A receiver is not answering.` });
  return out;
}
