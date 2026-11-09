# Excel with the Mr. Chartist API Bridge

Everything here is read-only: nothing under `/xl` can place an order, and URL keys are refused unless they are
read-only. The full guide, with the refresh advice and a troubleshooting table, is
[docs/guides/excel-sheets.md](../../docs/guides/excel-sheets.md).

## The workbook (Excel for Windows)

Get it from the dashboard (**API > Integrations > Excel and Sheets**), or build a shareable copy with no key:

```
node integrations/excel/make-template.mjs my-template.xlsx [--host http://127.0.0.1:4300] [--only watchlist,positions]
```

Paste a read-only key in `Setup`, cell B6, then press F9. Each sheet (Watchlist, Positions, Holdings, Funds, Orders)
is one request, however many rows it has. Make the key in the dashboard, or in a terminal:

```
mc-bridge keys create --label excel --scope read --allow-query --client excel --expires 90d
```

`--allow-query` lets the key travel in a web address, which `WEBSERVICE` needs because it cannot send headers.
`WEBSERVICE` exists only in Excel for Windows.

## Power Query (Windows and Mac)

Power Query can send a header, so the key stays out of the address and a plain read key is enough. Paste one of these
into *Data > Get Data > Blank Query > Advanced Editor*, and choose **Anonymous** when Excel asks how to connect:

- [`quotes.pq`](quotes.pq): your watchlist in one request (reads the ranges `BridgeURL`, `BridgeKeyCell`,
  `WatchlistSymbols` of the workbook).
- [`history.pq`](history.pq): candles for one symbol (`/xl/history`).
- [`chain.pq`](chain.pq): the option chain, one row per strike (`/xl/chain`). Change `Expiry` to a current date.

Set a refresh interval of a minute or more in *Query Properties*.
