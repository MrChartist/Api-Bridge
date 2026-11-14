#!/usr/bin/env node
/**
 * Builds docs/guides/config.md, the reference of every bridge.config.json key, from the real zod schemas (types, defaults,
 * limits: scripts/lib/config-model.mjs) and the plain-words descriptions (scripts/lib/config-descriptions.mjs).
 * scripts/config-reference.test.mjs fails when a key has no description or the committed page is stale.
 *
 *   node scripts/gen-config-reference.mjs           write
 *   node scripts/gen-config-reference.mjs --check   exit 1 when the committed page is out of date
 */
import { pathToFileURL } from "node:url";
import { REMOVED_SETTINGS } from "../server/bridge/core/config.mjs";
import { REPO_ROOT } from "./lib/openapi-model.mjs";
import { configSections, keysOf } from "./lib/config-model.mjs";
import { DESCRIPTIONS, SECTIONS } from "./lib/config-descriptions.mjs";
import { runCli } from "./lib/outputs.mjs";

const OUT = "docs/guides/config.md";

const cell = (s) => String(s).replaceAll("|", "\\|").replaceAll("\n", " ");

/** The default as it would be written in the file. */
function defaultText(k) {
  if (!k.hasDefault) return k.optional ? "not set" : "required";
  const v = k.default;
  if (v === undefined) return "see the keys below";
  if (typeof v === "string") return `\`"${v}"\``;
  return `\`${JSON.stringify(v)}\``;
}

