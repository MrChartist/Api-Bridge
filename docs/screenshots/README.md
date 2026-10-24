# Dashboard screenshots

Every screenshot was taken from a Bridge running in **demo mode** (`npm start -- --demo`): the prices are sample data generated on the computer, not live market data, which is why each page shows the DEMO DATA banner. Desktop shots are 1600 x 1000 (full page where the page is longer); phone shots are 390 x 844 at 2x. The list with sizes is in [manifest.json](manifest.json).

## Dark theme

### Sign in (dark)

Sign-in screen: paste the admin key printed once by mc-bridge init. The key stays in this browser tab.

![Sign in](login-dark.webp)

### Home (dark)

Home: welcome checklist, market snapshot, broker accounts, calls saved and safety status.

![Home](home-dark.webp)

### Accounts (dark)

Accounts: your broker accounts with session state, and the directory of all 41 supported brokers.

![Accounts](accounts-dark.webp)

### Orders (dark)

Orders: AI-prepared tickets waiting for confirmation, today's orders and paper positions.

![Orders](orders-dark.webp)

### Safety (dark)

Safety: the kill switch, daily limits per account and the live-trading checklist.

![Safety](safety-dark.webp)

### Keys (dark)

API keys: one key per tool with its scopes, accounts, expiry and last use.

![Keys](keys-dark.webp)

### Test console (dark)

Test console: send any API call and see the status, rate-limit headers and JSON exactly as a script gets it.

![Test console](console-dark.webp)

### Rate limits (dark)

Rate limits: live usage per endpoint class against the broker's limits, and the calls saved by stream, cache, coalescing and batching.

![Rate limits](limits-dark.webp)

### Integrations: Python (dark)

Copy-paste setup for Python, with this Bridge's address filled in and a button that creates a key with only the access it needs.

![Integrations: Python](integrations-python-dark.webp)

### Integrations: Node (dark)

Copy-paste setup for Node, with this Bridge's address filled in and a button that creates a key with only the access it needs.

![Integrations: Node](integrations-node-dark.webp)

### Integrations: Excel and Google Sheets (dark)

Copy-paste setup for Excel and Google Sheets, with this Bridge's address filled in and a button that creates a key with only the access it needs.

![Integrations: Excel and Google Sheets](integrations-excel-dark.webp)

### Integrations: AmiBroker (dark)

Copy-paste setup for AmiBroker, with this Bridge's address filled in and a button that creates a key with only the access it needs.

![Integrations: AmiBroker](integrations-amibroker-dark.webp)

### Integrations: Claude Desktop and Claude Code (MCP) (dark)

Copy-paste setup for Claude Desktop and Claude Code (MCP), with this Bridge's address filled in and a button that creates a key with only the access it needs.

![Integrations: Claude Desktop and Claude Code (MCP)](integrations-claude-dark.webp)

### Integrations: ChatGPT and OpenAI tools (dark)

Copy-paste setup for ChatGPT and OpenAI tools, with this Bridge's address filled in and a button that creates a key with only the access it needs.

![Integrations: ChatGPT and OpenAI tools](integrations-chatgpt-dark.webp)

### Integrations: REST and curl (dark)

Copy-paste setup for REST and curl, with this Bridge's address filled in and a button that creates a key with only the access it needs.

![Integrations: REST and curl](integrations-rest-dark.webp)

### Activity: request log (dark)

Activity: the recent request log (paths only, never keys or query strings).

![Activity: request log](activity-dark.webp)

### Activity: audit log (dark)

Audit log: the append-only, hash-chained record of keys, orders and kill-switch actions.

![Activity: audit log](audit-dark.webp)

## Light theme

### Sign in (light)

Sign-in screen: paste the admin key printed once by mc-bridge init. The key stays in this browser tab.

![Sign in](login-light.webp)

### Home (light)

Home: welcome checklist, market snapshot, broker accounts, calls saved and safety status.

![Home](home-light.webp)

### Accounts (light)

Accounts: your broker accounts with session state, and the directory of all 41 supported brokers.

![Accounts](accounts-light.webp)

### Orders (light)

Orders: AI-prepared tickets waiting for confirmation, today's orders and paper positions.

![Orders](orders-light.webp)

### Safety (light)

Safety: the kill switch, daily limits per account and the live-trading checklist.

![Safety](safety-light.webp)

### Keys (light)

API keys: one key per tool with its scopes, accounts, expiry and last use.

![Keys](keys-light.webp)

### Test console (light)

Test console: send any API call and see the status, rate-limit headers and JSON exactly as a script gets it.

![Test console](console-light.webp)

### Rate limits (light)

Rate limits: live usage per endpoint class against the broker's limits, and the calls saved by stream, cache, coalescing and batching.

![Rate limits](limits-light.webp)

### Integrations: Python (light)

Copy-paste setup for Python, with this Bridge's address filled in and a button that creates a key with only the access it needs.

![Integrations: Python](integrations-python-light.webp)

### Integrations: Node (light)

Copy-paste setup for Node, with this Bridge's address filled in and a button that creates a key with only the access it needs.

