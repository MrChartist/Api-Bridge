# Documentation

API Bridge v2 is one local API in front of your Indian broker accounts. It is free and open source (AGPL-3.0), runs on your own computer and has no hosted
service. These pages are for people who run it and people who build on it. Everything works in demo mode first: sample prices, no broker,
paper orders.

**New here?** Start with the [quickstart](guides/quickstart.md): five minutes from a fresh clone to a price, a paper order and a live
stream. Then pick what you want to do below. Every guide is also listed, one line each, in [guides/README.md](guides/README.md).

## Trade on paper

Orders are paper unless you ask for live and every opt-in is in place. Practise the whole flow first.

- Orders in one place: [orders.md](guides/orders.md) covers paper and live, tickets and confirmation, product words, target-size and basket orders, idempotency and what `OUTCOME_UNKNOWN` means.
- Does the Bridge agree with your broker? [orders-drift.md](guides/orders-drift.md): a read-only check that compares the orders the Bridge knows with the broker's order book and helps resolve an `OUTCOME_UNKNOWN`.
- Size and baskets: [alert-orders.md](guides/alert-orders.md) has "be long 3 lots", several orders at once, basket margin and the market calendar.
- The simulator: [paper-margin.md](guides/paper-margin.md) says how margin is estimated for F&O.
- The rules that protect you: [safety.md](guides/safety.md) lists the limits, the kill switch, keys and the audit log. Read it before you turn live trading on.
- Instruments: [symbols.md](guides/symbols.md) shows how a share, future or option is written, and why an expired contract is not found.

## Connect a broker

- Dhan, step by step: [dhan.md](guides/dhan.md) is the broker checked with a real account. Every other broker is beta or contract-tested: see [BROKERS.md](BROKERS.md).
- Any broker and several accounts: [accounts.md](guides/accounts.md) covers adding accounts, logging in, sessions and family accounts.
- Free data sources: [sources.md](guides/sources.md) explains where prices come from, and what delayed and end-of-day mean.
- Live orders: [deployment.md](guides/deployment.md) explains the static IP your broker needs, the daily login and the readiness badge.
- Limits: [rate-limits.md](guides/rate-limits.md) says how the Bridge stays inside each broker's request limits.

## Connect a tool

- Excel and Google Sheets: [excel-sheets.md](guides/excel-sheets.md) shows `WEBSERVICE`, Power Query and an Apps Script.
- AmiBroker: [amibroker.md](guides/amibroker.md) has the AFL and the import format.
- AI assistants: [mcp.md](guides/mcp.md) covers Claude Desktop, Claude Code and Cursor; [chatgpt-openai.md](guides/chatgpt-openai.md) covers ChatGPT and function calling.
- Pick one with a key made for you: [connect.md](guides/connect.md) describes the dashboard's Connect page.
- Tools that send the key in the request body: [compat-api.md](guides/compat-api.md) describes the `/api/v1` style.

## Get alerts in

- TradingView: [tradingview.md](guides/tradingview.md) is the ten-minute path, with the messages to paste and the sender addresses.
- Every alert source: [webhooks.md](guides/webhooks.md) covers TradingView, signed generic hooks, ChartInk and GoCharting in full.
- Reaching the Bridge from the internet: [expose-alerts.md](guides/expose-alerts.md) shows the narrow listener, the provider recipes and the tests, so the dashboard is never exposed.

## Receive events

- The data calls every project points at: [data-api.md](guides/data-api.md) covers prices, history, option chains and instruments, how to read freshness and errors, and what stays stable.
- Events without polling: [events.md](guides/events.md) covers the event stream with replay and signed webhooks with retries and dead letters, with receiver code.
- Live prices: [streaming.md](guides/streaming.md) covers the WebSocket and server-sent events.
- On your phone: [telegram.md](guides/telegram.md) sets up alerts and read-only commands, and [notifications.md](guides/notifications.md) explains how a message travels.

## Write your own program

