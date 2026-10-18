/**
 * mcp module — stream S11: MCP server for AI assistants. Owned files and tasks: docs/STREAMS.md §S11.
 * The route below is the contract in docs/openapi.yaml (method, path, auth, scope).
 *
 *   POST /mcp     Streamable HTTP (stateless JSON mode); key with "read" scope; tools depend on key + config
 *   mc-bridge mcp stdio relay to POST /mcp (stdio.mjs runStdio)
 *
 * Config section `mcp` (optional; see config.mjs): enabled, toolsets, orderAccounts, maxItems. Default read-only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BridgeError } from "../core/errors.mjs";
import { defineModule } from "../core/modules.mjs";
import { MCP_CONFIG_SCHEMA, mcpConfig } from "./config.mjs";
import { handleMcpHttp } from "./server.mjs";
import { createToolRegistry } from "./tools.mjs";

/** [method, path, route options] */
export const ROUTES = Object.freeze([["POST", "/mcp", { scope: "read" }]]);

const registries = new WeakMap();

/** The registry register() built for these deps (tests, the OpenAI export of a running Bridge). */
export function mcpRegistryFor(deps) {
  return registries.get(deps) ?? null;
}

function packageVersion(root) {
  try {
    return String(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

export default defineModule({
  name: "mcp",
  stream: "S11",
  configKey: "mcp",
  configSchema: MCP_CONFIG_SCHEMA,
  register(app, deps) {
    const cfg = mcpConfig(deps.config);
    const registry = createToolRegistry({ deps, now: () => deps.clock.now() });
    registries.set(deps, registry);
    const version = packageVersion(deps.paths.root);
    const handler = async (ctx) => {
      if (!cfg.enabled) throw new BridgeError("NOT_FOUND", "The MCP endpoint is switched off (mcp.enabled in the config file).");
      return handleMcpHttp(ctx, { registry, version });
    };
    for (const [method, path, options] of ROUTES) app.route(method, path, handler, options);
  },
});
