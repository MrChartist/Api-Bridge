# Excel and Google Sheets

Nothing a spreadsheet can call is able to place an order: every `/xl` route is a read-only GET. Full instructions and
Power Query files: [integrations/excel](../../integrations/excel/README.md),
[integrations/google-sheets](../../integrations/google-sheets/README.md).

## Excel for Windows: one value per cell

```bash
npx mc-bridge keys create --label excel --scope read --allow-query --client excel --expires 90d
```

Put the key in a cell on a hidden sheet and name it `BridgeKey`. With a symbol in `A2`:

| What | Formula |
|---|---|
| LTP | `=VALUE(WEBSERVICE("http://127.0.0.1:4300/xl/ltp?symbol="&ENCODEURL(A2)&"&key="&BridgeKey))` |
| % change | `=VALUE(WEBSERVICE("http://127.0.0.1:4300/xl/quote?symbol="&ENCODEURL(A2)&"&field=changePct&key="&BridgeKey))` |
| Open interest | `=VALUE(WEBSERVICE("http://127.0.0.1:4300/xl/quote?symbol="&ENCODEURL(A2)&"&field=oi&key="&BridgeKey))` |
| Safe | `=IFERROR(VALUE(WEBSERVICE(...)),"")` |

- The answer is a bare number (`.` decimal point, no grouping). In decimal-comma locales use
  `NUMBERVALUE(WEBSERVICE(...), ".")`.
- Any problem (unknown symbol, bad key, rate limit, Bridge not running) returns `#N/A` with an error status, so
  `IFERROR` catches it; the reason is in the `X-Error-Code` header (`curl -i`).
- These routes never use a backup data source (Yahoo, a plugin, ...), whatever `sources.autoFallback` says. A bare number or a
  fixed table has no room to say "this is 15 minutes old", and `WEBSERVICE` cannot see headers, so a delayed value would pass
  for a live one. `?backup=true` is refused with a message; for a labelled backup answer use the `/v1` routes. The freshness
  headers (`X-Data-Source`, `X-Data-Age-Ms`, `X-Data-Stale`) say when a cached value that has aged was served.
- Press F9 to refresh. Hundreds of cells are fine: repeated reads are served from the Bridge's stream or cache, and the
  broker only sees what is really needed.

## Tables with Power Query (Windows and Mac)

Power Query sends the key in an `Authorization` header, so a plain read key is enough. Paste
[`history.pq`](../../integrations/excel/history.pq) (candles) or [`chain.pq`](../../integrations/excel/chain.pq) (option
chain) into *Data → Get Data → Blank Query → Advanced Editor*, and choose **Anonymous** when Excel asks how to
connect.

```
http://127.0.0.1:4300/xl/chain?underlying=NIFTY&expiry=2026-10-27&strikes=10&greeks=true
http://127.0.0.1:4300/xl/history?symbol=NSE:NIFTY&interval=5m&countback=500
```

## Google Sheets

> **Compliance warning.** A tunnel to the main API makes a **public endpoint**, and your broker's data then passes
> through Google's and the tunnel provider's servers. Your broker's data terms may not allow that (**needs
> verification per broker**); the risk is yours. Excel on this computer needs no tunnel. See
> [compliance.md](compliance.md#tunnels-and-public-endpoints).

Sheets formulas and Apps Script run on Google's servers and cannot reach `127.0.0.1`. You need your own tunnel, its
host name in `server.allowedHosts`, and a read-only key with an expiry, limited to the accounts the sheet needs.
Anyone with the tunnel URL and the key can read your data, so put the tunnel behind its own access control where you
can, and do not share the sheet. Requests that arrive through a tunnel (a host from `server.allowedHosts`, or any
`X-Forwarded-For` / `Forwarded` / `CF-Connecting-IP` header) are never treated as coming from this computer: the
dashboard, key creation, hooks, account logins, order confirmations and kill-switch release all refuse them.

[`bridge.gs`](../../integrations/google-sheets/bridge.gs) adds `=BRIDGE_LTP("NSE:NIFTY")`,
`=BRIDGE_QUOTE("NSE:RELIANCE","changePct")`, `=BRIDGE_CHAIN("NIFTY","2026-10-27",10)` and
`=BRIDGE_HISTORY("NSE:NIFTY","5m",100)`, sending the key in a header. Google refreshes custom functions only
occasionally, so Sheets suits slow dashboards, not live trading screens.
