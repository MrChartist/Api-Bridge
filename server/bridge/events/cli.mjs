/**
 * `mc-bridge subscriptions ...`: webhooks out, from the terminal. It talks to the RUNNING Bridge over loopback with an admin
 * key (the same way `notify` and `sources` do), so it works only on the computer that runs the Bridge.
 *
 *   mc-bridge subscriptions list | topics | status
 *   mc-bridge subscriptions add <https url> --topics order.*,download.* [--label name] [--accounts a,b] [--secret-stdin]
 *   mc-bridge subscriptions show <id>
 *   mc-bridge subscriptions pause <id> | resume <id> | remove <id>
 *   mc-bridge subscriptions rotate-secret <id> [--secret-stdin]
 *   mc-bridge subscriptions test <id>
 *   mc-bridge subscriptions deliveries <id> [--outcome dead] [--limit 20]
 *   mc-bridge subscriptions dead-letters <id> [--retry <deliveryId> | --retry-all | --clear]
 *   mc-bridge subscriptions tail [--topics order.*] [--since <cursor>]     print events as they arrive (polls every 2 s)
 *   mc-bridge subscriptions allow-local [--off]   let webhooks go to a receiver on this computer or your home network (http://, 127.0.0.1,
 *                                                  192.168.x.x ...): sets events.webhooks.allowPrivateTargets in the config file. Needs a restart.
 *
 * The signing secret is never an argument (shell history and process lists would keep it). `add` and `rotate-secret` make a
 * random one on this computer and print it ONCE; `--secret-stdin` reads your own from standard input instead. The Bridge never
 * shows it again.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { setConfigSection } from "../accounts/configFile.mjs";
import { BridgeError } from "../core/errors.mjs";
import { adminTopicsNamed } from "./catalog.mjs";
import { EVENTS_CONFIG_SCHEMA } from "./config.mjs";

const SECRET_FLAGS = ["secret", "signing-secret", "token", "password", "value", "api-key"];
export const SUBSCRIPTION_SUBCOMMANDS = Object.freeze(["list", "topics", "status", "add", "show", "pause", "resume", "remove", "rotate-secret", "test", "deliveries", "dead-letters", "tail", "allow-local"]);

/** Standard input to the end, for --secret-stdin when the caller gave no reader. */
const readProcessStdin = () =>
  new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (text += c));
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", () => resolve(text));
  });

const pad = (s, n) => String(s).padEnd(n);

/**
 * `subscriptions allow-local [--off]`: turn events.webhooks.allowPrivateTargets on (or back off) in the config file, with the
 * existing config-writing helper (checked against the events schema and the core schema, written atomically, every other
 * setting kept). It edits the file only; it does not need the Bridge to be running and takes effect at the next start.
 */
async function allowLocal(flags, io, helpers) {
  const off = flags.off === true;
  const file = typeof helpers.configFile === "function" ? helpers.configFile() : null;
  if (!file) throw new BridgeError("VALIDATION_FAILED", "Could not work out which config file to change. Pass --config <file>.");
  let obj = {};
  if (existsSync(file)) {
    try {
      obj = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new BridgeError("VALIDATION_FAILED", `Your config file ${file} could not be read (it may have a typing mistake). Nothing was changed.`);
    }
  }
  const events = obj && typeof obj.events === "object" && obj.events && !Array.isArray(obj.events) ? obj.events : {};
  const webhooks = events.webhooks && typeof events.webhooks === "object" && !Array.isArray(events.webhooks) ? events.webhooks : {};
  if ((webhooks.allowPrivateTargets === true) === !off) {
    io.out(off ? "Webhooks to this computer were already off. Nothing changed." : "Webhooks to this computer were already allowed in the config file. Nothing changed.");
    return 0;
  }
  await setConfigSection(file, "events", { ...events, webhooks: { ...webhooks, allowPrivateTargets: !off } }, { schema: EVENTS_CONFIG_SCHEMA });
  if (off) {
    io.out(`Done: webhooks may go to public https:// addresses only again (events.webhooks.allowPrivateTargets is false in ${file}).`);
    io.out("Restart the Bridge for this to take effect. A receiver that uses a private address will then be refused.");
    return 0;
  }
  io.out(`Done: events.webhooks.allowPrivateTargets is now true in ${file}.`);
  io.out("Warning, in plain words:");
  io.out("  - The Bridge may now send webhooks over plain http:// and to addresses on this computer (127.0.0.1, localhost) and your home or office network (192.168.x.x, 10.x.x.x).");
  io.out("  - Do this only for receivers you run yourself. Anything that can read your network could read those events: orders and prices.");
  io.out("  - Events are still signed, redirects are still not followed, and cloud metadata addresses stay blocked.");
  io.out(`Restart the Bridge to apply it. Then add your receiver, for example: ${helpers.cli} subscriptions add http://127.0.0.1:8080/bridge --topics order.*`);
  io.out(`Turn it off again with: ${helpers.cli} subscriptions allow-local --off`);
  return 0;
}

