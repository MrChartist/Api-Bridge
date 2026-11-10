/**
 * `mc-bridge init <starter> [folder]` (the command line side of starters.mjs).
 *
 *   mc-bridge init node                 a project in ./bridge-node with this Bridge's address, no key
 *   mc-bridge init python my-bot --with-key [--scope read|paper] [--expires 30d] [--accounts a,b|all]
 *   mc-bridge init --list               the starters
 *
 * Everything that touches the Bridge is passed in (`deps`), so the command is tested without a running Bridge:
 *   baseUrl()          the address of this Bridge (--url, MCB_BRIDGE_URL, or the configuration)
 *   createKey(body)    makes a key in this computer's key store (the local administrator may); returns { key, record }
 *   probe(baseUrl)     the health answer of a running Bridge, or null
 *   listAccounts()     the accounts of this Bridge and whether each is connected now: [{ id, state }] (optional)
 *   ask(question)      a line typed by the person, only given when a person is at the terminal (optional)
 *
 * Which accounts the key may use: --accounts a,b (checked against the Bridge's accounts), --accounts all (every account,
 * also later ones), else the accounts that are connected right now, said out loud and written in the README. With no
 * account connected the key may use all of them, so a starter is never harder to make than before. A person at a terminal
 * with several connected accounts is asked once; Enter accepts the default.
 */
import { resolve } from "node:path";
import { BridgeError } from "../core/errors.mjs";
import { STARTERS, STARTER_IDS, STARTER_SCOPES, checkStarter, planStarter, secretIsThere, starterById, writeStarter, runCommand, shellWord } from "./starters.mjs";

/** The `--expires` words the keys command takes: 30d, 12h, 90m. Returns an ISO time. */
function expiry(value, days, now) {
  if (value !== undefined) {
    const m = /^(\d{1,4})([dhm])$/.exec(String(value));
    if (!m) throw new BridgeError("VALIDATION_FAILED", `--expires must be like 30d, 12h or 90m, got ${value}.`);
    return new Date(now + Number(m[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2]]).toISOString();
  }
  return days > 0 ? new Date(now + days * 86_400_000).toISOString() : null;
}

const KEY_ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

/**
 * Decide which accounts a starter key may use. Pure apart from `ask`.
 * @param {{ flag?: string | boolean, known: Array<{ id: string, state?: string }> | null, ask?: (q: string) => Promise<string>, cli?: string }} o
 * @returns {Promise<{ accounts: "*" | string[], note: string }>}
 */
export async function chooseKeyAccounts({ flag, known, ask, cli = "mc-bridge" }) {
  const ids = (known ?? []).map((a) => a.id);
  const connected = (known ?? []).filter((a) => a.state === "connected").map((a) => a.id);
  const usable = (list) => {
    const bad = list.filter((a) => !KEY_ACCOUNT_RE.test(a));
    if (bad.length) throw new BridgeError("VALIDATION_FAILED", `A key can only name accounts whose id is 2 to 32 lower-case letters, digits or hyphens; ${bad.join(", ")} is not. Use --accounts all, or rename the account.`);
    return list;
  };
  const parse = (text) => {
    const t = String(text).trim();
    if (t === "all" || t === "*") return { accounts: "*", note: "The key may use every account, including accounts you add later." };
    const list = [...new Set(t.split(",").map((x) => x.trim()).filter(Boolean))];
    if (!list.length) throw new BridgeError("VALIDATION_FAILED", "--accounts needs account ids separated by commas, or all.");
    if (known) {
      const unknown = list.filter((a) => !ids.includes(a));
      if (unknown.length) throw new BridgeError("VALIDATION_FAILED", `This Bridge has no account called ${unknown.join(", ")}. Its accounts: ${ids.join(", ") || "(none yet)"}. List them with: ${cli} accounts list`);
    }
    return { accounts: usable(list), note: `The key may use only: ${list.join(", ")}.` };
  };
  if (typeof flag === "string") return parse(flag);
  if (!connected.length) {
    return { accounts: "*", note: ids.length ? `No account is connected right now, so the key may use all of them (${ids.join(", ")}), including accounts you add later. Narrow it with --accounts a,b.` : "No account is set up yet, so the key may use any account you add later. Narrow it with --accounts a,b." };
  }
  // An id a key cannot name (for example one with an underscore) must not make a starter fail: the key may then use all accounts.
  if (connected.some((a) => !KEY_ACCOUNT_RE.test(a))) return { accounts: "*", note: `An account id (${connected.filter((a) => !KEY_ACCOUNT_RE.test(a)).join(", ")}) cannot be named in a key, so the key may use all accounts, including accounts you add later.` };
  const dflt = { accounts: usable(connected), note: `The key may use only the accounts connected right now: ${connected.join(", ")}. Accounts added or connected later need a new key, or use --accounts all.` };
  if (ask && connected.length > 1) {
    const answer = String(await ask(`Which accounts may this key use? Connected now: ${connected.join(", ")}. Press Enter for those, type ids separated by commas, or "all": `)).trim();
    if (answer) return parse(answer);
  }
  return dflt;
}