function typeText(k) {
  let t = k.type;
  if (k.values) t = k.type === "one of" ? `one of ${k.values.map((v) => `\`${v}\``).join(", ")}` : `${t} (${k.values.map((v) => `\`${v}\``).join(", ")})`;
  const extra = [...k.limits];
  if (k.nullable) extra.push("or `null`");
  return extra.length ? `${t}; ${extra.join(", ")}` : t;
}

/** Page text for the given sections (default: the real ones). */
export function configPage(allSections = configSections(), descriptions = DESCRIPTIONS, meta = SECTIONS) {
  // Single-value keys at the top of the file (dataDir, masterKeyFile, demo) read better in one table than in three.
  const isScalar = (s) => ["dataDir", "masterKeyFile", "demo"].includes(s.name);
  const scalars = allSections.filter(isScalar);
  const sections = [{ name: "general", schemas: scalars, owner: "core" }, ...allSections.filter((s) => !isScalar(s))];
  const lines = [
    "# Configuration reference",
    "",
    "> Commands here start with `mc-bridge`. In a git checkout, run them as `npm run bridge -- <command>` instead ([why](README.md#running-mc-bridge)).",
    "",
    "Every setting of `bridge.config.json`: what it is, its type, its default and what it does. *This page is generated from the",
    "Bridge's own settings checker and `scripts/lib/config-descriptions.mjs` (run `npm run docs:generate`); a test fails when a setting",
    "has no description.*",
    "",
    "Most people change very little: a demo or paper Bridge runs with no file at all. For a first set-up use `mc-bridge init`, then",
    "[accounts.md](accounts.md) to add a broker. Change a setting here only when a guide tells you to, or when you know what it does.",
    "",
    "## How the file is read",
    "",
    "- **Where it is.** The Bridge looks for `bridge.config.json` in this order: `--config <file>`, the `MCB_CONFIG` variable, the file of that name in the current folder, then the per-user folder (`MCB_HOME`, else `%APPDATA%\\MrChartist\\Bridge` on Windows, else `~/.mc-bridge`). With none of them it runs on safe defaults: paper only, no accounts, `127.0.0.1:4300`.",
    "- **Order of precedence.** Built-in defaults, then the file, then the environment. The environment can only change where the Bridge listens and logs, or make it stricter. It can never switch live trading on.",
    "- **Changes need a restart.** The Bridge reads the file once, when it starts. Accounts added on the dashboard are the exception: they are written to the file and used at once. Stop with Ctrl+C and start again after editing.",
    "- **Typos are caught.** A key the Bridge does not know, or a value outside its range, stops the start with a message that names the key, for example `Config is not valid: safety: Unrecognized key: \"maxOrderValu\"`. `mc-bridge doctor` checks the file without starting the Bridge.",
    "- **Only what you change.** Write only the keys you want to change. Leave the rest out and the defaults below apply. A section you leave out is the same as `{}`.",
    "- **No secrets.** Broker logins, the master key and webhook secrets never go in this file. They are kept encrypted in the data folder.",
    "- **Times** are IST (Asia/Kolkata), 24-hour `HH:MM`, unless a setting says this computer's clock. **Money** is in rupees. Names that end in `Ms` are milliseconds, `Sec` or `S` seconds, `Mb` megabytes.",
    "",
    "### Environment variables",
    "",
    "| Variable | Effect |",
    "|---|---|",
    "| `MCB_CONFIG` | The config file to read |",
    "| `MCB_HOME` | The per-user Bridge folder (config file and data) |",
    "| `MCB_HOST`, `MCB_PORT` | Override `server.host` and `server.port` |",
    "| `MCB_DATA_DIR` | Overrides `dataDir` |",
    "| `MCB_LOG_LEVEL` | Overrides `logging.level` |",
    "| `MCB_PAPER_ONLY=1` | Forces `safety.liveTrading` off |",
    "| `MCB_KILL_SWITCH=1` | Starts with the kill switch on (same as `safety.killSwitchOnStart`) |",
    "| `MCB_DEMO=1` | Demo mode (same as `demo`) |",
    "| `MCB_MASTER_KEY`, `MCB_MASTER_KEY_FILE` | The master key itself, or the file that holds it. These take precedence over `masterKeyFile` |",
    "| `MCB_API_KEY`, `MCB_ADMIN_KEY`, `MCB_BRIDGE_URL` | Not settings of the Bridge: what the command line and the SDKs use to reach a running Bridge ([cli.md](cli.md)) |",
    "",
    "### Settings that no longer exist",
    "",
    "A file that still holds one of these stops the start with a message that lists them (`Your config file has settings that v2 no longer has. Delete them and start again`):",
    "",
    ...Object.entries(REMOVED_SETTINGS).map(([k, why]) => `- \`${k}\`: ${why}`),
    "- `mcp.toolsets` with `\"options\"`: there are no options tools",
    "",
    "## Sections",
    "",
    ...sections.map((s) => `- [\`${s.name}\`](#${s.name.toLowerCase()})${s.name === "general" ? ": " + scalars.map((x) => `\`${x.name}\``).join(", ") : ""}`),
    "",
  ];
  for (const s of sections) {
    const m = meta[s.name];
    if (!m) throw new Error(`config section ${s.name} has no entry in scripts/lib/config-descriptions.mjs SECTIONS`);
    lines.push(`## ${s.name}`, "", m.about + (m.guide ? ` More: [${m.guide}](${m.guide}).` : ""), "");
    lines.push("| Key | Type | Default | What it does |", "|---|---|---|---|");
    const keys = s.schemas ? s.schemas.flatMap((x) => keysOf(x.schema, x.name, x.name)) : keysOf(s.schema, s.name, s.name);
    for (const k of keys) {
      const text = descriptions[k.path];
      if (!text) throw new Error(`config key ${k.path} has no description in scripts/lib/config-descriptions.mjs`);
      lines.push(`| \`${cell(k.path)}\` | ${cell(typeText(k))} | ${cell(defaultText(k))} | ${cell(text)} |`);
    }
    lines.push("");
  }
  lines.push(
    "In `ratelimit`, `<name>` stands for a name you choose: a broker id, an account id, a key id, or the kind of request. In lists such as `accounts[]` and `sources.plugins[]`, `[]` stands for one entry of the list.",
    "",
  );
  return lines.join("\n");
}

export function buildConfigReference() {
  return new Map([[OUT, configPage()]]);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) runCli("gen-config-reference", REPO_ROOT, buildConfigReference(), [OUT]);
