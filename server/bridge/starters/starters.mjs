/**
 * Developer starters: `mc-bridge init <starter> [folder]` writes a ready project into a new folder, with this Bridge's
 * real address, a README with three runnable steps, and (on request) a key with only the access the starter needs.
 *
 * The code of each starter lives as real files next to this one (server/bridge/starters/<id>/), so it can be read,
 * linted and run as it is; a test (starters.test.mjs) runs every starter against a demo Bridge. This module only
 * lists them, fills in the README, and writes the files that must never be shared: `.env` (the key and the address),
 * `.env.example`, `.gitignore`.
 *
 * Rules
 *  - A key is never written to a file that could be committed: only to `.env` (mode 0600), which `.gitignore` lists.
 *  - A starter key is least privilege: `read` unless the person asks for `paper`; never `live` or `admin`.
 *  - The folder must be new or empty; `--force` writes into a folder that already has files. It never deletes any, never
 *    follows a link (a symlink or dangling link in the folder is refused), never replaces an existing `.env`, and keeps a
 *    `.bak` copy of any other file it replaces.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");

/**
 * @typedef {{ id: string, title: string, about: string, run: string, clientKind: "script"|"excel"|"mcp"|"other", needsKey: boolean,
 *   expiresDays: number, secret?: boolean, extra?: (o: { root: string }) => Array<{ path: string, content: string }>, packageJson?: object }} Starter
 */

/** @type {readonly Starter[]} */
export const STARTERS = Object.freeze([
  { id: "node", title: "Node", about: "Prices, history, data downloads and events from Node 22. No packages.", run: "node index.mjs", clientKind: "script", needsKey: true, expiresDays: 90, packageJson: { name: "bridge-node-starter", private: true, type: "module", description: "A starter that talks to the Bridge.", scripts: { start: "node index.mjs", history: "node examples/history.mjs", download: "node examples/download.mjs", events: "node examples/events.mjs" }, engines: { node: ">=22" } } },
  { id: "python", title: "Python", about: "The same from Python 3.9 or newer, standard library only.", run: "python3 main.py", clientKind: "script", needsKey: true, expiresDays: 90 },
  { id: "curl", title: "curl", about: "Shell scripts with curl: one function that handles the key, errors and retries.", run: "bash quote.sh", clientKind: "script", needsKey: true, expiresDays: 90 },
  {
    id: "sheets",
    title: "Google Sheets",
    about: "The Bridge's Apps Script for Google Sheets, with a check you can run before you paste it. Needs a tunnel you set up.",
    run: "node check.mjs",
    clientKind: "excel",
    needsKey: true,
    expiresDays: 30,
    extra: ({ root }) => [{ path: "Code.gs", content: readFileSync(join(root, "integrations", "google-sheets", "bridge.gs"), "utf8") }],
  },
  { id: "webhook-receiver", title: "Webhook receiver", about: "A server that receives the Bridge's signed events, checks the signature and handles each event once.", run: "node receiver.mjs", clientKind: "other", needsKey: false, expiresDays: 0, secret: true },
  { id: "mcp-client", title: "MCP client", about: "Use the Bridge's AI tools from your own program, or set up an assistant app.", run: "node mcp.mjs", clientKind: "mcp", needsKey: true, expiresDays: 90 },
]);

export const STARTER_IDS = Object.freeze(STARTERS.map((s) => s.id));
export const starterById = (id) => STARTERS.find((s) => s.id === id) ?? null;

/** Scopes a starter key may have. Never admin or live: a starter is a place to begin, not to hold power. */
export const STARTER_SCOPES = Object.freeze(["read", "paper"]);

const GITIGNORE = [".env", ".env.*", "!.env.example", "node_modules/", "__pycache__/", "*.pyc", ".venv/", "downloads/", "*.csv", ""].join("\n");

/** All files under `dir`, as paths relative to it, sorted. */
function walk(dir, base = dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p, base) : [relative(base, p).split(sep).join("/")];
    });
}