- Start in five minutes: [developers.md](guides/developers.md) covers keys and scopes, limits, pagination, idempotency and the versioning promise; `mc-bridge init node` writes a starter project.
- Python and Node: [python.md](guides/python.md) and [typescript.md](guides/typescript.md) describe the two libraries.
- The API: [api/README.md](api/README.md) has one page per endpoint, [api/errors.md](api/errors.md) lists every error code, and [openapi.yaml](openapi.yaml) and [asyncapi.yaml](asyncapi.yaml) are the full descriptions.
- Every setting: [config.md](guides/config.md) is the reference of `bridge.config.json`, written from the code.
- Every command: [cli.md](guides/cli.md) lists the `mc-bridge` commands and which key each needs.

## Save data

- The whole picture: [data.md](guides/data.md) ties downloads, recordings, collections and local-first reads together, with three recipes: two years of 5-minute bars, daily option chains read in Python, and a dataset kept up to date by a scheduled command.
- Old candles: [downloads.md](guides/downloads.md) covers CSV, JSONL and AmiBroker files, datasets that update from their last bar, and the API budget share.
- Option chains and ticks, going forward: [recording.md](guides/recording.md) covers rules that run every trading day, gaps, disk limits and the file layout.
- Lists of instruments: [collections.md](guides/collections.md) covers named lists and option universes with a rolling expiry and ATM strike.

## Run it for weeks

- Windows: [windows.md](guides/windows.md) covers PowerShell, folders, the firewall and start at login.
- A server or a container: [vps.md](guides/vps.md) is a hardened server recipe, and [docker.md](guides/docker.md) explains the Dockerfile and compose file.
- Day to day: [operations.md](guides/operations.md) covers one Bridge per folder, stopping, damaged files, disk space, health and logs.
- Keep your data: [backup.md](guides/backup.md) covers backup, restore and recovery runbooks.
- New versions: [upgrading.md](guides/upgrading.md) covers versions, the copy made before an upgrade, going back and settings a version no longer accepts.
- Rules and law: [compliance.md](guides/compliance.md) lists the SEBI, exchange and broker rules that shape the design, with what still needs checking.

## Stuck, or a word you do not know?

- By symptom: [troubleshooting.md](guides/troubleshooting.md) maps what you see to the cause and the fix, by symptom and by error code.
- Short answers: [faq.md](guides/faq.md) answers the common questions, and [glossary.md](guides/glossary.md) explains the words.

## For AI assistants and search

- [llms.txt](llms.txt): a short index of the project and its docs, in the [llms.txt](https://llmstxt.org/) format.
- [llms-full.txt](llms-full.txt): the API overview and every guide in one file.
- [search-index.json](search-index.json): title, path, headings and a short text for each page, for a search box.

## Reference

- [ARCHITECTURE.md](ARCHITECTURE.md): how the Bridge is built.
- [BROKERS.md](BROKERS.md): the broker table and what each adapter can do.
- [source-contract.md](source-contract.md) and [sources-architecture.md](sources-architecture.md): writing a data source or plugin, and how routing and quotas fit together.
- [broker-contract.md](broker-contract.md): what a broker adapter must provide.
- [API-DEPRECATIONS.md](API-DEPRECATIONS.md): API changes that need a migration window. Release notes are in the [main changelog](../CHANGELOG.md).
- [reference-data.md](reference-data.md): the market tables shipped with the Bridge (holidays, trading hours, special sessions, freeze quantities, charges), where each comes from, what `verified` means and how to update them.
- [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md): licences of the packages that ship with the Bridge, and the broker names and logos that are not under the project licence.

## Generated files

`api/`, the collections, `guides/glossary.md` (from the dashboard glossary), `guides/config.md` (from the settings checker), `llms.txt`,
`llms-full.txt` and `search-index.json` are written by scripts from `openapi.yaml`, the code and the guides. Do not edit them by hand:

```bash
npm run docs:generate     # rewrite them
npm run docs:check        # fail when they are out of date (CI runs this)
```
