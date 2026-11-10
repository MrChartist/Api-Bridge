# Documentation

API Bridge v2 is one local API in front of your Indian broker accounts. These pages are for people who run it and people who build on it. Everything here works in demo mode first: sample prices, no broker, paper orders.

## Start here

1. **[Quickstart](guides/quickstart.md).** Five minutes from a fresh clone to a price, a paper order and a live stream. It also lists the fixes for the usual first-run problems.
2. **Connect a tool.** Pick the one you use:
   - AI assistants: [MCP for Claude Desktop, Claude Code and Cursor](guides/mcp.md), [ChatGPT and OpenAI function calling](guides/chatgpt-openai.md)
   - Spreadsheets: [Excel and Google Sheets](guides/excel-sheets.md)
   - Charting and alerts: [AmiBroker](guides/amibroker.md), [signed webhooks, ChartInk and GoCharting](guides/webhooks.md)
   - Your own code: [the developer guide](guides/developers.md) (starters: `mc-bridge init node`), [Python](guides/python.md), [Node and TypeScript](guides/typescript.md), [streaming](guides/streaming.md), [events and signed webhooks](guides/events.md)
   - Tools that already speak the apikey-in-body style: [compat REST](guides/compat-api.md)
3. **[API reference](api/README.md).** One page per endpoint (scope, parameters, answers, error codes, a curl and a Python example), the [error codes](api/errors.md), and the full [OpenAPI](openapi.yaml) and [AsyncAPI](asyncapi.yaml) files. To try calls without code, import a [Postman or Bruno collection](collections/README.md).
4. **Sources and limits.** [Where prices come from](guides/sources.md) (your broker, optional free sources, plugins; what delayed and end-of-day mean) and [how the Bridge stays inside each broker's limits](guides/rate-limits.md).
5. **[Safety](guides/safety.md).** Paper and live modes, API keys and scopes, limits, the kill switch and the audit log. Read this before you turn live trading on.
6. **Stuck, or a word you do not know?** [Troubleshooting](guides/troubleshooting.md) (by symptom and by error code), the [FAQ](guides/faq.md), the [glossary](guides/glossary.md), and [Windows notes](guides/windows.md) (PowerShell instead of bash).

All guides, one line each: [guides/README.md](guides/README.md).

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
- [release-process.md](release-process.md): for maintainers, how a version is numbered, checked, tagged and published.
- [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md): licences of the packages that ship with the Bridge, and the broker names and logos that are not MIT.

## Generated files

`api/`, the collections, `guides/glossary.md` (from the dashboard glossary), `llms.txt`, `llms-full.txt` and `search-index.json` are written by scripts from `openapi.yaml` and the guides. Do not edit them by hand:

```bash
npm run docs:generate     # rewrite them
npm run docs:check        # fail when they are out of date (CI runs this)
```
