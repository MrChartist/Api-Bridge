# Excel with the Mr. Chartist API Bridge

Everything here is read-only: nothing under `/xl` can place an order, and URL keys are refused unless they are
read-only.

## Create a key for Excel

```
mc-bridge keys create --label excel --scope read --allow-query --client excel --expires 90d
```

`--allow-query` lets the key travel in a URL (`?key=`), which `WEBSERVICE` needs because it cannot send headers.
Power Query can send headers, so use a header key there whenever you can (see below).

Put the key in a cell on a separate, hidden sheet (for example `Settings!B1`, named `BridgeKey`) rather than in every
formula, and do not email the workbook with the key in it.

## Single values with WEBSERVICE (Excel for Windows)

| What | Formula |
|---|---|
| LTP | `=VALUE(WEBSERVICE("http://127.0.0.1:4300/xl/ltp?symbol="&ENCODEURL(A2)&"&key="&BridgeKey))` |
| % change | `=VALUE(WEBSERVICE("http://127.0.0.1:4300/xl/quote?symbol="&ENCODEURL(A2)&"&field=changePct&key="&BridgeKey))` |
| Open interest | `=VALUE(WEBSERVICE("http://127.0.0.1:4300/xl/quote?symbol="&ENCODEURL(A2)&"&field=oi&key="&BridgeKey))` |
| Safe version | `=IFERROR(VALUE(WEBSERVICE(...)),"")` |

`A2` holds a Bridge symbol such as `NSE:NIFTY`, `NSE:M&M` or `NFO:NIFTY-2026-10-27-25000-CE` (`ENCODEURL` takes care
of the `&` and `:`). Fields: `ltp, open, high, low, close, change, changePct, volume, oi, bid, ask`.

What to expect:

- The answer is a bare number with a `.` decimal point and no grouping, so `VALUE()` reads it in any locale that uses
  `.`; in locales with a decimal comma use `NUMBERVALUE(WEBSERVICE(...), ".")`.
- On any problem (unknown symbol, field with no value, rate limit, Bridge not running) the reply is `#N/A` with an
  error status, so `WEBSERVICE` shows `#VALUE!` and `IFERROR` catches it. The reason is in the `X-Error-Code`
  response header (visible with `curl -i`).
- `WEBSERVICE` exists only in Excel for Windows (not Mac or the web), URLs are limited to 2,048 characters and a
  result to 32,767 characters. The single-value routes are a few characters long.
- Excel recalculates `WEBSERVICE` when the sheet recalculates. Press F9 to refresh. Avoid making it volatile with
  `NOW()` on hundreds of cells: the Bridge serves repeated reads from its live stream or cache, but each cell is still
  a separate request.

## Tables with Power Query (Windows and Mac)

Power Query can send an `Authorization` header, so the key does not need to be in the URL. Name a one-cell range
`BridgeKey` holding a key (a plain read key is enough; it does not need `--allow-query`), then *Data → Get Data →
From Other Sources → Blank Query → Advanced Editor* and paste one of:

- [`history.pq`](history.pq) — candles for one symbol (`/xl/history`), typed as date-time and numbers.
- [`chain.pq`](chain.pq) — the option chain, one row per strike (`/xl/chain`).

When Excel asks how to connect, choose **Anonymous** (the key is already in the header). Refresh with *Data →
Refresh All* or set a refresh interval of a minute or more in *Query Properties*.

A table going through `WEBSERVICE` instead must stay under 32,767 characters: add `&maxChars=32767` and the Bridge
trims it (oldest bars, or strikes furthest from ATM, go first) and marks the reply with `X-Truncated: true`.

## Formula safety

CSV and JSON cells that begin with `=`, `+`, `-`, `@`, tab or carriage return are prefixed with `'` so Excel never
evaluates text from a broker or an instrument master as a formula.
