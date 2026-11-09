/**
 * What `mc-bridge doctor` says about Telegram alerts. It makes no network call: it reports what the Bridge last saw (the
 * delivery health kept in dataDir/notify/state.json), and says plainly when delivery has never been tested. It never says
 * alerts "go to" a place that cannot receive them.
 */
import { cliCommand } from "../core/cliName.mjs";

/**
 * @param {{ notify: { status(): Promise<any>, listTargets(): Promise<any[]> } }} deps
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<Array<{ level: "ok"|"warn", check: string, message: string }>>}
 */
export async function notifyDoctorChecks(deps, { env = process.env } = {}) {
  const cli = cliCommand(env);
  const out = [];
  let status;
  try {
    status = await deps.notify.status();
  } catch {
    return [{ level: "warn", check: "notify", message: `Telegram settings could not be read (is the master key available?). Run: ${cli} notify status` }];
  }
  if (!status.enabled) return [{ level: "ok", check: "notify", message: "Notifications are switched off in the config (notify.enabled is false)" }];
  if (!status.targets.length) return [{ level: "ok", check: "notify", message: `Telegram alerts are not set up (optional). To get alerts and prices on your phone: ${cli} notify telegram setup` }];
  for (const t of status.targets) {
    if (!t.chats) out.push({ level: "warn", check: "notify", message: `Telegram ${t.bot} has no chat yet, so nothing can be sent. Run: ${cli} notify telegram setup (or use Find my chat in the dashboard)` });
    else if (t.state === "ok") out.push({ level: "ok", check: "notify", message: `Telegram ${t.bot}: ${t.chats} chat${t.chats === 1 ? "" : "s"}, last delivery ${t.lastOkAt ?? "unknown"}` });
    else if (t.state === "unverified") out.push({ level: "warn", check: "notify", message: `Telegram ${t.bot}: set up, but nothing has been delivered yet, so it is not verified. Send a test: ${cli} notify test` });
    else out.push({ level: "warn", check: "notify", message: `Telegram ${t.bot} cannot send right now: ${t.message}` });
  }
  if (status.queue.depth > 0) out.push({ level: "warn", check: "notify", message: `${status.queue.depth} message(s) are waiting to be sent${status.queue.dropped ? ` and ${status.queue.dropped} were dropped when the queue was full` : ""}` });
  return out;
}