/** The list of starters, one per line. */
export function starterList(cli = "mc-bridge") {
  const w = Math.max(...STARTER_IDS.map((s) => s.length));
  return ["Starters (each makes a ready project in a new folder):", ...STARTERS.map((s) => `  ${s.id.padEnd(w)}  ${s.about}`), "", `Make one:  ${cli} init <starter> [folder] [--with-key] [--scope read|paper] [--expires 30d] [--accounts a,b|all] [--url <Bridge address>]`].join("\n");
}

/**
 * @param {{ id?: string, folder?: string }} args
 * @param {Record<string, string | boolean | undefined>} flags
 * @param {{ out(s: string): void, err(s: string): void, cwd: string }} io
 * @param {{ baseUrl(): string, createKey(body: object): Promise<{ key: string, record: { id: string, scopes: string[], expiresAt: string | null } }>, probe?(url: string): Promise<{ demo?: boolean } | null>, listAccounts?(): Promise<Array<{ id: string, state?: string }>>, ask?(q: string): Promise<string>, cli?: string, now?: () => number }} deps
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

  // Check the folder and every file before making a key, so a refusal leaves no key behind.
  const files = planStarter(starter.id, { baseUrl, folder: name, cli, now: new Date(now) });
  try {
    checkStarter(dir, files, { force: flags.force === true });
  } catch (err) {
    io.err(`Error: ${err.message}`);
    return 1;
  }

  let key = null;
  let record = null;
  let keySkipped = false;
  let keyAccounts = null;
  let accountsNote = null;
  if (wantsKey && !starter.needsKey) io.err(`Note: the ${starter.id} starter does not call the Bridge with a key, so none was made.`);
  if (wantsKey && starter.needsKey) {
    // A `.env` that is already there is never replaced, so a key made now would be shown nowhere and could not be recovered.
    if (secretIsThere(dir, files)) keySkipped = true;
    else {
      // Which accounts the key may use is settled (and checked) before a key exists, so a mistake leaves no key behind.
      let known = null;
      try {
        known = deps.listAccounts ? await deps.listAccounts() : null;
      } catch {
        known = null; // the account list could not be read: the key falls back to all accounts and the output says so
      }
      ({ accounts: keyAccounts, note: accountsNote } = await chooseKeyAccounts({ flag: flags.accounts, known, ask: deps.ask, cli }));
      ({ key, record } = await deps.createKey({ label: `starter-${starter.id}`, scopes: [scope], accounts: keyAccounts, clientKind: starter.clientKind, expiresAt: expiry(flags.expires, starter.expiresDays, now) }));
    }
  }
  // Plan again with the key so README and .env say what is true; the first plan only checked the folder.
  const final = key ? planStarter(starter.id, { baseUrl, folder: name, key, keyRecord: record, keyAccounts, cli, now: new Date(now), webhookSecret: undefined }) : files;
  let result;
  try {
    result = writeStarter(dir, final, { force: flags.force === true });
  } catch (err) {
    // A key made for this project that could not be written would be lost (it is shown once): name it, so it can be revoked.
    io.err(`Error: ${err.message}${record ? ` The key ${record.id} that was made for this project was not saved anywhere. Revoke it with: ${cli} keys revoke ${record.id}` : ""}`);
    return 1;
  }
  const { written, kept, backedUp } = result;

  io.out(`Made ${starter.title} starter in ${name}/ (${written.length} files)`);
  for (const p of written) io.out(`  ${p}`);
  for (const p of kept) io.out(`  ${p} (kept: it already existed)`);
  for (const b of backedUp) io.out(`  ${b.path} replaced; the old file is saved as ${b.backup}`);
  io.out("");
  io.out(`Bridge address: ${baseUrl}`);
  if (record) {
    io.out(`Key ${record.id}: scope ${record.scopes.join(", ")}${record.expiresAt ? `, expires ${record.expiresAt.slice(0, 10)}` : ""}. It is in ${name}/.env only (listed in .gitignore). Revoke it with: ${cli} keys revoke ${record.id}`);
    if (accountsNote) io.out(accountsNote);
  } else if (keySkipped) io.out(`No key was made: ${name}/.env already exists and is never replaced, so a new key would have been shown nowhere. Put a key in it yourself, or remove it and run again with --with-key.`);
  else if (starter.needsKey) io.out(`No key was made. Add one to ${name}/.env, or run again with --with-key (a read-only key made for this project).`);
  const running = deps.probe ? await deps.probe(baseUrl).catch(() => null) : null;
  io.out(running ? `The Bridge is running${running.demo ? " in demo mode" : ""}.` : `The Bridge is not answering at ${baseUrl}. Start it with: ${cli} start${flags.demo ? " --demo" : ""}   (or ${cli} start --demo to try with sample data)`);
  io.out("");
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    // PowerShell 5 and cmd.exe disagree about "&&": two lines work in both.
    io.out(`Next: cd ${shellWord(name)}`);
    io.out(`Then: ${runCommand(starter, platform)}`);
  } else io.out(`Next: cd ${shellWord(name)} && ${runCommand(starter, platform)}`);
  io.out(`Then read ${name}/README.md (three steps) and the Developers page in the dashboard.`);
  return 0;
}

