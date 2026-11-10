# AmiBroker with the Mr. Chartist API Bridge

Two ways to get Bridge data into AmiBroker. Both are read-only: nothing under `/xl` can place an order.

## 1. Import history (ASCII import)

The Bridge serves candles in AmiBroker's ASCII layout from `GET /xl/history?layout=amibroker`.

| Interval | Columns | Format file |
|---|---|---|
| `1m` … `60m` | `Ticker,Date,Time,Open,High,Low,Close,Volume,OpenInt` | `mrchartist-intraday.format` |
| `1d`, `1w`, `1M` | `Ticker,Date,Open,High,Low,Close,Volume,OpenInt` | `mrchartist-eod.format` |

Dates are `YYYY-MM-DD` and times are IST (`HH:MM:SS`, bar open). Volume and open interest are whole numbers (open
interest is 0 when the instrument has none).

**Setup (once)**

1. Copy both `.format` files into AmiBroker's `Formats` folder.
2. Add these two lines to `Formats\import.types` so they appear in *File → Import ASCII*:

   ```
   Mr. Chartist Bridge intraday (*.csv)|*.csv|mrchartist-intraday.format
   Mr. Chartist Bridge EOD (*.csv)|*.csv|mrchartist-eod.format
   ```

**Each import**

```powershell
# PowerShell: the key goes in a header, not the URL
$h = @{ Authorization = "Bearer $env:MCB_AMIBROKER_KEY" }
Invoke-WebRequest -Headers $h -OutFile nifty-5m.csv `
  "http://127.0.0.1:4300/xl/history?symbol=NSE:NIFTY&interval=5m&countback=2000&layout=amibroker"
```

Then *File → Import ASCII*, choose the file and the matching *Mr. Chartist Bridge* type.

**Tickers.** AmiBroker stores each symbol as a file, so the Bridge drops the `:`: NSE, NFO, MCX and CDS symbols keep
the part after the colon (`NSE:RELIANCE` → `RELIANCE`, a future such as `NFO:NIFTY-<expiry>-FUT` → `NIFTY-<expiry>-FUT`); BSE and
BFO get a suffix (`BSE:RELIANCE` → `RELIANCE.BSE`). Add `&ticker=MYNAME` to choose your own (letters, digits and
`& . _ ^ # -`).

## 2. Live values in formulas (AFL include)

`mrchartist-bridge.afl` gives you `McbLtp(symbol)`, `McbQuote(symbol, field)` and `McbHistoryUrl(...)`.

1. Copy `mrchartist-bridge.afl` into `Formulas\Include`.
2. Create a **read-only URL key** (AmiBroker cannot send headers, so the key travels in the URL):

   ```
   mc-bridge keys create --label amibroker --scope read --allow-query --client other
   ```

3. Store it **outside your formulas**, either:
   - as the Windows user environment variable `MCB_AMIBROKER_KEY` (then restart AmiBroker), or
   - as the only line of `%APPDATA%\MrChartist\Bridge\amibroker.key` (the older `%USERPROFILE%\.mc-bridge\amibroker.key`
     is still read).
4. In any formula: `#include_once <mrchartist-bridge.afl>` and see `example-display.afl`.

Never paste the key into a strategy file: strategy files get shared, backed up and posted on forums. A URL key only
reads data, but it still reads *your* data.

**Rate limits.** Each value is cached in a static variable and fetched at most once a second per symbol
(`McbMinIntervalMs`), and the Bridge answers from its live stream or short cache first, so a chart that refreshes
many times a second does not turn into many broker calls.

**Needs verification on your installation:** AmiBroker 5.90 or later for `InternetOpenURL` and
`GetPerformanceCounter`; Windows Script Host for reading environment variables; the ASCII importer's acceptance of
`YYYY-MM-DD` dates in `Date_YMD` (documented, but check your version).