/** A secret for signing webhooks: 32 random bytes. It is shown to nobody; it lives in .env and in the subscription. */
export const newWebhookSecret = () => `whsec_${randomBytes(32).toString("base64url")}`;

const envText = (starter, { baseUrl, key, webhookSecret, madeOn, withKey }) => {
  const lines = [`# Made by mc-bridge init ${starter.id} on ${madeOn}. This file holds secrets: it is in .gitignore. Do not commit or share it.`, `BRIDGE_URL=${baseUrl}`];
  if (starter.needsKey) lines.push(`BRIDGE_KEY=${withKey ? key : ""}`);
  if (starter.secret) lines.push(`WEBHOOK_SECRET=${webhookSecret}`, "RECEIVER_PORT=4600");
  return `${lines.join("\n")}\n`;
};

const exampleText = (starter, { baseUrl }) => {
  const lines = [`# Copy to .env and fill in. .env is in .gitignore; this example file is safe to commit.`, `BRIDGE_URL=${baseUrl}`];
  if (starter.needsKey) lines.push("BRIDGE_KEY=");
  if (starter.secret) lines.push("WEBHOOK_SECRET=", "RECEIVER_PORT=4600");
  return `${lines.join("\n")}\n`;
};

/**
 * Every file of a starter, with README words filled in: [{ path, content, secret? }]. `secret: true` marks the one file
 * that holds a key (.env): the writer gives it mode 0600.
 * @param {string} id
 * @param {{ baseUrl: string, folder?: string, key?: string | null, keyRecord?: { id: string, scopes: string[], expiresAt: string | null } | null,
 *   webhookSecret?: string, now?: Date, root?: string, cli?: string }} o
 */
export function planStarter(id, { baseUrl, folder = `bridge-${id}`, key = null, keyRecord = null, webhookSecret, now = new Date(), root = ROOT, cli = "mc-bridge" }) {
  const starter = starterById(id);
  if (!starter) throw new Error(`Unknown starter "${id}". Choose one of: ${STARTER_IDS.join(", ")}.`);
  const secret = starter.secret ? (webhookSecret ?? newWebhookSecret()) : undefined;
  const withKey = Boolean(key);
  const label = `starter-${id}`;
  const scope = keyRecord?.scopes?.join(", ") ?? "read";
  const keyStep = !starter.needsKey
    ? "No Bridge key is needed to receive events."
    : withKey
      ? `Your key is already in \`.env\` (scope \`${scope}\`, key id \`${keyRecord?.id ?? "?"}\`).`
      : `Put an API key in \`.env\` as \`BRIDGE_KEY=...\`. Make one with \`${cli} keys create --label ${label} --scope read --client ${starter.clientKind} --expires ${starter.expiresDays}d\` (it is shown once).`;
  const keyNote = !starter.needsKey
    ? "This project holds a webhook secret in `.env`, made for you. Treat it like a password."
    : withKey
      ? `This project's key was made for it with only the \`${scope}\` scope${keyRecord?.expiresAt ? ` and expires on ${keyRecord.expiresAt.slice(0, 10)}` : ""}. It is in \`.env\`, which is in \`.gitignore\`. Revoke it any time: \`${cli} keys revoke ${keyRecord?.id ?? "<key id>"}\`.`
      : `No key was made. Next time, \`${cli} init ${id} --with-key\` makes one with only the \`read\` scope and puts it in \`.env\` for you.`;
  const words = { baseUrl, folder, keyStep, keyNote };
  const fill = (text) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in words ? words[k] : m));

  const dir = join(HERE, id);
  const files = walk(dir).map((path) => {
    const raw = readFileSync(join(dir, path), "utf8");
    return { path, content: path === "README.md" ? fill(raw) : raw, executable: path.endsWith(".sh") };
  });
  for (const e of starter.extra?.({ root }) ?? []) files.push({ ...e, executable: false });
  if (starter.packageJson) files.push({ path: "package.json", content: `${JSON.stringify(starter.packageJson, null, 2)}\n`, executable: false });
  const madeOn = now.toISOString().slice(0, 10);
  files.push({ path: ".env", content: envText(starter, { baseUrl, key, webhookSecret: secret, madeOn, withKey }), secret: true, executable: false });
  files.push({ path: ".env.example", content: exampleText(starter, { baseUrl }), executable: false });
  files.push({ path: ".gitignore", content: GITIGNORE, executable: false });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** lstat that says "not there" as null (a dangling link IS there: lstat sees the link, existsSync does not). */
