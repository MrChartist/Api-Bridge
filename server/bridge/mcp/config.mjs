/**
 * The `mcp` config section (owned by the mcp module; core validates it with this schema).
 *
 *   "mcp": {
 *     "enabled": true,                                   // false: POST /mcp answers 404 and `mc-bridge mcp` gets nothing
 *     "toolsets": ["market", "analytics", "account"],    // add "orders" to let AI assistants PREPARE orders;
 *     "orderAccounts": [],                               // accounts order tools may name; empty = no order tools at all
 *     "maxItems": 200                                    // largest page a tool returns (cursor for the rest)
 *   }
 *
 * Default: read-only. Order tools exist only when "orders" is in toolsets AND orderAccounts lists the account AND the
 * calling key has the "paper" scope (or "live") AND may use that account. Even then they only prepare a ticket: a
 * person confirms it in the Bridge on this computer (dashboard, Orders, Pending confirmations) before anything is sent.
 * There is no tool, and no setting here, that can change paper/live mode, key scopes or release the kill switch.
 */
import { z } from "zod";

/**
 * "options" is an opt-in toolset kept out of the default list so it stays under 20 tools. A tool with a
 * `requiredScope` (ToolDef.requiredScope) is shown only to keys that hold it.
 */
export const TOOLSETS = Object.freeze(["market", "analytics", "account", "orders", "options"]);
export const DEFAULT_TOOLSETS = Object.freeze(["market", "analytics", "account"]);

export const MCP_DEFAULTS = Object.freeze({
  enabled: true,
  toolsets: DEFAULT_TOOLSETS,
  orderAccounts: [],
  maxItems: 200,
});

export const MCP_CONFIG_SCHEMA = z
  .object({
    enabled: z.boolean().default(true),
    toolsets: z
      .array(z.enum(TOOLSETS))
      .max(TOOLSETS.length)
      .default([...DEFAULT_TOOLSETS])
      .transform((a) => TOOLSETS.filter((t) => a.includes(t))),
    orderAccounts: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/, "use account ids from your config")).max(50).default([]),
    maxItems: z.number().int().min(10).max(1000).default(200),
  })
  .strict();

/**
 * The effective mcp config: the parsed section when core applied it, else the defaults.
 * @param {any} config
 * @returns {{ enabled: boolean, toolsets: string[], orderAccounts: string[], maxItems: number }}
 */
export function mcpConfig(config) {
  const parsed = MCP_CONFIG_SCHEMA.safeParse(config?.mcp ?? {});
  return parsed.success ? parsed.data : { ...MCP_DEFAULTS, toolsets: [...DEFAULT_TOOLSETS], orderAccounts: [] };
}
