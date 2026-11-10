# AI assistants over MCP (Claude Desktop, Claude Code, Cursor)

> Commands here start with `mc-bridge`. In a git checkout, run them as `npm run bridge -- <command>` instead ([why](README.md#running-mc-bridge)).

The Bridge is an MCP server. AI assistants use the same broker connections, rate limits, safety checks and audit log
as every other tool, and they are **read-only by default**.

Two transports:

- **Streamable HTTP** at `POST /mcp` on the Bridge (this computer only; Host and Origin checked; bearer key).
- **stdio** through `mc-bridge mcp`, a relay that forwards each message to the running Bridge's `/mcp`. Start the
  Bridge first (`mc-bridge start`).

Create a key for the assistant:

```bash
mc-bridge keys create --label claude --scope read --client mcp
```

## Claude Desktop

Edit `claude_desktop_config.json` (*Settings → Developer → Edit Config*):

```json
{
  "mcpServers": {
    "mr-chartist-bridge": {
      "command": "node",
      "args": ["/path/to/api-bridge-v2/bin/mc-bridge.mjs", "mcp"],
      "env": { "MCB_API_KEY": "mcb_..." }
    }
  }
}
```

On Windows use a path such as `"C:\\Users\\you\\api-bridge-v2\\bin\\mc-bridge.mjs"`. Restart Claude Desktop.

## Claude Code

```bash
claude mcp add mr-chartist-bridge --env MCB_API_KEY=mcb_... -- node /path/to/api-bridge-v2/bin/mc-bridge.mjs mcp
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
| `orders` (off by default) | `prepare_order`, `check_order_ticket`, `submit_confirmed_order` |

Every result is wrapped as untrusted data (instrument names and broker messages are third-party text) and carries
freshness labels.

## Letting an assistant prepare orders

Order tools appear only when all of these hold:

```json
"mcp": { "toolsets": ["market", "analytics", "account", "orders"], "orderAccounts": ["paper"] }
```

and the assistant's key has the `paper` scope (or `live`) and may use that account. Even then:

1. `prepare_order` only opens a **ticket**; nothing is sent.
2. You confirm the ticket on the dashboard (Pending confirmations) on this computer, within about a minute, or you
   **decline** it there (with an optional reason).
3. The confirmation gives a one-time code; `submit_confirmed_order` sends exactly the prepared order, once.

If you decline, nothing is sent and nothing can be: the ticket can never be confirmed afterwards. An assistant that asks
`check_order_ticket` with the `ticketId` gets a plain, machine-readable answer instead of silence:

```json
{ "ticketId": "tkt_...", "status": "rejected", "reason": "Wrong quantity", "canRetry": false, "nextStep": "..." }
```

`status` is `open` (you have not decided), `confirmed` (it needs your code), `consumed` (its order was already sent),
`rejected` (you declined; `reason` holds your words, which the assistant can read), `expired`, or `unknown` (the Bridge
does not know this ticket for this assistant; other assistants' tickets are never shown). Retrying
`submit_confirmed_order` for a declined ticket is refused with `STATE_CONFLICT` and `status: rejected`. Over plain REST
the same ticket ends as `CONFIRMATION_REQUIRED` when its confirmation code or `ticketId` is used.

No tool can change paper/live mode, key scopes or account sessions, or release the kill switch. Client-side approval
prompts never count as confirmation. AI-placed orders are a regulatory gray area; see [compliance.md](compliance.md).

> **What the confirmation step does not cover.** It stops an assistant that can only reach the Bridge through its
> MCP tools or its API key. It cannot stop an assistant (or any program) that can also **run shell commands or
> control the browser on your computer**, such as a coding agent with terminal access or a computer-use tool: such
> a program can read the Bridge's data folder, use the local CLI, or click Confirm on the dashboard for you. Give
> those tools a `read` key only, keep the `orders` toolset off for them, or run them in a sandbox or on another
> machine that cannot reach your Bridge's files or dashboard.