function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
    throw err;
  }
}

/** Refuse a path that goes through a link, or ends in something that is not a plain file. */
function assertPlainTarget(dir, target) {
  let cur = dir;
  for (const part of relative(dir, target).split(sep)) {
    cur = join(cur, part);
    const st = lstatOrNull(cur);
    if (st === null) return; // nothing below can exist either
    if (st.isSymbolicLink()) throw new Error(`${cur} is a link. A link in the folder could send the write somewhere else, so nothing was written. Remove the link or choose a new folder name.`);
    if (cur === target && !st.isFile()) throw new Error(`${cur} is not a plain file, so nothing was written. Choose a new folder name.`);
  }
}

/** Is the file a starter keeps (the `.env`) already there? A link counts: it is refused by checkStarter first. */
export const secretIsThere = (dir, files) => files.some((f) => f.secret && lstatOrNull(resolve(dir, f.path)) !== null);

/**
 * Check a folder and every file about to be written, without writing: the folder is new or empty (or `force`), nothing
 * goes outside it, and no path in it is a link. Throws an Error with a plain message.
 * @param {string} dir absolute
 * @param {Array<{ path: string }>} files
 */
export function checkStarter(dir, files, { force = false } = {}) {
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new Error(`${dir} is a file. Choose a new folder name.`);
    if (readdirSync(dir).length > 0 && !force) throw new Error(`${dir} is not empty. Choose a new folder name, or add --force to write into it (nothing is deleted; a file that is replaced is kept as .bak).`);
  }
  for (const f of files) {
    const target = resolve(dir, f.path);
    // Starter paths are fixed by this repository; this guards the writer anyway.
    if (target !== dir && !target.startsWith(dir + sep)) throw new Error(`Refusing to write outside ${dir}: ${f.path}`);
    assertPlainTarget(dir, target);
  }
}

/** A free `<path>.bak`, `<path>.bak2`, ... */
function backupName(path) {
  let name = `${path}.bak`;
  for (let i = 2; lstatOrNull(name) !== null; i += 1) name = `${path}.bak${i}`;
  return name;
}

/**
 * Write a starter into `dir` (new or empty unless `force`). Returns { written, kept, backedUp }: with `force`, a `.env`
 * that is already there is kept as it is (it may hold a key that is in use), and any other file that would be replaced
 * with different content is first renamed to `<name>.bak`. A link anywhere in the folder is refused before anything is written.
 * @param {string} dir absolute
 * @param {ReturnType<typeof planStarter>} files
 */
export function writeStarter(dir, files, { force = false } = {}) {
  checkStarter(dir, files, { force });
  const written = [];
  const kept = [];
  const backedUp = [];
  for (const f of files) {
    const target = resolve(dir, f.path);
    const there = lstatOrNull(target);
    if (f.secret && there !== null) {
      kept.push(f.path);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    assertPlainTarget(dir, target); // again, after the folders above exist
    if (there !== null && readFileSync(target, "utf8") !== f.content) {
      const bak = backupName(target);
      renameSync(target, bak);
      backedUp.push({ path: f.path, backup: relative(dir, bak).split(sep).join("/") });
    }
    // `wx` and no-follow: if something appeared at the path since the check, this fails instead of writing through it
    const flags = constants.O_WRONLY | constants.O_CREAT | (there !== null && !backedUp.some((b) => b.path === f.path) ? constants.O_TRUNC : constants.O_EXCL) | (constants.O_NOFOLLOW ?? 0);
    const fd = openSync(target, flags, f.secret ? 0o600 : f.executable ? 0o755 : 0o644);
    try {
      writeSync(fd, f.content);
    } finally {
      closeSync(fd);
    }
    written.push(f.path);
  }
  return { written, kept, backedUp };
}
