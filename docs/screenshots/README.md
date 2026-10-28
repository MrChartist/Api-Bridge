# Dashboard screenshots

Every screenshot was taken from a Bridge running in **demo mode** (`npm start -- --demo`): the prices are sample data generated on the computer, not live market data, which is why each page shows the DEMO DATA banner. Desktop shots are 1600 x 1000 (full page where the page is longer); phone shots are 390 x 844 at 2x. The list with sizes is in [manifest.json](manifest.json).

They are made by `node scripts/capture-screenshots.mjs`, which starts a throwaway demo Bridge, puts some traffic, keys and an AI-prepared ticket into it, and drives the dashboard with Playwright. Run it again after any dashboard change.

## Dark theme

### Sign in (dark)

Sign-in screen: paste the admin key printed once by mc-bridge init. The key stays in this browser tab.

![Sign in](login-dark.webp)

### Home (dark)

Home: welcome checklist, market snapshot, broker accounts, calls saved and safety status.

![Home](home-dark.webp)

### Accounts (dark)

Accounts: connected broker accounts with session state, and the directory of 41 supported brokers.

![Accounts](accounts-dark.webp)

### Test console (dark)

Test console: pick an endpoint, send it, and see the response, status and timing.

![Test console](console-dark.webp)

### Rate limits (dark)

Rate limits: live per-endpoint budgets for each account and the calls the Bridge saved through streaming, caching, coalescing and batching.

![Rate limits](limits-dark.webp)

### Scanner (dark)

Scanner: a readable condition, a universe and the accounts it is shared across.

![Scanner](scanner-dark.webp)

### Orders (dark)

Orders: an AI-prepared ticket waiting for confirmation, open orders and positions on the paper account.

![Orders](orders-dark.webp)

### Safety (dark)

Safety: kill switch, daily limits, live-trading status and audit-log verification.

![Safety](safety-dark.webp)

### API keys (dark)

API keys: one key per tool with only the scopes and accounts it needs.

![API keys](keys-dark.webp)

### Integrations: AmiBroker (dark)

Integrations, AmiBroker tab: copy-paste setup with a key made for that tool.

![Integrations: AmiBroker](integrations-amibroker-dark.webp)

### Integrations: ChatGPT (dark)

Integrations, ChatGPT tab: copy-paste setup with a key made for that tool.

![Integrations: ChatGPT](integrations-chatgpt-dark.webp)

### Integrations: Claude (dark)

Integrations, Claude tab: copy-paste setup with a key made for that tool.

![Integrations: Claude](integrations-claude-dark.webp)

### Integrations: Excel (dark)

Integrations, Excel tab: copy-paste setup with a key made for that tool.

![Integrations: Excel](integrations-excel-dark.webp)

### Integrations: Node.js (dark)

Integrations, Node.js tab: copy-paste setup with a key made for that tool.

![Integrations: Node.js](integrations-node-dark.webp)

### Integrations: Python (dark)

Integrations, Python tab: copy-paste setup with a key made for that tool.

![Integrations: Python](integrations-python-dark.webp)

### Integrations: REST (dark)

Integrations, REST tab: copy-paste setup with a key made for that tool.

![Integrations: REST](integrations-rest-dark.webp)

### Integrations: Webhooks (dark)

Integrations, Webhooks tab: copy-paste setup with a key made for that tool.

![Integrations: Webhooks](integrations-webhooks-dark.webp)

### Activity (dark)

Activity: recent requests with the tool, endpoint, status and time each took.

![Activity](activity-dark.webp)

### Audit log (dark)

The tamper-evident audit log: key changes, orders and kill-switch actions, hash-chained per day.

![Audit log](audit-dark.webp)

## Light theme

### Sign in (light)

Sign-in screen: paste the admin key printed once by mc-bridge init. The key stays in this browser tab.

![Sign in](login-light.webp)

### Home (light)

Home: welcome checklist, market snapshot, broker accounts, calls saved and safety status.

![Home](home-light.webp)

### Accounts (light)

Accounts: connected broker accounts with session state, and the directory of 41 supported brokers.

![Accounts](accounts-light.webp)

### Test console (light)

Test console: pick an endpoint, send it, and see the response, status and timing.

![Test console](console-light.webp)

### Rate limits (light)

Rate limits: live per-endpoint budgets for each account and the calls the Bridge saved through streaming, caching, coalescing and batching.

![Rate limits](limits-light.webp)

### Scanner (light)

Scanner: a readable condition, a universe and the accounts it is shared across.

![Scanner](scanner-light.webp)

### Orders (light)

Orders: an AI-prepared ticket waiting for confirmation, open orders and positions on the paper account.

![Orders](orders-light.webp)

### Safety (light)

Safety: kill switch, daily limits, live-trading status and audit-log verification.

![Safety](safety-light.webp)

### API keys (light)

API keys: one key per tool with only the scopes and accounts it needs.

![API keys](keys-light.webp)

### Integrations: AmiBroker (light)

Integrations, AmiBroker tab: copy-paste setup with a key made for that tool.

![Integrations: AmiBroker](integrations-amibroker-light.webp)

