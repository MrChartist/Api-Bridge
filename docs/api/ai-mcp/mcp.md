# MCP Streamable HTTP endpoint for AI assistants

`POST /mcp`

| | |
|---|---|
| Area | [AI (MCP)](../README.md#ai-mcp) |
| Operation | `mcp` |
| Scope | `read` |
| This computer only | no |
| Guide | [mcp.md](../../guides/mcp.md) |

- An API key with the `read` scope (any key).

JSON-RPC 2.0 per the Model Context Protocol. The key's scopes decide which tools exist: market-data and account
tools for `read`; order tools only when enabled in config, and every order still needs your confirmation in the
Bridge. Desktop assistants should prefer `mc-bridge mcp` over stdio.

## Request body

Required, `application/json`.

A JSON object.

Example:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list"
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | JSON-RPC response, or an SSE stream for long calls. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/mcp" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("POST", "/mcp", body={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
print(response.body)
```
