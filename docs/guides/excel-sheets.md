# Excel and Google Sheets

Prices and your own book in a spreadsheet, with **one request per refresh** instead of one per cell. Nothing a
spreadsheet can call is able to place, change or cancel an order: every `/xl` route is a read-only GET.

Fastest way: open the dashboard, **API > Integrations > Excel and Sheets**. Choose what to show, make a read-only key,
download the workbook (or copy the Apps Script), and press **Test it** to see the same single request a sheet makes,
with each price's freshness label.

| You use | What to use | Needs |
|---|---|---|
| Excel for Windows | The workbook from the dashboard (or `node integrations/excel/make-template.mjs`) | Nothing else. `WEBSERVICE` exists only on Windows |
| Excel for Mac, Excel for the web | Power Query: [`quotes.pq`](../../integrations/excel/quotes.pq) | A refresh timer in Query Properties |
| Google Sheets | The Apps Script: [`bridge.gs`](../../integrations/google-sheets/bridge.gs) | A public address for the Bridge (see below) |

Microsoft's own page says `WEBSERVICE` is not available on Mac and does not list it for the web.

## The Excel workbook

Sheets: **Setup**, **Watchlist** (prices), **Positions**, **Holdings**, **Funds**, **Orders** and **Feed** (helper: each
request's address and answer). Choose the ones you want in the dashboard.

1. Make a key in the dashboard (read-only, expires) and paste it into the yellow cell on **Setup**, cell B6. Check the
   Bridge address in B5 (`http://127.0.0.1:4300` when Excel and the Bridge are on the same computer).
2. Open **Watchlist**. It already has ten symbols; type your own in column A (up to 50).
3. Press **F9**. The Status line on top says what happened, for example
   `OK. 10 prices, newest 2026-11-09 11:00:27 IST, oldest 0 s old.`

How it works: each sheet makes one request (`/xl/quotes`, `/xl/positions` and so on, as tab-separated text) into one
cell on **Feed**, cuts it into lines and fields with ordinary functions, and looks each row up by symbol. It works in
Excel 2013 and later on Windows. Functions newer than Excel 2007 (`WEBSERVICE`, `ENCODEURL`, `NUMBERVALUE`) are stored
with the `_xlfn.` prefix, which is what stops `#NAME?`. If you add your own formulas with these functions by typing
them in Excel, no prefix is needed; the prefix only matters inside the file.

Every price row says how current it is: **As of** (IST), **Age (s)**, **Class** (`realtime`, `delayed`, `eod`),
**Source** (`stream`, `cache`, `broker`) and **Stale**. In demo mode the Status line starts with `DEMO DATA`.

### The key

The workbook holds **no key** unless you tick "Put this key inside the workbook" when you download it; then the key is
stored as a workbook name (Formulas > Name Manager), not in a cell. Otherwise it lives in the yellow cell, and Setup
tells you whether a key is there. The key travels in the web address of each request, so it can appear in logs on the
way (this computer's own logs do not record it). Use a read-only key with an expiry, and **clear the cell before you
share or email the file**.

### Refreshing, and how often

| What | Recommended | How |
|---|---|---|
| Prices | Not more often than every 5 seconds | Press F9 (Setup switch "Refresh on every recalculation" = Yes), or Ctrl+Alt+F9 |
| Positions, Holdings, Funds, Orders | About once a minute | Same |
| Timer | Not built in: Excel has no timer without a macro | A macro below, or Power Query with *Refresh every N minutes* |

Each refresh is one request per sheet that is in the workbook. The Bridge allows each key about 50 requests a second
and your broker has its own limits, so a handful of requests every few seconds is nothing, while a macro that
recalculates in a loop is not. A macro for a 10-second timer (save the workbook as `.xlsm`; macros are yours to add,
the Bridge never ships one):

```vba
Sub Tick()
    Application.CalculateFull
    Application.OnTime Now + TimeSerial(0, 0, 10), "Tick"
End Sub
```

Run `Tick` once to start it. `Application.OnTime Now + TimeSerial(0,0,10), "Tick", , False` stops it.

### What a sheet costs, measured

On the demo Bridge, 42 symbols read one cell at a time (`/xl/ltp`, what the old workbook did) took 4.5 seconds cold
and about 1 broker call per symbol per recalculation; 120 cells recalculated in parallel got 66 answers `429`. The
same 42 symbols through `/xl/quotes` are one request, about 60 milliseconds, one batched read; 120 sheets in parallel
would still hit the per-key limit, and then the answer says how long to wait.

## Google Sheets

Google runs formulas and Apps Script on its own servers, which cannot reach `127.0.0.1`. The Bridge has to be
reachable from the internet through a tunnel you set up yourself: see [Exposing the Bridge](expose-alerts.md). Read
the risks there first: your data then passes through the tunnel provider and Google, your broker's terms may not allow
it ([compliance](compliance.md#tunnels-and-public-endpoints)), and requests that arrive through a tunnel are never
treated as coming from this computer, so the dashboard and every admin route refuse them.

Sheets formulas and Apps Script run on Google's servers and cannot reach `127.0.0.1`. Run `mc-bridge expose sheets`: it
turns on a separate **Sheets listener** (`server.sheetsIngress`, port 4302) that serves only `GET /xl/*`, only for
read-only keys, with its own host list and a request cap. Point your tunnel at that port and at nothing else (never at
4300); the dashboard, `/v1` and every admin route do not exist on it. Make a read-only key with an expiry, limited to the
accounts the sheet needs. Anyone with the address and the key can read your data, so do not share the sheet. The steps,
the safe layout and the check are in [expose-alerts.md](expose-alerts.md#6-google-sheets). If you tunnel to the main port
anyway, requests that arrive through a tunnel (a host from `server.allowedHosts`, or any `X-Forwarded-For` / `Forwarded` /
`CF-Connecting-IP` header) are never treated as coming from this computer, but a read key then reaches far more than a
sheet needs; `mc-bridge doctor` warns about it.

1. Make a key **for Google Sheets** in the dashboard (read-only, expires). It is sent in a request header, never in the
   address, so it stays out of tunnel and Google address logs. Do **not** use `IMPORTDATA(...&key=...)`: the key then sits
   in a web address everyone who can see the sheet can read.
2. *Extensions > Apps Script*, paste the script (button in the dashboard), save.
3. *Project Settings > Script properties*: `BRIDGE_URL` (your tunnel address, no trailing slash) and `BRIDGE_KEY`.
   Anyone who can edit the script can read these: do not share the sheet.
4. Reload the sheet. **Bridge > Set up sheets** makes Watchlist, Positions, Holdings, Funds and Orders;
   **Bridge > Refresh now** fills them (one request per sheet); **Bridge > Start timed refresh** runs it every 5 minutes
   (1, 5, 10, 15 and 30 are the intervals Google allows).
5. Or use `=BRIDGE_QUOTES(A5:A30)` in any cell: the whole range in one request, with the freshness columns.

Google's own limits (Apps Script quotas page): 20,000 URL Fetch calls a day for a consumer account (100,000 for
Workspace), 90 minutes a day of trigger run time on a consumer account, 30 seconds for a custom function. One refresh
is at most five requests, so every minute is about 7,200 a day. Every 5 minutes is plenty for a book, and gentler on
your broker.

## The routes (for Power Query, curl, your own script)

All are `GET`, all take `?format=csv|tsv|json` (CSV is the default; CRLF for CSV, LF for TSV; numbers with a `.`
decimal point and no thousands separator; times in IST as `YYYY-MM-DD HH:MM:SS`) and the optional `?cache=1`.

| Route | What |
|---|---|
| `/xl/quotes?symbols=A,B,C&fields=ltp,chg,pct,volume` | One row per symbol, in the order asked, duplicates kept. At most 100 symbols (`integrations.xl.maxSymbols`, up to 200). `fields` chooses value columns from `ltp open high low close chg pct volume oi bid ask`; `as_of age_s class source stale error` always follow. A bad symbol gives blank values and a text in `error`: it never fails the table |
| `/xl/positions`, `/xl/holdings`, `/xl/funds`, `/xl/orders` | Your book, fixed columns. Every account the key may use that can answer, or `?account=`. An account that cannot answer (not logged in) gives one row with its name and an `error` |
| `/xl/instrument?symbol=NSE:RELIANCE&field=lot` | One symbol and one field: a bare number. Several symbols or fields: a table of `lot tick freeze name kind` |
| `/xl/ltp`, `/xl/quote`, `/xl/chain`, `/xl/history` | Unchanged: one value (`#N/A` on error), the option chain, candles |

Rules these routes keep:

- **Never a backup price.** A Yahoo-style or other backup source is never used (`?backup=true` is refused), and the
  single-value routes also refuse a price whose class is not `realtime`, because a bare number cannot carry the label.
  `/xl/quotes` shows such a value with its `class` and `stale` columns instead.
- **Read-only.** A `?key=` in the address works only on `/xl`, and only for keys that can do nothing but read. Keys are
  never logged.
- **Caching is off by default** (`Cache-Control: no-store`). With `?cache=1` a table is sent with
  `Cache-Control: private, max-age=5` (`integrations.xl.cacheSeconds`) and an `ETag`; `If-None-Match` gets `304`.
  Errors are never cached.
- **Errors you can read in a cell.** A refused table request answers a one-row table
  `status,code,message,retry_after_s`, for example `429,RATE_LIMITED,Too many refreshes: wait 3 seconds and try again.,3`,
  with the real status and a `Retry-After` header.

## When something is wrong

| You see | Why | What to do |
|---|---|---|
| `#NAME?` in a cell | A workbook made before this version, or a formula typed from an old example, stored without the `_xlfn.` prefix | Download the workbook again. In your own formulas, type them in Excel (it adds the prefix itself) |
| Status `NO ANSWER` | The request failed: the Bridge is not running, the address or key is wrong or expired, the symbol list made the address longer than 2,048 characters, or the Bridge answered 429 | Check Setup (address, key check line), open the address in a browser or press **Test it** in the dashboard, wait 10 seconds and press F9. `WEBSERVICE` cannot show the reason; the dashboard test and Power Query can |
| Prices blank in the morning | Your broker session expired overnight, so the Bridge has nothing to read. The table says `SESSION_EXPIRED` in the Error column | Log in on the Accounts page; press F9 |
| `429` / "Too many refreshes: wait N seconds" | Too many requests from one key (about 50 a second), or your broker's limit | Refresh less often; one sheet is one request, so look for a macro or a loop |
| `Stale` = true, or `Class` = `delayed` | The value is older than the Bridge's target, or comes from a delayed feed | Do not trade on it; the `As of` time says how old. Press F9 once the market feed is back |
| `DEMO DATA` | The Bridge is in demo mode: sample prices | Expected until a real broker is connected |
| `symbol could not be priced` | A typo, an expired contract or a symbol your broker does not carry | Bridge symbols: `NSE:RELIANCE`, `NSE:M&M`, `NFO:NIFTY-2026-11-24-FUT`. Search with `GET /v1/instruments/search` |
| `401` on a table, key was working | The key expired or was revoked | Make a new one; the dashboard shows expiries under API > Keys |
| Excel for Mac or the web shows nothing | No `WEBSERVICE` there | Use `quotes.pq` (Power Query) or Google Sheets |

## Power Query (Windows and Mac)

Power Query sends the key in an `Authorization` header, so a plain read key is enough and it never appears in an
address. [`quotes.pq`](../../integrations/excel/quotes.pq) reads the ranges `BridgeURL`, `BridgeKeyCell` and
`WatchlistSymbols` that the workbook defines; [`history.pq`](../../integrations/excel/history.pq) and
[`chain.pq`](../../integrations/excel/chain.pq) read candles and the option chain. Paste one into *Data > Get Data >
Blank Query > Advanced Editor*, choose **Anonymous** when asked how to connect, and set *Refresh every N minutes* in
Query Properties.

## Sharing a template

`node integrations/excel/make-template.mjs my-template.xlsx` writes the same workbook with a sample watchlist and no
key. Send it to a friend; they paste their own key. For Sheets, the script's *Bridge > Set up sheets* builds the same
layout in any blank sheet.

## Formula safety

Text that begins with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'` in CSV, TSV and JSON, so
Excel never evaluates text that came from a broker or an instrument master.
