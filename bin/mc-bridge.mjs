#!/usr/bin/env node
/**
 * mc-bridge — command line for the Mr. Chartist API Bridge.
 *
 *   mc-bridge start [--config <file>]
 *   mc-bridge keys create --label <name> --scope read[,paper,live,admin] [--accounts a,b|*] [--expires 30d] [--allow-query] [--client excel]
 *   mc-bridge keys list
 *   mc-bridge keys revoke <keyId>
 *   mc-bridge accounts list
 *   mc-bridge doctor [--no-port-check]
 *   mc-bridge mcp --key <key>            (MCP over stdio for Claude Desktop, Claude Code, Cursor)
 *   mc-bridge openai-tools [--scope read|paper] [--format responses|chat]   (tool schemas for OpenAI function calling)
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
    json: { type: "boolean" },
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