### Integrations: ChatGPT (light)

Integrations, ChatGPT tab: copy-paste setup with a key made for that tool.

![Integrations: ChatGPT](integrations-chatgpt-light.webp)

### Integrations: Claude (light)

Integrations, Claude tab: copy-paste setup with a key made for that tool.

![Integrations: Claude](integrations-claude-light.webp)

### Integrations: Excel (light)

Integrations, Excel tab: copy-paste setup with a key made for that tool.

![Integrations: Excel](integrations-excel-light.webp)

### Integrations: Node.js (light)

Integrations, Node.js tab: copy-paste setup with a key made for that tool.

![Integrations: Node.js](integrations-node-light.webp)

### Integrations: Python (light)

Integrations, Python tab: copy-paste setup with a key made for that tool.

![Integrations: Python](integrations-python-light.webp)

### Integrations: REST (light)

Integrations, REST tab: copy-paste setup with a key made for that tool.

![Integrations: REST](integrations-rest-light.webp)

### Integrations: Webhooks (light)

Integrations, Webhooks tab: copy-paste setup with a key made for that tool.

![Integrations: Webhooks](integrations-webhooks-light.webp)

### Activity (light)

Activity: recent requests with the tool, endpoint, status and time each took.

![Activity](activity-light.webp)

### Audit log (light)

The tamper-evident audit log: key changes, orders and kill-switch actions, hash-chained per day.

![Audit log](audit-light.webp)

## Features

### Command palette (dark)

Press Command-K (Ctrl-K) to jump to any page or action from the keyboard.

![Command palette](feature-command-palette-dark.webp)

### Command palette (light)

Press Command-K (Ctrl-K) to jump to any page or action from the keyboard.

![Command palette](feature-command-palette-light.webp)

### Welcome checklist

The welcome checklist on Home walks through connecting a broker, making a key, copying a snippet and testing a call.

![Welcome checklist](feature-welcome-checklist.webp)

### Option chain in the test console

The test console calling the option chain endpoint on demo data.

![Option chain in the test console](feature-test-console-option-chain.webp)

### Rate-limit usage

Per-endpoint budget bars after a burst of identical requests: most were coalesced into one broker call.

![Rate-limit usage](feature-rate-limit-usage.webp)

### Scan results (dark)

A finished scan: matched symbols with their values, progress per account and the calls it cost.

![Scan results](feature-scanner-results-dark.webp)

### Scan results (light)

A finished scan: matched symbols with their values, progress per account and the calls it cost.

![Scan results](feature-scanner-results-light.webp)

### AI ticket confirmation

An order prepared by Claude through MCP waits here; nothing is sent until you check every field and confirm.

![AI ticket confirmation](feature-ai-ticket-confirmation.webp)

### Kill switch sheet

Engaging the kill switch: a sheet asks for a reason and whether to cancel open orders.

![Kill switch sheet](feature-kill-switch-dialog.webp)

### Kill switch engaged

With the kill switch on, every order route refuses until an admin releases it.

![Kill switch engaged](feature-kill-switch-engaged.webp)

### Key scopes

Creating a key: choose its access, the accounts it can use, the tool it is for and when it expires.

![Key scopes](feature-keys-scopes.webp)

### Claude snippet

The Claude snippet, ready to paste.

![Claude snippet](feature-snippets-claude.webp)

### Excel snippet

The Excel snippet, ready to paste.

![Excel snippet](feature-snippets-excel.webp)

### Python snippet

The Python snippet, ready to paste.

![Python snippet](feature-snippets-python.webp)

### Request log

The request log: every call with its client, account, status and latency.

![Request log](feature-request-log.webp)

## On a phone

### Home on a phone (dark)

Home at phone width: the sidebar becomes a floating tab bar and cards stack.

![Home on a phone](mobile-home-dark.webp)

### Home on a phone (light)

Home at phone width: the sidebar becomes a floating tab bar and cards stack.

![Home on a phone](mobile-home-light.webp)

### Test console on a phone (dark)

Test console at phone width.

![Test console on a phone](mobile-console-dark.webp)

### Test console on a phone (light)

Test console at phone width.

![Test console on a phone](mobile-console-light.webp)

### Scanner on a phone (dark)

Scanner at phone width: condition, universe and example buttons wrap cleanly.

![Scanner on a phone](mobile-scanner-dark.webp)

### Scanner on a phone (light)

Scanner at phone width: condition, universe and example buttons wrap cleanly.

![Scanner on a phone](mobile-scanner-light.webp)

### Safety on a phone (dark)

Safety at phone width: the kill switch is one tap away.

![Safety on a phone](mobile-safety-dark.webp)

### Safety on a phone (light)

Safety at phone width: the kill switch is one tap away.

![Safety on a phone](mobile-safety-light.webp)

### Integrations on a phone (dark)

Integrations at phone width, with copy-paste snippets.

![Integrations on a phone](mobile-integrations-dark.webp)

### Integrations on a phone (light)

Integrations at phone width, with copy-paste snippets.

![Integrations on a phone](mobile-integrations-light.webp)