![Integrations: Node](integrations-node-light.webp)

### Integrations: Excel and Google Sheets (light)

Copy-paste setup for Excel and Google Sheets, with this Bridge's address filled in and a button that creates a key with only the access it needs.

![Integrations: Excel and Google Sheets](integrations-excel-light.webp)

### Integrations: AmiBroker (light)

Copy-paste setup for AmiBroker, with this Bridge's address filled in and a button that creates a key with only the access it needs.

![Integrations: AmiBroker](integrations-amibroker-light.webp)

### Integrations: Claude Desktop and Claude Code (MCP) (light)

Copy-paste setup for Claude Desktop and Claude Code (MCP), with this Bridge's address filled in and a button that creates a key with only the access it needs.

![Integrations: Claude Desktop and Claude Code (MCP)](integrations-claude-light.webp)

### Integrations: ChatGPT and OpenAI tools (light)

Copy-paste setup for ChatGPT and OpenAI tools, with this Bridge's address filled in and a button that creates a key with only the access it needs.

![Integrations: ChatGPT and OpenAI tools](integrations-chatgpt-light.webp)

### Integrations: REST and curl (light)

Copy-paste setup for REST and curl, with this Bridge's address filled in and a button that creates a key with only the access it needs.

![Integrations: REST and curl](integrations-rest-light.webp)

### Activity: request log (light)

Activity: the recent request log (paths only, never keys or query strings).

![Activity: request log](activity-light.webp)

### Activity: audit log (light)

Audit log: the append-only, hash-chained record of keys, orders and kill-switch actions.

![Activity: audit log](audit-light.webp)

## Features

### Welcome checklist

First-run checklist: connect a broker or try demo mode, create a key, copy a snippet, make a test call.

![Welcome checklist](feature-welcome-checklist.webp)

### Live rate-limit usage

Per-account budgets per endpoint class, refreshed every few seconds, after 20 identical requests were coalesced.

![Live rate-limit usage](feature-rate-limit-usage.webp)

### Test console with a response

An option-chain call with Greeks: status, timing, request id, rate-limit headers and the JSON, labelled Demo data.

![Test console with a response](feature-test-console-option-chain.webp)

### Snippet panel: Python

Ready-to-paste Python setup with copy buttons.

![Snippet panel: Python](feature-snippets-python.webp)

### Snippet panel: Excel and Google Sheets

Ready-to-paste Excel and Google Sheets setup with copy buttons.

![Snippet panel: Excel and Google Sheets](feature-snippets-excel.webp)

### Snippet panel: Claude Desktop and Claude Code (MCP)

Ready-to-paste Claude Desktop and Claude Code (MCP) setup with copy buttons.

![Snippet panel: Claude Desktop and Claude Code (MCP)](feature-snippets-claude.webp)

### Kill switch: confirm

Stopping all orders asks for a reason and whether to cancel open orders.

![Kill switch: confirm](feature-kill-switch-dialog.webp)

### Kill switch engaged

With the kill switch on, every new order from every tool is refused until an admin releases it.

![Kill switch engaged](feature-kill-switch-engaged.webp)

### API keys with scopes

A new key is shown once; every key lists its scopes (read, paper, admin), accounts, client and expiry.

![API keys with scopes](feature-keys-scopes.webp)

### Confirming an AI-prepared order

An order prepared by Claude over MCP: every field is shown before a person confirms it. Nothing is sent until then.

![Confirming an AI-prepared order](feature-ai-ticket-confirmation.webp)

### Request log

Every request from scripts, charts, Excel and AI tools: method, path, status, time and key id.

![Request log](feature-request-log.webp)

## Phone

### Mobile: home (dark)

Home: welcome checklist, market snapshot, broker accounts, calls saved and safety status. (390 x 844 at 2x)

![Mobile: home](mobile-home-dark.webp)

### Mobile: console (dark)

Test console: send any API call and see the status, rate-limit headers and JSON exactly as a script gets it. (390 x 844 at 2x)

![Mobile: console](mobile-console-dark.webp)

### Mobile: integrations (dark)

Integrations on a phone. (390 x 844 at 2x)

![Mobile: integrations](mobile-integrations-dark.webp)

### Mobile: safety (dark)

Safety: the kill switch, daily limits per account and the live-trading checklist. (390 x 844 at 2x)

![Mobile: safety](mobile-safety-dark.webp)

### Mobile: home (light)

Home: welcome checklist, market snapshot, broker accounts, calls saved and safety status. (390 x 844 at 2x)

![Mobile: home](mobile-home-light.webp)

### Mobile: console (light)

Test console: send any API call and see the status, rate-limit headers and JSON exactly as a script gets it. (390 x 844 at 2x)

![Mobile: console](mobile-console-light.webp)

### Mobile: integrations (light)

Integrations on a phone. (390 x 844 at 2x)

![Mobile: integrations](mobile-integrations-light.webp)

### Mobile: safety (light)

Safety: the kill switch, daily limits per account and the live-trading checklist. (390 x 844 at 2x)

![Mobile: safety](mobile-safety-light.webp)