/** Plain lines for `subscriptions list`. Exported for tests. @param {any[]} rows */
export function formatSubscriptions(rows) {
  if (!rows.length) return "No webhook subscriptions. Add one with: subscriptions add <https url> --topics order.*";
  return rows
    .map((s) => {
      const h = s.health;
      const bits = [`${h.state}`, `${h.delivered} delivered`, s.pending ? `${s.pending} waiting` : null, s.deadLetters ? `${s.deadLetters} dead` : null, h.lastFailure ? `last problem: ${h.lastFailure.message}` : null].filter(Boolean);
      return `${pad(s.id, 13)} ${pad(s.target, 36)} ${pad(s.topics.join(","), 24)} ${s.active ? "on " : "off"}  ${bits.join(", ")}${s.label ? `  (${s.label})` : ""}`;
    })
    .join("\n");
}

const secretBanner = (secret) => [
  "Signing secret (shown once; the Bridge cannot show it again, so keep it where your receiver can read it):",
  `  ${secret}`,
  "Receivers check X-Bridge-Signature with it: see docs/guides/events.md.",
];

/**
 * @param {string[]} args  after "subscriptions"
 * @param {Record<string, string | boolean | undefined>} flags
 * @param {{ out(s: string): void, err(s: string): void, env: NodeJS.ProcessEnv, readStdin?: () => Promise<string>, sleep?: (ms: number) => Promise<void>, randomSecret?: () => string, maxPolls?: number }} io
 * @param {{ connect: () => Promise<{ call: (method: string, path: string, body?: any) => Promise<any> }>, cli: string, usage: string }} helpers
 */
