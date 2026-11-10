# AmiBroker

Everything AmiBroker can reach is read-only: `/xl/*` cannot place orders. Full instructions and the files:
[integrations/amibroker](../../integrations/amibroker/README.md).

## Live values in AFL

1. Copy `integrations/amibroker/mrchartist-bridge.afl` into AmiBroker's `Formulas\Include` folder.
2. Create a read-only URL key (AmiBroker cannot send headers):
   `mc-bridge keys create --label amibroker --scope read --allow-query`
3. Store it outside your formulas: the Windows user variable `MCB_AMIBROKER_KEY` (restart AmiBroker), or the only line
   of `%USERPROFILE%\.mc-bridge\amibroker.key`.
4. Use it:

```c
#include_once <mrchartist-bridge.afl>

nifty = McbLtp("NSE:NIFTY");
oi    = McbQuote("NFO:NIFTY-2026-10-27-FUT", "oi");
chg   = McbQuote("NSE:RELIANCE", "changePct");

Title = StrFormat("NIFTY %.2f   FUT OI %.0f   RELIANCE %.2f%%", nifty, oi, chg);
```

Each value is fetched at most once per `McbMinIntervalMs` (1 s by default) per symbol, and the Bridge answers from
its stream or cache first, so a chart refreshing many times a second does not multiply broker calls. Fields:
`ltp, open, high, low, close, change, changePct, volume, oi, bid, ask`. Set `MCB_BRIDGE_URL` if the Bridge is not on
`http://127.0.0.1:4300`.

## History via ASCII import

```powershell
$h = @{ Authorization = "Bearer $env:MCB_AMIBROKER_KEY" }
Invoke-WebRequest -Headers $h -OutFile nifty-5m.csv `
  "http://127.0.0.1:4300/xl/history?symbol=NSE:NIFTY&interval=5m&countback=2000&layout=amibroker"
```

Import with *File → Import ASCII* and the shipped `mrchartist-intraday.format` (or `mrchartist-eod.format` for daily
and longer). Times are IST bar-open times.
