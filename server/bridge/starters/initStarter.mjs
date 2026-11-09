/**
 * `mc-bridge init <starter> [folder]` (the command line side of starters.mjs).
 *
 *   mc-bridge init node                 a project in ./bridge-node with this Bridge's address, no key
 *   mc-bridge init python my-bot --with-key [--scope read|paper] [--expires 30d]
 *   mc-bridge init --list               the starters
 *
 * Everything that touches the Bridge is passed in (`deps`), so the command is tested without a running Bridge:
 *   baseUrl()          the address of this Bridge (--url, MCB_BRIDGE_URL, or the configuration)
 *   createKey(body)    makes a key in this computer's key store (the local administrator may); returns { key, record }
 *   probe(baseUrl)     the health answer of a running Bridge, or null
 */
import { resolve } from "node:path";
import { BridgeError } from "../core/errors.mjs";
import { STARTERS, STARTER_IDS, STARTER_SCOPES, planStarter, starterById, writeStarter } from "./starters.mjs";

/** The `--expires` words the keys command takes: 30d, 12h, 90m. Returns an ISO time. */
function expiry(value, days, now) {
  if (value !== undefined) {
    const m = /^(\d{1,4})([dhm])$/.exec(String(value));
    if (!m) throw new BridgeError("VALIDATION_FAILED", `--expires must be like 30d, 12h or 90m, got ${value}.`);
    return new Date(now + Number(m[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2]]).toISOString();
  }
  return days > 0 ? new Date(now + days * 86_400_000).toISOString() : null;
}

/** The list of starters, one per line. */
export function starterList(cli = "mc-bridge") {
  const w = Math.max(...STARTER_IDS.map((s) => s.length));
  return ["Starters (each makes a ready project in a new folder):", ...STARTERS.map((s) => `  ${s.id.padEnd(w)}  ${s.about}`), "", `Make one:  ${cli} init <starter> [folder] [--with-key] [--scope read|paper] [--expires 30d] [--url <Bridge address>]`].join("\n");
}

/**
 * @param {{ id?: string, folder?: string }} args
 * @param {Record<string, string | boolean | undefined>} flags
 * @param {{ out(s: string): void, err(s: string): void, cwd: string }} io
 * @param {{ baseUrl(): string, createKey(body: object): Promise<{ key: string, record: { id: string, scopes: string[], expiresAt: string | null } }>, probe?(url: string): Promise<{ demo?: boolean } | null>, cli?: string, now?: () => number }} deps
 * @returns {Promise<number>} exit code
 */
export async function runInitStarter({ id, folder }, flags, io, deps) {
  const cli = deps.cli ?? "mc-bridge";
  if (flags.list || id === "starters" || id === "list") {
    io.out(starterList(cli));
    return 0;
  }
  const starter = id ? starterById(id) : null;
  if (!starter) {
    io.err(`Unknown starter "${id ?? ""}".\n${starterList(cli)}`);
    return 1;
  }
  const now = deps.now?.() ?? Date.now();
  const scope = flags.scope === undefined ? "read" : String(flags.scope);
  if (!STARTER_SCOPES.includes(scope)) throw new BridgeError("VALIDATION_FAILED", `A starter key may have the scope ${STARTER_SCOPES.join(" or ")}, not "${scope}". Live and admin keys are made on purpose with: ${cli} keys create`);
  const wantsKey = flags["with-key"] === true;
  const baseUrl = deps.baseUrl();
  const name = folder ?? `bridge-${starter.id}`;
  const dir = resolve(io.cwd, name);

  // Check the folder before making a key, so a refusal leaves no key behind.
  const files = planStarter(starter.id, { baseUrl, folder: name, cli, now: new Date(now) });
  try {
    writeStarter(dir, [], { force: flags.force === true });
  } catch (err) {
    io.err(`Error: ${err.message}`);
    return 1;
  }

  let key = null;
  let record = null;
  if (wantsKey && !starter.needsKey) io.err(`Note: the ${starter.id} starter does not call the Bridge with a key, so none was made.`);
  if (wantsKey && starter.needsKey) {
    ({ key, record } = await deps.createKey({ label: `starter-${starter.id}`, scopes: [scope], accounts: "*", clientKind: starter.clientKind, expiresAt: expiry(flags.expires, starter.expiresDays, now) }));
  }
  // Plan again with the key so README and .env say what is true; the first plan only checked the folder.
  const final = key ? planStarter(starter.id, { baseUrl, folder: name, key, keyRecord: record, cli, now: new Date(now), webhookSecret: undefined }) : files;
  const { written, kept } = writeStarter(dir, final, { force: flags.force === true });

  io.out(`Made ${starter.title} starter in ${name}/ (${written.length} files)`);
  for (const p of written) io.out(`  ${p}`);
  for (const p of kept) io.out(`  ${p} (kept: it already existed)`);
  io.out("");
  io.out(`Bridge address: ${baseUrl}`);
  if (record) io.out(`Key ${record.id}: scope ${record.scopes.join(", ")}${record.expiresAt ? `, expires ${record.expiresAt.slice(0, 10)}` : ""}. It is in ${name}/.env only (listed in .gitignore). Revoke it with: ${cli} keys revoke ${record.id}`);
  else if (starter.needsKey) io.out(`No key was made. Add one to ${name}/.env, or run again with --with-key (a read-only key made for this project).`);
  const running = deps.probe ? await deps.probe(baseUrl).catch(() => null) : null;
  io.out(running ? `The Bridge is running${running.demo ? " in demo mode" : ""}.` : `The Bridge is not answering at ${baseUrl}. Start it with: ${cli} start${flags.demo ? " --demo" : ""}   (or ${cli} start --demo to try with sample data)`);
  io.out("");
  io.out(`Next: cd ${name} && ${starter.run}`);
  io.out(`Then read ${name}/README.md (three steps) and the Developers page in the dashboard.`);
  return 0;
}

