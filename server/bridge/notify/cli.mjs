/**
 * `mc-bridge notify ...`: set up and check Telegram from the terminal. It talks to the RUNNING Bridge over loopback with an
 * admin key (the same way `accounts connect` and `sources set-key` do), so the bot token goes from a hidden prompt straight
 * to the Bridge on this computer and is never an argument: shell history and process lists would keep an argument.
 *
 *   mc-bridge notify telegram setup       token (hidden prompt), find your chat, confirm it, send a test
 *   mc-bridge notify telegram remove <id>
 *   mc-bridge notify status
 *   mc-bridge notify test [<id>]
 */
import { BridgeError } from "../core/errors.mjs";

const SECRET_FLAGS = ["token", "bot-token", "botToken", "secret", "password", "value", "api-key"];

/** Plain lines for `notify status`. Exported for tests. @param {any} s */
export function formatStatus(s) {
  const lines = [];
  if (!s.enabled) lines.push("Notifications are switched off in the config (notify.enabled).");
  if (!s.targets.length) lines.push("No Telegram bot is set up. Run: mc-bridge notify telegram setup");
  for (const t of s.targets) {
    lines.push(`${t.label} (${t.bot}), ${t.chats} chat${t.chats === 1 ? "" : "s"}: ${t.state === "ok" ? "OK" : t.state === "unverified" ? "not tested yet" : "PROBLEM"}. ${t.message}`);
    if (t.inbound?.state && !["listening", "off", "starting"].includes(t.inbound.state)) lines.push(`  Commands: ${t.inbound.message}`);
  }
  lines.push(`Waiting to send: ${s.queue.depth}${s.queue.dropped ? ` (${s.queue.dropped} dropped when the queue was full)` : ""}. Last delivery: ${s.lastDeliveryAt ?? "none yet"}.`);
  if (s.counters.ignoredMessages) lines.push(`${s.counters.ignoredMessages} message(s) from chats that are not on your list were ignored.`);
  return lines.join("\n");
}

/**
 * @param {string[]} args  after "notify"
 * @param {Record<string, string | boolean | undefined>} flags
 * @param {{ out(s: string): void, err(s: string): void, env: NodeJS.ProcessEnv, readStdin?: () => Promise<string>, prompt?: Function, sleep?: (ms: number) => Promise<void> }} io
 * @param {{ connect: () => Promise<{ call: (method: string, path: string, body?: any) => Promise<any> }>, prompt: (label: string, o?: { hidden?: boolean }) => Promise<string>, cli: string, usage: string }} helpers
 */
export async function notifyCommand(args, flags, io, helpers) {
  const [a, b, c] = args;
  const cli = helpers.cli;
  const ask = typeof io.prompt === "function" ? io.prompt : helpers.prompt;
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  if (a === "status") {
    const { call } = await helpers.connect();
    const { data } = await call("GET", "/v1/notify/status");
    io.out(flags.json ? JSON.stringify(data, null, 2) : formatStatus(data));
    return data.targets.some((t) => !["ok", "unverified"].includes(t.state)) ? 1 : 0;
  }

  if (a === "test") {
    const { call } = await helpers.connect();
    const { data: targets } = await call("GET", "/v1/notify/targets");
    const chosen = b ? targets.filter((t) => t.id === b) : targets;
    if (!chosen.length) throw new BridgeError("NOT_FOUND", b ? `No Telegram bot with id ${b}.` : `No Telegram bot is set up. Run: ${cli} notify telegram setup`);
    let bad = 0;
    for (const t of chosen) {
      const { data } = await call("POST", `/v1/notify/targets/${encodeURIComponent(t.id)}/test`, {});
      if (!data.results.length) {
        io.out(`${t.label}: ${data.message}`);
        bad += 1;
      }
      for (const r of data.results) {
        io.out(`${t.label} / ${r.chat.name}: ${r.ok ? "delivered" : `NOT delivered. ${r.error?.message}`}`);
        if (!r.ok) bad += 1;
      }
    }
    return bad ? 1 : 0;
  }

  if (a === "telegram" && b === "remove") {
    if (!c) throw new BridgeError("VALIDATION_FAILED", `notify telegram remove needs the bot id (see: ${cli} notify status --json).`);
    const { call } = await helpers.connect();
    await call("DELETE", `/v1/notify/targets/${encodeURIComponent(c)}`);
    io.out("Removed. The bot token and the chats are forgotten.");
    return 0;
  }

  if (a === "telegram" && b === "setup") {
    // The token is never taken from the command line.
    if (args.length > 2) throw new BridgeError("VALIDATION_FAILED", "setup takes no arguments. The bot token is asked for with hidden input and never read from the command line (shell history and process lists would keep it). If you pasted a token after 'setup', it is in your shell history now: delete that line, then get a new token from BotFather with /token.");
    for (const f of SECRET_FLAGS) if (flags[f] !== undefined) throw new BridgeError("VALIDATION_FAILED", "The bot token is never taken from the command line. Run 'notify telegram setup' without it: it asks with hidden input. If you typed it here, it is in your shell history: get a new one from BotFather (/token).");
    const { call } = await helpers.connect();
    io.err("Create a bot in Telegram first: open a chat with @BotFather, send /newbot, follow the questions, and copy the token it gives you.");
    io.err("What you type next is not shown and goes only to the Bridge on this computer.");
    let token;
    if (typeof io.readStdin === "function") token = await io.readStdin();
    else token = await ask("Bot token", { hidden: true });
    token = String(token ?? "").trim();
    if (!token) throw new BridgeError("VALIDATION_FAILED", "No token was given.");
    const { data: target } = await call("POST", "/v1/notify/targets", { token });
    io.out(`Bot @${target.bot.username} accepted${target.replaced ? " (its token was replaced; your chats are kept)" : ""}.`);

    if (!target.chats.length) {
      io.err(`Now open Telegram, find @${target.bot.username} and send it any message (for example /start). Then press Enter here.`);
      await ask("Press Enter when you have sent it", { hidden: false });
      let found = [];
      for (let i = 0; i < 3 && !found.length; i += 1) {
        ({ data: found } = await call("POST", `/v1/notify/targets/${encodeURIComponent(target.id)}/find-chat`));
        if (!found.length) await sleep(1500);
      }
      if (!found.length) {
        io.err("I did not see a message yet. Send the bot a message, then run this again (or use Find my chat in the dashboard).");
        return 1;
      }
      for (const f of found) {
        const yes = String(await ask(`Send alerts to "${f.name}" (${f.type}, id ending ${f.idHint.replace("••••", "")})? [y/N]`, { hidden: false })).trim().toLowerCase();
        if (yes === "y" || yes === "yes") {
          const { data: chat } = await call("POST", `/v1/notify/targets/${encodeURIComponent(target.id)}/chats`, { ref: f.ref });
          io.out(`Added ${chat.name}.${chat.commands ? " It may also ask for prices and status (read-only)." : ""}`);
        }
      }
    }
    const { data: test } = await call("POST", `/v1/notify/targets/${encodeURIComponent(target.id)}/test`, {});
    for (const r of test.results) io.out(`${r.chat.name}: ${r.ok ? "test message delivered" : `NOT delivered. ${r.error?.message}`}`);
    if (!test.results.length) io.out(test.message);
    io.out(`Done. Choose which events you want in the dashboard (Integrations, Telegram). Check any time with: ${cli} notify status`);
    return test.ok ? 0 : 1;
  }

  io.err(helpers.usage);
  return 1;
}
