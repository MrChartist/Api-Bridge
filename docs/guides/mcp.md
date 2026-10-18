# AI assistants over MCP (Claude Desktop, Claude Code, Cursor)

The Bridge is an MCP server. AI assistants use the same broker connections, rate limits, safety checks and audit log
as every other tool, and they are **read-only by default**.

Two transports:

- **Streamable HTTP** at `POST /mcp` on the Bridge (this computer only; Host and Origin checked; bearer key).
- **stdio** through `mc-bridge mcp`, a relay that forwards each message to the running Bridge's `/mcp`. Start the
  Bridge first (`npx mc-bridge start`).

Create a key for the assistant:

```bash
npx mc-bridge keys create --label claude --scope read --client mcp
```

## Claude Desktop

Edit `claude_desktop_config.json` (*Settings → Developer → Edit Config*):

```json
{
  "mcpServers": {
    "mr-chartist-bridge": {
      "command": "node",
      "args": ["/path/to/api-bridge/bin/mc-bridge.mjs", "mcp"],
      "env": { "MCB_API_KEY": "mcb_..." }
    }
  }
}
```

On Windows use a path such as `"C:\\Users\\you\\api-bridge\\bin\\mc-bridge.mjs"`. Restart Claude Desktop.

## Claude Code

```bash
claude mcp add mr-chartist-bridge --env MCB_API_KEY=mcb_... -- node /path/to/api-bridge/bin/mc-bridge.mjs mcp
# or the HTTP transport directly:
claude mcp add --transport http mr-chartist-bridge http://127.0.0.1:4300/mcp --header "Authorization: Bearer mcb_..."
```

Check with `claude mcp list`. (Flags as of Claude Code's current CLI; see `claude mcp add --help`.)

## Cursor and other clients

Any MCP client that can run a command uses the stdio form (`node .../bin/mc-bridge.mjs mcp` with `MCB_API_KEY` in its
environment); clients that speak Streamable HTTP use `http://127.0.0.1:4300/mcp` with an `Authorization` header.

## Tools

| Toolset | Tools |
|---|---|
| `market` | `get_ltp`, `get_quotes`, `get_depth`, `get_history`, `get_expiries`, `get_option_chain`, `search_instruments`, `convert_symbol` |
| `analytics` | `option_chain_summary`, `history_summary` |
| `account` | `list_accounts`, `get_positions`, `get_holdings`, `get_funds`, `list_orders`, `get_order`, `get_safety_status` |
| `orders` (off by default) | `prepare_order`, `submit_confirmed_order` |

Every result is wrapped as untrusted data (instrument names and broker messages are third-party text) and carries
freshness labels.

## Letting an assistant prepare orders

Order tools appear only when all of these hold:

```json
"mcp": { "toolsets": ["market", "analytics", "account", "orders"], "orderAccounts": ["paper"] }
```

and the assistant's key has the `paper` scope (or `live`) and may use that account. Even then:

1. `prepare_order` only opens a **ticket**; nothing is sent.
2. You confirm the ticket on the dashboard (Pending confirmations) on this computer, within about a minute.
3. The confirmation gives a one-time code; `submit_confirmed_order` sends exactly the prepared order, once.

No tool can change paper/live mode, key scopes or account sessions, or release the kill switch. Client-side approval
prompts never count as confirmation. AI-placed orders are a regulatory gray area; see [compliance.md](compliance.md).
