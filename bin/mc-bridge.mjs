#!/usr/bin/env node
/**
 * mc-bridge — command line for the Mr. Chartist API Bridge.
 *
 *   mc-bridge init [--yes] [--demo] [--broker <id>]   (first-run setup; alias: setup)
 *   mc-bridge start [--config <file>] [--demo] [--open]   (--open: dashboard already signed in; reuses a running Bridge)
 *   mc-bridge open                       (open the running Bridge's dashboard, already signed in)
 *   mc-bridge keys create --label <name> --scope read[,paper,live,admin] [--accounts a,b|*] [--expires 30d] [--allow-query] [--client excel]
 *   mc-bridge keys list
 *   mc-bridge keys revoke <keyId>
 *   mc-bridge accounts list
 *   mc-bridge doctor [--no-port-check] [--strict]
 *   mc-bridge expose [alerts|sheets] | check | status | off      (let TradingView or a Google Sheet reach the Bridge safely)
 *   mc-bridge backup [--out FILE] [--include-secrets] | backup list | backup verify FILE   (see docs/guides/backup.md)
 *   mc-bridge restore FILE [--dry-run] [--yes]   (the Bridge must be stopped)
 *   mc-bridge mcp --key <key>            (MCP over stdio for Claude Desktop, Claude Code, Cursor)
 *   mc-bridge openai-tools [--scope read|paper] [--format responses|chat]   (tool schemas for OpenAI function calling)
 *   mc-bridge sources list | enable <id> [--acknowledge <version>] | disable <id> | set-key <id> | test <id>
 *   mc-bridge sources trace --capability quotes --symbols NSE:RELIANCE [--purpose display]
 *   mc-bridge sources plugins check <folder> | pin <folder>   (data sources and plugins; see docs/guides/sources.md)
 *   mc-bridge notify telegram setup | remove <id>, notify status | test   (Telegram alerts; the token is asked for, never an argument)
 *   mc-bridge collections list | show | create | universe | resolve | tag | rename | duplicate | delete | export | import | usage | estimate
 *   mc-bridge subscriptions list | add <https url> --topics ... | test | deliveries | dead-letters | tail   (signed webhooks out; see docs/guides/events.md)
 *   mc-bridge download <symbols...> --interval 5m --from 2024-01-01 [--dataset <name>] [--watch] | list | show | pause | resume | cancel | files | datasets | update
 *                                       (save history to files; see docs/guides/downloads.md)
 *
 * The CLI runs on this computer with access to the data directory, so it acts as the local administrator
 * (principal { kind: "local", id: "cli" }). Keys are printed once and never again.
 */
import { parseArgs } from "node:util";
import { runCli } from "../server/bridge/core/cli.mjs";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    config: { type: "string" },
    label: { type: "string" },
    scope: { type: "string" },
    accounts: { type: "string" },
    expires: { type: "string" },
    client: { type: "string" },
    key: { type: "string" },
    format: { type: "string" },
    "allow-query": { type: "boolean" },
    "no-port-check": { type: "boolean" },
    strict: { type: "boolean" },
    provider: { type: "string" },
    host: { type: "string" },
    port: { type: "string" },
    "allow-ips": { type: "string" },
    "public-url": { type: "string" },
    "allow-outbound": { type: "boolean" },
    check: { type: "boolean" },
    json: { type: "boolean" },
    demo: { type: "boolean" },
    open: { type: "boolean" },
    yes: { type: "boolean", short: "y" },
    force: { type: "boolean" },
    broker: { type: "string" },
    account: { type: "string" },
    "no-paper": { type: "boolean" },
    "no-key": { type: "boolean" },
    url: { type: "string" },
    reason: { type: "string" },
    "cancel-open": { type: "boolean" },
    capability: { type: "string" },
    symbols: { type: "string" },
    purpose: { type: "string" },
    acknowledge: { type: "string" },
    "max-age": { type: "string" },
    out: { type: "string" },
    "include-secrets": { type: "boolean" },
    interval: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    dataset: { type: "string" },
    layout: { type: "string" },
    collection: { type: "string" },
    tags: { type: "string" },
    name: { type: "string" },
    status: { type: "string" },
    watch: { type: "boolean" },
    backup: { type: "boolean" },
    "after-hours": { type: "boolean" },
    "dry-run": { type: "boolean" },
    "skip-config": { type: "boolean" },
    // mc-bridge collections
    tag: { type: "string" },
    tags: { type: "string" },
    description: { type: "string" },
    kind: { type: "string" },
    name: { type: "string" },
    file: { type: "string" },
    underlying: { type: "string" },
    expiries: { type: "string" },
    strikes: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    sides: { type: "string" },
    interval: { type: "string" },
    days: { type: "string" },
    spot: { type: "string" },
    future: { type: "boolean" },
    "no-underlying": { type: "boolean" },
    replace: { type: "boolean" },
    "skip-invalid": { type: "boolean" },
    "allow-stale": { type: "boolean" },
    topics: { type: "string" },
    since: { type: "string" },
    outcome: { type: "string" },
    limit: { type: "string" },
    retry: { type: "string" },
    "retry-all": { type: "boolean" },
    clear: { type: "boolean" },
    "secret-stdin": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
});

const code = await runCli(positionals, values, {
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
  env: process.env,
  cwd: process.cwd(),
});
if (code !== null) process.exitCode = code;
