# Integrations

Ready-made ways to use the Mr. Chartist API Bridge from other tools. Each folder has its own README.

| Folder | For | Uses |
|---|---|---|
| [`excel/`](excel) | Excel `WEBSERVICE` cells and Power Query tables | `/xl/quotes` (a table), `/xl/positions`, `/xl/holdings`, `/xl/funds`, `/xl/orders`, `/xl/ltp`, `/xl/quote`, `/xl/chain`, `/xl/history` |
| [`google-sheets/`](google-sheets) | Google Sheets via Apps Script (needs your own tunnel) | `/xl/*` |
| [`amibroker/`](amibroker) | AmiBroker ASCII import and AFL formulas | `/xl/history?layout=amibroker`, `/xl/ltp`, `/xl/quote` |
| [`../sdk/python`](../sdk/python), [`../sdk/node`](../sdk/node) | Your own scripts and strategies | the whole `/v1` API |

Everything under `/xl` is **read-only**: those routes are GET-only, need only the `read` scope, and cannot
place, modify or cancel an order. Orders go through `/v1/orders` (paper by default) with the SDKs or the dashboard.

Keys: create one per tool, with the least it needs, and keep keys out of files you share:

```
mc-bridge keys create --label excel  --scope read --allow-query --client excel --expires 90d   # URL key for WEBSERVICE
mc-bridge keys create --label sheets --scope read                                              # header key
mc-bridge keys create --label algo   --scope paper --client script                             # paper orders from a script
```

`--allow-query` is only for tools that cannot send headers (Excel `WEBSERVICE`, AmiBroker, `IMPORTDATA`), and only
works with read-only keys.
