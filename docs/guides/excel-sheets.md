# Excel and Google Sheets

> Commands here start with `mc-bridge`. In a git checkout, run them as `npm run bridge -- <command>` instead ([why](README.md#running-mc-bridge)).

Prices and your own book in a spreadsheet, with **one request per refresh** instead of one per cell. Nothing a
spreadsheet can call is able to place, change or cancel an order: every `/xl` route is a read-only GET.

Fastest way: open the dashboard, **API > Integrations > Excel and Sheets** (in the Simple view the API page is hidden: press
Ctrl K and type *Integrations*, or switch to Advanced in the account menu). Choose what to show, make a read-only key,
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

**A big book is never cut silently.** Each book sheet has room for a fixed number of rows (40 positions, 60 holdings,
10 funds, 60 orders) and asks the Bridge for no more, so an answer can never pass `WEBSERVICE`'s limit of 32,767
characters (beyond it Excel shows `#VALUE!`, and the sheet would say `NO ANSWER` although the Bridge is fine). When the
book is bigger, the Bridge ends the table with one visible row, `(more rows)` with `SHOWING 40 OF 130 ROWS: ...`, and
the Status line repeats it. The P&L total on Positions then reads `PARTIAL: ...` (it also does when an account could not
answer), never a smaller number passed off as the total. To see one account's rows alone, ask the Bridge for
`?account=` or raise `limit` in a request of your own (Power Query, curl, Apps Script have no 32,767 limit).

A broker account that is **logged out** is not left out: it has its own row with its name and
`SESSION_EXPIRED: <name> is logged out. Log in again on the Accounts page of the dashboard.`, and the Status line says
`CHECK: 1 row has an error`. A flat book with a green status therefore means a flat book.

Every request the workbook makes ends in `errors=200`, which makes the Bridge answer a refusal (wrong key, key not made
with Allow in URLs, too many refreshes) as a normal answer holding its reason. The Status line then reads
`REFUSED: Too many refreshes: wait 3 seconds and try again.` instead of a guess. An answer that is not a Bridge table at
all (a tunnel's notice page, a login page) reads `CHECK: the answer is not a Bridge table ... It starts: ...` and never
turns into rows or blank prices. **Not verified in real Excel here:** how `WEBSERVICE` treats other failures (no
reply, a network error) is Microsoft's behaviour; the workbook shows `NO ANSWER` for those.

Every price row says how current it is: **As of** (IST), **Age (s)**, **Class** (`realtime`, `delayed`, `eod`),
**Source** (`stream`, `cache`, `broker`) and **Stale**. In demo mode the Status line starts with `DEMO DATA`.

### A collection instead of typed symbols

`/xl/quotes` also takes `collection=<name>` in place of `symbols=`: a list you keep once in the Bridge (a fixed list, or an
option universe such as "NIFTY current weekly, ATM +/- 10", worked out at the time of the request). In Power Query or
`IMPORTDATA` use `/xl/quotes?collection=banks&fields=ltp,chg,pct`; in the workbook replace the `symbols=` part of the request.
A price that is not live is refused with the reason in a one-row table. See [collections.md](collections.md).

### The key

Excel's `WEBSERVICE` cannot send a header, so the key has to travel in the web address of each request (`?key=`). The
Bridge accepts that only for a **read-only key made for it**. From a terminal:

```bash
mc-bridge keys create --label excel --scope read --allow-query --expires 90d
```

The flag is `--allow-query`; the dashboard calls it **Allow in URLs**, and Connect a tool and the Excel preset set it for you.
A read key made without it works everywhere else but is refused here with `401` and the words "may not be sent in a web
address". A key that is simply wrong or expired gets "not accepted: it may be wrong, expired or revoked".

Where the key sits in the file: a workbook from **Integrations** holds **no key** unless you tick "Put this key inside the
workbook"; the workbook from **Connect a tool** always has the key inside. Either way the key is stored as a workbook name
(Formulas > Name Manager), not in a cell. Without it, the key lives in the yellow cell (Setup, B6), and Setup tells you
whether a key is there. The key travels in the web address of each request, so it can appear in logs on the way (this
computer's own logs do not record it). Use a read-only key with an expiry, and **clear the cell, and do not email a
workbook that has a key stored inside, before you share the file**.

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

**The safe way to hold the key is an Apps Script with the key in a script property, sent in a header.** `=IMPORTDATA("...&key=...")`
is the one thing not to do: the key then sits in a web address that everyone who can see the sheet can read (and Google
and the tunnel log it). The dashboard's Connect a tool page says the same.

Run `mc-bridge expose sheets`: it
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

The script puts each value under the column of the same name, so a column the Bridge adds (such as `demo`) cannot shift
anything. Each sheet is refreshed on its own: a problem on one shows as `ERROR: ...` in that sheet's cell A2 and the others
still refresh. An answer that is not a Bridge table (a tunnel's notice page) leaves the old values in place and shows
`NO ANSWER: The answer is not a Bridge table ...`. The script is run against a demo Bridge for every sheet in the tests;
it has **not** been run in Google's own Apps Script, so the first run there is yours.

Google's own limits (Apps Script quotas page): 20,000 URL Fetch calls a day for a consumer account (100,000 for
Workspace), 90 minutes a day of trigger run time on a consumer account, 30 seconds for a custom function. One refresh
is at most five requests, so every minute is about 7,200 a day. Every 5 minutes is plenty for a book, and gentler on
your broker.

## The routes (for Power Query, curl, your own script)

All are `GET`, all take `?format=csv|tsv|json` (CSV is the default; CRLF for CSV, LF for TSV; numbers with a `.`
decimal point and no thousands separator; times in IST as `YYYY-MM-DD HH:MM:SS`) and the optional `?cache=1`.

| Route | What |
|---|---|
| `/xl/quotes?symbols=A,B,C&fields=ltp,chg,pct,volume` | One row per symbol, in the order asked, duplicates kept. At most 100 symbols (`integrations.xl.maxSymbols`, up to 200). `fields` chooses value columns from `ltp open high low close chg pct volume oi bid ask`; `as_of age_s class source stale error` always follow (and `demo`, in demo mode only). A bad symbol gives blank values and a text in `error`: it never fails the table |
| `/xl/positions`, `/xl/holdings`, `/xl/funds`, `/xl/orders` | Your book, fixed columns. Every enabled account the key may use, or `?account=`. An account that cannot answer (logged out, broker down) gives one row with its name and an `error`: it is never left out. `limit=` keeps the first N rows (positions, holdings, funds) and then adds a `(more rows)` row `SHOWING N OF M ROWS: ...` with `X-Truncated` and `X-Total-Rows` |
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
  with the real status and a `Retry-After` header. With `?errors=200` the HTTP status is 200 and the table's `status`
  column still holds the real one (for `WEBSERVICE`, which cannot read an error reply).

## When something is wrong

| You see | Why | What to do |
|---|---|---|
| `#NAME?` in a cell | A workbook made before this version, or a formula typed from an old example, stored without the `_xlfn.` prefix | Download the workbook again. In your own formulas, type them in Excel (it adds the prefix itself) |
| Status `NO ANSWER` | The request got no reply at all: the Bridge is not running, the address is wrong, a tunnel is down, or the symbol list made the address longer than 2,048 characters | Check Setup (address), open the address in a browser or press **Test it** in the dashboard, then press F9 |
| Status `REFUSED: ...` | The Bridge answered and said no: the key is wrong, expired or not made with Allow in URLs, or too many refreshes | Do what the message says (make a new key; wait N seconds) |
| Status `CHECK: the answer is not a Bridge table` | Something other than the Bridge answered (a tunnel's notice page, a login page) | Open the address in a browser and follow the tunnel's page, or point the address at the Bridge |
| Status `SHOWING 40 OF 130 ROWS` and a `PARTIAL` total | The book is bigger than the sheet | Read one account at a time, or use Power Query or Apps Script, which have no row cap |
| Prices blank in the morning | Your broker session expired overnight, so the Bridge has nothing to read. Quotes say `BROKER_UNAVAILABLE: No connected broker account can supply quotes right now` in the Error column; positions, holdings and funds show a row `SESSION_EXPIRED: <account> is logged out` | Log in on the Accounts page; press F9 |
| `429` / "Too many refreshes: wait N seconds" | Too many requests from one key (about 50 a second), or your broker's limit | Refresh less often; one sheet is one request, so look for a macro or a loop |
| `Stale` = true, or `Class` = `delayed` | The value is older than the Bridge's target, or comes from a delayed feed | Do not trade on it; the `As of` time says how old. Press F9 once the market feed is back |
| `DEMO DATA` | The Bridge is in demo mode: sample prices | Expected until a real broker is connected |
| `SYMBOL_NOT_FOUND: NSE:NOPE is not in any connected broker's instrument master` (in the table's Error column; the Apps Script status line says `could not be priced`) | A typo, an expired contract or a symbol your broker does not carry | Bridge symbols: `NSE:RELIANCE`, `NSE:M&M`, and for a future `NFO:NIFTY-<expiry>-FUT` with a live expiry. Search with `GET /v1/instruments/search` |
| `401`, "may not be sent in a web address" | The key is valid but was not made with Allow in URLs | Make a key with `--allow-query` (see [The key](#the-key)) |
| `401` on a table, key was working | The key expired or was revoked | Make a new one; the dashboard shows expiries under API > Keys |
| Excel for Mac or the web shows nothing | No `WEBSERVICE` there | Use `quotes.pq` (Power Query) or Google Sheets |

## Power Query (Windows and Mac)

Power Query sends the key in an `Authorization` header, so a plain read key is enough and it never appears in an
address. [`quotes.pq`](../../integrations/excel/quotes.pq) reads the ranges `BridgeURL`, `BridgeKeyCell` and
`WatchlistSymbols` that the workbook defines; [`history.pq`](../../integrations/excel/history.pq) and
[`chain.pq`](../../integrations/excel/chain.pq) read candles and the option chain, from `BridgeURL` and `BridgeKeyCell`
too. Paste one into *Data > Get Data > Blank Query > Advanced Editor*, choose **Anonymous** when asked how to connect,
and set *Refresh every N minutes* in Query Properties.

These files read plain named ranges, because Microsoft documents `Excel.CurrentWorkbook` as returning tables, named
ranges and dynamic arrays; a workbook name that holds a formula (such as `BridgeKey`) is not one, which is why the
files read `BridgeKeyCell`. A test checks this against the workbook the Bridge writes. **Not tested in real Excel here**
(no Excel was available): if Power Query cannot find a name, open *Formulas > Name Manager* and check that
`BridgeURL` and `BridgeKeyCell` exist.

## Sharing a template

`node integrations/excel/make-template.mjs my-template.xlsx` writes the same workbook with a sample watchlist and no
key. Send it to a friend; they paste their own key. For Sheets, the script's *Bridge > Set up sheets* builds the same
layout in any blank sheet.

## Formula safety

Text that begins with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'` in CSV, TSV and JSON, so
Excel never evaluates text that came from a broker or an instrument master.