export async function subscriptionsCommand(args, flags, io, helpers) {
  const [sub, id] = args;
  const cli = helpers.cli;
  if (!SUBSCRIPTION_SUBCOMMANDS.includes(sub)) {
    io.err(helpers.usage);
    return 1;
  }
  for (const f of SECRET_FLAGS) {
    if (flags[f] !== undefined) throw new BridgeError("VALIDATION_FAILED", "The signing secret is never taken from the command line (shell history and process lists would keep it). Leave it out and the Bridge CLI makes a random one, or add --secret-stdin and pipe your own in.");
  }
  const needsId = ["show", "pause", "resume", "remove", "rotate-secret", "test", "deliveries", "dead-letters"];
  if (needsId.includes(sub) && !id) throw new BridgeError("VALIDATION_FAILED", `subscriptions ${sub} needs a subscription id. List them with: ${cli} subscriptions list`);
  if (sub === "add" && !id) throw new BridgeError("VALIDATION_FAILED", `subscriptions add needs the https URL of your receiver, for example: ${cli} subscriptions add https://example.com/bridge --topics order.*`);
  if (sub === "add" && args.length > 2) throw new BridgeError("VALIDATION_FAILED", "subscriptions add takes one URL. If you typed a secret after it, it is in your shell history now: delete that line and use the secret this command prints instead.");

  if (sub === "allow-local") return allowLocal(flags, io, helpers);

  const { call } = await helpers.connect();
  const path = (s) => `/v1/subscriptions/${encodeURIComponent(s)}`;
  const secretFor = async () => {
    if (flags["secret-stdin"]) {
      const text = String(await (io.readStdin ? io.readStdin() : readProcessStdin())).trim();
      if (!text) throw new BridgeError("VALIDATION_FAILED", "--secret-stdin was given but nothing arrived on standard input.");
      return { secret: text, generated: false };
    }
    return { secret: io.randomSecret ? io.randomSecret() : randomBytes(32).toString("hex"), generated: true };
  };
  const json = (data) => io.out(JSON.stringify(data, null, 2));

  switch (sub) {
    case "list": {
      const { data } = await call("GET", "/v1/subscriptions");
      io.out(flags.json ? JSON.stringify(data, null, 2) : formatSubscriptions(data));
      return data.some((s) => s.health.state === "failing") ? 1 : 0;
    }
    case "topics": {
      const { data } = await call("GET", "/v1/events/topics");
      if (flags.json) json(data);
      else for (const t of data) io.out(`${pad(t.topic, 24)} ${pad(t.scope, 6)} ${t.description}`);
      return 0;
    }
    case "status": {
      const { data } = await call("GET", "/v1/events/status");
      if (flags.json) json(data);
      else {
        io.out(`Event log: ${data.log.kept} kept (newest cursor ${data.log.latest}), ${data.clients.connections} open connection(s).`);
        io.out(`Webhooks: ${data.webhooks.subscriptions} subscription(s), ${data.webhooks.pending} waiting to be sent, ${data.webhooks.deadLetters} dead letter(s).`);
      }
      return data.webhooks.deadLetters > 0 ? 1 : 0;
    }
    case "add": {
      const topics = String(flags.topics ?? "").split(",").map((t) => t.trim()).filter(Boolean);
      if (!topics.length) throw new BridgeError("VALIDATION_FAILED", `Say which events to send with --topics, for example --topics order.*,download.* (list them: ${cli} subscriptions topics).`);
      const { secret } = await secretFor();
      const body = { url: id, topics, secret, ...(typeof flags.label === "string" ? { label: flags.label } : {}), ...(typeof flags.accounts === "string" && flags.accounts !== "*" ? { accounts: flags.accounts.split(",").map((a) => a.trim()).filter(Boolean) } : {}) };
      const { data } = await call("POST", "/v1/subscriptions", body);
      io.out(`Created ${data.id} for ${data.target} (${data.topics.join(", ")}).`);
      const named = adminTopicsNamed(data.topics);
      if (named.length) io.out(`Warning: ${named.join(", ")} ${named.length === 1 ? "is an admin topic" : "are admin topics"} (order tickets, webhook alerts, backups, config warnings). Their details will be sent to ${data.target}. Remove them with: ${cli} subscriptions show ${data.id}`);
      if (!flags["secret-stdin"]) for (const l of secretBanner(secret)) io.out(l);
      io.out(`Check it works: ${cli} subscriptions test ${data.id}`);
      return 0;
    }
    case "show": {
      const { data } = await call("GET", path(id));
      if (flags.json) json(data);
      else io.out(formatSubscriptions([data]));
      return 0;
    }
    case "pause":
    case "resume": {
      const { data } = await call("PATCH", path(id), { active: sub === "resume" });
      io.out(`${data.id} is ${data.active ? "on" : "paused"}.`);
      return 0;
    }
    case "remove": {
      await call("DELETE", path(id));
      io.out("Removed. Its queue, dead letters, log and stored secret are gone.");
      return 0;
    }
    case "rotate-secret": {
      const { secret } = await secretFor();
      await call("PATCH", path(id), { secret });
      io.out(`The signing secret of ${id} was replaced. Events signed from now on use the new one: update your receiver first or accept both for a short while.`);
      if (!flags["secret-stdin"]) for (const l of secretBanner(secret)) io.out(l);
      return 0;
    }
    case "test": {
      const { data } = await call("POST", `${path(id)}/test`);
      io.out(data.ok ? `Delivered: the receiver answered ${data.status} in ${data.durationMs} ms.` : `NOT delivered${data.status ? ` (the receiver answered ${data.status})` : ""}. ${data.message}`);
      return data.ok ? 0 : 1;
    }
    case "deliveries": {
      const q = new URLSearchParams();
      if (typeof flags.outcome === "string") q.set("outcome", flags.outcome);
      if (typeof flags.limit === "string") q.set("limit", flags.limit);
      const { data } = await call("GET", `${path(id)}/deliveries${q.size ? `?${q}` : ""}`);
      if (flags.json) json(data);
      else if (!data.length) io.out("Nothing has been sent yet.");
      else for (const r of data) io.out(`${r.at}  ${pad(r.outcome, 9)} event ${pad(r.eventId, 8)} ${pad(r.topic, 20)} attempt ${r.attempt}  ${r.ok ? `HTTP ${r.status}` : `${r.status ? `HTTP ${r.status}: ` : ""}${r.message}`}${r.test ? "  (test)" : ""}`);
      return 0;
    }
    case "dead-letters": {
      if (flags.clear) {
        const { data } = await call("DELETE", `${path(id)}/dead-letters`);
        io.out(`Removed ${data.removed} dead letter(s).`);
        return 0;
      }
      const { data } = await call("GET", `${path(id)}/dead-letters`);
      if (flags["retry-all"] || typeof flags.retry === "string") {
        const ids = flags["retry-all"] ? data.map((d) => d.id) : [String(flags.retry)];
        for (const d of ids) await call("POST", `${path(id)}/dead-letters/${encodeURIComponent(d)}/retry`);
        io.out(`Put ${ids.length} event(s) back in the queue.`);
        return 0;
      }
      if (flags.json) json(data);
      else if (!data.length) io.out("No dead letters.");
      else for (const d of data) io.out(`${pad(d.id, 17)} event ${pad(d.eventId, 8)} ${pad(d.topic, 20)} ${d.attempts} attempt(s)  ${d.message}`);
      return data.length ? 1 : 0;
    }
    case "tail": {
      const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
      const topics = typeof flags.topics === "string" ? flags.topics : "*";
      let cursor = typeof flags.since === "string" ? flags.since : null;
      if (cursor === null) {
        const { meta } = await call("GET", `/v1/events?${new URLSearchParams({ topics, limit: "1" })}`);
        cursor = meta.latest;
        if (!flags.json) io.err("Showing new events from now on (--since 0 starts from the oldest kept). Press Ctrl+C to stop.");
      }
      const rounds = io.maxPolls ?? Infinity;
      for (let i = 0; i < rounds; i += 1) {
        const { data, meta } = await call("GET", `/v1/events?${new URLSearchParams({ topics, limit: "200", since: cursor })}`);
        if (meta.gap) io.err("Some events were missed (they are no longer kept). Read the current state from the API.");
        for (const e of data) io.out(flags.json ? JSON.stringify(e) : `${e.id}  ${e.time}  ${e.topic}  ${JSON.stringify(e.data)}`);
        cursor = meta.cursor;
        if (i + 1 < rounds) await sleep(2000);
      }
      return 0;
    }
    default:
      io.err(helpers.usage);
      return 1;
  }
}
