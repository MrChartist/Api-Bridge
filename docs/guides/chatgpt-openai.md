# ChatGPT and OpenAI

> Commands here start with `mc-bridge`. In a git checkout, run them as `npm run bridge -- <command>` instead ([why](README.md#running-mc-bridge)).

## ChatGPT connectors

ChatGPT's connectors (custom connectors and apps) call MCP servers over the public internet, over HTTPS and usually
with OAuth. The Bridge keeps `/mcp` on this computer on purpose and has no OAuth server, so **ChatGPT cannot connect
to it out of the box**. Whether ChatGPT can reach a local MCP server in your setup **needs verification** against
OpenAI's current documentation.

Do not expose `/mcp` through a public tunnel to make this work. The public-ingress listener refuses `/mcp` by design
(it serves webhooks only), and `server.allowedHosts` plus a tunnel would put your account data one leaked key away
from the internet. If you do it anyway, put the tunnel behind your own identity-aware access control and use a
read-only, expiring key limited to the accounts you need.

## OpenAI function calling from your own script

The same tool registry is available as strict OpenAI function schemas:

```bash
mc-bridge openai-tools > tools.json                  # Responses API format, read-only tools
mc-bridge openai-tools --format chat > tools.json    # Chat Completions format
mc-bridge openai-tools --scope paper                 # includes order tools if mcp.toolsets/orderAccounts allow
```

Your script sends `tools.json` to the model and runs each tool call it gets back against the local Bridge, for
example through MCP's `tools/call`:

```python
import json, os, urllib.request

def call_bridge_tool(name, arguments):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}).encode()
    req = urllib.request.Request("http://127.0.0.1:4300/mcp", data=body, method="POST", headers={
        "Authorization": f"Bearer {os.environ['MCB_API_KEY']}",
        "Content-Type": "application/json", "Accept": "application/json, text/event-stream",
    })
    return json.loads(urllib.request.urlopen(req).read())["result"]
```

Order tools keep the same rule as everywhere else: they only prepare a ticket, and a person confirms it on the
dashboard before anything is sent. The Bridge itself never calls OpenAI.
